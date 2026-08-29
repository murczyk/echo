pub mod types;
pub mod worker;

use crate::ai_engine::{request_ai_response, AiEngineMessage};
use crate::config::{
    AI_CHAT_ROLE_SYSTEM, AI_CHAT_ROLE_USER, AI_SETTLEMENT_DEFAULT_PROMPT,
    AI_SETTLEMENT_MAX_CHARS, AI_SETTLEMENT_MAX_CONCURRENT_REQUESTS,
    AI_SETTLEMENT_MAX_SETTLEMENTS, AI_SETTLEMENT_MESSAGE_MAX_CHARS,
    AI_SETTLEMENT_PROMPT_MAX_CHARS, AI_SETTLEMENT_SETTINGS_ID,
};
use crate::entities::{
    ai_engine, ai_settlement_parse_result, ai_settlement_settings,
    ai_settlement_test_message,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use futures::stream::{self, StreamExt};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use types::{
    AiSettlementEngineItem, AiSettlementPageRsp, AiSettlementParseResultItem,
    AiSettlementParsingRsp, AiSettlementPromptState,
    AiSettlementTestMessageIdReq, AiSettlementTestMessageItem,
    AiSettlementWorkerSettingsItem, CreateAiSettlementTestMessageReq,
    RunAiSettlementParsingReq, SaveAiSettlementParsingReq,
    SaveAiSettlementWorkerSettingsReq, UpdateAiSettlementTestMessageReq,
};
use uuid::Uuid;

#[post("/api/admin/ai-settlements/page")]
pub async fn get_ai_settlement_page(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiSettlementPageRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(load_page(&env.dbx).await.context(h!())?))
}

#[post("/api/admin/ai-settlements/prompt/reset")]
pub async fn reset_ai_settlement_prompt(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiSettlementPromptState>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    reset_prompt(&env.dbx).await.context(h!())?;
    Ok(Json(prompt_state("")))
}

#[post("/api/admin/ai-settlements/messages/create")]
pub async fn create_ai_settlement_test_message(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<CreateAiSettlementTestMessageReq>,
) -> Result<Json<AiSettlementTestMessageItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let message = validate_message(req.into_inner().message).context(h!())?;
    let now = Utc::now().naive_utc();
    let message = ai_settlement_test_message::ActiveModel {
        id: Set(Uuid::now_v7()),
        message: Set(message),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(test_message_item(message, Vec::new())))
}

#[post("/api/admin/ai-settlements/messages/update")]
pub async fn update_ai_settlement_test_message(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<UpdateAiSettlementTestMessageReq>,
) -> Result<Json<AiSettlementTestMessageItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let message_id = parse_uuid(&req.id).context(h!())?;
    let message_text = validate_message(req.message).context(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    let message = find_test_message(&transaction, message_id)
        .await
        .context(h!())?;
    ai_settlement_parse_result::Entity::delete_many()
        .filter(
            ai_settlement_parse_result::Column::AiSettlementTestMessageId
                .eq(message_id),
        )
        .exec(&transaction)
        .await
        .c(h!())?;
    let mut message = message.into_active_model();
    message.message = Set(message_text);
    message.updated_at = Set(Utc::now().naive_utc());
    let message = message.update(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(test_message_item(message, Vec::new())))
}

#[post("/api/admin/ai-settlements/messages/delete")]
pub async fn delete_ai_settlement_test_message(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiSettlementTestMessageIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let message_id = parse_uuid(&req.id).context(h!())?;
    find_test_message(&env.dbx, message_id)
        .await
        .context(h!())?;
    ai_settlement_test_message::Entity::delete_by_id(message_id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/admin/ai-settlements/test")]
pub async fn test_ai_settlement_parsing(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<RunAiSettlementParsingReq>,
) -> Result<Json<AiSettlementParsingRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let prompt = validate_prompt(req.prompt).context(h!())?;
    let engines = load_enabled_engines(&env.dbx, req.ai_engine_ids)
        .await
        .context(h!())?;
    let messages = load_test_messages(&env.dbx).await.context(h!())?;
    let results = run_parsing(prompt, engines, messages).await;
    Ok(Json(AiSettlementParsingRsp { results }))
}

#[post("/api/admin/ai-settlements/save")]
pub async fn save_ai_settlement_parsing(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiSettlementParsingReq>,
) -> Result<Json<AiSettlementParsingRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let prompt = validate_prompt(req.prompt).context(h!())?;
    let results = validate_results(&env.dbx, req.results)
        .await
        .context(h!())?;
    let results = save_prompt_and_results(&env.dbx, prompt, results)
        .await
        .context(h!())?;
    Ok(Json(AiSettlementParsingRsp { results }))
}

#[post("/api/admin/ai-settlements/recalculate")]
pub async fn recalculate_ai_settlement_parsing(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<RunAiSettlementParsingReq>,
) -> Result<Json<AiSettlementParsingRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let prompt = validate_prompt(req.prompt).context(h!())?;
    let engines = load_enabled_engines(&env.dbx, req.ai_engine_ids)
        .await
        .context(h!())?;
    let messages = load_test_messages(&env.dbx).await.context(h!())?;
    let results = run_parsing(prompt.clone(), engines, messages).await;
    let results = save_prompt_and_results(&env.dbx, prompt, results)
        .await
        .context(h!())?;
    Ok(Json(AiSettlementParsingRsp { results }))
}

#[post("/api/admin/ai-settlements/worker/save")]
pub async fn save_ai_settlement_worker_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiSettlementWorkerSettingsReq>,
) -> Result<Json<AiSettlementWorkerSettingsItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let ai_engine_id =
        validate_worker_engine(&env.dbx, req.enabled, req.ai_engine_id)
            .await
            .context(h!())?;
    let settings = save_worker_settings(&env.dbx, req.enabled, ai_engine_id)
        .await
        .context(h!())?;
    Ok(Json(worker_settings_item(&settings)))
}

async fn load_page(
    dbx: &DatabaseConnection,
) -> Result<AiSettlementPageRsp, AppError> {
    let settings =
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .one(dbx)
            .await
            .c(h!())?;
    let prompt_override =
        settings.as_ref().map(|settings| settings.prompt.as_str());
    let prompt =
        effective_prompt(prompt_override.unwrap_or_default()).to_string();
    let worker = settings.as_ref().map(worker_settings_item).unwrap_or(
        AiSettlementWorkerSettingsItem {
            enabled: false,
            ai_engine_id: None,
        },
    );
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .order_by_asc(ai_engine::Column::Name)
        .all(dbx)
        .await
        .c(h!())?;
    let engine_ids: Vec<Uuid> =
        engines.iter().map(|engine| engine.id).collect();
    let messages = load_test_messages(dbx).await.context(h!())?;
    let results = if engine_ids.is_empty() {
        Vec::new()
    } else {
        ai_settlement_parse_result::Entity::find()
            .filter(ai_settlement_parse_result::Column::Prompt.eq(&prompt))
            .filter(
                ai_settlement_parse_result::Column::AiEngineId
                    .is_in(engine_ids),
            )
            .all(dbx)
            .await
            .c(h!())?
    };
    let mut results_by_message: HashMap<
        Uuid,
        Vec<AiSettlementParseResultItem>,
    > = HashMap::new();
    for result in results {
        results_by_message
            .entry(result.ai_settlement_test_message_id)
            .or_default()
            .push(result_item_from_db(result).context(h!())?);
    }
    Ok(AiSettlementPageRsp {
        prompt,
        prompt_overridden: prompt_override
            .is_some_and(|prompt| !prompt.is_empty()),
        worker,
        engines: engines
            .into_iter()
            .map(|engine| AiSettlementEngineItem {
                id: engine.id.to_string(),
                name: engine.name,
                model_name: engine.model_name,
            })
            .collect(),
        messages: messages
            .into_iter()
            .map(|message| {
                let results =
                    results_by_message.remove(&message.id).unwrap_or_default();
                test_message_item(message, results)
            })
            .collect(),
    })
}

fn worker_settings_item(
    settings: &ai_settlement_settings::Model,
) -> AiSettlementWorkerSettingsItem {
    AiSettlementWorkerSettingsItem {
        enabled: settings.worker_enabled,
        ai_engine_id: settings
            .worker_ai_engine_id
            .map(|ai_engine_id| ai_engine_id.to_string()),
    }
}

async fn validate_worker_engine(
    dbx: &DatabaseConnection,
    enabled: bool,
    ai_engine_id: Option<String>,
) -> Result<Option<Uuid>, AppError> {
    let ai_engine_id = ai_engine_id
        .as_deref()
        .map(parse_uuid)
        .transpose()
        .context(h!())?;
    if enabled && ai_engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Оберіть ШІ движок для воркера".to_string(),
        });
    }
    let Some(ai_engine_id) = ai_engine_id else {
        return Ok(None);
    };
    let exists = ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if !exists {
        return Err(AppError::BL {
            msg: "Вибраний ШІ движок вимкнено або видалено".to_string(),
        });
    }
    Ok(Some(ai_engine_id))
}

async fn save_worker_settings(
    dbx: &DatabaseConnection,
    enabled: bool,
    ai_engine_id: Option<Uuid>,
) -> Result<ai_settlement_settings::Model, AppError> {
    let now = Utc::now().naive_utc();
    ai_settlement_settings::Entity::insert(
        ai_settlement_settings::ActiveModel {
            id: Set(AI_SETTLEMENT_SETTINGS_ID),
            prompt: Set(String::new()),
            updated_at: Set(now),
            worker_enabled: Set(enabled),
            worker_ai_engine_id: Set(ai_engine_id),
        },
    )
    .on_conflict(
        OnConflict::column(ai_settlement_settings::Column::Id)
            .update_columns([
                ai_settlement_settings::Column::WorkerEnabled,
                ai_settlement_settings::Column::WorkerAiEngineId,
                ai_settlement_settings::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(
        ai_settlement_settings::Entity::find_by_id(AI_SETTLEMENT_SETTINGS_ID)
            .one(dbx)
            .await
            .c(h!())?
            .c(h!())?,
    )
}

pub(crate) fn effective_prompt(prompt: &str) -> &str {
    if prompt.is_empty() {
        AI_SETTLEMENT_DEFAULT_PROMPT
    } else {
        prompt
    }
}

fn prompt_state(prompt: &str) -> AiSettlementPromptState {
    AiSettlementPromptState {
        prompt: effective_prompt(prompt).to_string(),
        prompt_overridden: !prompt.is_empty(),
    }
}

async fn load_enabled_engines(
    dbx: &DatabaseConnection,
    ids: Vec<String>,
) -> Result<Vec<ai_engine::Model>, AppError> {
    let ids = parse_unique_uuids(ids).context(h!())?;
    if ids.is_empty() {
        return Err(AppError::BL {
            msg: "Оберіть хоча б один увімкнений ШІ движок".to_string(),
        });
    }
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Id.is_in(ids.iter().copied()))
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .order_by_asc(ai_engine::Column::Name)
        .all(dbx)
        .await
        .c(h!())?;
    if engines.len() != ids.len() {
        return Err(AppError::BL {
            msg: "Один або декілька ШІ движків вимкнено або видалено"
                .to_string(),
        });
    }
    Ok(engines)
}

async fn load_test_messages<C>(
    dbx: &C,
) -> Result<Vec<ai_settlement_test_message::Model>, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    Ok(ai_settlement_test_message::Entity::find()
        .order_by_asc(ai_settlement_test_message::Column::CreatedAt)
        .order_by_asc(ai_settlement_test_message::Column::Id)
        .all(dbx)
        .await
        .c(h!())?)
}

async fn find_test_message<C>(
    dbx: &C,
    message_id: Uuid,
) -> Result<ai_settlement_test_message::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    ai_settlement_test_message::Entity::find_by_id(message_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

fn test_message_item(
    message: ai_settlement_test_message::Model,
    results: Vec<AiSettlementParseResultItem>,
) -> AiSettlementTestMessageItem {
    AiSettlementTestMessageItem {
        id: message.id.to_string(),
        message: message.message,
        created_at: message.created_at.and_utc().timestamp_millis(),
        updated_at: message.updated_at.and_utc().timestamp_millis(),
        results,
    }
}

fn result_item_from_db(
    result: ai_settlement_parse_result::Model,
) -> Result<AiSettlementParseResultItem, AppError> {
    Ok(AiSettlementParseResultItem {
        test_message_id: result.ai_settlement_test_message_id.to_string(),
        ai_engine_id: result.ai_engine_id.to_string(),
        settlements: serde_json::from_value(result.settlements).c(h!())?,
        error: result.error,
        response_text: result.response_text,
        updated_at: Some(result.updated_at.and_utc().timestamp_millis()),
    })
}

async fn run_parsing(
    prompt: String,
    engines: Vec<ai_engine::Model>,
    messages: Vec<ai_settlement_test_message::Model>,
) -> Vec<AiSettlementParseResultItem> {
    let jobs = engines.into_iter().flat_map(|engine| {
        let prompt = prompt.clone();
        messages.clone().into_iter().map(move |message| {
            let engine = engine.clone();
            let prompt = prompt.clone();
            async move { parse_one(prompt, engine, message).await }
        })
    });
    stream::iter(jobs)
        .buffer_unordered(AI_SETTLEMENT_MAX_CONCURRENT_REQUESTS)
        .collect()
        .await
}

async fn parse_one(
    prompt: String,
    engine: ai_engine::Model,
    message: ai_settlement_test_message::Model,
) -> AiSettlementParseResultItem {
    let response = request_ai_response(
        &engine,
        vec![
            AiEngineMessage {
                role: AI_CHAT_ROLE_SYSTEM.to_string(),
                content: prompt,
            },
            AiEngineMessage {
                role: AI_CHAT_ROLE_USER.to_string(),
                content: message.message,
            },
        ],
    )
    .await;
    match response {
        Ok(response_text) => match parse_settlements(&response_text) {
            Ok(settlements) => AiSettlementParseResultItem {
                test_message_id: message.id.to_string(),
                ai_engine_id: engine.id.to_string(),
                settlements,
                error: None,
                response_text,
                updated_at: None,
            },
            Err(error) => AiSettlementParseResultItem {
                test_message_id: message.id.to_string(),
                ai_engine_id: engine.id.to_string(),
                settlements: Vec::new(),
                error: Some(format!("{error:#}")),
                response_text,
                updated_at: None,
            },
        },
        Err(error) => AiSettlementParseResultItem {
            test_message_id: message.id.to_string(),
            ai_engine_id: engine.id.to_string(),
            settlements: Vec::new(),
            error: Some(error.to_string()),
            response_text: String::new(),
            updated_at: None,
        },
    }
}

pub(crate) fn parse_settlements(
    response_text: &str,
) -> anyhow::Result<Vec<String>> {
    let response_json = strip_json_code_fence(response_text);
    let value: serde_json::Value = serde_json::from_str(response_json)
        .map_err(|error| anyhow::anyhow!("Некоректний JSON: {error}"))
        .c(h!())?;
    let values = if let Some(values) = value.as_array() {
        values
    } else {
        value
            .get("settlements")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Очікувався JSON-масив або об'єкт з масивом settlements"
                )
            })
            .c(h!())?
    };
    if values.len() > AI_SETTLEMENT_MAX_SETTLEMENTS {
        return Err(anyhow::anyhow!(
            "Отримано більше {AI_SETTLEMENT_MAX_SETTLEMENTS} населених пунктів"
        ));
    }
    let mut seen = HashSet::new();
    let mut settlements = Vec::new();
    for value in values {
        let settlement = value
            .as_str()
            .ok_or_else(|| {
                anyhow::anyhow!("Кожен елемент settlements повинен бути рядком")
            })
            .c(h!())?;
        let settlement = settlement.trim();
        if settlement.is_empty() {
            continue;
        }
        if settlement.chars().count() > AI_SETTLEMENT_MAX_CHARS {
            return Err(anyhow::anyhow!(
                "Назва має містити не більше {AI_SETTLEMENT_MAX_CHARS} символів"
            ));
        }
        if seen.insert(settlement.to_string()) {
            settlements.push(settlement.to_string());
        }
    }
    Ok(settlements)
}

fn strip_json_code_fence(response_text: &str) -> &str {
    let response_text = response_text.trim();
    if !response_text.starts_with("```") {
        return response_text;
    }
    let response_text = response_text
        .split_once('\n')
        .map(|(_, body)| body)
        .unwrap_or(response_text);
    response_text
        .strip_suffix("```")
        .unwrap_or(response_text)
        .trim()
}

async fn validate_results(
    dbx: &DatabaseConnection,
    results: Vec<AiSettlementParseResultItem>,
) -> Result<Vec<AiSettlementParseResultItem>, AppError> {
    let mut pairs = HashSet::new();
    let mut message_ids = HashSet::new();
    let mut engine_ids = HashSet::new();
    let mut validated = Vec::with_capacity(results.len());
    for result in results {
        let message_id = parse_uuid(&result.test_message_id).context(h!())?;
        let engine_id = parse_uuid(&result.ai_engine_id).context(h!())?;
        if !pairs.insert((message_id, engine_id)) {
            return Err(AppError::BL {
                msg: "Результат для повідомлення і движка дублюється"
                    .to_string(),
            });
        }
        message_ids.insert(message_id);
        engine_ids.insert(engine_id);
        validated.push(normalize_result(result).context(h!())?);
    }
    validate_result_references(dbx, message_ids, engine_ids)
        .await
        .context(h!())?;
    Ok(validated)
}

async fn validate_result_references(
    dbx: &DatabaseConnection,
    message_ids: HashSet<Uuid>,
    engine_ids: HashSet<Uuid>,
) -> Result<(), AppError> {
    if !message_ids.is_empty() {
        let count = ai_settlement_test_message::Entity::find()
            .filter(
                ai_settlement_test_message::Column::Id
                    .is_in(message_ids.iter().copied()),
            )
            .count(dbx)
            .await
            .c(h!())? as usize;
        if count != message_ids.len() {
            return Err(AppError::BL {
                msg: "Одне або декілька тестових повідомлень видалено"
                    .to_string(),
            });
        }
    }
    if !engine_ids.is_empty() {
        let count = ai_engine::Entity::find()
            .filter(ai_engine::Column::Id.is_in(engine_ids.iter().copied()))
            .filter(ai_engine::Column::Enabled.eq(true))
            .filter(ai_engine::Column::CallsignEnabled.eq(true))
            .count(dbx)
            .await
            .c(h!())? as usize;
        if count != engine_ids.len() {
            return Err(AppError::BL {
                msg: "Один або декілька ШІ движків вимкнено або видалено"
                    .to_string(),
            });
        }
    }
    Ok(())
}

fn normalize_result(
    mut result: AiSettlementParseResultItem,
) -> Result<AiSettlementParseResultItem, AppError> {
    if result.settlements.len() > AI_SETTLEMENT_MAX_SETTLEMENTS {
        return Err(AppError::BL {
            msg: format!(
                "Результат має містити не більше {AI_SETTLEMENT_MAX_SETTLEMENTS} населених пунктів"
            ),
        });
    }
    let mut seen = HashSet::new();
    let mut settlements = Vec::new();
    for settlement in result.settlements {
        let settlement = validate_required(
            settlement,
            "Назва населеного пункту не може бути порожньою",
            AI_SETTLEMENT_MAX_CHARS,
        )
        .context(h!())?;
        if seen.insert(settlement.clone()) {
            settlements.push(settlement);
        }
    }
    result.settlements = settlements;
    result.error = result
        .error
        .map(|error| error.trim().to_string())
        .filter(|error| !error.is_empty());
    if result.error.is_some() {
        result.settlements.clear();
    }
    result.updated_at = None;
    Ok(result)
}

async fn save_prompt_and_results(
    dbx: &DatabaseConnection,
    prompt: String,
    mut results: Vec<AiSettlementParseResultItem>,
) -> Result<Vec<AiSettlementParseResultItem>, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let now = Utc::now().naive_utc();
    clear_results_for_other_prompts(&transaction, &prompt)
        .await
        .context(h!())?;
    save_prompt(&transaction, prompt.clone(), now)
        .await
        .context(h!())?;
    for result in &results {
        save_result(&transaction, result, &prompt, now)
            .await
            .context(h!())?;
    }
    transaction.commit().await.c(h!())?;
    let updated_at = now.and_utc().timestamp_millis();
    for result in &mut results {
        result.updated_at = Some(updated_at);
    }
    Ok(results)
}

async fn clear_results_for_other_prompts(
    transaction: &DatabaseTransaction,
    prompt: &str,
) -> Result<(), AppError> {
    ai_settlement_parse_result::Entity::delete_many()
        .filter(ai_settlement_parse_result::Column::Prompt.ne(prompt))
        .exec(transaction)
        .await
        .c(h!())?;
    Ok(())
}

async fn save_prompt(
    transaction: &DatabaseTransaction,
    prompt: String,
    now: NaiveDateTime,
) -> Result<(), AppError> {
    ai_settlement_settings::Entity::insert(
        ai_settlement_settings::ActiveModel {
            id: Set(AI_SETTLEMENT_SETTINGS_ID),
            prompt: Set(prompt),
            updated_at: Set(now),
            worker_enabled: NotSet,
            worker_ai_engine_id: NotSet,
        },
    )
    .on_conflict(
        OnConflict::column(ai_settlement_settings::Column::Id)
            .update_columns([
                ai_settlement_settings::Column::Prompt,
                ai_settlement_settings::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(transaction)
    .await
    .c(h!())?;
    Ok(())
}

async fn reset_prompt(dbx: &DatabaseConnection) -> Result<(), AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    clear_results_for_other_prompts(&transaction, AI_SETTLEMENT_DEFAULT_PROMPT)
        .await
        .context(h!())?;
    save_prompt(&transaction, String::new(), Utc::now().naive_utc())
        .await
        .context(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn save_result(
    transaction: &DatabaseTransaction,
    result: &AiSettlementParseResultItem,
    prompt: &str,
    now: NaiveDateTime,
) -> Result<(), AppError> {
    ai_settlement_parse_result::Entity::insert(
        ai_settlement_parse_result::ActiveModel {
            ai_settlement_test_message_id: Set(
                parse_uuid(&result.test_message_id).context(h!())?,
            ),
            ai_engine_id: Set(
                parse_uuid(&result.ai_engine_id).context(h!())?,
            ),
            prompt: Set(prompt.to_string()),
            settlements: Set(serde_json::to_value(&result.settlements).c(h!())?),
            error: Set(result.error.clone()),
            response_text: Set(result.response_text.clone()),
            updated_at: Set(now),
        },
    )
    .on_conflict(
        OnConflict::columns([
            ai_settlement_parse_result::Column::AiSettlementTestMessageId,
            ai_settlement_parse_result::Column::AiEngineId,
        ])
        .update_columns([
            ai_settlement_parse_result::Column::Prompt,
            ai_settlement_parse_result::Column::Settlements,
            ai_settlement_parse_result::Column::Error,
            ai_settlement_parse_result::Column::ResponseText,
            ai_settlement_parse_result::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec(transaction)
    .await
    .c(h!())?;
    Ok(())
}

fn validate_prompt(prompt: String) -> Result<String, AppError> {
    validate_required(
        prompt,
        "Вкажіть промпт для пошуку населених пунктів",
        AI_SETTLEMENT_PROMPT_MAX_CHARS,
    )
}

fn validate_message(message: String) -> Result<String, AppError> {
    validate_required(
        message,
        "Вкажіть текст тестового повідомлення",
        AI_SETTLEMENT_MESSAGE_MAX_CHARS,
    )
}

fn validate_required(
    value: String,
    error: &str,
    max_chars: usize,
) -> Result<String, AppError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(AppError::BL {
            msg: error.to_string(),
        });
    }
    if value.chars().count() > max_chars {
        return Err(AppError::BL {
            msg: format!("Значення має містити не більше {max_chars} символів"),
        });
    }
    Ok(value)
}

fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Некоректний UUID".to_string(),
    })
}

fn parse_unique_uuids(values: Vec<String>) -> Result<HashSet<Uuid>, AppError> {
    values.into_iter().map(|value| parse_uuid(&value)).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        effective_prompt, parse_settlements, prompt_state,
        strip_json_code_fence,
    };
    use crate::config::{
        AI_SETTLEMENT_DEFAULT_PROMPT, AI_SETTLEMENT_SETTINGS_ID,
    };
    use crate::entities::ai_settlement_settings;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
    use serial_test::serial;

    #[test]
    fn parses_object_and_deduplicates_settlements() {
        assert_eq!(
            parse_settlements(
                r#"{"settlements":["АРТІЛЬНЕ"," АРТІЛЬНЕ ","КВАШИНЕ"]}"#
            )
            .unwrap(),
            vec!["АРТІЛЬНЕ", "КВАШИНЕ"]
        );
    }

    #[test]
    fn parses_array_response() {
        assert_eq!(
            parse_settlements(r#"["АРТІЛЬНЕ","КВАШИНЕ"]"#).unwrap(),
            vec!["АРТІЛЬНЕ", "КВАШИНЕ"]
        );
    }

    #[test]
    fn strips_markdown_json_fence() {
        assert_eq!(
            strip_json_code_fence("```json\n{\"settlements\":[]}\n```"),
            "{\"settlements\":[]}"
        );
    }

    #[test]
    fn parser_errors_include_source_context() {
        for response in ["not json", "{}", r#"{"settlements":[42]}"#] {
            let error =
                format!("{:#}", parse_settlements(response).unwrap_err());
            assert!(
                error.contains("at wdintel-rs/src/ai_settlement/mod.rs line"),
                "{error}"
            );
        }
    }

    #[test]
    fn empty_prompt_uses_static_default_while_override_is_retained() {
        assert_eq!(effective_prompt(""), AI_SETTLEMENT_DEFAULT_PROMPT);
        assert_eq!(effective_prompt("override"), "override");
        assert!(!prompt_state("").prompt_overridden);
        assert!(prompt_state("override").prompt_overridden);
    }

    #[tokio::test]
    #[serial]
    async fn reset_persists_fallback_without_changing_worker_settings() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        ai_settlement_settings::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let now = chrono::Utc::now().naive_utc();
        ai_settlement_settings::ActiveModel {
            id: Set(AI_SETTLEMENT_SETTINGS_ID),
            prompt: Set("override".to_string()),
            updated_at: Set(now),
            worker_enabled: Set(true),
            worker_ai_engine_id: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        super::reset_prompt(&env.dbx).await.unwrap();

        let settings = ai_settlement_settings::Entity::find_by_id(
            AI_SETTLEMENT_SETTINGS_ID,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(settings.prompt.is_empty());
        assert!(settings.worker_enabled);
        assert_eq!(settings.worker_ai_engine_id, None);
        let page = super::load_page(&env.dbx).await.unwrap();
        assert_eq!(page.prompt, AI_SETTLEMENT_DEFAULT_PROMPT);
        assert!(!page.prompt_overridden);
    }
}
