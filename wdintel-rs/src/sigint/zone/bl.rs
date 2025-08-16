use crate::entities::*;
use crate::types::*;
use sea_orm::*;

pub async fn zones_datasources_group_update_bl(
    user_logins: Vec<String>,
    is_secret: bool,
    short_note: Option<String>,
    long_note: Option<String>,
    szd: sigint_zone_datasource::Model,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let m_group = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(szd.group_master_key))
        .one(txn)
        .await
        .context(h!())?;

    if let Some(group) = m_group {
        let master_key = group.master_key.clone();

        let m_group = group_admin_data::Entity::find()
            .filter(
                group_admin_data::Column::GroupMasterKey
                    .eq(&master_key.clone()),
            )
            .one(txn)
            .await
            .context(h!())?;
        let mut group_data = match m_group {
            Some(group) => group,
            None => group_admin_data::ActiveModel {
                group_master_key: Set(Some(master_key.clone())),
                short_note: Set(short_note.clone()),
                long_note: Set(long_note.clone()),
                id: NotSet,
                created_at: NotSet,
            }
            .insert(txn)
            .await
            .context(h!())?,
        }
        .into_active_model();

        group_data.short_note = Set(short_note);
        group_data.long_note = Set(long_note);
        group_data.update(txn).await.context(h!())?;

        // Update the group's secret status
        let mut active_group: signal_group::ActiveModel = group.into();
        active_group.is_secret = Set(is_secret);
        active_group.update(txn).await.context(h!())?;

        // Delete all current users for this group
        secret_group_user::Entity::delete_many()
            .filter(secret_group_user::Column::MasterKey.eq(&master_key))
            .exec(txn)
            .await
            .context(h!())?;

        // Add all new users from the request
        for login in user_logins {
            secret_group_user::ActiveModel {
                master_key: Set(master_key.clone()),
                login: Set(login),
                ..Default::default()
            }
            .insert(txn)
            .await
            .context(h!())?;
        }
    }

    Ok(())
}
