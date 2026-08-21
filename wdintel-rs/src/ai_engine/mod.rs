pub mod types;

use crate::config::{
    AI_CHAT_PROMPT_MAX_CHARS, AI_CHAT_ROLE_ASSISTANT, AI_CHAT_ROLE_USER,
    AI_CHAT_TITLE_MAX_CHARS, AI_ENGINE_ERROR_BODY_MAX_CHARS,
    AI_ENGINE_MODEL_NAME_MAX_CHARS, AI_ENGINE_NAME_MAX_CHARS,
    AI_ENGINE_REQUEST_TIMEOUT_SEC, AI_ENGINE_TOKEN_MAX_CHARS,
    AI_ENGINE_URL_MAX_CHARS,
};
use crate::entities::{
    ai_callsign_settings, ai_chat, ai_chat_message, ai_engine, login,
    media_summary, media_summary_settings, ocr_job, ocr_settings,
    ocr_settings_ai_engine,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use crate::users::{ensure_admin, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{post, web::Json};
use base64::Engine;
use chrono::Utc;
use reqwest::StatusCode;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, TransactionTrait,
};
use std::time::Duration;
use types::{
    AiChatDetail, AiChatGetReq, AiChatListReq, AiChatListRsp,
    AiChatMessageItem, AiChatSummary, AiEngineIdReq, AiEngineItem,
    AiEngineListRsp, CreateAiEngineReq, SendAiChatMessageReq,
    UpdateAiEngineReq,
};
use url::Url;
use uuid::Uuid;

struct AiEngineValues {
    name: String,
    url: String,
    token: Option<String>,
    model_name: String,
    enabled: bool,
    callsign_enabled: bool,
    ocr_enabled: bool,
}

#[derive(Serialize)]
struct OpenAiChatCompletionReq {
    #[serde(rename = "model")]
    model_name: String,
    messages: Vec<AiEngineMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct AiEngineMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct OpenAiChatCompletionRsp {
    choices: Vec<OpenAiChatChoice>,
    model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEngineOcrResponse {
    pub content: String,
    pub finish_reason: Option<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub model_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiEngineOcrRequest {
    pub request_id: String,
    pub page_id: String,
    pub unit_id: String,
    pub prompt_version: String,
    pub retry: bool,
    #[serde(skip_serializing)]
    pub image_png: Vec<u8>,
}

#[derive(Deserialize)]
struct OcrCompletionResponse {
    choices: Vec<OcrCompletionChoice>,
    model: Option<String>,
    usage: Option<OcrUsage>,
}

#[derive(Deserialize)]
struct OcrCompletionChoice {
    message: OcrCompletionMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OcrCompletionMessage {
    content: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct OcrUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

pub struct AiEngineResponse {
    pub content: String,
    pub finish_reason: Option<String>,
    pub model_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChatResponseMessage {
    content: Option<String>,
}

#[post("/api/admin/ai-engines/list")]
pub async fn list_ai_engines(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiEngineListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let items = ai_engine::Entity::find()
        .order_by_asc(ai_engine::Column::Name)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(AiEngineItem::from)
        .collect();
    Ok(Json(AiEngineListRsp { items }))
}

#[post("/api/admin/ai-engines/get")]
pub async fn get_ai_engine(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiEngineIdReq>,
) -> Result<Json<AiEngineItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let ai_engine_id = parse_uuid(&req.id)?;
    let ai_engine = find_ai_engine(&env.dbx, ai_engine_id).await?;
    Ok(Json(AiEngineItem::from(ai_engine)))
}

#[post("/api/admin/ai-engines/create")]
pub async fn create_ai_engine(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<CreateAiEngineReq>,
) -> Result<Json<AiEngineItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let values = validate_create_values(req.into_inner())?;
    ensure_unique_name(&env.dbx, &values.name, None).await?;
    let now = Utc::now().naive_utc();
    let ai_engine = ai_engine::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(values.name),
        url: Set(values.url),
        token: Set(values.token),
        model_name: Set(values.model_name),
        enabled: Set(values.enabled),
        callsign_enabled: Set(values.callsign_enabled),
        ocr_enabled: Set(values.ocr_enabled),
        ocr_request_profile: Set("openai_vision".to_string()),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(AiEngineItem::from(ai_engine)))
}

#[post("/api/admin/ai-engines/update")]
pub async fn update_ai_engine(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<UpdateAiEngineReq>,
) -> Result<Json<AiEngineItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let ai_engine_id = parse_uuid(&req.id)?;
    let ai_engine = find_ai_engine(&env.dbx, ai_engine_id).await?;
    let values = validate_update_values(req, ai_engine.token.clone())?;
    if !values.enabled || !values.callsign_enabled {
        ensure_not_used_by_enabled_callsign_worker(&env.dbx, ai_engine_id)
            .await?;
        crate::ai_intel_report::ensure_engine_not_used(&env.dbx, ai_engine_id)
            .await
            .c(h!())?;
    }
    if !values.enabled {
        ensure_not_used_by_media_summary(&env.dbx, ai_engine_id)
            .await
            .c(h!())?;
    }
    if !values.ocr_enabled {
        ensure_not_used_by_ocr(&env.dbx, ai_engine_id).await?;
    }
    ensure_unique_name(&env.dbx, &values.name, Some(ai_engine_id)).await?;
    let mut ai_engine = ai_engine.into_active_model();
    ai_engine.name = Set(values.name);
    ai_engine.url = Set(values.url);
    ai_engine.token = Set(values.token);
    ai_engine.model_name = Set(values.model_name);
    ai_engine.enabled = Set(values.enabled);
    ai_engine.callsign_enabled = Set(values.callsign_enabled);
    ai_engine.ocr_enabled = Set(values.ocr_enabled);
    ai_engine.updated_at = Set(Utc::now().naive_utc());
    let ai_engine = ai_engine.update(&env.dbx).await.c(h!())?;
    Ok(Json(AiEngineItem::from(ai_engine)))
}

#[post("/api/admin/ai-engines/delete")]
pub async fn delete_ai_engine(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiEngineIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let ai_engine_id = parse_uuid(&req.id)?;
    find_ai_engine(&env.dbx, ai_engine_id).await?;
    ensure_not_used_by_enabled_callsign_worker(&env.dbx, ai_engine_id).await?;
    crate::ai_intel_report::ensure_engine_not_used(&env.dbx, ai_engine_id)
        .await
        .c(h!())?;
    ensure_not_used_by_media_summary(&env.dbx, ai_engine_id)
        .await
        .c(h!())?;
    ensure_not_used_by_ocr(&env.dbx, ai_engine_id).await?;
    ai_engine::Entity::delete_by_id(ai_engine_id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

async fn ensure_not_used_by_enabled_callsign_worker(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<(), AppError> {
    let is_used = ai_callsign_settings::Entity::find()
        .filter(ai_callsign_settings::Column::WorkerEnabled.eq(true))
        .filter(ai_callsign_settings::Column::WorkerAiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_used {
        return Err(AppError::BL {
            msg: "ШІ движок використовується воркером позивних. Спочатку вимкніть воркер або виберіть інший движок.".to_string(),
        });
    }
    Ok(())
}

async fn ensure_not_used_by_media_summary(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<(), AppError> {
    let selected_by_enabled_settings = media_summary_settings::Entity::find()
        .filter(media_summary_settings::Column::Enabled.eq(true))
        .filter(media_summary_settings::Column::AiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let has_nonterminal_job = media_summary::Entity::find()
        .filter(media_summary::Column::AiEngineId.eq(ai_engine_id))
        .filter(media_summary::Column::State.is_in([
            "queued",
            "running",
            "retry_wait",
        ]))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if selected_by_enabled_settings || has_nonterminal_job {
        return Err(AppError::BL {
            msg: "ШІ движок використовується стислим описом документів. Спочатку вимкніть описи, виберіть інший движок або дочекайтеся завершення завдань.".to_string(),
        });
    }
    Ok(())
}

async fn ensure_not_used_by_ocr(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<(), AppError> {
    let selected = ocr_settings_ai_engine::Entity::find()
        .filter(ocr_settings_ai_engine::Column::AiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let selected_as_main = ocr_settings::Entity::find()
        .filter(ocr_settings::Column::MainAiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let has_active_job = ocr_job::Entity::find()
        .filter(ocr_job::Column::AiEngineId.eq(ai_engine_id))
        .filter(ocr_job::Column::State.is_in([
            "queued",
            "submitted",
            "retry_wait",
        ]))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if selected || selected_as_main || has_active_job {
        return Err(AppError::BL {
            msg: "ШІ движок використовується OCR. Спочатку приберіть його з OCR-налаштувань або дочекайтеся завершення завдань.".to_string(),
        });
    }
    Ok(())
}

#[post("/api/admin/ai-engines/chats/list")]
pub async fn list_ai_chats(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiChatListReq>,
) -> Result<Json<AiChatListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let ai_engine_id = parse_uuid(&req.ai_engine_id)?;
    find_ai_engine(&env.dbx, ai_engine_id).await?;
    let ai_chats = ai_chat::Entity::find()
        .filter(ai_chat::Column::AiEngineId.eq(ai_engine_id))
        .order_by_desc(ai_chat::Column::UpdatedAt)
        .order_by_desc(ai_chat::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let items = chat_summaries(&env.dbx, ai_chats).await?;
    Ok(Json(AiChatListRsp { items }))
}

#[post("/api/admin/ai-engines/chats/get")]
pub async fn get_ai_chat(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiChatGetReq>,
) -> Result<Json<AiChatDetail>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let ai_engine_id = parse_uuid(&req.ai_engine_id)?;
    let chat_id = parse_uuid(&req.chat_id)?;
    Ok(Json(
        load_chat_detail(&env.dbx, ai_engine_id, chat_id).await?,
    ))
}

#[post("/api/admin/ai-engines/chats/send")]
pub async fn send_ai_chat_message(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SendAiChatMessageReq>,
) -> Result<Json<AiChatDetail>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = login_id_from_identity(&user)?;
    let req = req.into_inner();
    let ai_engine_id = parse_uuid(&req.ai_engine_id)?;
    let ai_engine = find_ai_engine(&env.dbx, ai_engine_id).await?;
    let prompt = validate_prompt(req.prompt)?;
    let chat_id = req.chat_id.as_deref().map(parse_uuid).transpose()?;
    let (ai_chat, mut messages) =
        load_chat_for_send(&env.dbx, ai_engine_id, chat_id).await?;
    messages.push(AiEngineMessage {
        role: AI_CHAT_ROLE_USER.to_string(),
        content: prompt.clone(),
    });
    let response = request_ai_response(&ai_engine, messages).await?;
    let chat_id = save_chat_exchange(
        &env.dbx,
        ai_engine_id,
        login_id,
        ai_chat,
        prompt,
        response,
    )
    .await?;
    Ok(Json(
        load_chat_detail(&env.dbx, ai_engine_id, chat_id).await?,
    ))
}

impl From<ai_engine::Model> for AiEngineItem {
    fn from(ai_engine: ai_engine::Model) -> Self {
        Self {
            id: ai_engine.id.to_string(),
            name: ai_engine.name,
            url: ai_engine.url,
            model_name: ai_engine.model_name,
            enabled: ai_engine.enabled,
            callsign_enabled: ai_engine.callsign_enabled,
            ocr_enabled: ai_engine.ocr_enabled,
            has_token: ai_engine.token.is_some(),
            created_at: ai_engine.created_at.and_utc().timestamp_millis(),
            updated_at: ai_engine.updated_at.and_utc().timestamp_millis(),
        }
    }
}

fn validate_create_values(
    req: CreateAiEngineReq,
) -> Result<AiEngineValues, AppError> {
    Ok(AiEngineValues {
        name: validate_required(
            req.name,
            "Вкажіть назву ШІ движка",
            AI_ENGINE_NAME_MAX_CHARS,
        )?,
        url: validate_url(req.url)?,
        token: validate_token(req.token)?,
        model_name: validate_required(
            req.model_name,
            "Вкажіть назву моделі",
            AI_ENGINE_MODEL_NAME_MAX_CHARS,
        )?,
        enabled: req.enabled,
        callsign_enabled: req.callsign_enabled,
        ocr_enabled: req.ocr_enabled,
    })
}

fn validate_update_values(
    req: UpdateAiEngineReq,
    current_token: Option<String>,
) -> Result<AiEngineValues, AppError> {
    let token = if req.clear_token {
        None
    } else {
        validate_token(req.token)?.or(current_token)
    };
    Ok(AiEngineValues {
        name: validate_required(
            req.name,
            "Вкажіть назву ШІ движка",
            AI_ENGINE_NAME_MAX_CHARS,
        )?,
        url: validate_url(req.url)?,
        token,
        model_name: validate_required(
            req.model_name,
            "Вкажіть назву моделі",
            AI_ENGINE_MODEL_NAME_MAX_CHARS,
        )?,
        enabled: req.enabled,
        callsign_enabled: req.callsign_enabled,
        ocr_enabled: req.ocr_enabled,
    })
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

fn validate_url(value: String) -> Result<String, AppError> {
    let value = validate_required(
        value,
        "Вкажіть URL OpenAI-сумісного API",
        AI_ENGINE_URL_MAX_CHARS,
    )?;
    let url = Url::parse(&value).map_err(|_| AppError::BL {
        msg: "Вкажіть коректний URL OpenAI-сумісного API".to_string(),
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::BL {
            msg: "URL ШІ API повинен використовувати http або https"
                .to_string(),
        });
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn validate_token(token: Option<String>) -> Result<Option<String>, AppError> {
    let token = token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty());
    if token
        .as_ref()
        .is_some_and(|token| token.chars().count() > AI_ENGINE_TOKEN_MAX_CHARS)
    {
        return Err(AppError::BL {
            msg: format!(
                "Токен має містити не більше {AI_ENGINE_TOKEN_MAX_CHARS} символів"
            ),
        });
    }
    Ok(token)
}

fn validate_prompt(prompt: String) -> Result<String, AppError> {
    validate_required(prompt, "Введіть повідомлення", AI_CHAT_PROMPT_MAX_CHARS)
}

fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Некоректний UUID".to_string(),
    })
}

async fn ensure_unique_name(
    dbx: &DatabaseConnection,
    name: &str,
    except_id: Option<Uuid>,
) -> Result<(), AppError> {
    let mut query =
        ai_engine::Entity::find().filter(ai_engine::Column::Name.eq(name));
    if let Some(except_id) = except_id {
        query = query.filter(ai_engine::Column::Id.ne(except_id));
    }
    if query.one(dbx).await.c(h!())?.is_some() {
        return Err(AppError::BL {
            msg: "ШІ движок з такою назвою вже існує".to_string(),
        });
    }
    Ok(())
}

async fn find_ai_engine(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
) -> Result<ai_engine::Model, AppError> {
    ai_engine::Entity::find_by_id(ai_engine_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn find_chat(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
    chat_id: Uuid,
) -> Result<ai_chat::Model, AppError> {
    ai_chat::Entity::find_by_id(chat_id)
        .filter(ai_chat::Column::AiEngineId.eq(ai_engine_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn chat_summaries(
    dbx: &DatabaseConnection,
    ai_chats: Vec<ai_chat::Model>,
) -> Result<Vec<AiChatSummary>, AppError> {
    let login_ids = ai_chats
        .iter()
        .map(|ai_chat| ai_chat.created_by_login_id)
        .collect();
    let login_names = crate::users::login_names_by_ids(dbx, login_ids).await?;
    Ok(ai_chats
        .into_iter()
        .map(|ai_chat| AiChatSummary {
            id: ai_chat.id.to_string(),
            title: ai_chat.title,
            created_by: login_names
                .get(&ai_chat.created_by_login_id)
                .cloned()
                .unwrap_or_else(|| ai_chat.created_by_login_id.to_string()),
            created_at: ai_chat.created_at.and_utc().timestamp_millis(),
            updated_at: ai_chat.updated_at.and_utc().timestamp_millis(),
        })
        .collect())
}

async fn load_chat_detail(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
    chat_id: Uuid,
) -> Result<AiChatDetail, AppError> {
    let ai_chat = find_chat(dbx, ai_engine_id, chat_id).await?;
    let created_by = login::Entity::find_by_id(ai_chat.created_by_login_id)
        .one(dbx)
        .await
        .c(h!())?
        .map(|login| login.login)
        .unwrap_or_else(|| ai_chat.created_by_login_id.to_string());
    let messages = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::AiChatId.eq(ai_chat.id))
        .order_by_asc(ai_chat_message::Column::CreatedAt)
        .order_by_asc(ai_chat_message::Column::Id)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|message| AiChatMessageItem {
            id: message.id.to_string(),
            role: message.role,
            content: message.content,
            created_at: message.created_at.and_utc().timestamp_millis(),
        })
        .collect();
    Ok(AiChatDetail {
        id: ai_chat.id.to_string(),
        title: ai_chat.title,
        created_by,
        created_at: ai_chat.created_at.and_utc().timestamp_millis(),
        updated_at: ai_chat.updated_at.and_utc().timestamp_millis(),
        messages,
    })
}

async fn load_chat_for_send(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
    chat_id: Option<Uuid>,
) -> Result<(Option<ai_chat::Model>, Vec<AiEngineMessage>), AppError> {
    let Some(chat_id) = chat_id else {
        return Ok((None, Vec::new()));
    };
    let ai_chat = find_chat(dbx, ai_engine_id, chat_id).await?;
    let messages = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::AiChatId.eq(chat_id))
        .order_by_asc(ai_chat_message::Column::CreatedAt)
        .order_by_asc(ai_chat_message::Column::Id)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|message| AiEngineMessage {
            role: message.role,
            content: message.content,
        })
        .collect();
    Ok((Some(ai_chat), messages))
}

pub async fn request_ai_response(
    ai_engine: &ai_engine::Model,
    messages: Vec<AiEngineMessage>,
) -> Result<String, AppError> {
    Ok(
        request_ai_response_with_options(ai_engine, messages, None, None, None)
            .await?
            .content,
    )
}

pub async fn request_ocr_response(
    ai_engine: &ai_engine::Model,
    request: AiEngineOcrRequest,
) -> Result<AiEngineOcrResponse, AppError> {
    let endpoint = chat_completions_url(&ai_engine.url)?;
    let image_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(request.image_png)
    );
    let mut body = serde_json::json!({
        "model": ai_engine.model_name,
        "temperature": 0,
        "seed": 0,
        "max_tokens": 6000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": ocr_prompt()},
                {"type": "image_url", "image_url": {"url": image_url}}
            ]
        }]
    });
    if ai_engine.ocr_request_profile == "ocr_gemma" {
        body["stop"] = serde_json::json!(["<!-- ECHO_EXTRACTION_END -->"]);
        body["include_stop_str_in_output"] = serde_json::json!(true);
        body["mm_processor_kwargs"] =
            serde_json::json!({"max_pixels": 1120_u64 * 1120});
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(AI_ENGINE_REQUEST_TIMEOUT_SEC))
        .build()
        .c(h!())?;
    let mut request_builder = client.post(endpoint).json(&body);
    if let Some(token) = ai_engine.token.as_deref() {
        request_builder = request_builder.bearer_auth(token);
    }
    let response = request_builder.send().await.c(h!())?;
    let status = response.status();
    let body = response.text().await.c(h!())?;
    if !status.is_success() {
        return Err(ai_api_error(status, body));
    }
    let response: OcrCompletionResponse =
        serde_json::from_str(&body).c(h!())?;
    let choice =
        response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| AppError::BL {
                msg: "OCR ШІ API не повернув варіант відповіді".to_string(),
            })?;
    let content = match choice.message.content {
        Some(serde_json::Value::String(content)) => content,
        Some(value) => value
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text").and_then(serde_json::Value::as_str)
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        None => String::new(),
    };
    if content.trim().is_empty() {
        return Err(AppError::BL {
            msg: "OCR ШІ API повернув порожню відповідь".to_string(),
        });
    }
    let usage = response.usage.unwrap_or_default();
    Ok(AiEngineOcrResponse {
        content,
        finish_reason: choice.finish_reason,
        prompt_tokens: usage.prompt_tokens.unwrap_or_default(),
        completion_tokens: usage.completion_tokens.unwrap_or_default(),
        total_tokens: usage.total_tokens.unwrap_or_default(),
        model_name: response.model,
    })
}

fn ocr_prompt() -> &'static str {
    "Transcribe the complete crop as bounded semantic HTML using only article, section, h1-h6, p, ul, ol, li, table, caption, thead, tbody, tr, th, td, br, and figure. Preserve empty cells and exact text. Represent visible images with data-image=\"present\". Never translate, correct, summarize, infer, add, or repeat content. End exactly with <!-- ECHO_EXTRACTION_END -->"
}

pub async fn request_structured_ai_response(
    ai_engine: &ai_engine::Model,
    messages: Vec<AiEngineMessage>,
    temperature: f32,
    max_tokens: u32,
    response_format: serde_json::Value,
) -> Result<AiEngineResponse, AppError> {
    request_ai_response_with_options(
        ai_engine,
        messages,
        Some(temperature),
        Some(max_tokens),
        Some(response_format),
    )
    .await
}

async fn request_ai_response_with_options(
    ai_engine: &ai_engine::Model,
    messages: Vec<AiEngineMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    response_format: Option<serde_json::Value>,
) -> Result<AiEngineResponse, AppError> {
    let endpoint = chat_completions_url(&ai_engine.url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(AI_ENGINE_REQUEST_TIMEOUT_SEC))
        .build()
        .c(h!())?;
    let mut request = client.post(endpoint).json(&OpenAiChatCompletionReq {
        model_name: ai_engine.model_name.clone(),
        messages,
        temperature,
        max_tokens,
        response_format,
    });
    if let Some(token) = ai_engine.token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.c(h!())?;
    let status = response.status();
    let body = response.text().await.c(h!())?;
    if !status.is_success() {
        return Err(ai_api_error(status, body));
    }
    let response: OpenAiChatCompletionRsp =
        serde_json::from_str(&body).c(h!())?;
    let choice = response
        .choices
        .into_iter()
        .find(|choice| {
            choice
                .message
                .content
                .as_deref()
                .is_some_and(|content| !content.trim().is_empty())
        })
        .ok_or_else(|| AppError::BL {
            msg: "ШІ API повернув порожню відповідь".to_string(),
        })?;
    let content = choice
        .message
        .content
        .ok_or_else(|| AppError::BL {
            msg: "ШІ API повернув порожню відповідь".to_string(),
        })
        .c(h!())?;
    Ok(AiEngineResponse {
        content,
        finish_reason: choice.finish_reason,
        model_name: response.model,
    })
}

fn chat_completions_url(base_url: &str) -> Result<Url, AppError> {
    let endpoint = if base_url
        .trim_end_matches('/')
        .ends_with("/chat/completions")
    {
        base_url.trim_end_matches('/').to_string()
    } else {
        format!("{}/chat/completions", base_url.trim_end_matches('/'))
    };
    Url::parse(&endpoint).map_err(|_| AppError::BL {
        msg: "Не вдалося сформувати URL Chat Completions API".to_string(),
    })
}

fn ai_api_error(status: StatusCode, body: String) -> AppError {
    let body: String =
        body.chars().take(AI_ENGINE_ERROR_BODY_MAX_CHARS).collect();
    AppError::BL {
        msg: format!("ШІ API повернув HTTP {status}: {body}"),
    }
}

async fn save_chat_exchange(
    dbx: &DatabaseConnection,
    ai_engine_id: Uuid,
    login_id: Uuid,
    ai_chat: Option<ai_chat::Model>,
    prompt: String,
    response: String,
) -> Result<Uuid, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let now = Utc::now().naive_utc();
    let chat_id = if let Some(ai_chat) = ai_chat {
        let chat_id = ai_chat.id;
        let mut ai_chat = ai_chat.into_active_model();
        ai_chat.updated_at = Set(now);
        ai_chat.update(&transaction).await.c(h!())?;
        chat_id
    } else {
        let chat_id = Uuid::now_v7();
        ai_chat::ActiveModel {
            id: Set(chat_id),
            ai_engine_id: Set(ai_engine_id),
            created_by_login_id: Set(login_id),
            title: Set(chat_title(&prompt)),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&transaction)
        .await
        .c(h!())?;
        chat_id
    };
    insert_chat_message(&transaction, chat_id, AI_CHAT_ROLE_USER, prompt, now)
        .await?;
    insert_chat_message(
        &transaction,
        chat_id,
        AI_CHAT_ROLE_ASSISTANT,
        response,
        Utc::now().naive_utc(),
    )
    .await?;
    transaction.commit().await.c(h!())?;
    Ok(chat_id)
}

async fn insert_chat_message(
    transaction: &sea_orm::DatabaseTransaction,
    chat_id: Uuid,
    role: &str,
    content: String,
    created_at: chrono::NaiveDateTime,
) -> Result<(), AppError> {
    ai_chat_message::ActiveModel {
        id: Set(Uuid::now_v7()),
        ai_chat_id: Set(chat_id),
        role: Set(role.to_string()),
        content: Set(content),
        created_at: Set(created_at),
    }
    .insert(transaction)
    .await
    .c(h!())?;
    Ok(())
}

fn chat_title(prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() <= AI_CHAT_TITLE_MAX_CHARS {
        return title;
    }
    let mut title: String = title
        .chars()
        .take(AI_CHAT_TITLE_MAX_CHARS.saturating_sub(1))
        .collect();
    title.push('…');
    title
}

#[cfg(test)]
mod tests {
    use super::{chat_completions_url, chat_title};

    #[test]
    fn appends_chat_completions_to_base_url() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1/")
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn keeps_full_chat_completions_url() {
        assert_eq!(
            chat_completions_url(
                "http://spark.internal:8000/v1/chat/completions"
            )
            .unwrap()
            .as_str(),
            "http://spark.internal:8000/v1/chat/completions"
        );
    }

    #[test]
    fn normalizes_chat_title_whitespace() {
        assert_eq!(chat_title("  hello \n world  "), "hello world");
    }

    #[test]
    fn limits_chat_title_length() {
        assert_eq!(chat_title(&"a".repeat(121)).chars().count(), 120);
    }
}
