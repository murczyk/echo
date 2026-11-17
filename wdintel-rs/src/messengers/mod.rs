pub mod access;
pub mod accounts;
pub mod attachments;
pub mod avatars;
pub mod chats;
pub mod contacts;
pub mod members;
pub mod messages;
pub mod paging;
pub mod read_state;
pub mod types;

use crate::error::AppError;
use crate::h;
use crate::messengers::access::ensure_messengers_access;
use crate::messengers::types::{
    MessengersAccountUpdateReq, MessengersAccountsListReq,
    MessengersAccountsListRsp, MessengersAttachmentsCountsReq,
    MessengersAttachmentsCountsRsp, MessengersAttachmentsListReq,
    MessengersAttachmentsListRsp, MessengersChatMembersListReq,
    MessengersChatMembersListRsp, MessengersChatReadState,
    MessengersChatReadStateGetReq, MessengersChatReadStateUpdateReq,
    MessengersChatsListReq, MessengersChatsListRsp,
    MessengersChatsMarkAllReadReq, MessengersContactsListReq,
    MessengersContactsListRsp, MessengersMessagesListReq,
    MessengersMessagesListRsp,
};
use crate::types::{Env, ShortContext};
use actix_web::web::{Data, Json, Path};
use actix_web::{get, post, HttpResponse};
use uuid::Uuid;

// Routes of the messengers viewer API, `/api/messengers`. Handlers
// only gate access and delegate to the per-entity modules.

#[post("/api/messengers/accounts/list")]
pub async fn accounts_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    _req: Json<MessengersAccountsListReq>,
) -> Result<Json<MessengersAccountsListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = accounts::list_accounts(&env.dbx, &scope).await.c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/accounts/update")]
pub async fn account_update(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersAccountUpdateReq>,
) -> Result<Json<()>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    accounts::update_account(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/messengers/chats/list")]
pub async fn chats_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersChatsListReq>,
) -> Result<Json<MessengersChatsListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = chats::list_chats(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/chats/read-state/get")]
pub async fn chat_read_state_get(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersChatReadStateGetReq>,
) -> Result<Json<MessengersChatReadState>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = read_state::get_read_state(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/chats/read-state/update")]
pub async fn chat_read_state_update(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersChatReadStateUpdateReq>,
) -> Result<Json<MessengersChatReadState>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = read_state::update_read_state(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/chats/mark-all-read")]
pub async fn chats_mark_all_read(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersChatsMarkAllReadReq>,
) -> Result<Json<()>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    read_state::mark_all_read(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/messengers/chats/members/list")]
pub async fn chat_members_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersChatMembersListReq>,
) -> Result<Json<MessengersChatMembersListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = members::list_chat_members(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[get("/api/messengers/avatars/{avatar_id}")]
pub async fn avatar_get(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    avatars::serve_avatar(&env, &scope, path.0).await
}

#[post("/api/messengers/contacts/list")]
pub async fn contacts_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersContactsListReq>,
) -> Result<Json<MessengersContactsListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = contacts::list_contacts(&env.dbx, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/messages/list")]
pub async fn messages_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersMessagesListReq>,
) -> Result<Json<MessengersMessagesListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = messages::list_messages(&env, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/attachments/count")]
pub async fn attachments_counts(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersAttachmentsCountsReq>,
) -> Result<Json<MessengersAttachmentsCountsRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = attachments::count_attachments(&env, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}

#[post("/api/messengers/attachments/list")]
pub async fn attachments_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<MessengersAttachmentsListReq>,
) -> Result<Json<MessengersAttachmentsListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = attachments::list_attachments(&env, &scope, req.into_inner())
        .await
        .c(h!())?;
    Ok(Json(rsp))
}
