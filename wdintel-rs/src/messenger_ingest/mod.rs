pub mod access;
pub mod accounts;
pub mod attachments;
pub mod chats;
pub mod contacts;
pub mod datasource;
pub mod members;
pub mod messages;
pub mod refs;
pub mod types;
pub mod uploads;

use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::{
    ensure_messenger_ingest_access, IngestScope,
};
use crate::messenger_ingest::types::{
    MessengerIngestAccountsSyncReq, MessengerIngestAccountsSyncRsp,
    MessengerIngestAttachmentsSubmitReq, MessengerIngestAttachmentsSubmitRsp,
    MessengerIngestChatMembersSyncReq, MessengerIngestChatMembersSyncRsp,
    MessengerIngestChatsSyncReq, MessengerIngestChatsSyncRsp,
    MessengerIngestContactsSyncReq, MessengerIngestContactsSyncRsp,
    MessengerIngestMessagesSubmitReq, MessengerIngestMessagesSubmitRsp,
};
use crate::types::Env;
use crate::types::ShortContext;
use actix_web::web::{Data, Json, Path, Payload};
use actix_web::{post, route, HttpRequest, HttpResponse};

// Routes of the messenger ingest API, `/api/messenger-ingest/v1`. Handlers
// only gate access and delegate to the per-entity modules.

/// The caller's ingest scope, rejected when its datasource is disabled.
async fn enabled_scope(
    env: &Env,
    user: &actix_identity::Identity,
) -> Result<IngestScope, AppError> {
    let scope = ensure_messenger_ingest_access(&env.dbx, user)
        .await
        .c(h!())?;
    if !scope.is_enabled() {
        return Err(AppError::Forbidden("datasource is disabled".to_string()));
    }
    Ok(scope)
}

#[post("/api/messenger-ingest/v1/accounts/sync")]
pub async fn accounts_sync(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestAccountsSyncReq>,
) -> Result<Json<MessengerIngestAccountsSyncRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = accounts::sync_accounts(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messenger-ingest/v1/chats/sync")]
pub async fn chats_sync(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestChatsSyncReq>,
) -> Result<Json<MessengerIngestChatsSyncRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = chats::sync_chats(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messenger-ingest/v1/chats/members/sync")]
pub async fn chat_members_sync(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestChatMembersSyncReq>,
) -> Result<Json<MessengerIngestChatMembersSyncRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = members::sync_chat_members(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messenger-ingest/v1/contacts/sync")]
pub async fn contacts_sync(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestContactsSyncReq>,
) -> Result<Json<MessengerIngestContactsSyncRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = contacts::sync_contacts(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messenger-ingest/v1/messages/submit")]
pub async fn messages_submit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestMessagesSubmitReq>,
) -> Result<Json<MessengerIngestMessagesSubmitRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = messages::submit_messages(&env, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messenger-ingest/v1/messages/attachments/submit")]
pub async fn attachments_submit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengerIngestAttachmentsSubmitReq>,
) -> Result<Json<MessengerIngestAttachmentsSubmitRsp>, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    let rsp = attachments::submit_attachments(&env, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

/// TUS creation (`POST`) and capability discovery (`OPTIONS`).
#[route(
    "/api/messenger-ingest/v1/uploads",
    method = "POST",
    method = "OPTIONS"
)]
pub async fn uploads_base(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: HttpRequest,
    payload: Payload,
) -> Result<HttpResponse, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    uploads::handle_upload(
        &env,
        &scope,
        req.method(),
        req.headers(),
        None,
        payload,
    )
    .await
}

/// TUS offset (`HEAD`), append (`PATCH`, or `POST` with
/// `X-HTTP-Method-Override: PATCH`) and termination (`DELETE`).
#[route(
    "/api/messenger-ingest/v1/uploads/{file_id}",
    method = "HEAD",
    method = "PATCH",
    method = "POST",
    method = "DELETE",
    method = "OPTIONS"
)]
pub async fn uploads_file(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: HttpRequest,
    path: Path<String>,
    payload: Payload,
) -> Result<HttpResponse, AppError> {
    let scope = enabled_scope(&env, &user).await.c(h!())?;
    uploads::handle_upload(
        &env,
        &scope,
        req.method(),
        req.headers(),
        Some(path.into_inner()),
        payload,
    )
    .await
}
