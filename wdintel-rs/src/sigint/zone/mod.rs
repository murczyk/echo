use self::bl::*;
use super::types::*;
use crate::entities::sigint_zone_datasource;
use crate::entities::*;
use crate::sigint::aor::bl::collect_group_aors;
use crate::sigint::aor::render_aor;
use crate::types::*;
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
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
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
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
    let zone_id: i64 = req.into_inner();
    let xs = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
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
        areas_of_responsibility: rsp
            .aor
            .map(|aors| aors.into_iter().map(render_aor).collect()),
        allowed_users: rsp.allowed_users,
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let req = req.into_inner();

    let txn = env.dbx.begin().await.c(h!())?;
    let szd = sigint_zone_datasource::ActiveModel {
        sigint_zone_id: Set(req.zone_id),
        datasource_id: Set(req.datasource_id),
        group_master_key: Set(req.master_key.clone()),
        ..Default::default()
    }
    .insert(&txn)
    .await
    .c(h!())?;

    bl_zones_datasources_group_update_or_add(
        req.user_logins.clone(),
        req.admin_logins.clone(),
        req.is_secret,
        req.short_note,
        req.long_note,
        szd.clone(),
        &txn,
    )
    .await
    .c(h!())?;

    // Fetch the final allowed users after update
    let allowed_users = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(&szd.group_master_key))
        .all(&txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();
    let admin_logins = bl::collect_signal_group_admins(
        vec![szd.group_master_key.clone()],
        &txn,
    )
    .await
    .c(h!())?
    .remove(&szd.group_master_key)
    .unwrap_or_default();

    // Fetch the group name and notes
    let group_name = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.eq(&szd.group_master_key))
        .select_only()
        .column(signal_group::Column::Name)
        .into_tuple::<Option<String>>()
        .one(&txn)
        .await
        .c(h!())?
        .flatten();

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

    let group_master_key = szd.group_master_key.clone();
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
            is_group_secret: req.is_secret,
            areas_of_responsibility,
            group_master_key,
            allowed_users,
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
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

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
    let login = user.id().c(h!())?;

    let groups = signal_group_admin::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group_admin::Relation::SignalGroup.def(),
        )
        .filter(signal_group_admin::Column::Deleted.eq(false))
        .filter(signal_group_admin::Column::Login.eq(&login))
        .filter(signal_group::Column::Deleted.eq(false))
        .select_only()
        .column_as(signal_group::Column::MasterKey, "master_key")
        .column_as(signal_group::Column::Name, "name")
        .column_as(signal_group::Column::DatasourceId, "datasource_id")
        .column_as(signal_group::Column::IsSecret, "is_group_secret")
        .order_by_asc(signal_group::Column::Name)
        .into_tuple::<(String, Option<String>, Option<i64>, bool)>()
        .all(&env.dbx)
        .await
        .c(h!())?;

    let master_keys = groups
        .iter()
        .map(|(master_key, _, _, _)| master_key.clone())
        .collect::<Vec<_>>();
    let datasource_ids = groups
        .iter()
        .filter_map(|(_, _, datasource_id, _)| *datasource_id)
        .collect::<Vec<_>>();

    let group_aors = collect_group_aors(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let group_admins =
        bl::collect_signal_group_admins(master_keys.clone(), &env.dbx)
            .await
            .c(h!())?;
    let allowed_users = collect_secret_group_users(master_keys, &env.dbx)
        .await
        .c(h!())?;
    let datasource_map = collect_datasources(datasource_ids, &env.dbx)
        .await
        .c(h!())?;

    let groups = groups
        .into_iter()
        .map(|(master_key, name, datasource_id, is_group_secret)| {
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
                areas_of_responsibility: group_aors.get(&master_key).cloned(),
                allowed_users: allowed_users
                    .get(&master_key)
                    .cloned()
                    .unwrap_or_default(),
                admin_logins: group_admins
                    .get(&master_key)
                    .cloned()
                    .unwrap_or_default(),
                master_key,
                is_group_secret,
            }
        })
        .collect();

    Ok(Json(MyAdminSignalGroupsRsp { groups }))
}

async fn collect_secret_group_users<'a, 'async_trait, C>(
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
    user_login: &str,
) {
    let key = &szd.group_master_key;
    let datasource_id = &szd.datasource_id;
    let sigint_zone_id = &szd.sigint_zone_id;
    info!("{event_name} login={user_login} master_key={key} datasource_id={datasource_id} sigint_zone_id={sigint_zone_id}");
}

pub fn filter_out_ineligible_secret_chats<E: EntityTrait>(
    select: Select<E>,
    login: &str,
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
                    .and_where(secret_group_user::Column::Login.eq(login))
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
    user_id: &str,
) -> Result<Option<i64>, AppError> {
    let user = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(user_id))
        .one(dbx)
        .await
        .c(h!())?;
    Ok(user.and_then(|x| x.sigint_zone_id))
}
