use super::effective_prompt;
use crate::config::{
    AI_CALLSIGN_SETTINGS_ID, AI_CALLSIGN_WORKER_CONCURRENCY,
    AI_CALLSIGN_WORKER_IDLE_SLEEP_MS, AI_CALLSIGN_WORKER_MAX_ATTEMPTS,
    AI_CALLSIGN_WORKER_MAX_ERROR_CHARS, AI_CALLSIGN_WORKER_RETRY_BASE_SECS,
    AI_CALLSIGN_WORKER_RETRY_MAX_SECS,
};
use crate::entities::{
    ai_callsign_settings, ai_callsign_worker_job, ai_engine, sigint_inbox_item,
    signal_message,
};
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use anyhow::Context;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, IntoActiveModel,
    QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct WorkerConfig {
    pub prompt: String,
    pub ai_engine: ai_engine::Model,
    pub fallback_ai_engine: Option<ai_engine::Model>,
}

#[derive(Clone, Copy)]
pub(crate) enum CompletionSource {
    Queue(chrono::NaiveDateTime),
    Reparse(Uuid),
}

struct CallsignJobState {
    inbox_item: sigint_inbox_item::Model,
    current: Vec<String>,
    suggested: Vec<String>,
}

struct HighlightedCallsigns {
    callsigns: Vec<String>,
    callsign_tokens: serde_json::Value,
}

pub async fn enqueue_if_enabled<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
    sigint_inbox_item_uuid: Option<Uuid>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if !worker_enabled(dbx).await.c(h!())? {
        return Ok(());
    }
    dbx.execute_raw(super::feedback::sql(
        "insert into ai_callsign_worker_job (sigint_inbox_item_id, sigint_inbox_item_uuid) values ($1, $2) on conflict (sigint_inbox_item_id) do update set created_at = greatest(now() at time zone 'utc', ai_callsign_worker_job.created_at + interval '1 microsecond'), attempts = 0, next_attempt_at = now() at time zone 'utc', last_error = null",
        vec![sigint_inbox_item_id.into(), sigint_inbox_item_uuid.into()],
    )).await.c(h!())?;
    Ok(())
}

/// Enabled with an engine chosen; the AI network match worker uses the same
/// engines.
pub(crate) async fn worker_enabled<C: ConnectionTrait>(
    dbx: &C,
) -> anyhow::Result<bool> {
    Ok(
        ai_callsign_settings::Entity::find_by_id(AI_CALLSIGN_SETTINGS_ID)
            .filter(ai_callsign_settings::Column::WorkerEnabled.eq(true))
            .filter(
                ai_callsign_settings::Column::WorkerAiEngineId.is_not_null(),
            )
            .one(dbx)
            .await
            .c(h!())?
            .is_some(),
    )
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    loop {
        if cancellation_token.is_cancelled() {
            break;
        }
        if let Err(error) = run_leased(&env, &cancellation_token).await {
            error!("ai_callsign_worker lease failed: {error:#}");
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(crate::config::AI_CALLSIGN_WORKER_LEASE_SECS)) => {}
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
        .bind(crate::config::AI_CALLSIGN_WORKER_LOCK)
        .fetch_one(&mut *connection)
        .await
        .c(h!())?;
    if !acquired {
        return Ok(());
    }
    let heartbeat = async {
        loop {
            tokio::time::sleep(Duration::from_secs(
                crate::config::AI_CALLSIGN_WORKER_LEASE_SECS,
            ))
            .await;
            tokio::time::timeout(
                Duration::from_secs(
                    crate::config::AI_CALLSIGN_WORKER_LEASE_SECS,
                ),
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

/// Jobs this lease owner's parsers are working on, so no two parsers take the
/// same message. The advisory lock makes this process the only owner.
#[derive(Default)]
struct JobClaims(tokio::sync::Mutex<HashSet<i64>>);

impl JobClaims {
    async fn claim_next(
        &self,
        dbx: &DatabaseConnection,
    ) -> Result<Option<ai_callsign_worker_job::Model>, AppError> {
        let mut claimed = self.0.lock().await;
        let job = load_next_job(dbx, &claimed).await.c(h!())?;
        if let Some(job) = &job {
            claimed.insert(job.sigint_inbox_item_id);
        }
        Ok(job)
    }

    async fn release(&self, sigint_inbox_item_id: i64) {
        self.0.lock().await.remove(&sigint_inbox_item_id);
    }
}

async fn run_owned(env: Arc<Env>, cancellation_token: CancellationToken) {
    info!(
        "ai_callsign_worker started with {AI_CALLSIGN_WORKER_CONCURRENCY} parsers"
    );
    let claims = JobClaims::default();
    futures::future::join_all((0..AI_CALLSIGN_WORKER_CONCURRENCY).map(
        |parser| run_parser(&env, &cancellation_token, &claims, parser == 0),
    ))
    .await;
    info!("ai_callsign_worker received cancellation token");
}

/// One parser loop. Only the first runs the reparse sweep, which keeps its
/// own cursor.
async fn run_parser(
    env: &Env,
    cancellation_token: &CancellationToken,
    claims: &JobClaims,
    runs_reparse: bool,
) {
    let mut redis = env.redis.clone();
    while !cancellation_token.is_cancelled() {
        let _loop_guard = worker_watch::loop_guard("ai_callsign_worker");
        let processed = match process_next(
            &env.ai_engine_client,
            &env.dbx,
            &env.rq,
            &mut redis,
            claims,
        )
        .await
        {
            Ok(processed) => processed,
            Err(error) => {
                error!("ai_callsign_worker failed: {error:#?}");
                false
            }
        };
        let reprocessed = runs_reparse
            && match super::reparse::tick(env).await {
                Ok(processed) => processed,
                Err(error) => {
                    error!("ai_callsign_reparse failed: {error:#}");
                    false
                }
            };
        if processed || reprocessed {
            continue;
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(
                AI_CALLSIGN_WORKER_IDLE_SLEEP_MS,
            )) => {}
        }
    }
}

async fn process_next(
    ai_client: &crate::ai_engine::AiEngineClient,
    dbx: &DatabaseConnection,
    rq: &reqwest::Client,
    redis: &mut redis::aio::ConnectionManager,
    claims: &JobClaims,
) -> Result<bool, AppError> {
    let Some(config) = load_worker_config(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let Some(job) = claims.claim_next(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let sigint_inbox_item_id = job.sigint_inbox_item_id;
    let result = process_job(ai_client, dbx, rq, redis, &config, job).await;
    claims.release(sigint_inbox_item_id).await;
    result.c(h!())?;
    Ok(true)
}

async fn process_job(
    ai_client: &crate::ai_engine::AiEngineClient,
    dbx: &DatabaseConnection,
    rq: &reqwest::Client,
    redis: &mut redis::aio::ConnectionManager,
    config: &WorkerConfig,
    job: ai_callsign_worker_job::Model,
) -> Result<(), AppError> {
    let message = signal_message::Entity::find_by_id(job.sigint_inbox_item_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?;
    let Some(message) = message else {
        delete_job(dbx, job.sigint_inbox_item_id, job.created_at)
            .await
            .c(h!())?;
        return Ok(());
    };
    let is_aviation_group =
        crate::inbox::message_is_aviation_group(dbx, &message)
            .await
            .c(h!())?;
    let body = message.body.unwrap_or_default();
    let callsigns = match parse_with_config(
        ai_client,
        dbx,
        rq,
        config,
        &body,
        is_aviation_group,
    )
    .await
    {
        Ok(callsigns) => callsigns,
        Err(error) => {
            fail_job(dbx, job, format!("{error:#}")).await.c(h!())?;
            return Ok(());
        }
    };
    let ai_callsigns = normalize_callsigns(callsigns);
    let changed = match complete_job(
        dbx,
        rq,
        job.sigint_inbox_item_id,
        &body,
        ai_callsigns,
        CompletionSource::Queue(job.created_at),
    )
    .await
    {
        Ok(changed) => changed,
        Err(error) => {
            fail_job(dbx, job, format!("{error:#}")).await.c(h!())?;
            return Ok(());
        }
    };
    if changed {
        if let Err(error) = fanout_mult(
            redis,
            vec![EventMsg::new(EventType::ETInboxChanged(
                job.sigint_inbox_item_id,
            ))],
        )
        .await
        {
            error!(
                "ai_callsign_worker failed to fanout completed message_id={}: {error:#?}",
                job.sigint_inbox_item_id
            );
        }
    }
    Ok(())
}

pub(crate) async fn parse_with_config<C: ConnectionTrait>(
    ai_client: &crate::ai_engine::AiEngineClient,
    db: &C,
    rq: &reqwest::Client,
    config: &WorkerConfig,
    body: &str,
    is_aviation_group: bool,
) -> anyhow::Result<Vec<String>> {
    let (callsigns, _) = crate::ai_worker::with_fallback(
        "callsign",
        &config.ai_engine,
        config.fallback_ai_engine.as_ref(),
        |engine| async move {
            super::parse_with_feedback(
                ai_client,
                db,
                rq,
                &engine,
                &config.prompt,
                body,
                is_aviation_group,
            )
            .await
            .c(h!())
        },
    )
    .await
    .c(h!())?;
    Ok(callsigns)
}

pub(crate) async fn load_worker_config(
    dbx: &DatabaseConnection,
) -> Result<Option<WorkerConfig>, AppError> {
    let settings =
        ai_callsign_settings::Entity::find_by_id(AI_CALLSIGN_SETTINGS_ID)
            .filter(ai_callsign_settings::Column::WorkerEnabled.eq(true))
            .one(dbx)
            .await
            .c(h!())?;
    let Some(settings) = settings else {
        return Ok(None);
    };
    let Some(ai_engine_id) = settings.worker_ai_engine_id else {
        return Err(AppError::BL {
            msg: "Для ШІ-воркера позивних не вибрано движок".to_string(),
        });
    };
    let ai_engine = ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "ШІ движок воркера позивних вимкнено або видалено".to_string(),
        })?;
    let fallback_ai_engine = crate::ai_worker::load_fallback(
        dbx,
        ai_engine.id,
        settings.worker_fallback_ai_engine_id,
    )
    .await
    .c(h!())?;
    Ok(Some(WorkerConfig {
        fallback_ai_engine,
        prompt: effective_prompt(&settings.prompt).to_string(),
        ai_engine,
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
    claimed: &HashSet<i64>,
) -> Result<Option<ai_callsign_worker_job::Model>, AppError> {
    Ok(ai_callsign_worker_job::Entity::find()
        .filter(
            ai_callsign_worker_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .filter(
            ai_callsign_worker_job::Column::SigintInboxItemId
                .is_not_in(claimed.iter().copied()),
        )
        .order_by_asc(ai_callsign_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_callsign_worker_job::Column::CreatedAt)
        .order_by_asc(ai_callsign_worker_job::Column::SigintInboxItemId)
        .one(dbx)
        .await
        .c(h!())?)
}

pub(crate) async fn complete_job(
    dbx: &DatabaseConnection,
    rq: &reqwest::Client,
    sigint_inbox_item_id: i64,
    body: &str,
    ai_callsigns: Vec<String>,
    source: CompletionSource,
) -> anyhow::Result<bool> {
    let run_id = match source {
        CompletionSource::Reparse(run_id) => Some(run_id),
        CompletionSource::Queue(_) => None,
    };
    let desired = super::feedback::apply_overrides(
        dbx,
        sigint_inbox_item_id,
        ai_callsigns.clone(),
    )
    .await
    .c(h!())?;
    let mut highlighted = highlight_callsigns(rq, body, desired, &[])
        .await
        .context(h!())?;
    loop {
        let transaction = dbx.begin().await.c(h!())?;
        if let Some(run_id) = run_id {
            let active = transaction.query_one_raw(super::feedback::sql("select id from ai_callsign_reparse_run where id = $1 and state = 'running' for update", vec![run_id.into()])).await.c(h!())?;
            if active.is_none() {
                return Ok(false);
            }
        }
        let Some(state) =
            lock_callsign_job_state(&transaction, sigint_inbox_item_id)
                .await
                .context(h!())?
        else {
            if let CompletionSource::Queue(created_at) = source {
                delete_job(&transaction, sigint_inbox_item_id, created_at)
                    .await
                    .c(h!())?;
            }
            transaction.commit().await.c(h!())?;
            return Ok(false);
        };
        let message = signal_message::Entity::find_by_id(sigint_inbox_item_id)
            .lock_exclusive()
            .one(&transaction)
            .await
            .c(h!())?
            .c(h!())?;
        anyhow::ensure!(
            !message.deleted
                && message.body.as_deref().unwrap_or_default() == body,
            "Message changed during callsign parsing"
        );
        if let CompletionSource::Queue(created_at) = source {
            if !lock_current_job(&transaction, sigint_inbox_item_id, created_at)
                .await
                .c(h!())?
            {
                transaction.commit().await.c(h!())?;
                return Ok(false);
            }
        }
        let callsigns = super::feedback::apply_overrides(
            &transaction,
            sigint_inbox_item_id,
            ai_callsigns.clone(),
        )
        .await
        .c(h!())?;
        if callsigns != highlighted.callsigns {
            transaction.commit().await.c(h!())?;
            highlighted = highlight_callsigns(rq, body, callsigns, &[])
                .await
                .context(h!())?;
            continue;
        }
        let changed = save_completed_job(
            &transaction,
            sigint_inbox_item_id,
            state,
            highlighted,
        )
        .await
        .context(h!())?;
        record_completion(&transaction, sigint_inbox_item_id, source, changed)
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(changed);
    }
}

async fn record_completion(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
    source: CompletionSource,
    changed: bool,
) -> anyhow::Result<()> {
    match source {
        CompletionSource::Queue(created_at) => {
            crate::ai_worker::record_success(
                transaction,
                "callsign",
                sigint_inbox_item_id,
            )
            .await
            .c(h!())?;
            delete_job(transaction, sigint_inbox_item_id, created_at)
                .await
                .c(h!())?;
        }
        CompletionSource::Reparse(run_id) => {
            super::reparse::record_success(
                transaction,
                run_id,
                sigint_inbox_item_id,
                if changed { "changed" } else { "unchanged" },
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn lock_callsign_job_state(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
) -> Result<Option<CallsignJobState>, AppError> {
    let Some(inbox_item) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .lock_exclusive()
            .one(transaction)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let current_callsigns = crate::inbox::callsigns::load_by_item_ids(
        transaction,
        &[sigint_inbox_item_id],
    )
    .await
    .context(h!())?
    .remove(&sigint_inbox_item_id)
    .unwrap_or_default();
    Ok(Some(CallsignJobState {
        inbox_item,
        current: normalize_callsigns(current_callsigns.primary),
        suggested: current_callsigns.alg2,
    }))
}

async fn highlight_callsigns(
    rq: &reqwest::Client,
    body: &str,
    current: Vec<String>,
    ai_callsigns: &[String],
) -> Result<HighlightedCallsigns, AppError> {
    let callsigns =
        merge_current_and_ai_callsigns(current, ai_callsigns.to_vec());
    let callsign_tokens = if callsigns.is_empty() {
        vec![]
    } else {
        crate::rer_importer::callsigns::highlight_callsigns(
            rq, body, &callsigns,
        )
        .await
        .c(h!())?
    };
    let callsign_tokens = serde_json::to_value(callsign_tokens).c(h!())?;
    Ok(HighlightedCallsigns {
        callsigns,
        callsign_tokens,
    })
}

async fn save_completed_job(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
    state: CallsignJobState,
    highlighted: HighlightedCallsigns,
) -> Result<bool, AppError> {
    let callsigns_changed = highlighted.callsigns != state.current;
    let should_update_callsign_tokens =
        state.inbox_item.callsign_tokens.as_ref()
            != Some(&highlighted.callsign_tokens);
    let changed = callsigns_changed
        || should_update_callsign_tokens
        || !state.suggested.is_empty();
    if changed {
        let sigint_inbox_item_uuid = state.inbox_item.id_uuid;
        if should_update_callsign_tokens {
            let mut inbox_item = state.inbox_item.into_active_model();
            inbox_item.callsign_tokens = Set(Some(highlighted.callsign_tokens));
            inbox_item.update(transaction).await.c(h!())?;
        }
        let system_login_id =
            crate::users::system_login_id(transaction).await.c(h!())?;
        crate::inbox::callsigns::sync(
            transaction,
            sigint_inbox_item_id,
            sigint_inbox_item_uuid,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: highlighted.callsigns,
                alg2: vec![],
            },
            system_login_id,
        )
        .await
        .c(h!())?;
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
                .one(transaction)
                .await
                .c(h!())?
                .c(h!())?;
        crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(vec![inbox_item], transaction).await.c(h!())?;
        crate::stats::enqueue_group_stats_recalculation_for_message(
            transaction,
            sigint_inbox_item_id,
            format!("callsign feedback update {sigint_inbox_item_id}"),
        )
        .await
        .c(h!())?;
    }
    Ok(changed)
}

async fn fail_job(
    dbx: &DatabaseConnection,
    job: ai_callsign_worker_job::Model,
    error_text: String,
) -> Result<(), AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    if !lock_current_job(&transaction, job.sigint_inbox_item_id, job.created_at)
        .await
        .c(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    let attempts = job.attempts + 1;
    let error_text = truncate_error(error_text);
    crate::ai_worker::record_failure(
        &transaction,
        "callsign",
        &job.sigint_inbox_item_id.to_string(),
        &error_text,
    )
    .await
    .c(h!())?;
    if attempts >= AI_CALLSIGN_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_callsign_worker dropped message_id={} after {} attempts: {}",
            job.sigint_inbox_item_id, attempts, error_text
        );
        delete_job(&transaction, job.sigint_inbox_item_id, job.created_at)
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    transaction.execute_raw(super::feedback::sql("update ai_callsign_worker_job set attempts = $3, next_attempt_at = $4, last_error = $5 where sigint_inbox_item_id = $1 and created_at = $2", vec![job.sigint_inbox_item_id.into(), job.created_at.into(), attempts.into(), (Utc::now().naive_utc() + ChronoDuration::seconds(retry_delay_secs(attempts))).into(), error_text.into()])).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn lock_current_job(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
    created_at: chrono::NaiveDateTime,
) -> anyhow::Result<bool> {
    let current =
        ai_callsign_worker_job::Entity::find_by_id(sigint_inbox_item_id)
            .lock_exclusive()
            .one(transaction)
            .await
            .c(h!())?;
    Ok(current.is_some_and(|job| job.created_at == created_at))
}

async fn delete_job<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
    created_at: chrono::NaiveDateTime,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    ai_callsign_worker_job::Entity::delete_many()
        .filter(
            ai_callsign_worker_job::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .filter(ai_callsign_worker_job::Column::CreatedAt.eq(created_at))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) fn normalize_callsigns(callsigns: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for callsign in callsigns {
        let callsign = callsign.trim().to_lowercase();
        if !callsign.is_empty() && seen.insert(callsign.clone()) {
            normalized.push(callsign);
        }
    }
    normalized
}

pub(crate) fn merge_current_and_ai_callsigns(
    current: Vec<String>,
    ai_callsigns: Vec<String>,
) -> Vec<String> {
    normalize_callsigns(
        current.into_iter().chain(ai_callsigns).collect::<Vec<_>>(),
    )
}

pub(crate) fn retry_delay_secs(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1)).unwrap_or(0);
    AI_CALLSIGN_WORKER_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AI_CALLSIGN_WORKER_RETRY_MAX_SECS)
}

fn truncate_error(error: String) -> String {
    error
        .chars()
        .take(AI_CALLSIGN_WORKER_MAX_ERROR_CHARS)
        .collect()
}

#[cfg(test)]
#[path = "worker/fallback_tests.rs"]
mod fallback_tests;

#[cfg(test)]
mod tests {
    use super::{
        merge_current_and_ai_callsigns, normalize_callsigns, retry_delay_secs,
    };

    #[test]
    fn normalizes_ai_callsigns_for_replacement() {
        assert_eq!(
            normalize_callsigns(vec![
                " ALPHA ".to_string(),
                "BRAVO".to_string(),
                "alpha".to_string(),
                "".to_string()
            ]),
            vec!["alpha", "bravo"]
        );
    }

    #[test]
    fn merges_ai_callsigns_without_removing_current_primary() {
        assert_eq!(
            merge_current_and_ai_callsigns(
                vec!["44408".to_string(), "саксофон".to_string()],
                vec!["саксофон".to_string(), "двор".to_string()],
            ),
            vec!["44408", "саксофон", "двор"]
        );
    }

    #[test]
    fn caps_retry_delay() {
        assert_eq!(retry_delay_secs(1), 5);
        assert_eq!(retry_delay_secs(2), 10);
        assert_eq!(retry_delay_secs(20), 300);
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn stale_completion_and_failure_do_not_consume_reenqueued_work() {
        use super::*;
        use crate::ai_callsign::feedback::sql;
        let env = crate::functest::tests::cleanup().await.unwrap();
        let item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let engine_id = Uuid::new_v4();
        env.dbx.execute_raw(sql("insert into ai_engine (id, name, url, model_name) values ($1, $2, 'http://127.0.0.1:1', 'fixture')", vec![engine_id.into(), engine_id.to_string().into()])).await.unwrap();
        env.dbx.execute_raw(sql("insert into ai_callsign_settings (id, prompt, worker_enabled, worker_ai_engine_id) values (1, '', true, $1) on conflict (id) do update set worker_enabled = true, worker_ai_engine_id = $1", vec![engine_id.into()])).await.unwrap();
        enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
            .await
            .unwrap();
        let old = load_next_job(&env.dbx, &HashSet::new())
            .await
            .unwrap()
            .unwrap();
        let body = signal_message::Entity::find_by_id(item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .body
            .unwrap_or_default();
        enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
            .await
            .unwrap();
        let new = load_next_job(&env.dbx, &HashSet::new())
            .await
            .unwrap()
            .unwrap();
        assert!(new.created_at > old.created_at);
        assert!(!complete_job(
            &env.dbx,
            &env.rq,
            item.id,
            &body,
            vec![],
            CompletionSource::Queue(old.created_at),
        )
        .await
        .unwrap());
        delete_job(&env.dbx, old.sigint_inbox_item_id, old.created_at)
            .await
            .unwrap();
        fail_job(&env.dbx, old, "stale failure".into())
            .await
            .unwrap();
        let pending = load_next_job(&env.dbx, &HashSet::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.created_at, new.created_at);
        assert_eq!(pending.attempts, 0);
        assert!(crate::entities::ai_worker_progress::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        delete_job(&env.dbx, new.sigint_inbox_item_id, new.created_at)
            .await
            .unwrap();
        assert!(load_next_job(&env.dbx, &HashSet::new())
            .await
            .unwrap()
            .is_none());
        assert!(!complete_job(
            &env.dbx,
            &env.rq,
            item.id,
            &body,
            vec![],
            CompletionSource::Queue(new.created_at),
        )
        .await
        .unwrap());
        assert!(crate::entities::ai_worker_progress::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        ai_engine::Entity::delete_by_id(engine_id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    // Regression: https://github.com/echoua/echo/issues/4123
    #[tokio::test]
    #[serial_test::serial]
    async fn issue_4123_parsers_claim_distinct_jobs() {
        use super::*;
        use crate::ai_callsign::feedback::sql;
        let env = crate::functest::tests::cleanup().await.unwrap();
        let mut items = vec![];
        for _ in 0..2 {
            items.push(
                crate::functest::tests::mk_sigint_inbox_item(
                    &env.dbx,
                    Default::default(),
                )
                .await
                .unwrap(),
            );
        }
        let engine_id = Uuid::new_v4();
        env.dbx.execute_raw(sql("insert into ai_engine (id, name, url, model_name) values ($1, $2, 'http://127.0.0.1:1', 'fixture')", vec![engine_id.into(), engine_id.to_string().into()])).await.unwrap();
        env.dbx.execute_raw(sql("insert into ai_callsign_settings (id, prompt, worker_enabled, worker_ai_engine_id) values (1, '', true, $1) on conflict (id) do update set worker_enabled = true, worker_ai_engine_id = $1", vec![engine_id.into()])).await.unwrap();
        for item in &items {
            enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
                .await
                .unwrap();
        }
        let claims = JobClaims::default();
        let first = claims.claim_next(&env.dbx).await.unwrap().unwrap();
        let second = claims.claim_next(&env.dbx).await.unwrap().unwrap();
        assert_ne!(first.sigint_inbox_item_id, second.sigint_inbox_item_id);
        assert!(claims.claim_next(&env.dbx).await.unwrap().is_none());
        claims.release(first.sigint_inbox_item_id).await;
        let again = claims.claim_next(&env.dbx).await.unwrap().unwrap();
        assert_eq!(again.sigint_inbox_item_id, first.sigint_inbox_item_id);
        for job in [first, second] {
            delete_job(&env.dbx, job.sigint_inbox_item_id, job.created_at)
                .await
                .unwrap();
        }
        ai_engine::Entity::delete_by_id(engine_id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }
}
