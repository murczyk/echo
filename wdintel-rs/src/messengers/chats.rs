use crate::entities::messenger_chat;
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::types::{
    MessengersChatItem, MessengersChatsListReq, MessengersChatsListRsp,
    MessengersTelegramChatId,
};
use crate::types::ShortContext;
use sea_orm::sea_query::NullOrdering;
use sea_orm::*;

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
        .order_by_desc(messenger_chat::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(MessengersChatsListRsp {
        items: chats.iter().map(chat_item).collect(),
    })
}

fn chat_item(chat: &messenger_chat::Model) -> MessengersChatItem {
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
    }
}
