use super::{effective_prompt, parse_settlements};
use crate::ai_engine::{request_ai_response, AiEngineMessage};
use crate::config::{
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER, AI_SETTLEMENT_SETTINGS_ID,
    AI_SETTLEMENT_WORKER_IDLE_SLEEP_MS, AI_SETTLEMENT_WORKER_MAX_ATTEMPTS,
    AI_SETTLEMENT_WORKER_MAX_ERROR_CHARS, AI_SETTLEMENT_WORKER_RETRY_BASE_SECS,
    AI_SETTLEMENT_WORKER_RETRY_MAX_SECS,
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
}

pub async fn enqueue_if_enabled<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let enabled =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .filter(ai_settlement_settings::Column::WorkerEnabled.eq(true))
            .filter(
                ai_settlement_settings::Column::WorkerAiEngineId.is_not_null(),
            )
            .one(dbx)
            .await
            .c(h!())?
            .is_some();
    if !enabled {
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
    .on_conflict_do_nothing()
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    let mut redis = env.redis.clone();
    info!("ai_settlement_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            info!("ai_settlement_worker received cancellation token");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("ai_settlement_worker");
        let processed = match process_next(&env.dbx, &mut redis).await {
            Ok(processed) => processed,
            Err(error) => {
                error!("ai_settlement_worker failed: {error:#?}");
                false
            }
        };
        if processed {
            continue;
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(
                AI_SETTLEMENT_WORKER_IDLE_SLEEP_MS,
            )) => {}
        }
    }
}

async fn process_next(
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> Result<bool, AppError> {
    let Some(config) = load_worker_config(dbx).await.context(h!())? else {
        return Ok(false);
    };
    let Some(job) = load_next_job(dbx).await.context(h!())? else {
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
    let response = request_ai_response(
        &config.ai_engine,
        vec![
            AiEngineMessage {
                role: AI_CHAT_ROLE_SYSTEM.to_string(),
                content: config.prompt,
            },
            AiEngineMessage {
                role: AI_CHAT_ROLE_USER.to_string(),
                content: body,
            },
        ],
    )
    .await;
    let settlements = match response {
        Ok(response_text) => match parse_settlements(&response_text) {
            Ok(settlements) => settlements,
            Err(error) => {
                fail_job(
                    dbx,
                    job,
                    format!("{error}; відповідь ШІ: {response_text}"),
                )
                .await
                .context(h!())?;
                return Ok(true);
            }
        },
        Err(error) => {
            fail_job(dbx, job, error.to_string()).await.context(h!())?;
            return Ok(true);
        }
    };
    let changed = match complete_job(
        dbx,
        job.sigint_inbox_item_id,
        normalize_settlements(settlements),
    )
    .await
    {
        Ok(changed) => changed,
        Err(error) => {
            fail_job(dbx, job, error.to_string()).await.c(h!())?;
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
    Ok(Some(WorkerConfig {
        prompt: effective_prompt(&settings.prompt).to_string(),
        ai_engine,
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
) -> Result<Option<ai_settlement_worker_job::Model>, AppError> {
    Ok(ai_settlement_worker_job::Entity::find()
        .filter(
            ai_settlement_worker_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(ai_settlement_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_settlement_worker_job::Column::CreatedAt)
        .order_by_asc(ai_settlement_worker_job::Column::SigintInboxItemId)
        .one(dbx)
        .await
        .c(h!())?)
}

async fn complete_job(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: i64,
    ai_settlements: Vec<String>,
) -> Result<bool, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
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
    let current = inbox_item
        .location_v2
        .as_deref()
        .map(crate::location::utils::to_location_list)
        .unwrap_or_default();
    let settlements =
        merge_current_and_ai_settlements(current.clone(), ai_settlements);
    let changed = settlements != current;
    if changed {
        let location_v2 =
            crate::location::utils::format_locations_list(settlements);
        let mut inbox_item = inbox_item.into_active_model();
        inbox_item.location_v2 = Set(Some(location_v2.clone()));
        inbox_item.update(&transaction).await.c(h!())?;
        crate::battle_line::settlement_queue::reconcile_item_locations(
            &transaction,
            sigint_inbox_item_id,
            Some(&location_v2),
        )
        .await
        .c(h!())?;
    }
    delete_job(&transaction, sigint_inbox_item_id)
        .await
        .context(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(changed)
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

async fn fail_job(
    dbx: &DatabaseConnection,
    job: ai_settlement_worker_job::Model,
    error_text: String,
) -> Result<(), AppError> {
    let attempts = job.attempts + 1;
    let error_text = truncate_error(error_text);
    if attempts >= AI_SETTLEMENT_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_settlement_worker dropped message_id={} after {} attempts: {}",
            job.sigint_inbox_item_id, attempts, error_text
        );
        delete_job(dbx, job.sigint_inbox_item_id)
            .await
            .context(h!())?;
        return Ok(());
    }
    let mut job = job.into_active_model();
    job.attempts = Set(attempts);
    job.next_attempt_at = Set(Utc::now().naive_utc()
        + ChronoDuration::seconds(retry_delay_secs(attempts)));
    job.last_error = Set(Some(error_text));
    job.update(dbx).await.c(h!())?;
    Ok(())
}

async fn delete_job<C>(
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

pub(crate) fn merge_current_and_ai_settlements(
    current: Vec<String>,
    ai_settlements: Vec<String>,
) -> Vec<String> {
    let mut seen = current
        .iter()
        .map(|settlement| settlement.trim().to_uppercase())
        .collect::<HashSet<_>>();
    let mut settlements = current;
    for settlement in normalize_settlements(ai_settlements) {
        if seen.insert(settlement.clone()) {
            settlements.push(settlement);
        }
    }
    settlements
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
mod tests {
    use super::{
        complete_job, merge_current_and_ai_settlements, normalize_settlements,
        retry_delay_secs,
    };
    use crate::entities::{
        ai_settlement_worker_job, sigint_inbox_item,
        sigint_inbox_item_settlement, signal_message,
    };
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        QueryFilter, QueryOrder,
    };

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
    fn appends_only_missing_ai_settlements() {
        assert_eq!(
            merge_current_and_ai_settlements(
                vec!["Артільне".to_string(), "СТАРИЙ ХУТІР".to_string()],
                vec!["артільне".to_string(), "ШЕВ’ЯКІВКА".to_string()],
            ),
            vec!["Артільне", "СТАРИЙ ХУТІР", "ШЕВ’ЯКІВКА"]
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
    async fn preserves_pipe_delimited_locations_and_reconciles_links_2133() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location_v2: Set(Some("|Existing Mixed|SECOND|".to_string())),
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

        assert!(complete_job(
            &env.dbx,
            message.id,
            vec!["existing mixed".to_string(), "THIRD".to_string()],
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
            Some("|Existing Mixed|SECOND|THIRD|")
        );
        let links = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(message.id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(
            links
                .into_iter()
                .map(|link| link.settlement_text)
                .collect::<Vec<_>>(),
            vec!["Existing Mixed", "SECOND", "THIRD"]
        );
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }
}
