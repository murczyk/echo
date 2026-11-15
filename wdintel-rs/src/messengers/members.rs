use crate::entities::messenger_chat_member;
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::chats::resolve_chat;
use crate::messengers::types::{
    MessengersChatMemberItem, MessengersChatMembersListReq,
    MessengersChatMembersListRsp, MessengersTelegramAccountId,
};
use crate::types::ShortContext;
use sea_orm::*;

/// Deleted members are included, flagged: old messages still reference them.
pub(crate) async fn list_chat_members(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersChatMembersListReq,
) -> Result<MessengersChatMembersListRsp, AppError> {
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let chat = resolve_chat(dbx, &account, &req.chat_id).await.c(h!())?;
    let members = messenger_chat_member::Entity::find()
        .filter(messenger_chat_member::Column::MessengerChatId.eq(chat.id))
        .order_by_asc(messenger_chat_member::Column::ExternalId)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(MessengersChatMembersListRsp {
        items: members.iter().map(chat_member_item).collect(),
    })
}

fn chat_member_item(
    member: &messenger_chat_member::Model,
) -> MessengersChatMemberItem {
    MessengersChatMemberItem {
        id: member.id.to_string(),
        messenger_type: member.messenger_type.clone(),
        external_id: member.external_id.clone(),
        username: member.username.clone(),
        first_name: member.first_name.clone(),
        last_name: member.last_name.clone(),
        phone: member.phone.clone(),
        is_bot: member.is_bot,
        role: member.role.clone(),
        joined_date: member
            .joined_date
            .map(|dt| dt.and_utc().timestamp_millis()),
        deleted: member.deleted,
        telegram: member.telegram_user_id.map(|id| {
            MessengersTelegramAccountId {
                user_id: id.to_string(),
            }
        }),
    }
}
