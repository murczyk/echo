use crate::entities::{
    datasource_group, device_name, sigint_inbox_item, signal_group,
    signal_message, signal_message_group, signal_profile,
};
use crate::error::AppError;
use crate::types::*;
use chrono::NaiveDateTime;
use sea_orm::sea_query::Expr;
use sea_orm::*;

pub async fn find_available_signal_group<C>(
    dbx: &C,
    login: &str,
    signal_group_master_key: &str,
) -> Result<signal_group::Model, AppError>
where
    C: ConnectionTrait,
{
    let signal_group = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(signal_group_master_key))
        .filter(signal_group::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let available_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    if !available_groups.contains(&signal_group.master_key) {
        return Err(AppError::Forbidden(
            "signal group is not available for user".to_string(),
        ));
    }

    Ok(signal_group)
}

pub async fn ensure_current_user_sender<C>(
    dbx: &C,
    login: &str,
) -> Result<String, AppError>
where
    C: ConnectionTrait,
{
    if signal_profile::Entity::find_by_id(login.to_string())
        .one(dbx)
        .await
        .c(h!())?
        .is_none()
    {
        signal_profile::ActiveModel {
            uuid: Set(login.to_string()),
            given_name: Set(Some(login.to_string())),
            family_name: Set(None),
            created_at: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(login.to_string())
}

pub async fn validate_device_name_id<C>(
    dbx: &C,
    device_name_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let count = device_name::Entity::find()
        .filter(device_name::Column::Id.eq(device_name_id))
        .count(dbx)
        .await
        .c(h!())?;
    if count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_inbox_items_device_name<C>(
    dbx: &C,
    inbox_item_ids: Vec<i64>,
    device_name_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if inbox_item_ids.is_empty() {
        return Ok(());
    }
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::DeviceNameId,
            Expr::value(device_name_id),
        )
        .filter(sigint_inbox_item::Column::Id.is_in(inbox_item_ids))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn resolve_datasource_id_for_group<C>(
    dbx: &C,
    signal_group_master_key: &str,
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    Ok(datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(signal_group_master_key),
        )
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .unwrap_or(None)
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID))
}

pub async fn ensure_datasource_group_id<'a, 'async_trait, C>(
    dbx: &'a C,
    signal_group_master_key: &str,
) -> Result<i64, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let datasource_id =
        resolve_datasource_id_for_group(dbx, signal_group_master_key)
            .await
            .c(h!())?;
    Ok(crate::messenger::group::ensure_datasource_group_id(
        dbx,
        signal_group_master_key.to_string(),
        datasource_id,
    )
    .await
    .c(h!())?)
}

pub async fn insert_signal_message<C>(
    dbx: &C,
    body: String,
    timestamp: NaiveDateTime,
    sender_uuid: Option<String>,
    datasource_group_id: i64,
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    Ok(signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body)),
        created_at: NotSet,
        timestamp: Set(Some(timestamp)),
        sender: Set(sender_uuid),
        format: Set(Some(2)),
        deleted: Set(false),
        external_id: NotSet,
        echo_inbox_message_id: Set(None),
        message_uid: NotSet,
        datasource_group_id: Set(Some(datasource_group_id)),
        operator_tags: NotSet,
        attachments_hash: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?)
}

pub async fn insert_signal_message_group<C>(
    dbx: &C,
    signal_group_master_key: &str,
    message: &signal_message::Model,
) -> Result<signal_message_group::Model, AppError>
where
    C: ConnectionTrait,
{
    Ok(signal_message_group::ActiveModel {
        id: NotSet,
        signal_message_id: Set(message.id),
        group_master_key: Set(Some(signal_group_master_key.to_string())),
        sender: Set(message.sender.clone()),
        message_uid: Set(message.message_uid.clone()),
        datasource_group_id: Set(message.datasource_group_id),
        created_at: Set(message.created_at),
    }
    .insert(dbx)
    .await
    .c(h!())?)
}
