//! Background worker: emits due source messages while a session runs and
//! purges replayed messages while it stops. Each emitted message is its own
//! transaction that also advances the cursor, so a crash never duplicates
//! or loses a replay. At the window end the session rewinds to the window
//! start and loops or pauses.
//!
//! Logs every replayed message, rewind and purge batch, plus a periodic
//! progress summary; all times are Kyiv local.

use crate::config::{
    MESSAGE_REPLAY_EMIT_BATCH_SIZE, MESSAGE_REPLAY_ERROR_SLEEP_SEC,
    MESSAGE_REPLAY_PROGRESS_LOG_SEC, MESSAGE_REPLAY_TICK_SEC,
};
use crate::entities::message_replay_session;
use crate::h;
use crate::message_replay::clock::ReplayClock;
use crate::message_replay::emit::EmittedReplay;
use crate::message_replay::source::{self, SourceKey};
use crate::message_replay::{emit, purge, session};
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use chrono::{NaiveDateTime, TimeZone};
use redis::aio::ConnectionManager;
use sea_orm::{DatabaseTransaction, TransactionTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Set once no copy of the replay before #4110 is left. None can appear
/// again, so the process stops looking for them; the first look can scan
/// every comment of the system login.
static LEGACY_PURGED: AtomicBool = AtomicBool::new(false);

enum Step {
    /// Work was done; more may be pending. Carries inbox ids for fanout.
    Progress(Vec<i64>),
    Idle,
}

enum Batch {
    /// Every step of the batch did work; more may be due right away.
    Full,
    /// The batch stopped at an idle step.
    Drained,
}

pub async fn run_message_replay_worker_nofail(env: Arc<Env>) {
    let mut redis = env.redis.clone();
    let mut progress_log = ProgressLog::default();
    info!("message_replay: worker started");
    loop {
        let _loop_guard = worker_watch::loop_guard("message_replay_worker");
        let sleep_sec = match run_iteration(&env, &mut redis).await {
            // A full batch means more is already due (a busy window at a
            // high speed, catching up, or purging): go on without a tick.
            Ok(Batch::Full) => 0,
            Ok(Batch::Drained) => MESSAGE_REPLAY_TICK_SEC,
            Err(e) => {
                error!("message_replay_worker failed: {:#?}", e);
                MESSAGE_REPLAY_ERROR_SLEEP_SEC
            }
        };
        if let Err(e) = progress_log.log(&env).await {
            error!("message_replay_worker progress log failed: {:#?}", e);
        }
        if sleep_sec == 0 {
            tokio::task::yield_now().await;
        } else {
            tokio::time::sleep(tokio::time::Duration::from_secs(sleep_sec))
                .await;
        }
    }
}

/// Runs up to a batch of steps, then fans out every committed change, even
/// when a later step failed.
async fn run_iteration(
    env: &Env,
    redis: &mut ConnectionManager,
) -> anyhow::Result<Batch> {
    let mut changed_inbox_item_ids = vec![];
    let result = run_steps(env, redis, &mut changed_inbox_item_ids).await;
    crate::inbox::fanout_inbox_changes(redis, changed_inbox_item_ids)
        .await
        .c(h!())?;
    result
}

async fn run_steps(
    env: &Env,
    redis: &mut ConnectionManager,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> anyhow::Result<Batch> {
    for _ in 0..MESSAGE_REPLAY_EMIT_BATCH_SIZE {
        match run_step(env, redis).await.c(h!())? {
            Step::Progress(ids) => changed_inbox_item_ids.extend(ids),
            Step::Idle => return Ok(Batch::Drained),
        }
    }
    Ok(Batch::Full)
}

async fn run_step(
    env: &Env,
    redis: &mut ConnectionManager,
) -> anyhow::Result<Step> {
    let txn = env.dbx.begin().await.c(h!())?;
    let Some(replay_session) = session::lock_for_worker(&txn).await.c(h!())?
    else {
        return purge_legacy_next(txn).await;
    };
    match replay_session.state.as_str() {
        session::STATE_RUNNING => {
            emit_next(env, redis, txn, replay_session).await
        }
        session::STATE_STOPPING => purge_next(txn, replay_session).await,
        _ => {
            txn.commit().await.c(h!())?;
            Ok(Step::Idle)
        }
    }
}

async fn emit_next(
    env: &Env,
    redis: &mut ConnectionManager,
    txn: DatabaseTransaction,
    replay_session: message_replay_session::Model,
) -> anyhow::Result<Step> {
    let clock = ReplayClock::from_session(&replay_session);
    let now = session::now_utc();
    let position = clock.position(now);
    let Some(source_key) = source::next_due_source(
        &txn,
        session::cursor(&replay_session),
        position.min(replay_session.window_to),
    )
    .await
    .c(h!())?
    else {
        if position >= replay_session.window_to {
            let rewound =
                session::rewind(&txn, replay_session, now).await.c(h!())?;
            txn.commit().await.c(h!())?;
            log_rewind(&rewound);
        } else {
            txn.commit().await.c(h!())?;
        }
        return Ok(Step::Idle);
    };
    let emitted = emit_or_skip(env, redis, &txn, &clock, source_key)
        .await
        .c(h!())?;
    let replayed_count =
        replay_session.replayed_count + i64::from(emitted.is_some());
    session::advance_cursor(
        &txn,
        replay_session,
        source_key,
        emitted.is_some(),
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    let Some(emitted) = emitted else {
        return Ok(Step::Progress(vec![]));
    };
    log_emitted(source_key, &emitted, replayed_count, now);
    Ok(Step::Progress(emitted.changed_inbox_item_ids))
}

/// Emits inside a savepoint. A source that fails to replay is logged and
/// skipped (`None`), so one bad message cannot stall the session.
async fn emit_or_skip(
    env: &Env,
    redis: &mut ConnectionManager,
    txn: &DatabaseTransaction,
    clock: &ReplayClock,
    source_key: SourceKey,
) -> anyhow::Result<Option<EmittedReplay>> {
    let savepoint = txn.begin().await.c(h!())?;
    match emit_source(env, redis, &savepoint, clock, source_key).await {
        Ok(emitted) => {
            savepoint.commit().await.c(h!())?;
            Ok(Some(emitted))
        }
        Err(e) => {
            savepoint.rollback().await.c(h!())?;
            error!(
                "message_replay_worker skipped source {}: {:#?}",
                source_key.id, e
            );
            Ok(None)
        }
    }
}

async fn emit_source(
    env: &Env,
    redis: &mut ConnectionManager,
    txn: &DatabaseTransaction,
    clock: &ReplayClock,
    source_key: SourceKey,
) -> anyhow::Result<EmittedReplay> {
    let source = source::load_source(txn, source_key.id).await?.c(h!())?;
    emit::emit_source(env, redis, txn, clock, &source).await
}

async fn purge_next(
    txn: DatabaseTransaction,
    replay_session: message_replay_session::Model,
) -> anyhow::Result<Step> {
    let purged_ids = purge::purge_batch(&txn).await.c(h!())?;
    if purged_ids.is_empty() {
        let session_id = replay_session.id;
        session::delete(&txn, replay_session).await.c(h!())?;
        txn.commit().await.c(h!())?;
        info!(
            "message_replay: session {session_id} stopped, all replays purged"
        );
        return Ok(Step::Idle);
    }
    txn.commit().await.c(h!())?;
    info!(
        "message_replay: purged {} replayed messages (session {})",
        purged_ids.len(),
        replay_session.id
    );
    Ok(Step::Progress(purged_ids))
}

/// With no session, removes the copies the replay before #4110 left behind.
async fn purge_legacy_next(txn: DatabaseTransaction) -> anyhow::Result<Step> {
    if LEGACY_PURGED.load(Ordering::Relaxed) {
        txn.commit().await.c(h!())?;
        return Ok(Step::Idle);
    }
    let purged_ids = purge::purge_legacy_batch(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    if purged_ids.is_empty() {
        LEGACY_PURGED.store(true, Ordering::Relaxed);
        return Ok(Step::Idle);
    }
    info!(
        "message_replay: purged {} copies left by the previous replay",
        purged_ids.len()
    );
    Ok(Step::Progress(purged_ids))
}

fn log_emitted(
    source_key: SourceKey,
    emitted: &EmittedReplay,
    replayed_count: i64,
    now: NaiveDateTime,
) {
    info!(
        "message_replay: #{replayed_count} source {} ({}) -> message {} shown {} (late {:.1}s, {} inbox items)",
        source_key.id,
        kyiv(source_key.timestamp),
        emitted.signal_message_id,
        kyiv(emitted.shown_at),
        (now - emitted.shown_at).num_milliseconds() as f64 / 1000.0,
        emitted.changed_inbox_item_ids.len(),
    );
}

fn log_rewind(rewound: &message_replay_session::Model) {
    info!(
        "message_replay: session {} completed cycle {}, rewound to {} ({})",
        rewound.id,
        rewound.completed_cycles,
        kyiv(rewound.window_from),
        if rewound.state == session::STATE_PAUSED {
            "paused until resumed"
        } else {
            "looping"
        },
    );
}

/// Logs the session state on every change (including changes made by
/// handlers or by hand) and a summary every
/// `MESSAGE_REPLAY_PROGRESS_LOG_SEC` while a session exists.
#[derive(Default)]
struct ProgressLog {
    last_seen: Option<(i64, String)>,
    logged_at: Option<Instant>,
}

impl ProgressLog {
    async fn log(&mut self, env: &Env) -> anyhow::Result<()> {
        let replay_session = session::load(&env.dbx).await.c(h!())?;
        let seen = replay_session
            .as_ref()
            .map(|session| (session.id, session.state.clone()));
        let changed = seen != self.last_seen;
        let summary_due = replay_session.is_some()
            && self.logged_at.is_none_or(|logged_at| {
                logged_at.elapsed()
                    >= Duration::from_secs(MESSAGE_REPLAY_PROGRESS_LOG_SEC)
            });
        if !changed && !summary_due {
            return Ok(());
        }
        let was_present = self.last_seen.is_some();
        self.last_seen = seen;
        self.logged_at = Some(Instant::now());
        match replay_session {
            Some(replay_session) => log_summary(env, replay_session).await,
            None => {
                if was_present {
                    info!("message_replay: no session");
                }
                Ok(())
            }
        }
    }
}

async fn log_summary(
    env: &Env,
    replay_session: message_replay_session::Model,
) -> anyhow::Result<()> {
    if replay_session.state == session::STATE_STOPPING {
        info!(
            "message_replay: session {} stopping, {} replays left to purge",
            replay_session.id,
            source::count_stored_replays(&env.dbx).await.c(h!())?
        );
        return Ok(());
    }
    let now = session::now_utc();
    let clock = ReplayClock::from_session(&replay_session);
    let next_due_ts = source::next_due_source(
        &env.dbx,
        session::cursor(&replay_session),
        replay_session.window_to,
    )
    .await
    .c(h!())?
    .map(|next| next.timestamp);
    let next = next_due_ts.map_or_else(
        || "none".to_string(),
        |ts| {
            format!(
                "{} shown {} (in {})",
                kyiv(ts),
                kyiv(clock.shown_at(ts)),
                format_duration(clock.real_time_until(ts, now))
            )
        },
    );
    info!(
        "message_replay: session {} {} at {:.1}x (on end: {}, cycle {}) window {} .. {}, position {}, cursor {}, replayed {}, remaining {}, offset {}, next {}, window end in {}",
        replay_session.id,
        replay_session.state,
        f64::from(replay_session.speed_pct) / 100.0,
        replay_session.on_end,
        replay_session.completed_cycles + 1,
        kyiv(replay_session.window_from),
        kyiv(replay_session.window_to),
        kyiv(clock.position(now)),
        kyiv(replay_session.cursor_ts),
        replay_session.replayed_count,
        session::remaining_count(&replay_session),
        format_duration(clock.offset(now)),
        next,
        format_duration(clock.real_time_until(replay_session.window_to, now)),
    );
    Ok(())
}

fn kyiv(utc: NaiveDateTime) -> String {
    crate::config::get_tz()
        .from_utc_datetime(&utc)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn format_duration(duration: chrono::Duration) -> String {
    let seconds = duration.num_seconds().max(0);
    format!(
        "{}d {:02}:{:02}:{:02}",
        seconds / 86_400,
        seconds % 86_400 / 3_600,
        seconds % 3_600 / 60,
        seconds % 60
    )
}
