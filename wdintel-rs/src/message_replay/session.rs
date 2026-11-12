//! The single replay session row and its state transitions. Handlers lock
//! the row exclusively; the worker locks it with SKIP LOCKED, so a tick is
//! skipped instead of blocking while a control request is in flight.

use crate::entities::message_replay_session;
use crate::error::AppError;
use crate::h;
use crate::message_replay::clock::{ReplayClock, ReplayPlan};
use crate::message_replay::source::{self, SourceKey};
use crate::message_replay::types::{
    MessageReplayOnEnd, MessageReplaySessionRsp, MessageReplaySpeed,
    MessageReplayStatusRsp,
};
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::sea_query::{LockBehavior, LockType};
use sea_orm::*;

pub const STATE_RUNNING: &str = "running";
pub const STATE_PAUSED: &str = "paused";
pub const STATE_STOPPING: &str = "stopping";

pub fn now_utc() -> NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

pub async fn load<C>(
    dbx: &C,
) -> Result<Option<message_replay_session::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(message_replay_session::Entity::find()
        .one(dbx)
        .await
        .c(h!())?)
}

pub async fn lock_for_update(
    txn: &DatabaseTransaction,
) -> Result<Option<message_replay_session::Model>, AppError> {
    Ok(message_replay_session::Entity::find()
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?)
}

pub async fn lock_for_worker(
    txn: &DatabaseTransaction,
) -> Result<Option<message_replay_session::Model>, AppError> {
    Ok(message_replay_session::Entity::find()
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(txn)
        .await
        .c(h!())?)
}

pub fn cursor(session: &message_replay_session::Model) -> SourceKey {
    SourceKey {
        timestamp: session.cursor_ts,
        id: session.cursor_id,
    }
}

pub async fn insert_running(
    txn: &DatabaseTransaction,
    login_id: uuid::Uuid,
    plan: &ReplayPlan,
    on_end: &MessageReplayOnEnd,
    cycle_source_count: i64,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, DbErr> {
    message_replay_session::ActiveModel {
        id: NotSet,
        state: Set(STATE_RUNNING.to_string()),
        on_end: Set(on_end.as_str().to_string()),
        window_from: Set(plan.window_from),
        window_to: Set(plan.window_to),
        speed_pct: Set(plan.speed_pct),
        anchor_ts: Set(plan.start_position),
        anchor_at: Set(now),
        paused_at: Set(None),
        // Exclusive keyset start: `(ts, 0)` keeps sources at exactly `ts`.
        cursor_ts: Set(plan.first_replayed_ts()),
        cursor_id: Set(0),
        replayed_count: Set(0),
        completed_cycles: Set(0),
        cycle_source_count: Set(cycle_source_count),
        cycle_processed_count: Set(0),
        created_by_login_id: Set(login_id),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await
}

pub async fn pause(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    ensure_state(&session, STATE_RUNNING, "Відтворення не запущене")?;
    let clock = ReplayClock::from_session(&session).paused(now);
    update_clock(txn, session, STATE_PAUSED, clock, now).await
}

pub async fn resume(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    ensure_state(&session, STATE_PAUSED, "Відтворення не на паузі")?;
    let clock = ReplayClock::from_session(&session).resumed(now);
    update_clock(txn, session, STATE_RUNNING, clock, now).await
}

/// Re-anchors at the current position, so the position does not jump.
pub async fn set_speed(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    speed: &MessageReplaySpeed,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    if session.state == STATE_STOPPING {
        return Err(AppError::BL {
            msg: "Відтворення зупиняється".to_string(),
        });
    }
    let clock =
        ReplayClock::from_session(&session).with_speed(speed.pct(), now);
    let state = session.state.clone();
    update_clock(txn, session, &state, clock, now).await
}

async fn update_clock(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    state: &str,
    clock: ReplayClock,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    let mut session = session.into_active_model();
    session.state = Set(state.to_string());
    session.anchor_ts = Set(clock.anchor_ts);
    session.anchor_at = Set(clock.anchor_at);
    session.speed_pct = Set(clock.speed_pct);
    session.paused_at = Set(clock.paused_at);
    session.updated_at = Set(now);
    Ok(session.update(txn).await.c(h!())?)
}

/// The worker purges every replayed message, then deletes the session.
pub async fn stop(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    if session.state == STATE_STOPPING {
        return Ok(session);
    }
    let mut session = session.into_active_model();
    session.state = Set(STATE_STOPPING.to_string());
    session.updated_at = Set(now);
    Ok(session.update(txn).await.c(h!())?)
}

pub async fn advance_cursor(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    source: SourceKey,
    replayed: bool,
) -> Result<(), AppError> {
    let replayed_count = session.replayed_count + i64::from(replayed);
    let cycle_processed_count = session.cycle_processed_count + 1;
    let mut session = session.into_active_model();
    session.cursor_ts = Set(source.timestamp);
    session.cursor_id = Set(source.id);
    session.replayed_count = Set(replayed_count);
    session.cycle_processed_count = Set(cycle_processed_count);
    session.updated_at = Set(now_utc());
    session.update(txn).await.c(h!())?;
    Ok(())
}

/// The window was played to its end: rewinds to the window start for the
/// next cycle, running or paused according to `on_end`. The whole window
/// is counted once per cycle, so status polls can skip counting.
pub async fn rewind(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
    now: NaiveDateTime,
) -> Result<message_replay_session::Model, AppError> {
    let cycle_source_count = source::count_window(
        txn,
        session.window_from,
        session.window_to,
        session.window_from,
    )
    .await?
    .window_count;
    let pause = MessageReplayOnEnd::from_db(&session.on_end)
        == MessageReplayOnEnd::Pause;
    let clock = ReplayClock::from_session(&session).rewound(
        session.window_from,
        now,
        pause,
    );
    let window_from = session.window_from;
    let completed_cycles = session.completed_cycles + 1;
    let state = if pause { STATE_PAUSED } else { STATE_RUNNING };
    let mut session = update_clock(txn, session, state, clock, now)
        .await?
        .into_active_model();
    session.cursor_ts = Set(window_from);
    session.cursor_id = Set(0);
    session.completed_cycles = Set(completed_cycles);
    session.cycle_source_count = Set(cycle_source_count);
    session.cycle_processed_count = Set(0);
    Ok(session.update(txn).await.c(h!())?)
}

pub async fn delete(
    txn: &DatabaseTransaction,
    session: message_replay_session::Model,
) -> Result<(), AppError> {
    session.into_active_model().delete(txn).await.c(h!())?;
    Ok(())
}

fn ensure_state(
    session: &message_replay_session::Model,
    expected: &str,
    msg: &str,
) -> Result<(), AppError> {
    if session.state == expected {
        return Ok(());
    }
    Err(AppError::BL {
        msg: msg.to_string(),
    })
}

/// Polled every few seconds by every open admin tab, so it never counts a
/// whole window or every stored replay of a running session: the cycle
/// counts are kept on the session row, and stored replays are counted only
/// with no session (leftovers, normally none) or while stopping (the purge
/// progress, shrinking batch by batch).
pub async fn status<C>(dbx: &C) -> Result<MessageReplayStatusRsp, AppError>
where
    C: ConnectionTrait,
{
    let session = load(dbx).await?;
    let stored_replay_count = match &session {
        Some(session) if session.state != STATE_STOPPING => None,
        _ => Some(source::count_stored_replays(dbx).await?),
    };
    let session = match session {
        Some(session) => Some(session_rsp(dbx, session).await?),
        None => None,
    };
    Ok(MessageReplayStatusRsp {
        session,
        stored_replay_count,
    })
}

/// Sources left in the current cycle, from the counts on the session row.
pub fn remaining_count(session: &message_replay_session::Model) -> i64 {
    // `Ord::max`: sea_orm's `ExprTrait::max` is in scope too.
    Ord::max(
        session.cycle_source_count - session.cycle_processed_count,
        0,
    )
}

async fn session_rsp<C>(
    dbx: &C,
    session: message_replay_session::Model,
) -> Result<MessageReplaySessionRsp, AppError>
where
    C: ConnectionTrait,
{
    let now = now_utc();
    let clock = ReplayClock::from_session(&session);
    let next_due_ts =
        source::next_due_source(dbx, cursor(&session), session.window_to)
            .await?
            .map(|next| next.timestamp);
    let remaining = remaining_count(&session);
    Ok(MessageReplaySessionRsp {
        id: session.id,
        state: session.state,
        on_end: MessageReplayOnEnd::from_db(&session.on_end),
        speed: MessageReplaySpeed::from_pct(session.speed_pct),
        completed_cycles: session.completed_cycles,
        window_from_ms: to_ms(session.window_from),
        window_to_ms: to_ms(session.window_to),
        anchor_ts_ms: to_ms(session.anchor_ts),
        anchor_at_ms: to_ms(session.anchor_at),
        paused_at_ms: session.paused_at.map(to_ms),
        replay_position_ms: to_ms(clock.position(now)),
        offset_ms: clock.offset(now).num_milliseconds(),
        cursor_ms: to_ms(session.cursor_ts),
        replayed_count: session.replayed_count,
        remaining_count: remaining,
        next_message_ms: next_due_ts.map(to_ms),
        next_message_eta_ms: next_due_ts.map(|ts| clock.eta_ms(ts, now)),
        cycle_end_eta_ms: clock.eta_ms(session.window_to, now),
        created_at_ms: to_ms(session.created_at),
    })
}

pub fn to_ms(ts: NaiveDateTime) -> i64 {
    ts.and_utc().timestamp_millis()
}
