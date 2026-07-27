use self::bl::*;
use super::types::*;
use crate::entities::sigint_zone_datasource;
use crate::entities::*;
use crate::sigint::aor::bl::collect_group_aors;
use crate::sigint::aor::render_aor;
use crate::types::*;
use crate::users::{ensure_admin, has_any_role, login_id_from_identity};
use crate::utils::orm::ArrayColumnOps;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod bl;
#[cfg(test)]
pub mod tests;

#[post("/api/sigint/zones/list")]
pub async fn zones_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<(i64, SigintZone)>>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api", "Admin"],
    )
    .await?;
    let zones = sigint_zone::Entity::find()
        .filter(sigint_zone::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for zone in zones {
        res.push((
            zone.id,
            SigintZone {
                name: zone.name.clone(),
                created_at: zone.created_at.and_utc().timestamp_millis(),
            },
        ));
    }
    Ok(Json(res))
}

#[post("/api/sigint/zones/zone-datasources")]
pub async fn zones_datasources_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i64>,
) -> Result<Json<Vec<i64>>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await?;
    let zone_id: i64 = req.into_inner();
    let xs = sigint_zone_datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_zone_datasource::Relation::SignalGroup.def(),
        )
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for x in xs {
        if !res.contains(&x.datasource_id) {
            res.push(x.datasource_id);
        }
    }
    Ok(Json(res))
}

#[post("/api/sigint/zones/zone-datasource-groups")]
pub async fn zones_datasources_groups_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupsReq>,
) -> Result<Json<ZoneDatasourceGroupListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let txn = env.dbx.begin().await.c(h!())?;

    let res = bl_szd_groups_list(req.zone_id, req.datasource_id, &txn)
        .await
        .c(h!())?;

    Ok(Json(ZoneDatasourceGroupListRsp {
        zone_datasource_groups: res.groups,
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-update")]
pub async fn zones_datasources_group_update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupUpdateReq>,
) -> Result<Json<ZoneDatasourceGroup>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();

    let txn = env.dbx.begin().await.c(h!())?;
    let szd = sigint_zone_datasource::Entity::find_by_id(req.id)
        .one(&txn)
        .await
        .c(h!())?
        .c(h!())?;

    let rsp = bl_szd_group_update(&req, &szd, &txn).await.c(h!())?;
    log_sigint_zone_datasource_event(
        &szd,
        "zone-datasource-group-update",
        &login,
    );

    txn.commit().await.c(h!())?;

    Ok(Json(ZoneDatasourceGroup {
        sigint_zone_datasource_id: szd.id,
        group_master_key: szd.group_master_key,
        is_group_secret: rsp.is_secret,
        interseption_kind: rsp.interseption_kind,
        disable_network_assignment: rsp.disable_network_assignment,
        areas_of_responsibility: rsp
            .aor
            .map(|aors| aors.into_iter().map(render_aor).collect()),
        allowed_users: rsp.allowed_users,
        allowed_organism_ids: rsp.allowed_organism_ids,
        admin_logins: rsp.admin_logins,
        short_note: rsp.short_note,
        long_note: rsp.long_note,
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-add")]
pub async fn zones_datasources_group_add(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupAddReq>,
) -> Result<Json<ZoneDatasourceGroupAddRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();

    let txn = env.dbx.begin().await.c(h!())?;
    signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&req.master_key))
        .one(&txn)
        .await
        .c(h!())?
        .c(h!())?;

    let szd = sigint_zone_datasource::ActiveModel {
        sigint_zone_id: Set(req.zone_id),
        datasource_id: Set(req.datasource_id),
        group_master_key: Set(req.master_key.clone()),
        ..Default::default()
    }
    .insert(&txn)
    .await
    .c(h!())?;

    let is_secret = bl_zones_datasources_group_add(
        req.user_logins.clone(),
        req.organism_ids.clone(),
        req.admin_logins.clone(),
        req.is_secret,
        req.short_note,
        req.long_note,
        &szd,
        &txn,
    )
    .await
    .c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_group_history(
        &txn,
        &szd.group_master_key,
        format!(
            "added group {} to zone datasource {}",
            szd.group_master_key, szd.id
        ),
    )
    .await
    .c(h!())?;

    let allowed_users = bl::collect_direct_secret_group_users(
        vec![szd.group_master_key.clone()],
        &txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();
    let allowed_organism_ids = bl::collect_secret_group_organism_ids(
        vec![szd.group_master_key.clone()],
        &txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();
    let admin_logins = bl::collect_signal_group_admins(
        vec![szd.group_master_key.clone()],
        &txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();

    let group_master_key = szd.group_master_key.clone();

    // Fetch the group name and notes
    let group_name = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::Name)
        .into_tuple::<Option<String>>()
        .one(&txn)
        .await
        .c(h!())?
        .flatten();
    bl::update_group_interseption_kind_if_enabled(
        req.interseption_kind,
        &group_master_key,
        &txn,
    )
    .await
    .c(h!())?;
    let interseption_kind =
        bl::group_interseption_kind(&group_master_key, &txn)
            .await
            .c(h!())?;
    let disable_network_assignment =
        signal_group::Entity::find_by_id(group_master_key.clone())
            .select_only()
            .column(signal_group::Column::DisableNetworkAssignment)
            .into_tuple::<bool>()
            .one(&txn)
            .await
            .c(h!())?
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
        .one(&txn)
        .await
        .c(h!())?
        .unwrap_or((None, None));

    let areas_of_responsibility =
        collect_group_aors(vec![group_master_key.clone()], &env.dbx)
            .await
            .c(h!())?
            .remove(&group_master_key);

    txn.commit().await.c(h!())?;
    log_sigint_zone_datasource_event(&szd, "zone-datasource-group-add", &login);

    Ok(Json(ZoneDatasourceGroupAddRsp {
        zone_id: req.zone_id,
        datasource_id: req.datasource_id,
        group_master_key: group_master_key.clone(),
        group_name,
        zone_datasource_group: ZoneDatasourceGroup {
            sigint_zone_datasource_id: szd.id,
            is_group_secret: is_secret,
            interseption_kind,
            disable_network_assignment,
            areas_of_responsibility,
            group_master_key,
            allowed_users,
            allowed_organism_ids,
            admin_logins,
            short_note,
            long_note,
        },
    }))
}

#[post("/api/sigint/zones/zone-datasource-group-delete")]
pub async fn zones_datasources_group_delete(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i64>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;

    let txn = env.dbx.begin().await.c(h!())?;

    if let Some(szd) = sigint_zone_datasource::Entity::find_by_id(req.0)
        .one(&txn)
        .await
        .c(h!())?
    {
        szd.clone().delete(&txn).await.c(h!())?;
        txn.commit().await.c(h!())?;
        log_sigint_zone_datasource_event(
            &szd,
            "zone-datasource-group-delete",
            &login,
        );
    } else {
        txn.commit().await.c(h!())?;
    }

    Ok(Json(()))
}

#[post("/api/sigint/zones/my-admin-groups")]
pub async fn my_admin_groups(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<MyAdminSignalGroupsRsp>, AppError> {
    let login = login_id_from_identity(&user)?;

    let groups = signal_group_admin::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group_admin::Relation::SignalGroup.def(),
        )
        .filter(signal_group_admin::Column::Deleted.eq(false))
        .filter(signal_group_admin::Column::LoginId.eq(login))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .select_only()
        .column_as(signal_group::Column::MasterKey, "master_key")
        .column_as(signal_group::Column::Name, "name")
        .column_as(signal_group::Column::DatasourceId, "datasource_id")
        .column_as(signal_group::Column::IsSecret, "is_group_secret")
        .column_as(
            signal_group::Column::DisableNetworkAssignment,
            "disable_network_assignment",
        )
        .order_by_asc(signal_group::Column::Name)
        .into_tuple::<(String, Option<String>, Option<i64>, bool, bool)>()
        .all(&env.dbx)
        .await
        .c(h!())?;

    let master_keys = groups
        .iter()
        .map(|(master_key, _, _, _, _)| master_key.clone())
        .collect::<Vec<_>>();
    let datasource_ids = groups
        .iter()
        .filter_map(|(_, _, datasource_id, _, _)| *datasource_id)
        .collect::<Vec<_>>();

    let group_aors = collect_group_aors(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let group_admins =
        bl::collect_signal_group_admins(master_keys.clone(), &env.dbx)
            .await
            .c(h!())?;
    let allowed_users =
        bl::collect_direct_secret_group_users(master_keys.clone(), &env.dbx)
            .await
            .c(h!())?;
    let allowed_organism_ids =
        bl::collect_secret_group_organism_ids(master_keys, &env.dbx)
            .await
            .c(h!())?;
    let datasource_map = collect_datasources(datasource_ids, &env.dbx)
        .await
        .c(h!())?;
    let group_login_map = collect_group_logins(
        group_admins
            .values()
            .chain(allowed_users.values())
            .flat_map(|logins| logins.iter().cloned())
            .collect(),
        &env.dbx,
    )
    .await
    .c(h!())?;

    let groups = groups
        .into_iter()
        .map(
            |(
                master_key,
                name,
                datasource_id,
                is_group_secret,
                disable_network_assignment,
            )| {
                let datasource =
                    datasource_id.and_then(|id| datasource_map.get(&id));
                let fallback_name = master_key
                    .chars()
                    .rev()
                    .take(5)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                MyAdminSignalGroup {
                    name: name.unwrap_or(fallback_name),
                    datasource_name: datasource
                        .map(|datasource| datasource.display_name.clone()),
                    datasource_kind: datasource
                        .map(|datasource| datasource.kind.clone()),
                    areas_of_responsibility: group_aors
                        .get(&master_key)
                        .cloned(),
                    allowed_users: render_group_logins(
                        allowed_users
                            .get(&master_key)
                            .cloned()
                            .unwrap_or_default(),
                        &group_login_map,
                    ),
                    allowed_organism_ids: allowed_organism_ids
                        .get(&master_key)
                        .cloned()
                        .unwrap_or_default(),
                    admin_logins: render_group_logins(
                        group_admins
                            .get(&master_key)
                            .cloned()
                            .unwrap_or_default(),
                        &group_login_map,
                    ),
                    master_key,
                    is_group_secret,
                    disable_network_assignment,
                }
            },
        )
        .collect();

    Ok(Json(MyAdminSignalGroupsRsp { groups }))
}

#[post("/api/sigint/zones/my-admin-group-edit-reference")]
pub async fn my_admin_group_edit_reference(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<MyAdminSignalGroupEditReferenceReq>,
) -> Result<Json<MyAdminSignalGroupEditReferenceRsp>, AppError> {
    if !env.config.feature_my_admin_groups_edit.unwrap_or(false) {
        return Err(AppError::Forbidden(
            "feature_my_admin_groups_edit is disabled".to_string(),
        ));
    }

    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();
    ensure_my_admin_group_access(&env.dbx, &login, &req.master_key)
        .await
        .c(h!())?;

    let login_ids = collect_active_organism_login_ids(&env.dbx, &login)
        .await
        .c(h!())?;
    let group_login_map = collect_group_logins(login_ids.clone(), &env.dbx)
        .await
        .c(h!())?;
    let logins = render_group_logins(login_ids, &group_login_map);
    let organisms = collect_active_user_organisms(&env.dbx, &login)
        .await
        .c(h!())?;

    let areas_of_responsibility = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(area_of_responsibility::Column::Name)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_aor)
        .collect();

    Ok(Json(MyAdminSignalGroupEditReferenceRsp {
        logins,
        organisms,
        areas_of_responsibility,
    }))
}

#[post("/api/sigint/zones/my-admin-group-update")]
pub async fn my_admin_group_update(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<MyAdminSignalGroupUpdateReq>,
) -> Result<Json<()>, AppError> {
    if !env.config.feature_my_admin_groups_edit.unwrap_or(false) {
        return Err(AppError::Forbidden(
            "feature_my_admin_groups_edit is disabled".to_string(),
        ));
    }

    let login = login_id_from_identity(&user)?;
    let req = req.into_inner();
    let txn = env.dbx.begin().await.c(h!())?;

    ensure_my_admin_group_access(&txn, &login, &req.master_key)
        .await
        .c(h!())?;
    let admin_logins =
        normalize_my_admin_group_admin_logins(req.admin_logins).c(h!())?;
    let allowed_organism_logins =
        collect_active_organism_login_ids(&txn, &login)
            .await
            .c(h!())?;
    let existing_admin_logins =
        bl::collect_signal_group_admins(vec![req.master_key.clone()], &txn)
            .await
            .c(h!())?
            .remove(&req.master_key)
            .unwrap_or_default();
    ensure_added_my_admin_group_admin_logins_allowed(
        &admin_logins,
        &allowed_organism_logins,
        &existing_admin_logins,
    )?;

    let (user_logins, organism_ids) = if req.is_secret {
        let existing_user_logins = bl::collect_direct_secret_group_users(
            vec![req.master_key.clone()],
            &txn,
        )
        .await
        .c(h!())?
        .remove(&req.master_key)
        .unwrap_or_default();
        ensure_added_my_admin_group_user_logins_allowed(
            &req.user_logins,
            &allowed_organism_logins,
            &existing_user_logins,
        )?;
        let allowed_organisms =
            collect_active_user_organisms(&txn, &login).await.c(h!())?;
        let allowed_organism_ids = allowed_organisms
            .iter()
            .map(|organism| organism.id)
            .collect::<Vec<_>>();
        let existing_organism_ids = bl::collect_secret_group_organism_ids(
            vec![req.master_key.clone()],
            &txn,
        )
        .await
        .c(h!())?
        .remove(&req.master_key)
        .unwrap_or_default();
        ensure_added_my_admin_group_organism_ids_allowed(
            &req.organism_ids,
            &allowed_organism_ids,
            &existing_organism_ids,
        )?;
        (req.user_logins, req.organism_ids)
    } else {
        (vec![], vec![])
    };
    bl::update_signal_group_access_and_admins(
        user_logins,
        organism_ids,
        admin_logins,
        req.is_secret,
        &req.master_key,
        &txn,
    )
    .await
    .c(h!())?;

    let mut network_invalidation_enqueued = false;
    let (group, changed) =
        crate::sigint::network::etalon_calc::set_group_disable_network_assignment(
            &txn,
            &req.master_key,
            req.disable_network_assignment,
        )
        .await
        .c(h!())?;
    if changed {
        crate::sigint::network::etalon_calc::invalidate_network_inbox_for_group_all_history_once(
            &txn,
            &group,
            format!(
                "updated group disable_network_assignment from my admin group edit: {}",
                group.master_key
            ),
            &mut network_invalidation_enqueued,
        )
        .await
        .c(h!())?;
    }

    crate::messenger::bl::upsert_group_area_of_responsibility(
        &txn,
        &req.master_key,
        req.area_of_responsibility_ids,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

fn normalize_my_admin_group_admin_logins(
    admin_logins: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let mut admin_logins = admin_logins
        .into_iter()
        .map(|login| login.trim().to_string())
        .filter(|login| !login.is_empty())
        .collect::<Vec<_>>();
    admin_logins.sort();
    admin_logins.dedup();

    if admin_logins.is_empty() {
        return Err(AppError::BL {
            msg: "signal group must have at least one admin".to_string(),
        });
    }

    Ok(admin_logins)
}

async fn collect_active_organism_login_ids<'a, 'async_trait, C>(
    dbx: &'a C,
    login_id: &uuid::Uuid,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_obj = login::Entity::find()
        .filter(login::Column::Id.eq(*login_id))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;

    let mut query = login::Entity::find()
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(login::Column::Id)
        .order_by_asc(login::Column::Id);

    query = match login_obj.organism_id {
        Some(organism_id) => {
            query.filter(login::Column::OrganismId.eq(organism_id))
        }
        None => query.filter(login::Column::Id.eq(login_obj.id)),
    };

    Ok(query
        .into_tuple::<uuid::Uuid>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|login_id| login_id.to_string())
        .collect())
}

async fn collect_active_user_organisms<'a, 'async_trait, C>(
    dbx: &'a C,
    login_id: &uuid::Uuid,
) -> Result<Vec<crate::organism::types::MyOrganism>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_obj = login::Entity::find()
        .filter(login::Column::Id.eq(*login_id))
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;

    let Some(organism_id) = login_obj.organism_id else {
        return Ok(vec![]);
    };

    Ok(organism::Entity::find()
        .filter(organism::Column::Id.eq(organism_id))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .order_by_asc(organism::Column::Name)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|organism| crate::organism::types::MyOrganism {
            id: organism.id,
            name: organism.name,
        })
        .collect())
}

fn ensure_added_my_admin_group_admin_logins_allowed(
    admin_logins: &[String],
    allowed_admin_logins: &[String],
    existing_admin_logins: &[String],
) -> Result<(), AppError> {
    let allowed_admin_logins =
        allowed_admin_logins.iter().collect::<HashSet<_>>();
    let existing_admin_logins =
        existing_admin_logins.iter().collect::<HashSet<_>>();
    let disallowed_admin_logins = admin_logins
        .iter()
        .filter(|login| {
            !allowed_admin_logins.contains(login)
                && !existing_admin_logins.contains(login)
        })
        .cloned()
        .collect::<Vec<_>>();

    if !disallowed_admin_logins.is_empty() {
        return Err(AppError::Forbidden(format!(
            "new signal group admins must be active users from your organism: {}",
            disallowed_admin_logins.join(", ")
        )));
    }

    Ok(())
}

fn ensure_added_my_admin_group_user_logins_allowed(
    user_logins: &[String],
    allowed_user_logins: &[String],
    existing_user_logins: &[String],
) -> Result<(), AppError> {
    let allowed_user_logins =
        allowed_user_logins.iter().collect::<HashSet<_>>();
    let existing_user_logins =
        existing_user_logins.iter().collect::<HashSet<_>>();
    let disallowed_user_logins = user_logins
        .iter()
        .filter(|login| {
            !allowed_user_logins.contains(login)
                && !existing_user_logins.contains(login)
        })
        .cloned()
        .collect::<Vec<_>>();

    if !disallowed_user_logins.is_empty() {
        return Err(AppError::Forbidden(format!(
            "new signal group users must be active users from your organism: {}",
            disallowed_user_logins.join(", ")
        )));
    }

    Ok(())
}

fn ensure_added_my_admin_group_organism_ids_allowed(
    organism_ids: &[i64],
    allowed_organism_ids: &[i64],
    existing_organism_ids: &[i64],
) -> Result<(), AppError> {
    let allowed_organism_ids =
        allowed_organism_ids.iter().collect::<HashSet<_>>();
    let existing_organism_ids =
        existing_organism_ids.iter().collect::<HashSet<_>>();
    let disallowed_organism_ids = organism_ids
        .iter()
        .filter(|organism_id| {
            !allowed_organism_ids.contains(organism_id)
                && !existing_organism_ids.contains(organism_id)
        })
        .map(|organism_id| organism_id.to_string())
        .collect::<Vec<_>>();

    if !disallowed_organism_ids.is_empty() {
        return Err(AppError::Forbidden(format!(
            "new signal group organisms must include only your organism: {}",
            disallowed_organism_ids.join(", ")
        )));
    }

    Ok(())
}

async fn ensure_my_admin_group_access<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    master_key: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let has_access = signal_group_admin::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group_admin::Relation::SignalGroup.def(),
        )
        .filter(signal_group_admin::Column::Deleted.eq(false))
        .filter(signal_group_admin::Column::LoginId.eq(*login))
        .filter(signal_group_admin::Column::SignalGroupId.eq(master_key))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();

    if !has_access {
        return Err(AppError::Forbidden(format!(
            "user {login} is not admin of signal group {master_key}"
        )));
    }

    Ok(())
}

fn render_group_logins(
    logins: Vec<String>,
    group_login_map: &HashMap<String, SignalGroupLogin>,
) -> Vec<SignalGroupLogin> {
    logins
        .into_iter()
        .map(|login_id| {
            group_login_map.get(&login_id).cloned().unwrap_or_else(|| {
                SignalGroupLogin {
                    login: login_id.clone(),
                    login_id,
                    delta_login: None,
                }
            })
        })
        .collect()
}

async fn collect_group_logins<'a, 'async_trait, C>(
    logins: Vec<String>,
    dbx: &'a C,
) -> Result<HashMap<String, SignalGroupLogin>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if logins.is_empty() {
        return Ok(HashMap::new());
    }

    let login_ids = logins
        .into_iter()
        .map(|login| {
            uuid::Uuid::parse_str(&login)
                .map_err(anyhow::Error::from)
                .map_err(AppError::from)
        })
        .collect::<Result<HashSet<_>, AppError>>()?
        .into_iter()
        .collect::<Vec<_>>();

    let rows = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .filter(login::Column::Id.eq_any(login_ids))
        .select_only()
        .column(login::Column::Id)
        .column(login::Column::Login)
        .column_as(delta_login::Column::Login, "delta_login")
        .into_tuple::<(uuid::Uuid, String, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?;

    Ok(rows
        .into_iter()
        .map(|(login_id, login, delta_login)| {
            let login_id = login_id.to_string();
            (
                login_id.clone(),
                SignalGroupLogin {
                    login_id,
                    login,
                    delta_login,
                },
            )
        })
        .collect())
}

async fn collect_datasources<'a, 'async_trait, C>(
    datasource_ids: Vec<i64>,
    dbx: &'a C,
) -> Result<HashMap<i64, datasource::Model>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if datasource_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let datasources = datasource::Entity::find()
        .filter(datasource::Column::Deleted.eq(false))
        .filter(datasource::Column::Id.eq_any(datasource_ids))
        .all(dbx)
        .await
        .c(h!())?;

    Ok(datasources
        .into_iter()
        .map(|datasource| (datasource.id, datasource))
        .collect())
}

fn log_sigint_zone_datasource_event(
    szd: &sigint_zone_datasource::Model,
    event_name: &str,
    user_login: &uuid::Uuid,
) {
    let key = &szd.group_master_key;
    let datasource_id = &szd.datasource_id;
    let sigint_zone_id = &szd.sigint_zone_id;
    info!("{event_name} login={user_login} master_key={key} datasource_id={datasource_id} sigint_zone_id={sigint_zone_id}");
}

pub fn filter_out_ineligible_secret_chats<E: EntityTrait>(
    select: Select<E>,
    login: &uuid::Uuid,
) -> Select<E> {
    select.filter(
        signal_group::Column::IsSecret.eq(false).or(
            signal_group::Column::MasterKey.in_subquery(
                sea_query::Query::select()
                    .expr_as(
                        sea_query::Expr::cust("master_key"),
                        sea_query::Alias::new("master_key"),
                    )
                    .from(secret_group_user::Entity)
                    .and_where(secret_group_user::Column::LoginId.eq(*login))
                    .to_owned(),
            ),
        ),
    )
}

pub async fn get_datasources_zones<'a, 'async_trait, C>(
    dbx: &'a C,
) -> Result<BTreeMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let zone_datasources = sigint_zone_datasource::Entity::find()
        .all(dbx)
        .await
        .c(h!())?;
    let mut res: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for zd in zone_datasources {
        res.entry(zd.datasource_id)
            .and_modify(|zs| {
                if !zs.contains(&zd.sigint_zone_id) {
                    zs.push(zd.sigint_zone_id);
                }
            })
            .or_insert(vec![zd.sigint_zone_id]);
    }
    Ok(res)
}

pub async fn get_user_zone_id(
    dbx: &DbConn,
    user_id: &uuid::Uuid,
) -> Result<Option<i64>, AppError> {
    let user = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Id.eq(*user_id))
        .one(dbx)
        .await
        .c(h!())?;
    Ok(user.and_then(|x| x.sigint_zone_id))
}
