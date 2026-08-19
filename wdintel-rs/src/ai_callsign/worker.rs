use super::{effective_prompt, parse_callsigns};
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
        let processed = match process_next(&env.dbx, &env.rq, &mut redis).await
        {
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
    rq: &reqwest::Client,
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
                content: body.clone(),
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
    let ai_callsigns = normalize_callsigns(callsigns);
    let changed = match complete_job(
        dbx,
        rq,
        job.sigint_inbox_item_id,
        &body,
        ai_callsigns,
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
                "ai_callsign_worker failed to fanout completed message_id={}: {error:#?}",
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
    Ok(Some(WorkerConfig {
        prompt: effective_prompt(&settings.prompt).to_string(),
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
    rq: &reqwest::Client,
    sigint_inbox_item_id: i64,
    body: &str,
    ai_callsigns: Vec<String>,
) -> Result<bool, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let Some(state) =
        lock_callsign_job_state(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?
    else {
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    };
    transaction.commit().await.c(h!())?;

    let mut highlighted =
        highlight_callsigns(rq, body, state.current, &ai_callsigns)
            .await
            .context(h!())?;
    loop {
        let transaction = dbx.begin().await.c(h!())?;
        let Some(state) =
            lock_callsign_job_state(&transaction, sigint_inbox_item_id)
                .await
                .context(h!())?
        else {
            delete_job(&transaction, sigint_inbox_item_id)
                .await
                .context(h!())?;
            transaction.commit().await.c(h!())?;
            return Ok(false);
        };
        let callsigns = merge_current_and_ai_callsigns(
            state.current.clone(),
            ai_callsigns.clone(),
        );
        if callsigns != highlighted.callsigns {
            transaction.commit().await.c(h!())?;
            highlighted =
                highlight_callsigns(rq, body, state.current, &ai_callsigns)
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
        delete_job(&transaction, sigint_inbox_item_id)
            .await
            .context(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(changed);
    }
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
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: highlighted.callsigns,
                alg2: vec![],
            },
            system_login_id,
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
}
