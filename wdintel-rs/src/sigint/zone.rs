use std::collections::BTreeMap;

use super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

#[post("/api/sigint/zones/list")]
pub async fn zones_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<(i64, SigintZone)>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let zones = sigint_zone::Entity::find()
        .filter(sigint_zone::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await?;
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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let zone_id: i64 = req.into_inner();
    let xs = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for x in xs {
        res.push(x.datasource_id);
    }
    Ok(Json(res))
}

#[post("/api/sigint/zones/zone-datasource-groups")]
pub async fn zones_datasources_groups_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupsReq>,
) -> Result<Json<Vec<String>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    let req = req.into_inner();
    let szd = find_sigint_zone_datasource_by_ids(
        &env.dbx,
        req.zone_id,
        req.datasource_id,
    )
    .await?;
    let groups: Vec<String> = match szd.group_master_keys {
        Some(gmks) => serde_json::from_value(gmks).context(h!())?,
        None => vec![],
    };

    Ok(Json(groups))
}

#[post("/api/sigint/zones/zone-datasource-groups-save")]
pub async fn zones_datasources_groups_list_save(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<ZoneDatasourceGroupsSaveReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let txn = env.dbx.begin().await?;
    let req = req.into_inner();

    let szd = find_sigint_zone_datasource_by_ids(
        &txn,
        req.zone_id,
        req.datasource_id,
    )
    .await?;

    let existing_groups = if let Some(gmks) = szd.group_master_keys.clone() {
        serde_json::from_value(gmks).context(h!())?
    } else {
        vec![]
    };

    debug!("existing_groups: {:?}", existing_groups);

    let new_groups: Vec<String> = req
        .groups
        .clone()
        .into_iter()
        .filter(|g| !existing_groups.contains(g))
        .collect();

    debug!("new_groups: {:?}", new_groups);

    let mut szd: sigint_zone_datasource::ActiveModel = szd.into();
    szd.group_master_keys = Set(Some(
        serde_json::to_value(req.groups.clone()).context(h!())?,
    ));
    szd.update(&txn).await?;

    for o in organism::Entity::find()
        .filter(organism::Column::GroupAutoLink.eq(true))
        .all(&txn)
        .await?
    {
        let organism_existing_groups = organism_group::Entity::find()
            .filter(organism_group::Column::OrganismId.eq(o.id))
            .all(&txn)
            .await?;
        // skip if organism has no groups (all groups enabled)
        if organism_existing_groups.is_empty() {
            continue;
        }

        for g in &new_groups {
            organism_group::Entity::insert(organism_group::ActiveModel {
                organism_id: Set(o.id),
                signal_group_master_key: Set(g.to_string()),
            })
            .on_conflict(
                sea_query::OnConflict::columns([
                    organism_group::Column::OrganismId,
                    organism_group::Column::SignalGroupMasterKey,
                ])
                .update_columns([
                    organism_group::Column::OrganismId,
                    organism_group::Column::SignalGroupMasterKey,
                ])
                .to_owned(),
            )
            .exec(&txn)
            .await?;
        }
    }

    txn.commit().await?;

    Ok(Json(()))
}

pub async fn get_datasources_zones<'a, 'async_trait, C>(
    dbx: &'a C,
) -> Result<BTreeMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let zone_datasources =
        sigint_zone_datasource::Entity::find().all(dbx).await?;
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
        .filter(login::Column::Login.eq(user_id))
        .one(dbx)
        .await?;
    Ok(user.and_then(|x| x.sigint_zone_id))
}

pub async fn find_sigint_zone_datasource_by_ids<'a, 'async_trait, C>(
    txn: &'a C,
    zone_id: i64,
    datasource_id: i64,
) -> Result<sigint_zone_datasource::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let szd = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
        .filter(sigint_zone_datasource::Column::DatasourceId.eq(datasource_id))
        .one(txn)
        .await?;
    match szd {
        Some(szd) => Ok(szd),
        None => {
            let empty: Vec<String> = vec![];
            let szd = sigint_zone_datasource::ActiveModel {
                id: NotSet,
                sigint_zone_id: Set(zone_id),
                datasource_id: Set(datasource_id),
                group_master_keys: Set(Some(
                    serde_json::to_value(empty).context(h!())?,
                )),
                created_at: NotSet,
            };
            let res = sigint_zone_datasource::Entity::insert(szd)
                .exec(txn)
                .await?;
            let szd_id = res.last_insert_id;
            let szd = sigint_zone_datasource::Entity::find_by_id(szd_id)
                .one(txn)
                .await?
                .ok_or(AppError::BL {
                    msg: "SZD not found".to_string(),
                })?;
            Ok(szd)
        }
    }
}
