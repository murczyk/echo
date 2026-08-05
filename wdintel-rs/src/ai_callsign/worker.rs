use super::parse_callsigns;
use crate::ai_engine::{request_ai_response, AiEngineMessage};
use crate::config::{
    AI_CALLSIGN_SETTINGS_ID, AI_CALLSIGN_WORKER_IDLE_SLEEP_MS,
    AI_CALLSIGN_WORKER_MAX_ATTEMPTS, AI_CALLSIGN_WORKER_MAX_ERROR_CHARS,
    AI_CALLSIGN_WORKER_RETRY_BASE_SECS, AI_CALLSIGN_WORKER_RETRY_MAX_SECS,
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER,
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
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, TransactionTrait,
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct WorkerConfig {
    prompt: String,
    ai_engine: ai_engine::Model,
}

pub async fn enqueue_if_enabled<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let enabled =
        ai_callsign_settings::Entity::find_by_id(AI_CALLSIGN_SETTINGS_ID)
            .filter(ai_callsign_settings::Column::WorkerEnabled.eq(true))
            .filter(
                ai_callsign_settings::Column::WorkerAiEngineId.is_not_null(),
            )
            .one(dbx)
            .await
            .c(h!())?
            .is_some();
    if !enabled {
        return Ok(());
    }
    ai_callsign_worker_job::Entity::insert(
        ai_callsign_worker_job::ActiveModel {
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
    info!("ai_callsign_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            info!("ai_callsign_worker received cancellation token");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("ai_callsign_worker");
        let processed = match process_next(&env.dbx, &mut redis).await {
            Ok(processed) => processed,
            Err(error) => {
                error!("ai_callsign_worker failed: {error:#?}");
                false
            }
        };
        if processed {
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
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> Result<bool, AppError> {
    let Some(config) = load_worker_config(dbx).await? else {
        return Ok(false);
    };
    let Some(job) = load_next_job(dbx).await? else {
        return Ok(false);
    };
    let message = signal_message::Entity::find_by_id(job.sigint_inbox_item_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?;
    let Some(message) = message else {
        delete_job(dbx, job.sigint_inbox_item_id).await?;
        return Ok(true);
    };
    let response = request_ai_response(
        &config.ai_engine,
        vec![
            AiEngineMessage {
                role: AI_CHAT_ROLE_SYSTEM.to_string(),
                content: config.prompt,
            },
            AiEngineMessage {
                role: AI_CHAT_ROLE_USER.to_string(),
                content: message.body.unwrap_or_default(),
            },
        ],
    )
    .await;
    let callsigns = match response {
        Ok(response_text) => match parse_callsigns(&response_text) {
            Ok(callsigns) => callsigns,
            Err(error) => {
                fail_job(
                    dbx,
                    job,
                    format!("{error}; відповідь ШІ: {response_text}"),
                )
                .await?;
                return Ok(true);
            }
        },
        Err(error) => {
            fail_job(dbx, job, error.to_string()).await?;
            return Ok(true);
        }
    };
    let changed =
        complete_job(dbx, job.sigint_inbox_item_id, callsigns).await?;
    if changed {
        fanout_mult(
            redis,
            vec![EventMsg::new(EventType::ETInboxChanged(
                job.sigint_inbox_item_id,
            ))],
        )
        .await
        .c(h!())?;
    }
    Ok(true)
}

async fn load_worker_config(
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
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "ШІ движок воркера позивних вимкнено або видалено".to_string(),
        })?;
    Ok(Some(WorkerConfig {
        prompt: settings.prompt,
        ai_engine,
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
) -> Result<Option<ai_callsign_worker_job::Model>, AppError> {
    Ok(ai_callsign_worker_job::Entity::find()
        .filter(
            ai_callsign_worker_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(ai_callsign_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_callsign_worker_job::Column::CreatedAt)
        .order_by_asc(ai_callsign_worker_job::Column::SigintInboxItemId)
        .one(dbx)
        .await
        .c(h!())?)
}

async fn complete_job(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: i64,
    callsigns: Vec<String>,
) -> Result<bool, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let inbox_item =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .one(&transaction)
            .await
            .c(h!())?;
    let Some(inbox_item) = inbox_item else {
        delete_job(&transaction, sigint_inbox_item_id).await?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    };
    let current: Vec<String> = inbox_item
        .callsigns
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .c(h!())?
        .unwrap_or_default();
    let suggested: Vec<String> = inbox_item
        .callsigns_alg2
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .c(h!())?
        .unwrap_or_default();
    let callsigns = normalize_callsigns(callsigns);
    let callsigns_changed = callsigns != current;
    let changed = callsigns_changed || !suggested.is_empty();
    if changed {
        let mut inbox_item = inbox_item.into_active_model();
        if callsigns_changed {
            inbox_item.callsigns =
                Set(Some(serde_json::to_value(&callsigns).c(h!())?));
            inbox_item.callsign_tokens = Set(Some(
                serde_json::to_value(Vec::<serde_json::Value>::new())
                    .c(h!())?,
            ));
        }
        inbox_item.callsigns_alg2 =
            Set(Some(serde_json::to_value(Vec::<String>::new()).c(h!())?));
        inbox_item.update(&transaction).await.c(h!())?;
        let system_login_id =
            crate::users::system_login_id(&transaction).await.c(h!())?;
        crate::inbox::callsigns::sync(
            &transaction,
            sigint_inbox_item_id,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: callsigns,
                alg2: vec![],
            },
            system_login_id,
        )
        .await
        .c(h!())?;
    }
    delete_job(&transaction, sigint_inbox_item_id).await?;
    transaction.commit().await.c(h!())?;
    Ok(changed)
}

async fn fail_job(
    dbx: &DatabaseConnection,
    job: ai_callsign_worker_job::Model,
    error_text: String,
) -> Result<(), AppError> {
    let attempts = job.attempts + 1;
    let error_text = truncate_error(error_text);
    if attempts >= AI_CALLSIGN_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_callsign_worker dropped message_id={} after {} attempts: {}",
            job.sigint_inbox_item_id, attempts, error_text
        );
        delete_job(dbx, job.sigint_inbox_item_id).await?;
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
    ai_callsign_worker_job::Entity::delete_by_id(sigint_inbox_item_id)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

fn normalize_callsigns(callsigns: Vec<String>) -> Vec<String> {
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

fn retry_delay_secs(attempts: i32) -> i64 {
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
mod tests {
    use super::{normalize_callsigns, retry_delay_secs};

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
    fn caps_retry_delay() {
        assert_eq!(retry_delay_secs(1), 5);
        assert_eq!(retry_delay_secs(2), 10);
        assert_eq!(retry_delay_secs(20), 300);
    }
}
