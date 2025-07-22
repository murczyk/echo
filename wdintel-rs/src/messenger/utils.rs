use crate::entities::{bot_organism_link, messenger_bot, messenger_group};
use crate::h;
use crate::types::AppError;
use anyhow::Context;
use echo_im::types::MessageF1;
use log::info;
use sea_orm::*;
use sea_orm::{ConnectionTrait, TransactionTrait};
use std::net::TcpListener;
use uuid::Uuid;

pub async fn bot_by_phone_number<'a, C>(
    phone_number: &str,
    db: &C,
) -> Result<Option<messenger_bot::Model>, AppError>
where
    C: ConnectionTrait + TransactionTrait,
{
    let m_bot = messenger_bot::Entity::find()
        .filter(
            messenger_bot::Column::PhoneNumber
                .is_not_null()
                .and(messenger_bot::Column::PhoneNumber.eq(phone_number)),
        )
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(db)
        .await
        .context(h!())?;

    Ok(m_bot)
}

pub async fn load_bot_by_id<'a, C>(
    id: i32,
    db: &C,
) -> Result<Option<messenger_bot::Model>, AppError>
where
    C: ConnectionTrait + TransactionTrait,
{
    let m_bot = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Id.eq(uuid))
        .filter(messenger_bot::Column::PhoneNumber.is_not_null())
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(db)
        .await
        .context(h!())?;
    Ok(m_bot)
}

pub async fn find_port_available(start: i32, end: i32) -> Result<i32, AppError> {
    let Some(port) = (start..end).find(|p| match TcpListener::bind(format!("127.0.0.1:{}", p)) {
        Ok(_) => true,
        Err(_) => false,
    }) else {
        return Err(AppError::BL("can't find free port".to_string()));
    };
    Ok(port)
}

pub async fn get_bot_link<'a, C>(
    restapi_group_id: &str,
    client_name: &str,
    db: &C,
) -> Result<Option<bot_organism_link::Model>, AppError>
where
    C: ConnectionTrait + TransactionTrait,
{
    let Some(group) = messenger_group::Entity::find()
        .filter(messenger_group::Column::ExternalId.eq(restapi_group_id))
        .one(db)
        .await?
    else {
        info!("unknown group. skip");
        return Ok(None);
    };

    let Some(bot) = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Name.eq(client_name))
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(db)
        .await?
    else {
        info!("this message is not for bot. skip");
        return Ok(None);
    };

    let Some(link_m) = bot_organism_link::Entity::find()
        .filter(bot_organism_link::Column::BotId.eq(bot.id))
        .filter(bot_organism_link::Column::GroupId.eq(group.id))
        .one(db)
        .await?
    else {
        info!(
            "bot does not link to this group. skip. bot_id={}, client_name={client_name}, group_id={}",
            bot.id, group.id
        );
        return Ok(None);
    };

    Ok(Some(link_m))
}

pub async fn get_group_name_by_id<'a, C>(group_id: &str, db: &C) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait + TransactionTrait,
{
    Ok(messenger_group::Entity::find()
        .filter(messenger_group::Column::ExternalId.eq(group_id))
        .one(db)
        .await
        .context(h!())?
        .map(|x| x.name))
}

pub async fn is_same_author(
    msg1: &MessageF1,
    msg2: &MessageF1,
    txn: &DatabaseTransaction,
) -> Result<bool, AppError> {
    let Some(replied_message_author) = echo_im::message_sender_name(&msg1, txn)
        .await
        .context(h!())?
    else {
        return Err(AppError::BL("Replied message author not found".to_string()));
    };
    let Some(context_msg_author) = echo_im::message_sender_name(msg2, txn)
        .await
        .context(h!())?
    else {
        return Err(AppError::BL("Context message author not found".to_string()));
    };
    if replied_message_author != context_msg_author {
        return Ok(false);
    }
    Ok(true)
}
