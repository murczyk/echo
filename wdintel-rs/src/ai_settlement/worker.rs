use super::{effective_prompt, groups::GroupFilter, parse_settlements};
use crate::ai_engine::{request_ai_response, AiEngineMessage};
use crate::config::{
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER, AI_SETTLEMENT_SETTINGS_ID,
    AI_SETTLEMENT_WORKER_IDLE_SLEEP_MS, AI_SETTLEMENT_WORKER_MAX_ATTEMPTS,
    AI_SETTLEMENT_WORKER_MAX_ERROR_CHARS, AI_SETTLEMENT_WORKER_RETRY_BASE_SECS,
    AI_SETTLEMENT_WORKER_RETRY_MAX_SECS, AI_SETTLEMENT_WORKER_SETTINGS_CHANNEL,
};
use crate::entities::{
    ai_engine, ai_settlement_settings, ai_settlement_worker_job,
    sigint_inbox_item, signal_message,
};
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use anyhow::Context;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct WorkerConfig {
    pub prompt: String,
    pub ai_engine: ai_engine::Model,
    fallback_ai_engine: Option<ai_engine::Model>,
    settings_updated_at: chrono::NaiveDateTime,
    group_filter: GroupFilter,
}

pub async fn enqueue_if_enabled<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let settings =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .filter(ai_settlement_settings::Column::WorkerEnabled.eq(true))
            .filter(
                ai_settlement_settings::Column::WorkerAiEngineId.is_not_null(),
            )
            .one(dbx)
            .await
            .c(h!())?;
    let Some(settings) = settings else {
        return Ok(());
    };
    if !GroupFilter::from_settings(&settings)
        .allows(dbx, sigint_inbox_item_id)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    ai_settlement_worker_job::Entity::insert(
        ai_settlement_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            attempts: NotSet,
            next_attempt_at: NotSet,
            last_error: NotSet,
            created_at: NotSet,
        },
    )
    .on_conflict(
        OnConflict::column(ai_settlement_worker_job::Column::SigintInboxItemId)
            .update_columns([
                ai_settlement_worker_job::Column::Attempts,
                ai_settlement_worker_job::Column::NextAttemptAt,
                ai_settlement_worker_job::Column::LastError,
            ])
            .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    info!("ai_settlement_worker started");
    while !cancellation_token.is_cancelled() {
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            result = run_with_settings_listener(&env, &cancellation_token) => {
                if let Err(error) = result {
                    error!("ai_settlement_worker listener failed: {error:#}");
                }
            }
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(AI_SETTLEMENT_WORKER_IDLE_SLEEP_MS)) => {}
        }
    }
}

async fn run_with_settings_listener(
    env: &Env,
    cancellation_token: &CancellationToken,
) -> anyhow::Result<()> {
    let mut listener = sqlx::postgres::PgListener::connect_with(
        env.dbx.get_postgres_connection_pool(),
    )
    .await
    .c(h!())?;
    listener
        .listen(AI_SETTLEMENT_WORKER_SETTINGS_CHANNEL)
        .await
        .c(h!())?;
    let mut redis = env.redis.clone();
    loop {
        let _loop_guard = worker_watch::loop_guard("ai_settlement_worker");
        let processed = tokio::select! {
            biased;
            _ = cancellation_token.cancelled() => return Ok(()),
            notification = listener.try_recv() => {
                notification.c(h!())?;
                info!("ai_settlement_worker restarted after settings change or listener reconnection");
                continue;
            }
            result = process_next(&env.ai_engine_client, &env.dbx, &mut redis) => match result {
                Ok(processed) => processed,
                Err(error) => {
                    error!("ai_settlement_worker failed: {error:#?}");
                    false
                }
            }
        };
        if processed {
            continue;
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => return Ok(()),
            notification = listener.try_recv() => { notification.c(h!())?; }
            _ = tokio::time::sleep(Duration::from_millis(
                AI_SETTLEMENT_WORKER_IDLE_SLEEP_MS,
            )) => {}
        }
    }
}

async fn process_next(
    ai_client: &crate::ai_engine::AiEngineClient,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> Result<bool, AppError> {
    let Some(config) = load_worker_config(dbx).await.context(h!())? else {
        return Ok(false);
    };
    let Some(job) = load_next_job(dbx, &config.group_filter)
        .await
        .context(h!())?
    else {
        return Ok(false);
    };
    let message = signal_message::Entity::find_by_id(job.sigint_inbox_item_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?;
    let Some(message) = message else {
        delete_job(dbx, job.sigint_inbox_item_id)
            .await
            .context(h!())?;
        return Ok(true);
    };
    let body = message.body.unwrap_or_default();
    let settlements = match crate::ai_worker::with_fallback(
        "settlement",
        &config.ai_engine,
        config.fallback_ai_engine.as_ref(),
        |engine| {
            let prompt = &config.prompt;
            let body = &body;
            async move {
                let response = request_ai_response(
                    ai_client,
                    &engine,
                    vec![
                        AiEngineMessage {
                            role: AI_CHAT_ROLE_SYSTEM.to_string(),
                            content: prompt.clone(),
                        },
                        AiEngineMessage {
                            role: AI_CHAT_ROLE_USER.to_string(),
                            content: body.clone(),
                        },
                    ],
                )
                .await
                .c(h!())?;
                parse_settlements(&response)
                    .with_context(|| format!("відповідь ШІ: {response}"))
                    .c(h!())
            }
        },
    )
    .await
    {
        Ok((settlements, _)) => settlements,
        Err(error) => {
            fail_job(
                dbx,
                job.sigint_inbox_item_id,
                &body,
                &config,
                format!("{error:#}"),
            )
            .await
            .c(h!())?;
            return Ok(true);
        }
    };
    let changed = match complete_job(
        dbx,
        job.sigint_inbox_item_id,
        &body,
        &config,
        normalize_settlements(settlements),
    )
    .await
    {
        Ok(changed) => changed,
        Err(error) => {
            fail_job(
                dbx,
                job.sigint_inbox_item_id,
                &body,
                &config,
                format!("{error:#}"),
            )
            .await
            .c(h!())?;
            return Ok(true);
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
                "ai_settlement_worker failed to fanout completed message_id={}: {error:#?}",
                job.sigint_inbox_item_id
            );
        }
    }
    Ok(true)
}

pub(crate) async fn load_worker_config(
    dbx: &DatabaseConnection,
) -> Result<Option<WorkerConfig>, AppError> {
    let settings =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .filter(ai_settlement_settings::Column::WorkerEnabled.eq(true))
            .one(dbx)
            .await
            .c(h!())?;
    let Some(settings) = settings else {
        return Ok(None);
    };
    let Some(ai_engine_id) = settings.worker_ai_engine_id else {
        return Err(AppError::BL {
            msg: "Для ШІ-воркера населених пунктів не вибрано движок"
                .to_string(),
        });
    };
    let ai_engine = ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "ШІ движок воркера населених пунктів вимкнено або видалено"
                .to_string(),
        })
        .context(h!())?;
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
        settings_updated_at: settings.updated_at,
        group_filter: GroupFilter::from_settings(&settings),
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
    group_filter: &GroupFilter,
) -> Result<Option<ai_settlement_worker_job::Model>, AppError> {
    let mut jobs = ai_settlement_worker_job::Entity::find().filter(
        ai_settlement_worker_job::Column::NextAttemptAt
            .lte(Utc::now().naive_utc()),
    );
    if let Some(condition) = group_filter.condition(Expr::col((
        ai_settlement_worker_job::Entity,
        ai_settlement_worker_job::Column::SigintInboxItemId,
    ))) {
        jobs = jobs.filter(condition);
    }
    Ok(jobs
        .order_by_asc(ai_settlement_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_settlement_worker_job::Column::CreatedAt)
        .order_by_asc(ai_settlement_worker_job::Column::SigintInboxItemId)
        .one(dbx)
        .await
        .c(h!())?)
}

pub(crate) async fn oldest_eligible_job_created_at<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<Option<chrono::NaiveDateTime>> {
    let settings =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .one(db)
            .await
            .c(h!())?;
    let Some(settings) = settings else {
        return Ok(None);
    };
    let filter = GroupFilter::from_settings(&settings);
    let mut jobs = ai_settlement_worker_job::Entity::find()
        .select_only()
        .column(ai_settlement_worker_job::Column::CreatedAt);
    if let Some(condition) = filter.condition(Expr::col((
        ai_settlement_worker_job::Entity,
        ai_settlement_worker_job::Column::SigintInboxItemId,
    ))) {
        jobs = jobs.filter(condition);
    }
    jobs.order_by_asc(ai_settlement_worker_job::Column::CreatedAt)
        .into_tuple::<chrono::NaiveDateTime>()
        .one(db)
        .await
        .c(h!())
}

async fn complete_job(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: i64,
    expected_body: &str,
    expected_config: &WorkerConfig,
    ai_settlements: Vec<String>,
) -> Result<bool, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let message = lock_signal_message(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?;
    let job = lock_worker_job(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?;
    if job.is_none() {
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    let Some(message) = message.filter(|message| !message.deleted) else {
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    };
    if message.body.as_deref().unwrap_or_default() != expected_body {
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    if !worker_config_is_current(&transaction, expected_config)
        .await
        .context(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    if !expected_config
        .group_filter
        .allows(&transaction, sigint_inbox_item_id)
        .await
        .c(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    let Some(inbox_item) = lock_inbox_item(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?
    else {
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    };
    if inbox_item.reviewed == Some(true) {
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    let settlements = normalize_settlements(ai_settlements);
    let location = (!settlements.is_empty()).then(|| settlements.join(", "));
    let location_v2 = (!settlements.is_empty())
        .then(|| crate::location::utils::format_locations_list(settlements));
    let changed = location_v2 != inbox_item.location_v2
        || location != inbox_item.location;
    let inbox_item_uuid = inbox_item.id_uuid;
    if changed {
        let mut inbox_item = inbox_item.into_active_model();
        inbox_item.location_v2 = Set(location_v2.clone());
        inbox_item.location = Set(location);
        inbox_item.update(&transaction).await.c(h!())?;
    }
    crate::battle_line::settlement_queue::reconcile_item_locations(
        &transaction,
        sigint_inbox_item_id,
        inbox_item_uuid,
        location_v2.as_deref(),
    )
    .await
    .c(h!())?;
    if changed {
        let inbox_item =
            sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
                .one(&transaction)
                .await
                .c(h!())?
                .c(h!())?;
        crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
            vec![inbox_item], &transaction,
        ).await.c(h!())?;
        crate::stats::enqueue_group_stats_recalculation_for_message(
            &transaction,
            sigint_inbox_item_id,
            format!(
                "AI settlements updated for inbox message {sigint_inbox_item_id}"
            ),
        )
        .await
        .c(h!())?;
    }
    crate::ai_worker::record_success(
        &transaction,
        "settlement",
        sigint_inbox_item_id,
    )
    .await
    .c(h!())?;
    delete_job(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(changed)
}

async fn lock_signal_message(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
) -> Result<Option<signal_message::Model>, AppError> {
    Ok(signal_message::Entity::find_by_id(sigint_inbox_item_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .c(h!())?)
}

async fn lock_worker_job(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
) -> Result<Option<ai_settlement_worker_job::Model>, AppError> {
    Ok(
        ai_settlement_worker_job::Entity::find_by_id(sigint_inbox_item_id)
            .lock_exclusive()
            .one(transaction)
            .await
            .c(h!())?,
    )
}

async fn lock_inbox_item(
    transaction: &DatabaseTransaction,
    sigint_inbox_item_id: i64,
) -> Result<Option<sigint_inbox_item::Model>, AppError> {
    Ok(sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .c(h!())?)
}

async fn worker_config_is_current(
    transaction: &DatabaseTransaction,
    expected: &WorkerConfig,
) -> Result<bool, AppError> {
    let settings =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .lock_exclusive()
            .one(transaction)
            .await
            .c(h!())?;
    let Some(settings) = settings else {
        return Ok(false);
    };
    if !settings.worker_enabled
        || settings.worker_ai_engine_id != Some(expected.ai_engine.id)
        || settings.worker_fallback_ai_engine_id
            != expected.fallback_ai_engine.as_ref().map(|engine| engine.id)
        || settings.updated_at != expected.settings_updated_at
        || effective_prompt(&settings.prompt) != expected.prompt
    {
        return Ok(false);
    }
    for engine in std::iter::once(&expected.ai_engine)
        .chain(expected.fallback_ai_engine.as_ref())
    {
        let current = ai_engine::Entity::find_by_id(engine.id)
            .lock_shared()
            .one(transaction)
            .await
            .c(h!())?;
        if current.as_ref() != Some(engine)
            || !engine.enabled
            || !engine.callsign_enabled
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn fail_job(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: i64,
    expected_body: &str,
    expected_config: &WorkerConfig,
    error_text: String,
) -> Result<(), AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let message = lock_signal_message(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?;
    let Some(job) = lock_worker_job(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?
    else {
        transaction.commit().await.c(h!())?;
        return Ok(());
    };
    let Some(message) = message.filter(|message| !message.deleted) else {
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(());
    };
    if message.body.as_deref().unwrap_or_default() != expected_body {
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    if !worker_config_is_current(&transaction, expected_config)
        .await
        .context(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    if !expected_config
        .group_filter
        .allows(&transaction, sigint_inbox_item_id)
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
        "settlement",
        &sigint_inbox_item_id.to_string(),
        &error_text,
    )
    .await
    .c(h!())?;
    if attempts >= AI_SETTLEMENT_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_settlement_worker dropped message_id={} after {} attempts: {}",
            job.sigint_inbox_item_id, attempts, error_text
        );
        delete_job(&transaction, job.sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    let mut job = job.into_active_model();
    job.attempts = Set(attempts);
    job.next_attempt_at = Set(Utc::now().naive_utc()
        + ChronoDuration::seconds(retry_delay_secs(attempts)));
    job.last_error = Set(Some(error_text));
    job.update(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn delete_job<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    ai_settlement_worker_job::Entity::delete_by_id(sigint_inbox_item_id)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) fn normalize_settlements(settlements: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for settlement in settlements {
        let settlement = settlement.trim().to_uppercase();
        if !settlement.is_empty() && seen.insert(settlement.clone()) {
            normalized.push(settlement);
        }
    }
    normalized
}

fn retry_delay_secs(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1)).unwrap_or(0);
    AI_SETTLEMENT_WORKER_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AI_SETTLEMENT_WORKER_RETRY_MAX_SECS)
}

fn truncate_error(error: String) -> String {
    error
        .chars()
        .take(AI_SETTLEMENT_WORKER_MAX_ERROR_CHARS)
        .collect()
}

#[cfg(test)]
#[path = "worker_group_tests.rs"]
mod group_tests;

#[cfg(test)]
#[path = "worker_reconciliation_tests.rs"]
mod reconciliation_tests;

#[cfg(test)]
mod tests {
    use super::{
        complete_job, enqueue_if_enabled, fail_job, load_worker_config,
        normalize_settlements, retry_delay_secs, WorkerConfig,
    };
    use crate::config::AI_SETTLEMENT_SETTINGS_ID;
    use crate::entities::{
        ai_engine, ai_settlement_settings, ai_settlement_worker_job,
        api_integration, api_integration_iggy_event,
        group_stats_recalculation_task, sigint_inbox_item,
        sigint_inbox_item_settlement, signal_group, signal_message,
        signal_message_group,
    };
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    };

    #[tokio::test]
    #[serial_test::serial]
    async fn fallback_recovered_settlement_job_persists_results_and_progress_3888(
    ) {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let primary = crate::ai_worker::test_support::engine(
            &env.dbx,
            200,
            "invalid JSON",
            false,
        )
        .await;
        let fallback = crate::ai_worker::test_support::engine(
            &env.dbx,
            200,
            r#"{"settlements":["АРТІЛЬНЕ"]}"#,
            false,
        )
        .await;
        crate::ai_settlement::save_worker_settings(
            &env.dbx,
            true,
            Some(primary.engine.id),
            Default::default(),
            Some(Some(fallback.engine.id)),
        )
        .await
        .unwrap();
        let item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                reviewed: Set(Some(false)),
                location: Set(None),
                location_v2: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        super::enqueue_if_enabled(&env.dbx, item.id).await.unwrap();
        let mut redis = env.redis.clone();
        assert!(super::process_next(
            &env.ai_engine_client,
            &env.dbx,
            &mut redis
        )
        .await
        .unwrap());
        let saved = sigint_inbox_item::Entity::find_by_id(item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.location.as_deref(), Some("АРТІЛЬНЕ"));
        assert!(ai_settlement_worker_job::Entity::find_by_id(item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let monitoring =
            crate::ai_worker::monitoring::load(&env.dbx).await.unwrap();
        assert!(monitoring.settlement.last_completed_at_ms.is_some());
        assert!(monitoring
            .settlement
            .latest_processed_entry_created_at_ms
            .is_some());
        assert_eq!(fallback.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn normalizes_ai_settlements() {
        assert_eq!(
            normalize_settlements(vec![
                " артільне ".to_string(),
                "ШЕВ’ЯКІВКА".to_string(),
                "АРТІЛЬНЕ".to_string(),
                "".to_string(),
            ]),
            vec!["АРТІЛЬНЕ", "ШЕВ’ЯКІВКА"]
        );
    }

    #[test]
    fn caps_retry_delay() {
        assert_eq!(retry_delay_secs(1), 5);
        assert_eq!(retry_delay_secs(2), 10);
        assert_eq!(retry_delay_secs(20), 300);
    }

    pub(super) async fn enable_worker(
        dbx: &sea_orm::DatabaseConnection,
    ) -> WorkerConfig {
        let now = chrono::Utc::now().naive_utc();
        let ai_engine_id = uuid::Uuid::now_v7();
        ai_engine::ActiveModel {
            id: Set(ai_engine_id),
            name: Set(format!("settlement-worker-test-{ai_engine_id}")),
            url: Set("http://localhost".to_string()),
            token: Set(None),
            model_name: Set("test".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
            callsign_enabled: Set(true),
            ocr_enabled: Set(false),
            ocr_request_profile: Set("openai_vision".to_string()),
            unhealthy: Set(None),
            health_message: Set(None),
            health_updated_at: Set(None),
            health_updated_by_login_id: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();
        ai_settlement_settings::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        ai_settlement_settings::ActiveModel {
            worker_fallback_ai_engine_id: sea_orm::ActiveValue::Set(None),
            id: Set(AI_SETTLEMENT_SETTINGS_ID),
            prompt: Set("test prompt".to_string()),
            worker_enabled: Set(true),
            worker_ai_engine_id: Set(Some(ai_engine_id)),
            worker_groups_except: Set(None),
            worker_group_master_keys: Set(None),
            updated_at: Set(now),
        }
        .insert(dbx)
        .await
        .unwrap();
        load_worker_config(dbx).await.unwrap().unwrap()
    }

    async fn enable_settlement_events(
        dbx: &sea_orm::DatabaseConnection,
    ) -> api_integration::Model {
        api_integration::ActiveModel {
            api_user_login_id: Set(crate::users::system_login_id(dbx)
                .await
                .unwrap()),
            sync_enabled: Set(true),
            has_iggy_connection: Set(true),
            iggy_url: Set(Some("tcp://localhost:8090".to_string())),
            iggy_login: Set(Some("test".to_string())),
            iggy_password: Set(Some("test".to_string())),
            iggy_inbox_topic: Set(Some("test-inbox".to_string())),
            iggy_analytics_topic: Set(Some("test-analytics".to_string())),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_settlement_link(
        dbx: &sea_orm::DatabaseConnection,
        inbox_item: &sigint_inbox_item::Model,
        text: &str,
        settlement_id: Option<i32>,
        is_undefined: Option<bool>,
    ) -> sigint_inbox_item_settlement::Model {
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(inbox_item.id),
            item_uuid: Set(inbox_item.id_uuid),
            settlement_text: Set(text.to_string()),
            settlement_id: Set(settlement_id),
            is_undefined: Set(is_undefined),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn settlement_events(
        dbx: &sea_orm::DatabaseConnection,
        integration_id: i64,
        message_id: i64,
    ) -> Vec<serde_json::Value> {
        api_integration_iggy_event::Entity::find()
            .filter(
                api_integration_iggy_event::Column::ApiIntegrationId
                    .eq(integration_id),
            )
            .filter(
                api_integration_iggy_event::Column::SigintInboxItemId
                    .eq(message_id),
            )
            .order_by_asc(api_integration_iggy_event::Column::Id)
            .all(dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.payload)
            .filter(|payload| {
                payload["event_type"].as_str().is_some_and(|kind| {
                    kind.starts_with("sigint_inbox_item_settlement_")
                })
            })
            .collect()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn replaces_code_locations_and_reconciles_links_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let config = enable_worker(&env.dbx).await;
        let integration = enable_settlement_events(&env.dbx).await;
        let group_master_key = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .select_only()
            .column(signal_group::Column::MasterKey)
            .into_tuple::<String>()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("message body".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group_master_key.clone())),
            created_at: Set(message.created_at),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let inbox_item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location: Set(Some("existing mixed, second, third".to_string())),
            location_v2: Set(Some("|EXISTING MIXED|SECOND|THIRD|".to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mut retained_ids = Vec::new();
        for (text, settlement_id, is_undefined) in [
            ("EXISTING MIXED", Some(79948), Some(false)),
            ("SECOND", Some(98911), Some(false)),
            ("THIRD", None, Some(true)),
        ] {
            let link = insert_settlement_link(
                &env.dbx,
                &inbox_item,
                text,
                settlement_id,
                is_undefined,
            )
            .await;
            if text != "SECOND" {
                retained_ids.push(link.id);
            }
        }
        ai_settlement_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            attempts: Set(0),
            next_attempt_at: Set(chrono::Utc::now().naive_utc()),
            last_error: Set(None),
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert!(complete_job(
            &env.dbx,
            message.id,
            "message body",
            &config,
            vec![
                "existing mixed".to_string(),
                "THIRD".to_string(),
                "ВЕРХНЄ ГОРІХОВЕ".to_string(),
                "ЗАЛИВНИЙ".to_string(),
            ],
        )
        .await
        .unwrap());

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            inbox_item.location_v2.as_deref(),
            Some("|EXISTING MIXED|THIRD|ВЕРХНЄ ГОРІХОВЕ|ЗАЛИВНИЙ|")
        );
        assert_eq!(
            inbox_item.location.as_deref(),
            Some("EXISTING MIXED, THIRD, ВЕРХНЄ ГОРІХОВЕ, ЗАЛИВНИЙ")
        );
        let links = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(message.id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(
            links
                .iter()
                .map(|link| link.settlement_text.as_str())
                .collect::<Vec<_>>(),
            vec!["EXISTING MIXED", "THIRD", "ВЕРХНЄ ГОРІХОВЕ", "ЗАЛИВНИЙ"]
        );
        assert!(links.iter().all(|link| link.settlement_id.is_none()
            && link.is_undefined.is_none()
            && link.item_uuid == inbox_item.id_uuid));
        assert_eq!(
            links[..2].iter().map(|link| link.id).collect::<Vec<_>>(),
            retained_ids,
        );
        assert_eq!(
            settlement_events(&env.dbx, integration.id, message.id).await,
            [79948, 98911].map(|settlement_id| serde_json::json!({
                "event_type": "sigint_inbox_item_settlement_unlinked",
                "settlement_id": settlement_id,
            })),
        );
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert!(group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::GroupMasterKey
                    .eq(group_master_key)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn empty_ai_result_clears_code_locations_and_links_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let config = enable_worker(&env.dbx).await;
        let integration = enable_settlement_events(&env.dbx).await;
        for (location_v2, location) in [
            (Some("|ГЛИБОКИЙ|МАЛИЙ|"), Some("глибокий, малий")),
            (None, Some("глибокий, малий")),
            (Some(""), None),
            (Some("||"), None),
            (Some("| |"), None),
            (None, None),
        ] {
            let message = crate::functest::tests::mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    body: Set(Some("глибокий, малий".to_string())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let inbox_item = sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                location: Set(location.map(str::to_string)),
                location_v2: Set(location_v2.map(str::to_string)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            insert_settlement_link(
                &env.dbx,
                &inbox_item,
                "ГЛИБОКИЙ",
                Some(98911),
                Some(false),
            )
            .await;
            enqueue_if_enabled(&env.dbx, message.id).await.unwrap();

            assert_eq!(
                complete_job(
                    &env.dbx,
                    message.id,
                    "глибокий, малий",
                    &config,
                    vec![],
                )
                .await
                .unwrap(),
                location_v2.is_some() || location.is_some(),
            );

            let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(inbox_item.location_v2, None);
            assert_eq!(inbox_item.location, None);
            assert_eq!(
                settlement_events(&env.dbx, integration.id, message.id).await,
                vec![serde_json::json!({
                    "event_type": "sigint_inbox_item_settlement_unlinked",
                    "settlement_id": 98911,
                })],
            );
            assert!(sigint_inbox_item_settlement::Entity::find()
                .filter(
                    sigint_inbox_item_settlement::Column::ItemId.eq(message.id)
                )
                .all(&env.dbx)
                .await
                .unwrap()
                .is_empty());
            assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconciles_unchanged_settlement_result_3383() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let config = enable_worker(&env.dbx).await;
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("#3383 unchanged result".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let location_v2 = "|ІВАЩИНЕ|ВЕРХНЄ ГОРІХОВЕ|ЗАЛИВНИЙ|";
        let inbox_item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location: Set(Some("OBSOLETE".to_string())),
            location_v2: Set(Some(location_v2.to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mut retained = vec![];
        for (text, settlement_id, is_undefined) in [
            ("ІВАЩИНЕ", Some(98911), None),
            ("ВЕРХНЄ ГОРІХОВЕ", None, Some(true)),
            ("OBSOLETE", Some(79948), None),
        ] {
            let row = sigint_inbox_item_settlement::ActiveModel {
                item_id: Set(message.id),
                item_uuid: Set(inbox_item.id_uuid),
                settlement_text: Set(text.to_string()),
                settlement_id: Set(settlement_id),
                is_undefined: Set(is_undefined),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            if text != "OBSOLETE" {
                let mut row = row;
                row.settlement_id = None;
                row.is_undefined = None;
                retained.push(row);
            }
        }
        for changed in [true, false] {
            enqueue_if_enabled(&env.dbx, message.id).await.unwrap();
            assert_eq!(
                complete_job(
                    &env.dbx,
                    message.id,
                    "#3383 unchanged result",
                    &config,
                    crate::location::utils::to_location_list(location_v2),
                )
                .await
                .unwrap(),
                changed,
            );
            let rows = sigint_inbox_item_settlement::Entity::find()
                .filter(
                    sigint_inbox_item_settlement::Column::ItemId.eq(message.id),
                )
                .order_by_asc(sigint_inbox_item_settlement::Column::Id)
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(rows.len(), 3);
            assert_eq!(&rows[..retained.len()], retained.as_slice());
            assert_eq!(rows[2].settlement_text, "ЗАЛИВНИЙ");
            assert_eq!(rows[2].settlement_id, None);
            assert_eq!(rows[2].is_undefined, None);
            assert_eq!(rows[2].item_uuid, inbox_item.id_uuid);
            retained = rows;
            if retained[0].settlement_id.is_none() {
                let mut linked = retained[0].clone().into_active_model();
                linked.settlement_id = Set(Some(98911));
                linked.is_undefined = Set(Some(false));
                retained[0] = linked.update(&env.dbx).await.unwrap();
                let mut undefined = retained[1].clone().into_active_model();
                undefined.is_undefined = Set(Some(true));
                retained[1] = undefined.update(&env.dbx).await.unwrap();
            }
        }
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location_v2.as_deref(), Some(location_v2));
        assert_eq!(
            inbox_item.location.as_deref(),
            Some("ІВАЩИНЕ, ВЕРХНЄ ГОРІХОВЕ, ЗАЛИВНИЙ")
        );
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn ignores_stale_or_already_completed_results_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let config = enable_worker(&env.dbx).await;
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("new body".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location: Set(Some("existing raw location".to_string())),
            location_v2: Set(Some("|EXISTING|".to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let original_link = insert_settlement_link(
            &env.dbx,
            &inbox_item,
            "EXISTING",
            Some(98911),
            Some(false),
        )
        .await;
        ai_settlement_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            attempts: Set(0),
            next_attempt_at: Set(chrono::Utc::now().naive_utc()),
            last_error: Set(None),
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert!(!complete_job(
            &env.dbx,
            message.id,
            "old body",
            &config,
            vec!["STALE".to_string()],
        )
        .await
        .unwrap());
        fail_job(
            &env.dbx,
            message.id,
            "old body",
            &config,
            "stale error".to_string(),
        )
        .await
        .unwrap();
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location_v2.as_deref(), Some("|EXISTING|"));
        let job = ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.attempts, 0);
        fail_job(
            &env.dbx,
            message.id,
            "new body",
            &config,
            "current request failed".to_string(),
        )
        .await
        .unwrap();
        let unchanged = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged, inbox_item);
        assert_eq!(
            sigint_inbox_item_settlement::Entity::find_by_id(original_link.id)
                .one(&env.dbx)
                .await
                .unwrap(),
            Some(original_link),
        );

        assert!(complete_job(
            &env.dbx,
            message.id,
            "new body",
            &config,
            vec!["FRESH".to_string()],
        )
        .await
        .unwrap());
        assert!(!complete_job(
            &env.dbx,
            message.id,
            "new body",
            &config,
            vec!["DUPLICATE".to_string()],
        )
        .await
        .unwrap());
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location_v2.as_deref(), Some("|FRESH|"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_stale_worker_config_2133() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let config = enable_worker(&env.dbx).await;
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("message body".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location_v2: Set(Some("|EXISTING|".to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        ai_settlement_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            attempts: Set(0),
            next_attempt_at: Set(chrono::Utc::now().naive_utc()),
            last_error: Set(None),
            created_at: Set(chrono::Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mut fallback = config.ai_engine.clone().into_active_model();
        let fallback_id = uuid::Uuid::now_v7();
        fallback.id = Set(fallback_id);
        fallback.name = Set(format!("fallback-{fallback_id}"));
        let fallback = fallback.insert(&env.dbx).await.unwrap();
        let mut settings = ai_settlement_settings::Entity::find_by_id(
            AI_SETTLEMENT_SETTINGS_ID,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
        settings.worker_fallback_ai_engine_id = Set(Some(fallback_id));
        settings.update(&env.dbx).await.unwrap();
        let with_fallback =
            load_worker_config(&env.dbx).await.unwrap().unwrap();
        let mut fallback = fallback.into_active_model();
        fallback.model_name = Set("changed-during-extraction".to_string());
        fallback.update(&env.dbx).await.unwrap();
        for stale in [&config, &with_fallback] {
            assert!(!complete_job(
                &env.dbx,
                message.id,
                "message body",
                stale,
                vec!["STALE FALLBACK".to_string()],
            )
            .await
            .unwrap());
            fail_job(
                &env.dbx,
                message.id,
                "message body",
                stale,
                "stale fallback failure".to_string(),
            )
            .await
            .unwrap();
        }
        assert!(crate::entities::ai_worker_progress::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let job = ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.attempts, 0);
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        let mut settings = ai_settlement_settings::Entity::find_by_id(
            AI_SETTLEMENT_SETTINGS_ID,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
        settings.worker_enabled = Set(false);
        settings.updated_at =
            Set(config.settings_updated_at + chrono::Duration::seconds(1));
        settings.update(&env.dbx).await.unwrap();

        assert!(!complete_job(
            &env.dbx,
            message.id,
            "message body",
            &config,
            vec!["STALE".to_string()],
        )
        .await
        .unwrap());

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.location_v2.as_deref(), Some("|EXISTING|"));
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }
}
