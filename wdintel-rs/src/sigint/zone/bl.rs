use crate::entities::*;
use crate::sigint::zone::ZoneDatasourceGroup;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::*;

#[derive(Debug)]
pub struct BlSzdGroupUpdateRes {
    pub is_secret: bool,
    pub is_rer: bool,
    pub fills_etalonka: bool,
    pub disable_network_assignment: bool,
    pub aor: Option<Vec<area_of_responsibility::Model>>,
    pub allowed_users: Vec<String>,
    pub admin_logins: Vec<String>,
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
        req.admin_logins.clone(),
        req.is_secret,
        req.short_note.clone(),
        req.long_note.clone(),
        szd.clone(),
        txn,
    )
    .await
    .c(h!())?;

    // Fetch updated allowed users
    let allowed_users = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(&szd.group_master_key))
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();

    // Fetch updated is_secret and other group attributes

    let is_secret = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::IsSecret)
        .into_tuple::<bool>()
        .one(txn)
        .await
        .c(h!())?
        .unwrap_or(false);
    update_group_is_rer_if_enabled(req.is_rer, &szd.group_master_key, txn)
        .await
        .c(h!())?;
    let is_rer = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::IsRer)
        .into_tuple::<bool>()
        .one(txn)
        .await
        .c(h!())?
        .unwrap_or(true);
    let mut network_invalidation_enqueued = false;
    let fills_etalonka = update_group_fills_etalonka_if_present(
        req.fills_etalonka,
        &szd.group_master_key,
        txn,
        &mut network_invalidation_enqueued,
    )
    .await
    .c(h!())?;
    let disable_network_assignment =
        update_group_disable_network_assignment_if_present(
            req.disable_network_assignment,
            &szd.group_master_key,
            txn,
            &mut network_invalidation_enqueued,
        )
        .await
        .c(h!())?;
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
        .c(h!())?
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
    .c(h!())?;

    let res = BlSzdGroupUpdateRes {
        is_secret,
        is_rer,
        fills_etalonka,
        disable_network_assignment,
        aor: if aor.is_empty() { None } else { Some(aor) },
        allowed_users,
        admin_logins: collect_signal_group_admins(
            vec![szd.group_master_key.clone()],
            txn,
        )
        .await
        .c(h!())?
        .remove(&szd.group_master_key)
        .unwrap_or_default(),
        short_note,
        long_note,
    };
    Ok(res)
}

async fn update_group_disable_network_assignment_if_present(
    disable_network_assignment: Option<bool>,
    master_key: &str,
    txn: &DatabaseTransaction,
    network_invalidation_enqueued: &mut bool,
) -> Result<bool, AppError> {
    let Some(disable_network_assignment) = disable_network_assignment else {
        return Ok(signal_group::Entity::find_by_id(master_key.to_string())
            .select_only()
            .column(signal_group::Column::DisableNetworkAssignment)
            .into_tuple::<bool>()
            .one(txn)
            .await
            .c(h!())?
            .unwrap_or(false));
    };

    let (group, changed) =
        crate::sigint::network::etalon_calc::set_group_disable_network_assignment(
            txn,
            master_key,
            disable_network_assignment,
        )
        .await
        .c(h!())?;
    if changed {
        crate::sigint::network::etalon_calc::invalidate_network_inbox_for_group_all_history_once(
            txn,
            &group,
            format!(
                "updated group disable_network_assignment from zone group edit: {}",
                group.master_key
            ),
            network_invalidation_enqueued,
        )
        .await
        .c(h!())?;
    }
    Ok(group.disable_network_assignment)
}

async fn update_group_fills_etalonka_if_present(
    fills_etalonka: Option<bool>,
    master_key: &str,
    txn: &DatabaseTransaction,
    network_invalidation_enqueued: &mut bool,
) -> Result<bool, AppError> {
    let Some(fills_etalonka) = fills_etalonka else {
        return Ok(signal_group::Entity::find_by_id(master_key.to_string())
            .select_only()
            .column(signal_group::Column::FillsEtalonka)
            .into_tuple::<bool>()
            .one(txn)
            .await
            .c(h!())?
            .unwrap_or(true));
    };

    let (group, changed) =
        crate::sigint::network::etalon_calc::set_group_fills_etalonka(
            txn,
            master_key,
            fills_etalonka,
        )
        .await
        .c(h!())?;
    if changed {
        crate::sigint::network::etalon_calc::invalidate_network_inbox_for_group_all_history_once(
            txn,
            &group,
            format!(
                "updated group fills_etalonka from zone group edit: {}",
                group.master_key
            ),
            network_invalidation_enqueued,
        )
        .await
        .c(h!())?;
    }
    Ok(group.fills_etalonka)
}

async fn update_group_is_rer_if_enabled(
    is_rer: Option<bool>,
    master_key: &str,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    if !crate::system_settings::support_non_rer_interceptions_enabled(txn)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    let Some(is_rer) = is_rer else {
        return Ok(());
    };
    if let Some(group) =
        signal_group::Entity::find_by_id(master_key.to_string())
            .one(txn)
            .await
            .c(h!())?
    {
        if group.is_rer == is_rer {
            return Ok(());
        }
        let mut group = group.into_active_model();
        group.is_rer = Set(is_rer);
        group.update(txn).await.c(h!())?;
        crate::sigint::unit_tag::enqueue_recent_unit_tag_recalculation_for_group(
            txn, master_key,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn bl_zones_datasources_group_update_or_add(
    user_logins: Vec<String>,
    admin_logins: Vec<String>,
    is_secret: bool,
    short_note: Option<String>,
    long_note: Option<String>,
    szd: sigint_zone_datasource::Model,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let m_group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(szd.group_master_key))
        .one(txn)
        .await
        .c(h!())?;

    if let Some(group) = m_group {
        let master_key = group.master_key.clone();

        let m_group = group_admin_data::Entity::find()
            .filter(
                group_admin_data::Column::GroupMasterKey.eq(master_key.clone()),
            )
            .one(txn)
            .await
            .c(h!())?;
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
            .c(h!())?,
        }
        .into_active_model();

        group_data.short_note = Set(short_note);
        group_data.long_note = Set(long_note);
        group_data.update(txn).await.c(h!())?;

        update_signal_group_access_and_admins(
            user_logins,
            admin_logins,
            is_secret,
            &master_key,
            txn,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn update_signal_group_access_and_admins(
    user_logins: Vec<String>,
    admin_logins: Vec<String>,
    is_secret: bool,
    master_key: &str,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(master_key))
        .one(txn)
        .await
        .c(h!())?;

    if let Some(group) = group {
        let mut group = group.into_active_model();
        group.is_secret = Set(is_secret);
        group.update(txn).await.c(h!())?;

        secret_group_user::Entity::delete_many()
            .filter(secret_group_user::Column::MasterKey.eq(master_key))
            .exec(txn)
            .await
            .c(h!())?;

        for login in user_logins {
            secret_group_user::ActiveModel {
                master_key: Set(master_key.to_string()),
                login: Set(login),
                ..Default::default()
            }
            .insert(txn)
            .await
            .c(h!())?;
        }

        replace_group_admin_logins(txn, master_key, admin_logins)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn replace_group_admin_logins(
    txn: &DatabaseTransaction,
    master_key: &str,
    admin_logins: Vec<String>,
) -> Result<(), AppError> {
    let admin_logins = admin_logins
        .into_iter()
        .map(|login| login.trim().to_string())
        .filter(|login| !login.is_empty())
        .collect::<HashSet<_>>();

    signal_group_admin::Entity::update_many()
        .col_expr(signal_group_admin::Column::Deleted, Expr::value(true))
        .filter(signal_group_admin::Column::SignalGroupId.eq(master_key))
        .exec(txn)
        .await
        .c(h!())?;

    for login in admin_logins {
        let existing = signal_group_admin::Entity::find_by_id((
            master_key.to_string(),
            login.clone(),
        ))
        .one(txn)
        .await
        .c(h!())?;

        if let Some(admin) = existing {
            let mut admin = admin.into_active_model();
            admin.deleted = Set(false);
            admin.update(txn).await.c(h!())?;
            continue;
        }

        signal_group_admin::ActiveModel {
            signal_group_id: Set(master_key.to_string()),
            login: Set(login),
            deleted: Set(false),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    Ok(())
}

pub async fn collect_signal_group_admins<'a, 'async_trait, C>(
    master_keys: Vec<String>,
    dbx: &'a C,
) -> Result<HashMap<String, Vec<String>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if master_keys.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = signal_group_admin::Entity::find()
        .filter(signal_group_admin::Column::Deleted.eq(false))
        .filter(signal_group_admin::Column::SignalGroupId.eq_any(master_keys))
        .select_only()
        .column(signal_group_admin::Column::SignalGroupId)
        .column(signal_group_admin::Column::Login)
        .order_by_asc(signal_group_admin::Column::Login)
        .into_tuple::<(String, String)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut res = HashMap::<String, Vec<String>>::new();
    for (master_key, login) in rows {
        res.entry(master_key).or_default().push(login);
    }
    Ok(res)
}

pub async fn unlink_reserve_group_dupes<'a, 'async_trait, C>(
    dbx: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let cutoff = Utc::now() - chrono::Duration::hours(3);
    let live_groups = signal_message::Entity::find()
        .filter(signal_message::Column::CreatedAt.gte(cutoff.naive_utc()))
        .select_only()
        .column(signal_message::Column::DatasourceGroupId)
        .distinct()
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .context(h!())?;
    if live_groups.is_empty() {
        warn!("no live groups, exiting.");
        return Ok(());
    }
    let groups = datasource_group::Entity::find()
        .filter(datasource_group::Column::Id.eq_any(live_groups))
        .all(dbx)
        .await
        .context(h!())?;
    let links = sigint_zone_datasource::Entity::find()
        .all(dbx)
        .await
        .context(h!())?;
    let mut active_links = HashSet::new();
    for rec in links {
        let master_key = &rec.group_master_key;
        if active_links.contains(master_key) {
            rec.delete(dbx).await.context(h!())?;
            continue;
        }
        let is_active = groups
            .iter()
            .filter(|g| g.group_master_key.eq(master_key))
            .any(|g| g.datasource_id.eq(&rec.datasource_id));
        if !is_active {
            continue;
        }
        active_links.insert(master_key.to_string());
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
        is_rer: bool,
        fills_etalonka: bool,
        disable_network_assignment: bool,
        short_note: Option<String>,
        long_note: Option<String>,
    }

    let rows = sigint_zone_datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_zone_datasource::Relation::Datasource.def(),
        )
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
        .column_as(signal_group::Column::IsRer, "is_rer")
        .column_as(signal_group::Column::FillsEtalonka, "fills_etalonka")
        .column_as(
            signal_group::Column::DisableNetworkAssignment,
            "disable_network_assignment",
        )
        .column_as(secret_group_user::Column::Login, "login")
        .column(group_admin_data::Column::ShortNote)
        .column(group_admin_data::Column::LongNote)
        .filter(datasource::Column::Deleted.eq(false))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .filter(sigint_zone_datasource::Column::DatasourceId.eq(datasource_id))
        .into_model::<Res>()
        .all(txn)
        .await
        .c(h!())?;

    let mut res = HashMap::<
        String,
        (
            bool,
            bool,
            bool,
            bool,
            i64,
            Vec<String>,
            Option<String>,
            Option<String>,
        ),
    >::new();
    for row in rows {
        if let Some((_, _, _, _, _, login_vec, _, _)) =
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
                (
                    row.is_secret,
                    row.is_rer,
                    row.fills_etalonka,
                    row.disable_network_assignment,
                    row.id,
                    logins,
                    row.short_note,
                    row.long_note,
                ),
            );
        }
    }

    let keys = res.keys().cloned().collect::<Vec<_>>();
    let group_aors =
        crate::sigint::aor::bl::collect_group_aors(keys.clone(), txn)
            .await
            .c(h!())?;
    let group_admins = collect_signal_group_admins(keys, txn).await.c(h!())?;

    let groups = res
        .into_iter()
        .map(
            |(
                master_key,
                (
                    is_secret,
                    is_rer,
                    fills_etalonka,
                    disable_network_assignment,
                    szd_id,
                    allowed_users,
                    short_note,
                    long_note,
                ),
            )| {
                let aors = group_aors.get(&master_key).cloned();
                ZoneDatasourceGroup {
                    areas_of_responsibility: aors,
                    sigint_zone_datasource_id: szd_id,
                    is_group_secret: is_secret,
                    is_rer,
                    fills_etalonka,
                    disable_network_assignment,
                    allowed_users,
                    admin_logins: group_admins
                        .get(&master_key)
                        .cloned()
                        .unwrap_or_default(),
                    group_master_key: master_key,
                    short_note,
                    long_note,
                }
            },
        )
        .collect();
    Ok(BlSzdGroupsListRes { groups })
}
