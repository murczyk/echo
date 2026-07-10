use crate::entities::sea_orm_active_enums as db_enums;
use crate::entities::*;
use crate::sigint::types::InterseptionKind;
use crate::sigint::zone::ZoneDatasourceGroup;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::*;

#[derive(Debug)]
pub struct BlSzdGroupUpdateRes {
    pub is_secret: bool,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub aor: Option<Vec<area_of_responsibility::Model>>,
    pub allowed_users: Vec<String>,
    pub allowed_organism_ids: Vec<i64>,
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
        req.organism_ids.clone(),
        req.admin_logins.clone(),
        req.is_secret,
        req.short_note.clone(),
        req.long_note.clone(),
        szd.clone(),
        txn,
    )
    .await
    .c(h!())?;

    let allowed_users = collect_direct_secret_group_users(
        vec![szd.group_master_key.clone()],
        txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();
    let allowed_organism_ids = collect_secret_group_organism_ids(
        vec![szd.group_master_key.clone()],
        txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();

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
    update_group_interseption_kind_if_enabled(
        req.interseption_kind,
        &szd.group_master_key,
        txn,
    )
    .await
    .c(h!())?;
    let interseption_kind = group_interseption_kind(&szd.group_master_key, txn)
        .await
        .c(h!())?;
    let mut network_invalidation_enqueued = false;
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
        interseption_kind,
        disable_network_assignment,
        aor: if aor.is_empty() { None } else { Some(aor) },
        allowed_users,
        allowed_organism_ids,
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

pub async fn group_interseption_kind(
    master_key: &str,
    txn: &DatabaseTransaction,
) -> Result<InterseptionKind, AppError> {
    Ok(signal_group::Entity::find_by_id(master_key.to_string())
        .select_only()
        .column(signal_group::Column::InterseptionKind)
        .into_tuple::<db_enums::InterseptionKind>()
        .one(txn)
        .await
        .c(h!())?
        .map(InterseptionKind::from)
        .unwrap_or(InterseptionKind::InterseptionRer))
}

pub async fn update_group_interseption_kind_if_enabled(
    interseption_kind: Option<InterseptionKind>,
    master_key: &str,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    if !crate::system_settings::support_non_rer_interceptions_enabled(txn)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    let Some(interseption_kind) = interseption_kind else {
        return Ok(());
    };
    let interseption_kind: db_enums::InterseptionKind =
        interseption_kind.into();
    if let Some(group) =
        signal_group::Entity::find_by_id(master_key.to_string())
            .one(txn)
            .await
            .c(h!())?
    {
        if group.interseption_kind == interseption_kind {
            return Ok(());
        }
        let mut group = group.into_active_model();
        group.interseption_kind = Set(interseption_kind);
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
    organism_ids: Vec<i64>,
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
            organism_ids,
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
    organism_ids: Vec<i64>,
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

        replace_secret_group_access(
            txn,
            master_key,
            is_secret,
            user_logins,
            organism_ids,
        )
        .await
        .c(h!())?;

        replace_group_admin_logins(txn, master_key, admin_logins)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn replace_secret_group_access(
    txn: &DatabaseTransaction,
    master_key: &str,
    is_secret: bool,
    user_logins: Vec<String>,
    organism_ids: Vec<i64>,
) -> Result<(), AppError> {
    secret_group_user::Entity::delete_many()
        .filter(secret_group_user::Column::MasterKey.eq(master_key))
        .exec(txn)
        .await
        .c(h!())?;

    secret_group_organism::Entity::delete_many()
        .filter(secret_group_organism::Column::MasterKey.eq(master_key))
        .exec(txn)
        .await
        .c(h!())?;

    if !is_secret {
        return Ok(());
    }

    for login in normalize_login_list(user_logins) {
        secret_group_user::ActiveModel {
            id: NotSet,
            master_key: Set(master_key.to_string()),
            login: Set(login),
            secret_group_organism_id: Set(None),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    for organism_id in
        load_active_organism_ids(txn, organism_ids).await.c(h!())?
    {
        secret_group_organism::ActiveModel {
            id: NotSet,
            master_key: Set(master_key.to_string()),
            organism_id: Set(organism_id),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    refresh_secret_group_memberships(txn).await.c(h!())?;
    Ok(())
}

fn normalize_login_list(logins: Vec<String>) -> Vec<String> {
    logins
        .into_iter()
        .map(|login| login.trim().to_string())
        .filter(|login| !login.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn load_active_organism_ids(
    txn: &DatabaseTransaction,
    organism_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError> {
    let organism_ids = organism_ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if organism_ids.is_empty() {
        return Ok(vec![]);
    }

    Ok(organism::Entity::find()
        .filter(organism::Column::Id.eq_any(organism_ids))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(organism::Column::Id)
        .order_by_asc(organism::Column::Id)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?)
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

pub async fn collect_direct_secret_group_users<'a, 'async_trait, C>(
    master_keys: Vec<String>,
    dbx: &'a C,
) -> Result<HashMap<String, Vec<String>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if master_keys.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq_any(master_keys))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
        .select_only()
        .column(secret_group_user::Column::MasterKey)
        .column(secret_group_user::Column::Login)
        .order_by_asc(secret_group_user::Column::Login)
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

pub async fn collect_secret_group_organism_ids<'a, 'async_trait, C>(
    master_keys: Vec<String>,
    dbx: &'a C,
) -> Result<HashMap<String, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if master_keys.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = secret_group_organism::Entity::find()
        .filter(secret_group_organism::Column::MasterKey.eq_any(master_keys))
        .select_only()
        .column(secret_group_organism::Column::MasterKey)
        .column(secret_group_organism::Column::OrganismId)
        .order_by_asc(secret_group_organism::Column::OrganismId)
        .into_tuple::<(String, i64)>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut res = HashMap::<String, Vec<i64>>::new();
    for (master_key, organism_id) in rows {
        res.entry(master_key).or_default().push(organism_id);
    }
    Ok(res)
}

pub async fn refresh_secret_group_memberships(
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let all_invites = secret_group_organism::Entity::find()
        .all(txn)
        .await
        .c(h!())?;
    if all_invites.is_empty() {
        return Ok(());
    }

    let invited_organism_ids = all_invites
        .iter()
        .map(|invite| invite.organism_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let active_organism_ids = organism::Entity::find()
        .filter(organism::Column::Id.eq_any(invited_organism_ids.clone()))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(organism::Column::Id)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();

    let mut valid_invites = vec![];
    for invite in all_invites {
        if active_organism_ids.contains(&invite.organism_id) {
            valid_invites.push(invite);
        } else {
            invite.delete(txn).await.c(h!())?;
        }
    }

    if valid_invites.is_empty() {
        return Ok(());
    }

    let logins = login::Entity::find()
        .filter(login::Column::OrganismId.eq_any(invited_organism_ids))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut logins_by_organism = HashMap::<i64, Vec<String>>::new();
    for login in logins {
        if let Some(organism_id) = login.organism_id {
            logins_by_organism
                .entry(organism_id)
                .or_default()
                .push(login.login);
        }
    }

    let mut desired = HashSet::<(i64, String, String)>::new();
    for invite in &valid_invites {
        let Some(logins) = logins_by_organism.get(&invite.organism_id) else {
            continue;
        };
        for login in logins {
            desired.insert((
                invite.id,
                invite.master_key.clone(),
                login.clone(),
            ));
        }
    }

    let existing = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_not_null())
        .all(txn)
        .await
        .c(h!())?;
    let mut existing_keys = HashSet::new();
    for secret_group_user in existing {
        let Some(secret_group_organism_id) =
            secret_group_user.secret_group_organism_id
        else {
            continue;
        };
        let key = (
            secret_group_organism_id,
            secret_group_user.master_key.clone(),
            secret_group_user.login.clone(),
        );
        if desired.contains(&key) {
            existing_keys.insert(key);
        } else {
            secret_group_user.delete(txn).await.c(h!())?;
        }
    }

    for (secret_group_organism_id, master_key, login) in desired {
        if existing_keys.contains(&(
            secret_group_organism_id,
            master_key.clone(),
            login.clone(),
        )) {
            continue;
        }
        secret_group_user::ActiveModel {
            id: NotSet,
            master_key: Set(master_key),
            login: Set(login),
            secret_group_organism_id: Set(Some(secret_group_organism_id)),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    Ok(())
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
        id: i64,
        group_master_key: String,
        is_secret: bool,
        interseption_kind: db_enums::InterseptionKind,
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
        .column_as(
            sigint_zone_datasource::Column::GroupMasterKey,
            "group_master_key",
        )
        .column_as(sigint_zone_datasource::Column::Id, "id")
        .column_as(signal_group::Column::IsSecret, "is_secret")
        .column_as(signal_group::Column::InterseptionKind, "interseption_kind")
        .column_as(
            signal_group::Column::DisableNetworkAssignment,
            "disable_network_assignment",
        )
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
            InterseptionKind,
            bool,
            i64,
            Option<String>,
            Option<String>,
        ),
    >::new();
    for row in rows {
        if !res.contains_key(&row.group_master_key) {
            res.insert(
                row.group_master_key,
                (
                    row.is_secret,
                    row.interseption_kind.into(),
                    row.disable_network_assignment,
                    row.id,
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
    let group_admins = collect_signal_group_admins(keys.clone(), txn)
        .await
        .c(h!())?;
    let group_users = collect_direct_secret_group_users(keys.clone(), txn)
        .await
        .c(h!())?;
    let group_organisms =
        collect_secret_group_organism_ids(keys, txn).await.c(h!())?;

    let groups = res
        .into_iter()
        .map(
            |(
                master_key,
                (
                    is_secret,
                    interseption_kind,
                    disable_network_assignment,
                    szd_id,
                    short_note,
                    long_note,
                ),
            )| {
                let aors = group_aors.get(&master_key).cloned();
                ZoneDatasourceGroup {
                    areas_of_responsibility: aors,
                    sigint_zone_datasource_id: szd_id,
                    is_group_secret: is_secret,
                    interseption_kind,
                    disable_network_assignment,
                    allowed_users: group_users
                        .get(&master_key)
                        .cloned()
                        .unwrap_or_default(),
                    allowed_organism_ids: group_organisms
                        .get(&master_key)
                        .cloned()
                        .unwrap_or_default(),
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
