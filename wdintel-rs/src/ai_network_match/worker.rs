//! Single-instance queue worker; see README.md.

use super::context::{self, MatchContext};
use super::{inference, sql, NetworkMatchCandidate};
use crate::config::{
    AI_NETWORK_MATCH_MAX_CANDIDATES, AI_NETWORK_MATCH_WORKER_IDLE_SLEEP_MS,
    AI_NETWORK_MATCH_WORKER_LEASE_SECS, AI_NETWORK_MATCH_WORKER_LOCK,
    AI_NETWORK_MATCH_WORKER_MAX_ATTEMPTS, AI_NETWORK_MATCH_WORKER_NAME,
    AI_NETWORK_MATCH_WORKER_RETRY_BASE_SECS,
    AI_NETWORK_MATCH_WORKER_RETRY_MAX_SECS,
};
use crate::entities::{
    ai_engine, ai_network_match_worker_job, sigint_inbox_item, signal_message,
};
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// The callsign parsing worker's engines, so both use the same model.
pub(crate) struct Engines {
    pub primary: ai_engine::Model,
    pub fallback: Option<ai_engine::Model>,
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    loop {
        if cancellation_token.is_cancelled() {
            break;
        }
        if let Err(error) = run_leased(&env, &cancellation_token).await {
            error!("ai_network_match_worker lease failed: {error:#}");
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(AI_NETWORK_MATCH_WORKER_LEASE_SECS)) => {}
        }
    }
}

async fn run_leased(
    env: &Arc<Env>,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    let mut connection = env
        .dbx
        .get_postgres_connection_pool()
        .acquire()
        .await
        .c(h!())?;
    connection.close_on_drop();
    let acquired: bool = sqlx::query_scalar("select pg_try_advisory_lock($1)")
        .bind(AI_NETWORK_MATCH_WORKER_LOCK)
        .fetch_one(&mut *connection)
        .await
        .c(h!())?;
    if !acquired {
        return Ok(());
    }
    let heartbeat = async {
        loop {
            tokio::time::sleep(Duration::from_secs(
                AI_NETWORK_MATCH_WORKER_LEASE_SECS,
            ))
            .await;
            tokio::time::timeout(
                Duration::from_secs(AI_NETWORK_MATCH_WORKER_LEASE_SECS),
                sqlx::query("select 1").execute(&mut *connection),
            )
            .await
            .c(h!())?
            .c(h!())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! {
        _ = cancellation.cancelled() => Ok(()),
        result = heartbeat => result,
        _ = run_owned(env.clone(), cancellation.clone()) => Ok(())
    }
}

async fn run_owned(env: Arc<Env>, cancellation_token: CancellationToken) {
    let mut redis = env.redis.clone();
    info!("ai_network_match_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            info!("ai_network_match_worker received cancellation token");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("ai_network_match_worker");
        let processed =
            match process_next(&env.ai_engine_client, &env.dbx, &mut redis)
                .await
            {
                Ok(processed) => processed,
                Err(error) => {
                    error!("ai_network_match_worker failed: {error:#}");
                    false
                }
            };
        if processed {
            continue;
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(
                AI_NETWORK_MATCH_WORKER_IDLE_SLEEP_MS,
            )) => {}
        }
    }
}

/// `true` when a job was handled, so the loop continues without sleeping.
pub(crate) async fn process_next(
    ai_client: &crate::ai_engine::AiEngineClient,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> anyhow::Result<bool> {
    if !super::enabled(dbx).await.c(h!())? {
        return Ok(false);
    }
    let Some(engines) = load_engines(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let Some(job) = load_next_job(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let item_id = job.sigint_inbox_item_id;
    let Some(context) = load_context(dbx, item_id).await.c(h!())? else {
        delete_job(dbx, item_id).await.c(h!())?;
        return Ok(true);
    };
    let scored = score(ai_client, &engines, &context).await;
    let stored = match scored {
        Ok((candidates, engine_id)) => {
            complete(dbx, item_id, &context, candidates, engine_id).await
        }
        Err(error) => Err(error),
    };
    match stored {
        Ok(true) => fanout_changed(redis, item_id).await,
        Ok(false) => {}
        Err(error) => {
            fail_job(dbx, &job, &format!("{error:#}")).await.c(h!())?
        }
    }
    Ok(true)
}

pub(crate) async fn load_engines(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<Engines>> {
    let config = crate::ai_callsign::worker::load_worker_config(dbx)
        .await
        .c(h!())?;
    Ok(config.map(|config| Engines {
        primary: config.ai_engine,
        fallback: config.fallback_ai_engine,
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ai_network_match_worker_job::Model>> {
    ai_network_match_worker_job::Entity::find()
        .filter(
            ai_network_match_worker_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(ai_network_match_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_network_match_worker_job::Column::CreatedAt)
        .order_by_asc(ai_network_match_worker_job::Column::SigintInboxItemId)
        .one(dbx)
        .await
        .c(h!())
}

/// `None` when there is nothing to score: the message is gone, or it no
/// longer has a candidate set the worker scores.
async fn load_context(
    dbx: &DatabaseConnection,
    item_id: i64,
) -> anyhow::Result<Option<MatchContext>> {
    let network_ids =
        context::current_network_ids(dbx, item_id).await.c(h!())?;
    if !is_scored_set(&network_ids) {
        return Ok(None);
    }
    context::load(dbx, item_id, network_ids).await.c(h!())
}

fn is_scored_set(network_ids: &[i64]) -> bool {
    (2..=AI_NETWORK_MATCH_MAX_CANDIDATES).contains(&network_ids.len())
}

async fn score(
    ai_client: &crate::ai_engine::AiEngineClient,
    engines: &Engines,
    context: &MatchContext,
) -> anyhow::Result<(Vec<NetworkMatchCandidate>, Uuid)> {
    let (candidates, engine) = crate::ai_worker::with_fallback(
        AI_NETWORK_MATCH_WORKER_NAME,
        &engines.primary,
        engines.fallback.as_ref(),
        |engine| async move {
            inference::score(
                ai_client,
                &engine,
                &context.input,
                &context.network_ids,
            )
            .await
            .c(h!())
        },
    )
    .await
    .c(h!())?;
    Ok((candidates, engine.id))
}

/// Stores the scores if the message and its candidates did not change during
/// the model call; otherwise the job runs again on the current state.
/// `true` when scores were stored.
pub(super) async fn complete(
    dbx: &DatabaseConnection,
    item_id: i64,
    context: &MatchContext,
    candidates: Vec<NetworkMatchCandidate>,
    engine_id: Uuid,
) -> anyhow::Result<bool> {
    let transaction = dbx.begin().await.c(h!())?;
    if !lock_item_and_job(&transaction, item_id).await.c(h!())? {
        delete_job(&transaction, item_id).await.c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    if !is_current(&transaction, item_id, context).await.c(h!())? {
        reschedule_stale(&transaction, item_id).await.c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    save_result(&transaction, item_id, context, &candidates, engine_id)
        .await
        .c(h!())?;
    crate::ai_worker::record_success(
        &transaction,
        AI_NETWORK_MATCH_WORKER_NAME,
        item_id,
    )
    .await
    .c(h!())?;
    delete_job(&transaction, item_id).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(true)
}

/// Item first, then job: the order network recalculation uses when it
/// queues a job under an item lock. `false` when either is gone.
async fn lock_item_and_job(
    transaction: &DatabaseTransaction,
    item_id: i64,
) -> anyhow::Result<bool> {
    let item = sigint_inbox_item::Entity::find_by_id(item_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .c(h!())?;
    let job = ai_network_match_worker_job::Entity::find_by_id(item_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .c(h!())?;
    Ok(item.is_some() && job.is_some())
}

async fn is_current(
    transaction: &DatabaseTransaction,
    item_id: i64,
    context: &MatchContext,
) -> anyhow::Result<bool> {
    let message = signal_message::Entity::find_by_id(item_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(transaction)
        .await
        .c(h!())?;
    let Some(message) = message else {
        return Ok(false);
    };
    let body_md5 =
        context::body_md5(message.body.as_deref().unwrap_or_default());
    let network_ids = context::current_network_ids(transaction, item_id)
        .await
        .c(h!())?;
    Ok(body_md5 == context.body_md5 && network_ids == context.network_ids)
}

/// Runs the job again right away without counting an attempt; a later pick
/// drops it if the message no longer has a scored candidate set.
async fn reschedule_stale(
    transaction: &DatabaseTransaction,
    item_id: i64,
) -> anyhow::Result<()> {
    transaction
        .execute_raw(sql(
            "update ai_network_match_worker_job set next_attempt_at = now() at time zone 'utc' where sigint_inbox_item_id = $1",
            vec![item_id.into()],
        ))
        .await
        .c(h!())?;
    Ok(())
}

async fn save_result(
    transaction: &DatabaseTransaction,
    item_id: i64,
    context: &MatchContext,
    candidates: &[NetworkMatchCandidate],
    engine_id: Uuid,
) -> anyhow::Result<()> {
    let certainties = serde_json::to_value(candidates).c(h!())?;
    transaction
        .execute_raw(sql(
            "insert into ai_network_match_result (sigint_inbox_item_id, candidate_network_ids, body_md5, certainties, ai_engine_id) values ($1, $2, $3, $4, $5) on conflict (sigint_inbox_item_id) do update set candidate_network_ids = excluded.candidate_network_ids, body_md5 = excluded.body_md5, certainties = excluded.certainties, ai_engine_id = excluded.ai_engine_id, created_at = now() at time zone 'utc'",
            vec![
                item_id.into(),
                context.network_ids.clone().into(),
                context.body_md5.clone().into(),
                certainties.into(),
                engine_id.into(),
            ],
        ))
        .await
        .c(h!())?;
    Ok(())
}

async fn fail_job(
    dbx: &DatabaseConnection,
    job: &ai_network_match_worker_job::Model,
    error_text: &str,
) -> anyhow::Result<()> {
    let item_id = job.sigint_inbox_item_id;
    let error_text = crate::ai_worker::bounded_error(error_text);
    let attempts = job.attempts + 1;
    let transaction = dbx.begin().await.c(h!())?;
    crate::ai_worker::record_failure(
        &transaction,
        AI_NETWORK_MATCH_WORKER_NAME,
        &item_id.to_string(),
        &error_text,
    )
    .await
    .c(h!())?;
    if attempts >= AI_NETWORK_MATCH_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_network_match_worker dropped message_id={item_id} after {attempts} attempts: {error_text}"
        );
        delete_job(&transaction, item_id).await.c(h!())?;
    } else {
        let next_attempt_at = Utc::now().naive_utc()
            + ChronoDuration::seconds(retry_delay_secs(attempts));
        transaction
            .execute_raw(sql(
                "update ai_network_match_worker_job set attempts = $2, next_attempt_at = $3, last_error = $4 where sigint_inbox_item_id = $1",
                vec![
                    item_id.into(),
                    attempts.into(),
                    next_attempt_at.into(),
                    error_text.into(),
                ],
            ))
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) fn retry_delay_secs(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1)).unwrap_or(0);
    AI_NETWORK_MATCH_WORKER_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AI_NETWORK_MATCH_WORKER_RETRY_MAX_SECS)
}

async fn delete_job<C: ConnectionTrait>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<()> {
    ai_network_match_worker_job::Entity::delete_by_id(item_id)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn fanout_changed(
    redis: &mut redis::aio::ConnectionManager,
    item_id: i64,
) {
    let events = vec![EventMsg::new(EventType::ETInboxChanged(item_id))];
    if let Err(error) = fanout_mult(redis, events).await {
        error!(
            "ai_network_match_worker failed to fanout message_id={item_id}: {error:#?}"
        );
    }
}
