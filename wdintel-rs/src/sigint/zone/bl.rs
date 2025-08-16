use crate::entities::*;
use crate::sigint::zone::ZoneDatasourceGroup;
use crate::types::*;
use sea_orm::*;

#[derive(Debug)]
pub struct BlSzdGroupUpdateRes {
    pub is_secret: bool,
    pub aor: Option<Vec<area_of_responsibility::Model>>,
    pub allowed_users: Vec<String>,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
}

pub async fn bl_szd_group_update(
    req: &crate::sigint::types::ZoneDatasourceGroupUpdateReq,
    szd: &sigint_zone_datasource::Model,
    txn: &DatabaseTransaction,
) -> Result<BlSzdGroupUpdateRes, AppError> {
    bl_zones_datasources_group_update_or_add(
        req.user_logins.clone(),
        req.is_secret,
        req.short_note.clone(),
        req.long_note.clone(),
        szd.clone(),
        &txn,
    )
    .await
    .context(h!())?;

    // Fetch updated allowed users
    let allowed_users = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(&szd.group_master_key))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();

    // Fetch updated is_secret and other group attributes

    let is_secret = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::IsSecret)
        .into_tuple::<bool>()
        .one(txn)
        .await
        .context(h!())?
        .unwrap_or(false);
    let (short_note, long_note) = group_admin_data::Entity::find()
        .filter(
            group_admin_data::Column::GroupMasterKey.eq(&szd.group_master_key),
        )
        .select_only()
        .columns([
            group_admin_data::Column::ShortNote,
            group_admin_data::Column::LongNote,
        ])
        .into_tuple::<(Option<String>, Option<String>)>()
        .one(txn)
        .await
        .context(h!())?
        .unwrap_or((None, None));

    let aor_ids = match &req.area_of_responsibility_ids {
        None => req.area_of_responsibility_id.map(|id| vec![id]),
        Some(ids) => Some(ids.clone()),
    };
    let aor = crate::messenger::bl::upsert_group_area_of_responsibility(
        txn,
        &szd.group_master_key,
        aor_ids,
    )
    .await
    .context(h!())?;

    let res = BlSzdGroupUpdateRes {
        is_secret,
        aor: if aor.is_empty() { None } else { Some(aor) },
        allowed_users,
        short_note,
        long_note,
    };
    Ok(res)
}

pub async fn bl_zones_datasources_group_update_or_add(
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

pub struct BlSzdGroupsListRes {
    pub groups: Vec<crate::sigint::zone::ZoneDatasourceGroup>,
}

pub async fn bl_szd_groups_list(
    zone_id: i64,
    datasource_id: i64,
    txn: &DatabaseTransaction,
) -> Result<BlSzdGroupsListRes, AppError> {
    #[derive(FromQueryResult, Debug)]
    struct Res {
        login: Option<String>,
        id: i64,
        group_master_key: String,
        is_secret: bool,
        short_note: Option<String>,
        long_note: Option<String>,
    }

    let rows = sigint_zone_datasource::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_zone_datasource::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::GroupAdminData.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_group::Relation::SecretGroupUser.def(),
        )
        .column_as(
            sigint_zone_datasource::Column::GroupMasterKey,
            "group_master_key",
        )
        .column_as(sigint_zone_datasource::Column::Id, "id")
        .column_as(signal_group::Column::IsSecret, "is_secret")
        .column_as(secret_group_user::Column::Login, "login")
        .column(group_admin_data::Column::ShortNote)
        .column(group_admin_data::Column::LongNote)
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .filter(sigint_zone_datasource::Column::DatasourceId.eq(datasource_id))
        .into_model::<Res>()
        .all(txn)
        .await
        .context(h!())?;

    let mut res = HashMap::<
        String,
        (bool, i64, Vec<String>, Option<String>, Option<String>),
    >::new();
    for row in rows {
        if let Some((_, _, login_vec, _, _)) =
            res.get_mut(&row.group_master_key)
        {
            if let Some(user_login) = row.login {
                login_vec.push(user_login);
            }
        } else {
            let logins = if let Some(user_login) = row.login {
                vec![user_login]
            } else {
                vec![]
            };
            res.insert(
                row.group_master_key,
                (row.is_secret, row.id, logins, row.short_note, row.long_note),
            );
        }
    }

    let keys = res.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
    let group_aors =
        crate::sigint::area_of_responsibility::bl::collect_group_aors(
            keys.clone(),
            txn,
        )
        .await
        .context(h!())?;

    let groups = res
        .into_iter()
        .map(
            |(
                master_key,
                (is_secret, szd_id, allowed_users, short_note, long_note),
            )| {
                let aor = group_aors.get(&master_key).cloned();
                ZoneDatasourceGroup {
                    areas_of_responsibility: aor.map(|a| vec![a]),
                    sigint_zone_datasource_id: szd_id,
                    group_master_key: master_key,
                    is_group_secret: is_secret,
                    allowed_users,
                    short_note,
                    long_note,
                }
            },
        )
        .collect();
    Ok(BlSzdGroupsListRes { groups })
}
