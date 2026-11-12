pub mod access;
pub mod accounts;
pub mod attachments;
pub mod chats;
pub mod contacts;
pub mod members;
pub mod messages;
pub mod paging;
pub mod types;

use crate::error::AppError;
use crate::h;
use crate::messengers::access::ensure_messengers_access;
use crate::messengers::types::{
    MessengersAccountUpdateReq, MessengersAccountsListReq,
    MessengersAccountsListRsp, MessengersAttachmentsCountsReq,
    MessengersAttachmentsCountsRsp, MessengersAttachmentsListReq,
    MessengersAttachmentsListRsp, MessengersChatMembersListReq,
    MessengersChatMembersListRsp, MessengersChatsListReq,
    MessengersChatsListRsp, MessengersContactsListReq,
    MessengersContactsListRsp, MessengersMessagesListReq,
    MessengersMessagesListRsp,
};
use crate::types::{Env, ShortContext};
use actix_web::post;
use actix_web::web::{Data, Json};

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

#[post("/api/messengers/attachments/counts")]
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
