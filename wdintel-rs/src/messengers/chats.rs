use crate::entities::{messenger_account, messenger_chat};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::refs::parse_echo_uuid;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::read_state::with_read_state;
use crate::messengers::types::{
    MessengersChatItem, MessengersChatsListReq, MessengersChatsListRsp,
    MessengersTelegramChatId,
};
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::sea_query::NullOrdering;
use sea_orm::*;

/// A chat with the caller's read state of it, see `with_read_state`.
#[derive(FromQueryResult)]
struct ChatRow {
    #[sea_orm(nested)]
    chat: messenger_chat::Model,
    oldest_read_at: Option<NaiveDateTime>,
    newest_read_at: Option<NaiveDateTime>,
    unread_count: i64,
}

pub(crate) async fn list_chats(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersChatsListReq,
) -> Result<MessengersChatsListRsp, AppError> {
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let chats = messenger_chat::Entity::find()
        .filter(messenger_chat::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_chat::Column::Deleted.eq(false))
        .order_by_with_nulls(
            messenger_chat::Column::LastMessageDate,
            Order::Desc,
            NullOrdering::Last,
        )
        .order_by_desc(messenger_chat::Column::Id);
    let rows = with_read_state(chats, scope.login_id)
        .into_model::<ChatRow>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(MessengersChatsListRsp {
        items: rows.iter().map(chat_item).collect(),
    })
}

/// The chat a request refers to, under an already resolved account. An
/// invalid id is a `400`; a chat that is unknown, deleted or under another
/// account is a `404`.
pub(crate) async fn resolve_chat(
    dbx: &DatabaseConnection,
    account: &messenger_account::Model,
    chat_id: &str,
) -> Result<messenger_chat::Model, AppError> {
    let chat_id = parse_echo_uuid(chat_id).c(h!())?;
    messenger_chat::Entity::find_by_id(chat_id)
        .filter(messenger_chat::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_chat::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

fn chat_item(row: &ChatRow) -> MessengersChatItem {
    let chat = &row.chat;
    MessengersChatItem {
        id: chat.id.to_string(),
        messenger_type: chat.messenger_type.clone(),
        external_id: chat.external_id.clone(),
        chat_type: chat.chat_type.clone(),
        title: chat.title.clone(),
        username: chat.username.clone(),
        members_count: chat.members_count,
        account_member_status: chat.account_member_status.clone(),
        last_message_date: chat
            .last_message_date
            .map(|dt| dt.and_utc().timestamp_millis()),
        telegram: chat.telegram_chat_id.map(|id| MessengersTelegramChatId {
            chat_id: id.to_string(),
        }),
        oldest_read_at: row
            .oldest_read_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        newest_read_at: row
            .newest_read_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        unread_count: row.unread_count,
        total_count: chat.message_count,
    }
}
