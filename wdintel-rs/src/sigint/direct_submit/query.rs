use crate::entities::{
    datasource_group, device_name, login, sigint_inbox_item, signal_group,
    signal_message, signal_message_group, signal_message_media, signal_profile,
};
use crate::error::AppError;
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::*;
use uuid::Uuid;

pub async fn find_available_signal_group<C>(
    dbx: &C,
    login: &uuid::Uuid,
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

    crate::messenger::group::ensure_identity_group_available(
        dbx,
        login,
        &signal_group.master_key,
    )
    .await?;

    Ok(signal_group)
}

pub async fn find_editable_signal_message<C>(
    dbx: &C,
    signal_message_id: i64,
    signal_group_master_key: &str,
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    signal_message::Entity::find_by_id(signal_message_id)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq(signal_group_master_key),
        )
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn ensure_current_user_sender<C>(
    dbx: &C,
    login: &uuid::Uuid,
) -> Result<String, AppError>
where
    C: ConnectionTrait,
{
    let sender = login.to_string();
    let login_name = login::Entity::find_by_id(*login)
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    match signal_profile::Entity::find_by_id(*login)
        .one(dbx)
        .await
        .c(h!())?
    {
        None => {
            signal_profile::ActiveModel {
                uuid: Set(sender.clone()),
                given_name: Set(Some(login_name)),
                family_name: Set(None),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        Some(signal_profile)
            if signal_profile.given_name.as_deref()
                == Some(sender.as_str()) =>
        {
            let mut signal_profile = signal_profile.into_active_model();
            signal_profile.given_name = Set(Some(login_name));
            signal_profile.update(dbx).await.c(h!())?;
        }
        Some(_) => {}
    }
    Ok(sender)
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
    device_name_id: Option<i64>,
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

pub async fn set_inbox_item_network<C>(
    dbx: &C,
    inbox_item_id: i64,
    network: Option<String>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    sigint_inbox_item::Entity::update_many()
        .col_expr(sigint_inbox_item::Column::Network, Expr::value(network))
        .filter(sigint_inbox_item::Column::Id.eq(inbox_item_id))
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

pub async fn delete_signal_message_media<C>(
    dbx: &C,
    signal_message_id: i64,
    media_ids: &[Uuid],
) -> Result<Vec<signal_message_media::Model>, AppError>
where
    C: ConnectionTrait,
{
    if media_ids.is_empty() {
        return Ok(vec![]);
    }
    let media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_media::Column::Id.is_in(media_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    if media.len() != media_ids.len() {
        return Err(AppError::NotFound);
    }
    signal_message_media::Entity::delete_many()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_media::Column::Id.is_in(media_ids.iter().copied()),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(media)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::delta_login;
    use crate::functest::tests::{cleanup, mk_login};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn current_user_sender_profile_uses_echo_login_name() {
        let env = cleanup().await.unwrap();
        let regular_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("regular-sender".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("delta-auth-name".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let delta_linked_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("delta-linked-sender".to_string()),
                delta_login_id: Set(Some(delta_login.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_profile::ActiveModel {
            uuid: Set(delta_linked_login.id.to_string()),
            given_name: Set(Some(delta_linked_login.id.to_string())),
            family_name: Set(None),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for login in [regular_login, delta_linked_login] {
            let sender = ensure_current_user_sender(&env.dbx, &login.id)
                .await
                .unwrap();
            let signal_profile =
                signal_profile::Entity::find_by_id(sender.clone())
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap();

            assert_eq!(sender, login.id.to_string());
            assert_eq!(
                signal_profile.given_name.as_deref(),
                Some(login.login.as_str())
            );
        }
    }
}
