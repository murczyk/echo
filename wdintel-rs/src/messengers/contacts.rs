use crate::config::{
    MESSENGERS_CONTACTS_DEFAULT_LIMIT, MESSENGERS_CONTACTS_MAX_LIMIT,
};
use crate::entities::messenger_contact;
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::messengers::messages::page_limit;
use crate::messengers::types::{
    MessengersContactItem, MessengersContactsListReq,
    MessengersContactsListRsp, MessengersTelegramAccountId,
};
use crate::types::ShortContext;
use sea_orm::*;

pub(crate) async fn list_contacts(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersContactsListReq,
) -> Result<MessengersContactsListRsp, AppError> {
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let limit = page_limit(
        req.limit,
        MESSENGERS_CONTACTS_DEFAULT_LIMIT,
        MESSENGERS_CONTACTS_MAX_LIMIT,
    )
    .c(h!())?;
    let page = req.page.unwrap_or(1);
    let offset = page_offset(page, limit).c(h!())?;
    let live_contacts = messenger_contact::Entity::find()
        .filter(messenger_contact::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_contact::Column::Deleted.eq(false));
    let total = live_contacts.clone().count(dbx).await.c(h!())?;
    let contacts = live_contacts
        .order_by_asc(messenger_contact::Column::Id)
        .offset(offset)
        .limit(limit)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(MessengersContactsListRsp {
        items: contacts.iter().map(contact_item).collect(),
        total,
        page: page as u64,
        page_size: limit,
    })
}

/// Rows before a 1-based page. A page below 1, or one too large for a
/// PostgreSQL offset, is a `400`.
fn page_offset(page: i64, limit: u64) -> Result<u64, AppError> {
    (page >= 1)
        .then(|| (page - 1).checked_mul(limit as i64))
        .flatten()
        .map(|offset| offset as u64)
        .ok_or_else(|| AppError::BL {
            msg: format!("invalid page: {page}"),
        })
}

fn contact_item(contact: &messenger_contact::Model) -> MessengersContactItem {
    MessengersContactItem {
        id: contact.id.to_string(),
        messenger_type: contact.messenger_type.clone(),
        external_id: contact.external_id.clone(),
        username: contact.username.clone(),
        first_name: contact.first_name.clone(),
        last_name: contact.last_name.clone(),
        phone: contact.phone.clone(),
        is_mutual: contact.is_mutual,
        is_close_friend: contact.is_close_friend,
        created_at: contact.created_at.and_utc().timestamp_millis(),
        updated_at: contact.updated_at.and_utc().timestamp_millis(),
        telegram: contact.telegram_user_id.map(|id| {
            MessengersTelegramAccountId {
                user_id: id.to_string(),
            }
        }),
    }
}
