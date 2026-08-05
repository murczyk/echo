mod access;
pub mod admin;
pub mod auth;
mod chat_monitoring;
pub(crate) mod dispatcher;
mod events;
mod lifecycle;
pub mod middleware;
pub mod profile;
pub mod provider_gateway;
mod review;
mod route_registry;
pub mod types;
pub mod worker;

use crate::config::{
    AI_AGENT_CONVERSATION_TITLE_MAX_CHARS, AI_AGENT_REQUEST_PROMPT_MAX_CHARS,
    AI_AGENT_SSE_POLL_MS,
};
use crate::entities::{
    ai_agent_conversation, ai_agent_request, ai_agent_request_event,
    ai_agent_settings, ai_agent_user_link, login,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    get, post,
    web::{Json, Path, Query},
    HttpRequest, HttpResponse,
};
use bytes::Bytes;
use chrono::Utc;
use futures_util::stream;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition,
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use std::collections::HashSet;
use std::time::Duration;
use types::*;
use uuid::Uuid;

pub async fn ensure_unmanaged_login<C>(
    dbx: &C,
    login_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let linked = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::AgentLoginId.eq(login_id))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let settings = ai_agent_settings::Entity::find_by_id(
        crate::config::AI_AGENT_SETTINGS_ID,
    )
    .one(dbx)
    .await
    .c(h!())?;
    let login = login::Entity::find_by_id(login_id).one(dbx).await.c(h!())?;
    let default_template_id =
        Uuid::parse_str(crate::config::AI_AGENT_TEMPLATE_LOGIN_ID).c(h!())?;
    let has_reserved_role = login
        .as_ref()
        .map(|login| {
            serde_json::from_value::<Vec<String>>(login.roles.clone())
                .c(h!())
                .map(|roles| has_reserved_agent_role(&roles))
        })
        .transpose()?
        .unwrap_or(false);
    let template = login_id == default_template_id
        || settings
            .and_then(|settings| settings.template_login_id)
            .is_some_and(|template_login_id| template_login_id == login_id)
        || login.as_ref().is_some_and(|login| {
            login.login == crate::config::AI_AGENT_TEMPLATE_LOGIN_NAME
        });
    if linked || template || has_reserved_role {
        return Err(AppError::Forbidden(
            "AI agent accounts are managed only through the AI control plane"
                .to_string(),
        ));
    }
    Ok(())
}

/// Selects logins that are not reserved for or managed by the AI agent control plane.
pub fn unmanaged_login_condition() -> Condition {
    let default_template_id =
        Uuid::parse_str(crate::config::AI_AGENT_TEMPLATE_LOGIN_ID)
            .expect("AI agent template login UUID is valid");
    Condition::all()
        .add(login::Column::Id.ne(default_template_id))
        .add(
            login::Column::Login
                .ne(crate::config::AI_AGENT_TEMPLATE_LOGIN_NAME),
        )
        .add(Expr::cust(
            "not (login.roles ?| array['ApiAgent', 'Cyber'])",
        ))
        .add(Expr::cust(
            "not exists (select 1 from ai_agent_user_link link where link.agent_login_id = login.id)",
        ))
        .add(Expr::cust(
            "not exists (select 1 from ai_agent_settings settings where settings.template_login_id = login.id)",
        ))
}

pub async fn unmanaged_login_ids<C>(
    dbx: &C,
    login_ids: impl IntoIterator<Item = Uuid>,
) -> Result<HashSet<Uuid>, AppError>
where
    C: ConnectionTrait,
{
    let login_ids = login_ids.into_iter().collect::<HashSet<_>>();
    if login_ids.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(login::Entity::find()
        .filter(login::Column::Id.is_in(login_ids))
        .filter(unmanaged_login_condition())
        .select_only()
        .column(login::Column::Id)
        .into_tuple::<Uuid>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

pub async fn ensure_unmanaged_logins<C>(
    dbx: &C,
    login_ids: &[Uuid],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let requested = login_ids.iter().copied().collect::<HashSet<_>>();
    let unmanaged = unmanaged_login_ids(dbx, requested.iter().copied()).await?;
    if unmanaged != requested {
        return Err(AppError::Forbidden(
            "AI agent accounts are managed only through the AI control plane"
                .to_string(),
        ));
    }
    Ok(())
}

pub fn ensure_no_reserved_agent_roles(
    roles: &[String],
) -> Result<(), AppError> {
    if has_reserved_agent_role(roles) {
        return Err(AppError::Forbidden(
            "ApiAgent and Cyber roles are reserved for managed AI accounts"
                .to_string(),
        ));
    }
    Ok(())
}

fn has_reserved_agent_role(roles: &[String]) -> bool {
    roles.iter().any(|role| {
        role == crate::config::AI_AGENT_ROLE_API
            || role == crate::config::AI_AGENT_ROLE_CYBER
    })
}

pub async fn ensure_valid_human_target<C>(
    dbx: &C,
    login_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    ensure_unmanaged_login(dbx, login_id).await?;
    let login = login::Entity::find_by_id(login_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    ensure_no_reserved_agent_roles(&roles)
}

#[get("/api/ai-agent/configuration")]
pub async fn configuration(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentConfigurationRsp>, AppError> {
    access::current_human_login(&env.dbx, &user, false).await?;
    let settings = access::settings(&env.dbx).await?;
    let providers = access::allowed_engines(&env.dbx)
        .await?
        .into_iter()
        .map(|ai_engine| AiAgentProviderItem {
            id: ai_engine.id.to_string(),
            name: ai_engine.name,
            model_name: ai_engine.model_name,
        })
        .collect();
    Ok(Json(AiAgentConfigurationRsp {
        feature_enabled: settings.feature_enabled,
        default_ai_engine_id: settings
            .default_ai_engine_id
            .map(|id| id.to_string()),
        providers,
    }))
}

#[post("/api/ai-agent/conversations/list")]
pub async fn list_conversations(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentConversationListRsp>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false).await?;
    let items = ai_agent_conversation::Entity::find()
        .filter(ai_agent_conversation::Column::HumanLoginId.eq(human.id))
        .filter(ai_agent_conversation::Column::DeletedAt.is_null())
        .order_by_desc(ai_agent_conversation::Column::UpdatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(conversation_summary)
        .collect();
    Ok(Json(AiAgentConversationListRsp { items }))
}

#[post("/api/ai-agent/conversations/create")]
pub async fn create_conversation(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentConversationCreateReq>,
) -> Result<Json<AiAgentConversationDetail>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true).await?;
    let requested_engine = req
        .ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()?;
    let ai_engine = access::allowed_engine(&env.dbx, requested_engine).await?;
    let title = normalize_title(req.title.as_deref(), "Нова розмова");
    let conversation =
        insert_conversation(&env.dbx, human.id, ai_engine.id, title).await?;
    Ok(Json(conversation_detail(&env.dbx, conversation).await?))
}

#[post("/api/ai-agent/conversations/get")]
pub async fn get_conversation(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentConversationIdReq>,
) -> Result<Json<AiAgentConversationDetail>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true).await?;
    let conversation =
        owned_conversation(&env.dbx, human.id, access::parse_uuid(&req.id)?)
            .await?;
    Ok(Json(conversation_detail(&env.dbx, conversation).await?))
}

#[post("/api/ai-agent/conversations/update")]
pub async fn update_conversation(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentConversationUpdateReq>,
) -> Result<Json<AiAgentConversationDetail>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true).await?;
    let title = req.title.trim();
    if title.is_empty() {
        return Err(AppError::BL {
            msg: "Назва розмови не може бути порожньою".to_string(),
        });
    }
    let conversation =
        owned_conversation(&env.dbx, human.id, access::parse_uuid(&req.id)?)
            .await?;
    let mut conversation = conversation.into_active_model();
    conversation.title = Set(access::truncate(
        title,
        AI_AGENT_CONVERSATION_TITLE_MAX_CHARS,
    ));
    conversation.updated_at = Set(Utc::now().naive_utc());
    let conversation = conversation.update(&env.dbx).await.c(h!())?;
    Ok(Json(conversation_detail(&env.dbx, conversation).await?))
}

#[post("/api/ai-agent/conversations/delete")]
pub async fn delete_conversation(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentConversationIdReq>,
) -> Result<Json<()>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let conversation =
        owned_conversation_locked(&txn, human.id, access::parse_uuid(&req.id)?)
            .await?;
    let has_active = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::ConversationId.eq(conversation.id))
        .filter(ai_agent_request::Column::State.is_in(["queued", "running"]))
        .one(&txn)
        .await
        .c(h!())?
        .is_some();
    if has_active {
        return Err(AppError::BL {
            msg: "Неможливо видалити розмову з активним запитом".to_string(),
        });
    }
    let mut conversation = conversation.into_active_model();
    conversation.deleted_at = Set(Some(Utc::now().naive_utc()));
    conversation.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/ai-agent/requests/create")]
pub async fn create_request(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentRequestCreateReq>,
) -> Result<Json<AiAgentRequestCreateRsp>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true).await?;
    let prompt = validate_prompt(&req.prompt)?;
    let requested_engine = req
        .ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()?;
    let (existing_conversation, ai_engine_id) = match req
        .conversation_id
        .as_deref()
    {
        Some(conversation_id) => {
            let conversation = owned_conversation(
                &env.dbx,
                human.id,
                access::parse_uuid(conversation_id)?,
            )
            .await?;
            if requested_engine
                .is_some_and(|id| id != conversation.ai_engine_id)
            {
                return Err(AppError::BL {
                    msg: "Провайдер розмови не можна змінити".to_string(),
                });
            }
            access::allowed_engine(&env.dbx, Some(conversation.ai_engine_id))
                .await?;
            let ai_engine_id = conversation.ai_engine_id;
            (Some(conversation), ai_engine_id)
        }
        None => {
            let ai_engine =
                access::allowed_engine(&env.dbx, requested_engine).await?;
            (None, ai_engine.id)
        }
    };
    let txn = env.dbx.begin().await.c(h!())?;
    lifecycle::lock_user_lifecycle(&txn, human.id).await?;
    let settings = ai_agent_settings::Entity::find_by_id(
        crate::config::AI_AGENT_SETTINGS_ID,
    )
    .lock_shared()
    .one(&txn)
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)?;
    if !settings.feature_enabled {
        return Err(AppError::Forbidden(
            "AI agent harness is disabled".to_string(),
        ));
    }
    access::allowed_engine_by_id(&txn, ai_engine_id).await?;
    let conversation = match existing_conversation {
        Some(conversation) => {
            owned_conversation_locked(&txn, human.id, conversation.id).await?
        }
        None => {
            let title = normalize_title(None, &prompt);
            insert_conversation_in_transaction(
                &txn,
                human.id,
                ai_engine_id,
                title,
            )
            .await?
        }
    };
    let now = Utc::now().naive_utc();
    let request_id = Uuid::now_v7();
    ai_agent_request::ActiveModel {
        id: Set(request_id),
        conversation_id: Set(conversation.id),
        human_login_id: Set(human.id),
        agent_login_id: Set(None),
        ai_engine_id: Set(ai_engine_id),
        prompt: Set(prompt),
        response: Set(None),
        state: Set("queued".to_string()),
        cancellation_requested: Set(false),
        error: Set(None),
        correlation_id: Set(None),
        queued_at: Set(now),
        started_at: Set(None),
        completed_at: Set(None),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    chat_monitoring::enqueue_in_transaction(
        &txn,
        request_id,
        settings.mattermost_chat_enabled,
    )
    .await?;
    let conversation_id = conversation.id;
    let mut conversation = conversation.into_active_model();
    conversation.updated_at = Set(now);
    conversation.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(AiAgentRequestCreateRsp {
        request_id: request_id.to_string(),
        conversation_id: conversation_id.to_string(),
        state: "queued".to_string(),
    }))
}

#[post("/api/ai-agent/requests/cancel")]
pub async fn cancel_request(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentRequestIdReq>,
) -> Result<Json<AiAgentRequestCancelRsp>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false).await?;
    let request_id = access::parse_uuid(&req.request_id)?;
    let state = cancel_request_for_user(&env, human.id, request_id).await?;
    Ok(Json(AiAgentRequestCancelRsp { state }))
}

async fn cancel_request_for_user(
    env: &Env,
    human_login_id: Uuid,
    request_id: Uuid,
) -> Result<String, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if matches!(request.state.as_str(), "completed" | "failed" | "cancelled") {
        let state = request.state.clone();
        let should_retry_revoke = request.state == "cancelled";
        txn.commit().await.c(h!())?;
        if should_retry_revoke {
            auth::revoke_request(env, request_id).await?;
        }
        return Ok(state);
    }
    let now = Utc::now().naive_utc();
    let mut request = request.into_active_model();
    request.state = Set("cancelled".to_string());
    request.cancellation_requested = Set(true);
    request.completed_at = Set(Some(now));
    request.updated_at = Set(now);
    request.update(&txn).await.c(h!())?;
    lifecycle::touch_container_activity_in_transaction(
        &txn,
        human_login_id,
        now,
    )
    .await?;
    events::append_in_transaction(
        &txn,
        request_id,
        "cancellation",
        serde_json::json!({}),
    )
    .await?;
    review::enqueue_in_transaction(&txn, request_id).await?;
    txn.commit().await.c(h!())?;
    auth::revoke_request(env, request_id).await?;
    Ok("cancelled".to_string())
}

pub(crate) async fn cancel_all_for_user(
    env: &Env,
    human_login_id: Uuid,
) -> Result<(), AppError> {
    let request_ids = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_request::Column::State.is_in(["queued", "running"]))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|request| request.id)
        .collect::<Vec<_>>();
    let mut failure_count = 0_usize;
    for request_id in request_ids {
        if cancel_request_for_user(env, human_login_id, request_id)
            .await
            .is_err()
        {
            failure_count += 1;
        }
    }
    if failure_count > 0 {
        return Err(AppError::BL {
            msg: format!("Could not cancel {failure_count} AI agent requests"),
        });
    }
    Ok(())
}

#[derive(Deserialize)]
struct SseQuery {
    after: Option<i64>,
}

struct SseState {
    dbx: DatabaseConnection,
    request_id: Uuid,
    after: i64,
}

#[get("/api/ai-agent/requests/{request_id}/events")]
pub async fn request_events(
    env: actix_web::web::Data<Env>,
    user: Identity,
    request_id: Path<String>,
    query: Query<SseQuery>,
    http_req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false).await?;
    let request_id = access::parse_uuid(&request_id)?;
    owned_request(&env.dbx, human.id, request_id).await?;
    let last_event_id = http_req
        .headers()
        .get("Last-Event-ID")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let state = SseState {
        dbx: env.dbx.clone(),
        request_id,
        after: last_event_id.or(query.after).unwrap_or(0).max(0),
    };
    let stream = stream::unfold(Some(state), |state| async move {
        let mut state = state?;
        match next_sse_chunk(&mut state).await {
            Ok(Some(chunk)) => {
                Some((Ok::<Bytes, AppError>(chunk), Some(state)))
            }
            Ok(None) => None,
            Err(err) => Some((Err(err), None)),
        }
    });
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(stream))
}

async fn next_sse_chunk(
    state: &mut SseState,
) -> Result<Option<Bytes>, AppError> {
    let items = pending_sse_events(state).await?;
    if !items.is_empty() {
        return Ok(Some(render_sse_events(state, items)?));
    }
    let terminal = ai_agent_request::Entity::find_by_id(state.request_id)
        .one(&state.dbx)
        .await
        .c(h!())?
        .is_none_or(|request| {
            matches!(
                request.state.as_str(),
                "completed" | "failed" | "cancelled"
            )
        });
    if terminal {
        let items = pending_sse_events(state).await?;
        if !items.is_empty() {
            return Ok(Some(render_sse_events(state, items)?));
        }
        return Ok(None);
    }
    tokio::time::sleep(Duration::from_millis(AI_AGENT_SSE_POLL_MS)).await;
    Ok(Some(Bytes::from_static(b": keepalive\n\n")))
}

async fn pending_sse_events(
    state: &SseState,
) -> Result<Vec<ai_agent_request_event::Model>, AppError> {
    ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(state.request_id))
        .filter(ai_agent_request_event::Column::Sequence.gt(state.after))
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .limit(100)
        .all(&state.dbx)
        .await
        .c(h!())
        .map_err(Into::into)
}

fn render_sse_events(
    state: &mut SseState,
    items: Vec<ai_agent_request_event::Model>,
) -> Result<Bytes, AppError> {
    let mut chunk = String::new();
    for event in items {
        state.after = event.sequence;
        let item = AiAgentRequestEventItem {
            sequence: event.sequence,
            event_type: event.event_type.clone(),
            payload_json: event.payload.to_string(),
            created_at: event.created_at.and_utc().timestamp_millis(),
        };
        chunk.push_str(&format!(
            "id: {}\nevent: {}\ndata: {}\n\n",
            event.sequence,
            event.event_type,
            serde_json::to_string(&item).c(h!())?
        ));
    }
    Ok(Bytes::from(chunk))
}

async fn insert_conversation(
    dbx: &DatabaseConnection,
    human_login_id: Uuid,
    ai_engine_id: Uuid,
    title: String,
) -> Result<ai_agent_conversation::Model, AppError> {
    let now = Utc::now().naive_utc();
    ai_agent_conversation::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human_login_id),
        ai_engine_id: Set(ai_engine_id),
        title: Set(title),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    }
    .insert(dbx)
    .await
    .c(h!())
    .map_err(Into::into)
}

async fn insert_conversation_in_transaction(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    ai_engine_id: Uuid,
    title: String,
) -> Result<ai_agent_conversation::Model, AppError> {
    let now = Utc::now().naive_utc();
    ai_agent_conversation::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human_login_id),
        ai_engine_id: Set(ai_engine_id),
        title: Set(title),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    }
    .insert(txn)
    .await
    .c(h!())
    .map_err(Into::into)
}

async fn owned_conversation_locked(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    conversation_id: Uuid,
) -> Result<ai_agent_conversation::Model, AppError> {
    ai_agent_conversation::Entity::find_by_id(conversation_id)
        .filter(ai_agent_conversation::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_conversation::Column::DeletedAt.is_null())
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn owned_conversation(
    dbx: &DatabaseConnection,
    human_login_id: Uuid,
    conversation_id: Uuid,
) -> Result<ai_agent_conversation::Model, AppError> {
    ai_agent_conversation::Entity::find_by_id(conversation_id)
        .filter(ai_agent_conversation::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_conversation::Column::DeletedAt.is_null())
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn owned_request(
    dbx: &DatabaseConnection,
    human_login_id: Uuid,
    request_id: Uuid,
) -> Result<ai_agent_request::Model, AppError> {
    ai_agent_request::Entity::find_by_id(request_id)
        .filter(ai_agent_request::Column::HumanLoginId.eq(human_login_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub(super) async fn conversation_detail(
    dbx: &DatabaseConnection,
    conversation: ai_agent_conversation::Model,
) -> Result<AiAgentConversationDetail, AppError> {
    let requests = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::ConversationId.eq(conversation.id))
        .order_by_asc(ai_agent_request::Column::QueuedAt)
        .order_by_asc(ai_agent_request::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let mut messages = Vec::new();
    for request in requests {
        let request_state = request.state;
        messages.push(AiAgentMessageItem {
            request_id: request.id.to_string(),
            request_state: request_state.clone(),
            role: "user".to_string(),
            content: request.prompt,
            created_at: request.queued_at.and_utc().timestamp_millis(),
        });
        if let Some(response) = request.response {
            messages.push(AiAgentMessageItem {
                request_id: request.id.to_string(),
                request_state,
                role: "assistant".to_string(),
                content: response,
                created_at: request
                    .completed_at
                    .unwrap_or(request.updated_at)
                    .and_utc()
                    .timestamp_millis(),
            });
        }
    }
    Ok(AiAgentConversationDetail {
        id: conversation.id.to_string(),
        title: conversation.title,
        ai_engine_id: conversation.ai_engine_id.to_string(),
        created_at: conversation.created_at.and_utc().timestamp_millis(),
        updated_at: conversation.updated_at.and_utc().timestamp_millis(),
        messages,
    })
}

fn conversation_summary(
    conversation: ai_agent_conversation::Model,
) -> AiAgentConversationSummary {
    AiAgentConversationSummary {
        id: conversation.id.to_string(),
        title: conversation.title,
        ai_engine_id: conversation.ai_engine_id.to_string(),
        created_at: conversation.created_at.and_utc().timestamp_millis(),
        updated_at: conversation.updated_at.and_utc().timestamp_millis(),
    }
}

fn validate_prompt(prompt: &str) -> Result<String, AppError> {
    let prompt = prompt.trim();
    if prompt.is_empty()
        || prompt.chars().count() > AI_AGENT_REQUEST_PROMPT_MAX_CHARS
    {
        return Err(AppError::BL {
            msg: "Некоректна довжина запиту".to_string(),
        });
    }
    Ok(prompt.to_string())
}

fn normalize_title(title: Option<&str>, fallback: &str) -> String {
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback);
    access::truncate(title, AI_AGENT_CONVERSATION_TITLE_MAX_CHARS)
}
