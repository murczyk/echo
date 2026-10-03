//! AI position extraction: named positions in messages and document
//! summaries, and the coordinates the text ties to them. See README.md.

pub mod eval;
mod extract;
pub mod feedback;
pub mod knowledge;
pub mod list;
pub mod lookup;
pub mod normalize;
pub mod types;
pub mod worker;

use crate::config::{
    AI_POSITION_BACKFILL_MAX_DAYS, AI_POSITION_DEFAULT_PROMPT,
    AI_POSITION_PROMPT_MAX_CHARS, AI_POSITION_SETTINGS_ID,
    AI_POSITION_TEST_MESSAGE_MAX_CHARS,
};
use crate::entities::{ai_engine, ai_position_settings};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use types::{
    AiPositionEngineItem, AiPositionPageRsp, AiPositionPromptState,
    AiPositionWorkerSettingsItem, EnqueueAiPositionBackfillReq,
    EnqueueAiPositionBackfillRsp, SaveAiPositionPromptReq,
    SaveAiPositionWorkerSettingsReq, TestAiPositionReq, TestAiPositionRsp,
};
use uuid::Uuid;

#[post("/api/admin/ai-positions/page")]
pub async fn get_ai_position_page(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiPositionPageRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(load_page(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-positions/prompt/save")]
pub async fn save_ai_position_prompt(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiPositionPromptReq>,
) -> Result<Json<AiPositionPromptState>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let prompt = req.into_inner().prompt.trim().to_string();
    if prompt.chars().count() > AI_POSITION_PROMPT_MAX_CHARS {
        return Err(AppError::BL {
            msg: "Промпт задовгий".to_string(),
        });
    }
    // The default prompt is stored as empty so it follows code updates.
    let prompt = if prompt == AI_POSITION_DEFAULT_PROMPT.trim() {
        String::new()
    } else {
        prompt
    };
    upsert_settings(&env.dbx, SettingsChange::Prompt(prompt.clone()))
        .await
        .c(h!())?;
    Ok(Json(prompt_state(&prompt)))
}

#[post("/api/admin/ai-positions/worker/save")]
pub async fn save_ai_position_worker_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiPositionWorkerSettingsReq>,
) -> Result<Json<AiPositionWorkerSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let ai_engine_id = req
        .ai_engine_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    if req.enabled && ai_engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Оберіть ШІ движок для воркера".to_string(),
        });
    }
    // The engine stays locked until the settings are saved, so it cannot be
    // disabled in between (the engine update checks these settings).
    let transaction = env.dbx.begin().await.c(h!())?;
    if let (true, Some(ai_engine_id)) = (req.enabled, ai_engine_id) {
        load_engine(&transaction, ai_engine_id, true)
            .await
            .context(h!())?;
    }
    upsert_settings(
        &transaction,
        SettingsChange::Worker(req.enabled, ai_engine_id),
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(AiPositionWorkerSettingsItem {
        enabled: req.enabled,
        ai_engine_id: ai_engine_id.map(|id| id.to_string()),
    }))
}

#[post("/api/admin/ai-positions/test")]
pub async fn test_ai_positions(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<TestAiPositionReq>,
) -> Result<Json<TestAiPositionRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    if req.text.trim().is_empty()
        || req.text.chars().count() > AI_POSITION_TEST_MESSAGE_MAX_CHARS
    {
        return Err(AppError::BL {
            msg: "Введіть текст повідомлення (до 20 000 символів)".to_string(),
        });
    }
    let engine = load_engine(
        &env.dbx,
        Uuid::parse_str(&req.ai_engine_id).c(h!())?,
        false,
    )
    .await
    .context(h!())?;
    let extraction = extract::extract(
        &engine,
        effective_prompt(req.prompt.trim()),
        &req.text,
        &[],
    )
    .await
    .c(h!())?;
    Ok(Json(TestAiPositionRsp {
        positions: extraction.positions,
        response_text: extraction.response_text,
    }))
}

#[post("/api/admin/ai-positions/backfill")]
pub async fn enqueue_ai_position_backfill(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<EnqueueAiPositionBackfillReq>,
) -> Result<Json<EnqueueAiPositionBackfillRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let days = req.days;
    if !(1..=AI_POSITION_BACKFILL_MAX_DAYS).contains(&days) {
        return Err(AppError::BL {
            msg: format!(
                "Вкажіть від 1 до {AI_POSITION_BACKFILL_MAX_DAYS} днів"
            ),
        });
    }
    let settings = settings(&env.dbx).await.c(h!())?;
    if !settings.is_some_and(|settings| settings.worker_enabled) {
        return Err(AppError::BL {
            msg: "Спершу увімкніть воркер".to_string(),
        });
    }
    // Long histories take a while; the queue size on the page shows progress.
    let dbx = env.dbx.clone();
    tokio::spawn(async move {
        match worker::enqueue_backfill(&dbx, days).await {
            Ok((messages, documents)) => crate::types::info!(
                "ai_position backfill of {days} days queued {messages} messages and {documents} documents"
            ),
            Err(error) => {
                crate::types::error!("ai_position backfill of {days} days failed: {error:#?}")
            }
        }
    });
    Ok(Json(EnqueueAiPositionBackfillRsp { started: true }))
}

/// Refuses to disable or delete the engine the enabled worker uses.
pub(crate) async fn ensure_engine_not_used<C>(
    dbx: &C,
    ai_engine_id: Uuid,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let is_used = ai_position_settings::Entity::find()
        .filter(ai_position_settings::Column::WorkerEnabled.eq(true))
        .filter(ai_position_settings::Column::WorkerAiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_used {
        return Err(AppError::BL {
            msg: "ШІ движок використовується воркером позицій. Спочатку вимкніть воркер або виберіть інший движок.".to_string(),
        });
    }
    Ok(())
}

pub(crate) async fn settings(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ai_position_settings::Model>> {
    ai_position_settings::Entity::find_by_id(AI_POSITION_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())
}

pub(crate) fn effective_prompt(prompt: &str) -> &str {
    if prompt.is_empty() {
        AI_POSITION_DEFAULT_PROMPT
    } else {
        prompt
    }
}

fn prompt_state(prompt: &str) -> AiPositionPromptState {
    AiPositionPromptState {
        prompt: effective_prompt(prompt).to_string(),
        prompt_overridden: !prompt.is_empty(),
    }
}

/// Engines usable for text extraction (the callsign capability).
fn usable_engines() -> sea_orm::Select<ai_engine::Entity> {
    ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
}

async fn load_engine<C>(
    dbx: &C,
    id: Uuid,
    lock: bool,
) -> Result<ai_engine::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let query = usable_engines().filter(ai_engine::Column::Id.eq(id));
    let query = if lock { query.lock_shared() } else { query };
    query.one(dbx).await.c(h!())?.ok_or_else(|| AppError::BL {
        msg: "Вибраний ШІ движок вимкнено або видалено".to_string(),
    })
}

async fn load_page(
    dbx: &DatabaseConnection,
) -> anyhow::Result<AiPositionPageRsp> {
    let settings = settings(dbx).await.c(h!())?;
    let prompt = settings
        .as_ref()
        .map(|s| s.prompt.clone())
        .unwrap_or_default();
    let engines = usable_engines()
        .order_by_asc(ai_engine::Column::Name)
        .all(dbx)
        .await
        .c(h!())?;
    let state = prompt_state(&prompt);
    Ok(AiPositionPageRsp {
        prompt: state.prompt,
        prompt_overridden: state.prompt_overridden,
        engines: engines
            .into_iter()
            .map(|engine| AiPositionEngineItem {
                id: engine.id.to_string(),
                name: engine.name,
                model_name: engine.model_name,
            })
            .collect(),
        worker: AiPositionWorkerSettingsItem {
            enabled: settings.as_ref().is_some_and(|s| s.worker_enabled),
            ai_engine_id: settings
                .as_ref()
                .and_then(|s| s.worker_ai_engine_id)
                .map(|id| id.to_string()),
        },
        pending_jobs: worker::pending_jobs(dbx).await.c(h!())?,
        open_feedback: feedback::open_feedback_count(dbx).await.c(h!())?,
    })
}

enum SettingsChange {
    Prompt(String),
    Worker(bool, Option<Uuid>),
}

async fn upsert_settings<C>(
    dbx: &C,
    change: SettingsChange,
) -> anyhow::Result<()>
where
    C: sea_orm::ConnectionTrait,
{
    let mut settings = ai_position_settings::ActiveModel {
        id: Set(AI_POSITION_SETTINGS_ID),
        prompt: Set(String::new()),
        worker_enabled: Set(false),
        worker_ai_engine_id: Set(None),
        updated_at: Set(Utc::now().naive_utc()),
    };
    let columns = match change {
        SettingsChange::Prompt(prompt) => {
            settings.prompt = Set(prompt);
            vec![ai_position_settings::Column::Prompt]
        }
        SettingsChange::Worker(enabled, ai_engine_id) => {
            settings.worker_enabled = Set(enabled);
            settings.worker_ai_engine_id = Set(ai_engine_id);
            vec![
                ai_position_settings::Column::WorkerEnabled,
                ai_position_settings::Column::WorkerAiEngineId,
            ]
        }
    };
    ai_position_settings::Entity::insert(settings)
        .on_conflict(
            OnConflict::column(ai_position_settings::Column::Id)
                .update_columns(
                    columns
                        .into_iter()
                        .chain([ai_position_settings::Column::UpdatedAt]),
                )
                .to_owned(),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}
