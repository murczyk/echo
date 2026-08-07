use self::types::*;
use crate::config::SIGINT_UNIT_AUTO_CYBER_NETWORK_NAME;
use crate::entities::sea_orm_active_enums::ChangelogActionEnum;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use crate::users::{
    ensure_rer_role, has_any_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;
use sea_query::types::IntoColumnRef;
use sea_query::{Expr, OnConflict, SimpleExpr};
use std::collections::HashMap;

pub mod attachment;
pub mod orbit;
pub mod types;

pub fn unit_name(unit: &Unit) -> String {
    unit_name_from_hierarchy([
        &unit.company,
        &unit.battalion,
        &unit.regiment,
        &unit.division,
        &unit.army,
        &unit.military_district,
        &unit.army_region,
    ])
}

pub fn unit_name_req(req: &CreateUnitReq) -> String {
    unit_name_from_hierarchy([
        &req.company,
        &req.battalion,
        &req.regiment,
        &req.division,
        &req.army,
        &req.military_district,
        &req.army_region,
    ])
}

fn unit_name_from_hierarchy(hierarchy: [&str; 7]) -> String {
    hierarchy
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[post("/api/sigint/units")]
pub async fn list_units(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListUnitsReq>,
) -> Result<Json<ListUnitsRsp>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &login_id, vec!["Rer", "Api"])
        .await
        .c(h!())?;
    let can_view_orbit =
        orbit::can_view_orbit_data(&env.dbx, &login_id).await?;
    let mut response = read_units(&env.dbx, &req).await?;
    if can_view_orbit {
        let orbit_unit_ids = orbit::unit_ids_with_orbit(&env.dbx).await?;
        for unit in &mut response.units {
            unit.orbit_unit_ids =
                orbit_unit_ids.get(&unit.id).cloned().unwrap_or_default();
            unit.has_orbit = !unit.orbit_unit_ids.is_empty();
        }
    } else {
        for unit in &mut response.units {
            redact_unit_orbit_data(unit);
        }
    }
    Ok(Json(response))
}

pub(crate) async fn read_units(
    dbx: &DatabaseConnection,
    req: &ListUnitsReq,
) -> Result<ListUnitsRsp, AppError> {
    const LIMIT: u64 = 100000;
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    let sort_by = req
        .sort_by
        .clone()
        .unwrap_or(ListUnitsSortBy::NaturalMilitarySortAsc);
    match sort_by {
        ListUnitsSortBy::CreatedAtDesc => {
            if let Some(before_unit_id) = &req.before_unit_id {
                let before_unit =
                    find_unit(dbx, *before_unit_id).await.c(h!())?;
                units = units.filter(
                    Expr::tuple([
                        sigint_unit::Column::CreatedAt.into_column_ref().into(),
                        sigint_unit::Column::Id.into_column_ref().into(),
                    ])
                    .lt(SimpleExpr::Tuple(vec![
                        before_unit.created_at.into(),
                        before_unit.id.into(),
                    ])),
                );
            }
            units = units
                .order_by_desc(sigint_unit::Column::CreatedAt)
                .order_by_desc(sigint_unit::Column::Id);
        }
        ListUnitsSortBy::CreatedAtAsc => {
            if let Some(after_unit_id) = &req.after_unit_id {
                let after_unit =
                    find_unit(dbx, *after_unit_id).await.c(h!())?;
                units = units.filter(
                    Expr::tuple([
                        sigint_unit::Column::CreatedAt.into_column_ref().into(),
                        sigint_unit::Column::Id.into_column_ref().into(),
                    ])
                    .gt(SimpleExpr::Tuple(vec![
                        after_unit.created_at.into(),
                        after_unit.id.into(),
                    ])),
                );
            }
            units = units
                .order_by_asc(sigint_unit::Column::CreatedAt)
                .order_by_asc(sigint_unit::Column::Id);
        }
        ListUnitsSortBy::NaturalMilitarySortAsc => {
            if let Some(after_unit_id) = &req.after_unit_id {
                let after_unit =
                    find_unit(dbx, *after_unit_id).await.c(h!())?;
                units = units.filter(
                    Expr::tuple([
                        sigint_unit::Column::ArmyRegion
                            .into_column_ref()
                            .into(),
                        sigint_unit::Column::MilitaryDistrict
                            .into_column_ref()
                            .into(),
                        sigint_unit::Column::Army.into_column_ref().into(),
                        sigint_unit::Column::Division.into_column_ref().into(),
                        sigint_unit::Column::Regiment.into_column_ref().into(),
                        sigint_unit::Column::Battalion.into_column_ref().into(),
                        sigint_unit::Column::Company.into_column_ref().into(),
                        sigint_unit::Column::Id.into_column_ref().into(),
                    ])
                    .gt(SimpleExpr::Tuple(vec![
                        after_unit.army_region.into(),
                        after_unit.military_district.into(),
                        after_unit.army.into(),
                        after_unit.division.into(),
                        after_unit.regiment.into(),
                        after_unit.battalion.into(),
                        after_unit.company.into(),
                        after_unit.id.into(),
                    ])),
                );
            }
            units = units.order_by_asc(sigint_unit::Column::ArmyRegion);
            units = units.order_by_asc(sigint_unit::Column::MilitaryDistrict);
            units = units.order_by_asc(sigint_unit::Column::Army);
            units = units.order_by_asc(sigint_unit::Column::Division);
            units = units.order_by_asc(sigint_unit::Column::Regiment);
            units = units.order_by_asc(sigint_unit::Column::Battalion);
            units = units.order_by_asc(sigint_unit::Column::Company);
            units = units.order_by_asc(sigint_unit::Column::Id);
        }
    }
    let units = units.limit(LIMIT).all(dbx).await.c(h!())?;
    let mut res = vec![];
    for unit in units {
        res.push(render_unit(&unit)?);
    }
    Ok(ListUnitsRsp {
        show_load_more: res.len() as u64 == LIMIT,
        units: res,
    })
}

#[post("/api/sigint/units-by-id")]
pub async fn list_units_by_id(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListUnitsByIdReq>,
) -> Result<Json<ListUnitsByIdRsp>, AppError> {
    let login = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &login, vec!["Rer", "Api"])
        .await
        .c(h!())?;
    let can_view_orbit = orbit::can_view_orbit_data(&env.dbx, &login).await?;
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    if let Some(ids) = &req.ids {
        units = units.filter(sigint_unit::Column::Id.eq_any(ids.clone()));
    }
    let units = units.all(&env.dbx).await.c(h!())?;

    let mut res = vec![];
    for unit in units {
        let mut unit = render_unit(&unit)?;
        if !can_view_orbit {
            redact_unit_orbit_data(&mut unit);
        }
        res.push(unit);
    }
    Ok(Json(ListUnitsByIdRsp { units: res }))
}

#[post("/api/sigint/unit/create")]
pub async fn create_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateUnitReq>,
) -> Result<Json<Unit>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;

    let mut req = req.into_inner();
    let can_view_orbit =
        clear_create_unit_orbit_note_if_hidden(&env.dbx, &login, &mut req)
            .await?;
    let transaction = env.dbx.begin().await.context(h!())?;
    let unit = insert_unit_with_changelog(&transaction, &login, &req).await?;
    if unit.active {
        reconcile_parent_unit_activity(
            &transaction,
            &login,
            std::slice::from_ref(&unit),
        )
        .await?;
    }
    transaction.commit().await.context(h!())?;

    if unit.active {
        crate::orbit::link_new_sigint_unit_with_lock(&env.dbx, unit.id)
            .await
            .c(h!())?;
    }
    let unit = sigint_unit::Entity::find_by_id(unit.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    fanout_unit_changed(&env).await?;

    let mut unit = render_unit(&unit)?;
    if can_view_orbit {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
    } else {
        redact_unit_orbit_data(&mut unit);
    }
    Ok(Json(unit))
}

#[post("/api/sigint/unit/create-with-auto-network")]
pub async fn create_unit_with_auto_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateUnitWithAutoNetworkReq>,
) -> Result<Json<CreateUnitWithAutoNetworkRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
        .await
        .c(h!())?;
    let login = login_id_from_identity(&user)?;

    Ok(Json(
        create_unit_with_auto_network_for_login(&login, &env, req.into_inner())
            .await
            .c(h!())?,
    ))
}

#[post("/api/sigint/unit/create-device-network")]
pub async fn create_device_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateDeviceNetworkReq>,
) -> Result<Json<CreateDeviceNetworkRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
        .await
        .c(h!())?;
    let login = login_id_from_identity(&user)?;

    Ok(Json(
        create_device_network_for_login(&login, &env, req.into_inner())
            .await
            .c(h!())?,
    ))
}

pub async fn create_device_network_for_login(
    login: &uuid::Uuid,
    env: &Env,
    req: CreateDeviceNetworkReq,
) -> Result<CreateDeviceNetworkRsp, AppError> {
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;
    let locations = normalize_network_locations(req.locations.clone());
    if locations.is_empty() {
        return Err(AppError::BL {
            msg: "network locations are required".to_string(),
        });
    }

    let transaction = env.dbx.begin().await.context(h!())?;
    let unit = sigint_unit::Entity::find_by_id(req.unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if unit_has_active_network(&transaction, unit.id).await? {
        return Err(AppError::BL {
            msg: "unit already has a network".to_string(),
        });
    }
    let network = insert_auto_cyber_network(
        &transaction,
        login,
        &req,
        unit.id,
        locations,
        req.unit_mask.clone(),
    )
    .await
    .c(h!())?;
    transaction.commit().await.context(h!())?;

    fanout_created_network(env, network.clone()).await?;
    Ok(CreateDeviceNetworkRsp {
        network_id: network.id,
    })
}

pub async fn create_unit_with_auto_network_for_login(
    login: &uuid::Uuid,
    env: &Env,
    mut req: CreateUnitWithAutoNetworkReq,
) -> Result<CreateUnitWithAutoNetworkRsp, AppError> {
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;
    clear_create_unit_orbit_note_if_hidden(&env.dbx, login, &mut req.unit)
        .await?;

    let txn = env.dbx.begin().await.context(h!())?;
    let unit = insert_unit_with_changelog(&txn, login, &req.unit)
        .await
        .c(h!())?;
    let network = if req.skip_network_creation {
        None
    } else {
        let locations = normalize_network_locations(req.locations.clone());
        if locations.is_empty() {
            return Err(AppError::BL {
                msg: "network locations are required".to_string(),
            });
        }
        Some(
            insert_auto_cyber_network(
                &txn,
                login,
                &req,
                unit.id,
                locations,
                req.unit_mask.clone(),
            )
            .await
            .c(h!())?,
        )
    };
    if unit.active {
        reconcile_parent_unit_activity(
            &txn,
            login,
            std::slice::from_ref(&unit),
        )
        .await?;
    }
    txn.commit().await.context(h!())?;

    if unit.active {
        crate::orbit::link_new_sigint_unit_with_lock(&env.dbx, unit.id)
            .await
            .c(h!())?;
    }

    render_created_unit_with_optional_network(login, env, unit, network).await
}

async fn clear_create_unit_orbit_note_if_hidden(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &mut CreateUnitReq,
) -> Result<bool, AppError> {
    let can_view_orbit = orbit::can_view_orbit_data(dbx, login).await?;
    if !can_view_orbit {
        req.orbit_note = None;
    }
    Ok(can_view_orbit)
}

async fn render_created_unit_with_optional_network(
    login: &uuid::Uuid,
    env: &Env,
    unit: sigint_unit::Model,
    network: Option<sigint_network::Model>,
) -> Result<CreateUnitWithAutoNetworkRsp, AppError> {
    fanout_unit_changed_data(env).await?;

    if let Some(network) = network.clone() {
        fanout_created_network(env, network).await?;
    }

    let unit = sigint_unit::Entity::find_by_id(unit.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut unit = render_unit(&unit)?;
    if orbit::can_view_orbit_data(&env.dbx, login).await? {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
    } else {
        redact_unit_orbit_data(&mut unit);
    }
    Ok(CreateUnitWithAutoNetworkRsp {
        unit,
        network_id: network.map(|network| network.id),
    })
}

async fn insert_unit_with_changelog<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    req: &CreateUnitReq,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let unit = sigint_unit::ActiveModel {
        id: NotSet,
        company: Set(req.company.clone()),
        battalion: Set(req.battalion.clone()),
        regiment: Set(req.regiment.clone()),
        division: Set(req.division.clone()),
        army: Set(req.army.clone()),
        military_district: Set(req.military_district.clone()),
        army_region: Set(req.army_region.clone()),
        active: Set(req.active),
        is_deduplicate_candidate: Set(req.is_deduplicate_candidate),
        created_at: NotSet,
        created_by_login_id: Set(*login),
        comment: Set(req.comment.clone()),
        orbit_note: Set(req.orbit_note.clone()),
        name: Set(unit_name_req(req)),
        deleted: Set(false),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(dbx)
    .await
    .context(h!())?;

    let unit_json = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login_id: Set(*login),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(req).context(h!())?)),
    }
    .insert(dbx)
    .await
    .context(h!())?;
    unit_after_insert_update(dbx, unit.id).await.context(h!())?;

    Ok(unit)
}

async fn insert_auto_cyber_network<'a, 'async_trait, C, R>(
    txn: &'a C,
    login: &uuid::Uuid,
    req: &R,
    unit_id: i64,
    locations: Vec<String>,
    unit_mask: Vec<String>,
) -> Result<sigint_network::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
    R: serde::Serialize + ?Sized,
{
    let unit_mask =
        crate::sigint::unit_tag::normalize_unit_mask(unit_mask).c(h!())?;
    let network = sigint_network::ActiveModel {
        id: NotSet,
        name: Set(SIGINT_UNIT_AUTO_CYBER_NETWORK_NAME.to_string()),
        location: Set(locations.join(", ")),
        deleted: Set(false),
        created_at: NotSet,
        updated_by_login_id: Set(Some(*login)),
        updated_at: NotSet,
        radio_station: Set(None),
        purpose: Set(None),
        operation_mode: Set(None),
        operation_type: Set(None),
        operation_period: Set(None),
        merged_to: NotSet,
        active_from: Set(None),
        active_to: Set(None),
        do_not_archive: Set(true),
        unit_mask: Set(serde_json::to_value(unit_mask).context(h!())?),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    let network_json = sigint_network::Entity::find_by_id(network.id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    sigint_network_changelog::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(network.id),
        login_id: Set(*login),
        action: Set(ChangelogActionEnum::Create),
        created_at: NotSet,
        new_value: Set(Some(network_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(req).context(h!())?)),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    sigint_network_unit::ActiveModel {
        id: NotSet,
        network_id: Set(network.id),
        unit_id: Set(unit_id),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    Ok(network)
}

pub(super) async fn unit_has_active_network<C>(
    dbx: &C,
    unit_id: i64,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::UnitId.eq(unit_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn fanout_created_network(
    env: &Env,
    network: sigint_network::Model,
) -> Result<(), AppError> {
    fanout_network_changed_data(env).await.c(h!())?;
    crate::sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("created cyber network {}", network.id),
    )
    .await
    .c(h!())?;
    if !crate::sigint::unit_tag::sigint_network_unit_mask(&network).is_empty() {
        crate::sigint::unit_tag::enqueue_recent_non_rer_unit_tag_recalculation(
            &env.dbx,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

fn normalize_network_locations(locations: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut keys = Vec::new();
    for location in locations {
        for location in location.split(',') {
            let location = location.trim().to_string();
            if location.is_empty() {
                continue;
            }
            let key = location.to_lowercase();
            if keys.contains(&key) {
                continue;
            }
            keys.push(key);
            out.push(location);
        }
    }
    out
}

async fn fanout_unit_changed(
    env: &actix_web::web::Data<Env>,
) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut redis, event).await.context(h!())?;
    Ok(())
}

async fn fanout_unit_changed_data(env: &Env) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut redis, event).await.context(h!())?;
    Ok(())
}

async fn fanout_network_changed_data(env: &Env) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut redis, event).await.context(h!())?;
    Ok(())
}

#[post("/api/sigint/unit/update")]
pub async fn update_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateUnitReq>,
) -> Result<Json<Unit>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    let can_update_orbit_note =
        orbit::can_view_orbit_data(&env.dbx, &login).await?;
    let unit =
        update_unit_for_login(&env.dbx, &login, &req, can_update_orbit_note)
            .await?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let mut unit = render_unit(&unit)?;
    if can_update_orbit_note {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
    } else {
        redact_unit_orbit_data(&mut unit);
    }
    Ok(Json(unit))
}

async fn update_unit_for_login(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &UpdateUnitReq,
    can_update_orbit_note: bool,
) -> Result<sigint_unit::Model, AppError> {
    let transaction = dbx.begin().await.context(h!())?;
    let unit = sigint_unit::Entity::find_by_id(req.id)
        .one(&transaction)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let military_district = req
        .military_district
        .clone()
        .unwrap_or_else(|| unit.military_district.clone());
    let army_region = req
        .army_region
        .clone()
        .unwrap_or_else(|| unit.army_region.clone());
    let previous_unit = unit.clone();
    let hierarchy_or_activity_changed = unit.active != req.active
        || unit_hierarchy(&unit)
            != [
                req.company.as_str(),
                req.battalion.as_str(),
                req.regiment.as_str(),
                req.division.as_str(),
                req.army.as_str(),
                military_district.as_str(),
                army_region.as_str(),
            ];
    let unit_json_old = unit_json(&transaction, req.id).await?;
    let mut unit = unit.into_active_model();
    unit.company = Set(req.company.clone());
    unit.battalion = Set(req.battalion.clone());
    unit.regiment = Set(req.regiment.clone());
    unit.division = Set(req.division.clone());
    unit.army = Set(req.army.clone());
    unit.military_district = Set(military_district.clone());
    unit.army_region = Set(army_region.clone());
    unit.active = Set(req.active);
    unit.name = Set(unit_name_from_hierarchy([
        &req.company,
        &req.battalion,
        &req.regiment,
        &req.division,
        &req.army,
        &military_district,
        &army_region,
    ]));
    unit.comment = Set(req.comment.clone());
    if can_update_orbit_note {
        if let Some(orbit_note) = &req.orbit_note {
            unit.orbit_note = Set(orbit_note.clone());
        }
    }
    let unit = unit.update(&transaction).await.context(h!())?;
    let unit_json_new = unit_json(&transaction, req.id).await?;
    insert_unit_update_changelog(
        &transaction,
        login,
        req.id,
        unit_json_old,
        unit_json_new,
    )
    .await?;
    unit_after_insert_update(&transaction, req.id)
        .await
        .context(h!())?;
    if hierarchy_or_activity_changed {
        reconcile_parent_unit_activity(
            &transaction,
            login,
            &[previous_unit, unit.clone()],
        )
        .await?;
    }
    transaction.commit().await.context(h!())?;
    Ok(unit)
}

async fn unit_json<C>(
    dbx: &C,
    unit_id: i64,
) -> Result<serde_json::Value, AppError>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::find_by_id(unit_id)
        .into_json()
        .one(dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)
}

async fn insert_unit_update_changelog<C>(
    dbx: &C,
    login: &uuid::Uuid,
    unit_id: i64,
    old_value: serde_json::Value,
    new_value: serde_json::Value,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit_id),
        login_id: Set(*login),
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(new_value)),
        old_value: Set(Some(old_value)),
        req: Set(None),
    }
    .insert(dbx)
    .await
    .context(h!())?;
    Ok(())
}

async fn reconcile_parent_unit_activity<C>(
    dbx: &C,
    login: &uuid::Uuid,
    changed_units: &[sigint_unit::Model],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .context(h!())?;
    let mut parent_indexes = units
        .iter()
        .enumerate()
        .filter_map(|(index, unit)| {
            changed_units
                .iter()
                .any(|changed_unit| is_parent_unit(unit, changed_unit))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    parent_indexes.sort_by_key(|index| unit_hierarchy_level(&units[*index]));

    for parent_index in parent_indexes {
        let should_be_active = units.iter().any(|unit| {
            unit.active && is_parent_unit(&units[parent_index], unit)
        });
        if units[parent_index].active == should_be_active {
            continue;
        }
        units[parent_index] = set_unit_activity(
            dbx,
            login,
            &units[parent_index],
            should_be_active,
        )
        .await?;
    }
    Ok(())
}

async fn set_unit_activity<C>(
    dbx: &C,
    login: &uuid::Uuid,
    unit: &sigint_unit::Model,
    active: bool,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    let old_value = unit_json(dbx, unit.id).await?;
    let mut unit = unit.clone().into_active_model();
    unit.active = Set(active);
    let unit = unit.update(dbx).await.context(h!())?;
    let new_value = unit_json(dbx, unit.id).await?;
    insert_unit_update_changelog(dbx, login, unit.id, old_value, new_value)
        .await?;
    Ok(unit)
}

fn unit_hierarchy_level(unit: &sigint_unit::Model) -> Option<usize> {
    unit_hierarchy(unit)
        .iter()
        .position(|value| !value.trim().is_empty())
}

fn is_parent_unit(
    parent: &sigint_unit::Model,
    child: &sigint_unit::Model,
) -> bool {
    let Some(parent_level) = unit_hierarchy_level(parent) else {
        return false;
    };
    let Some(child_level) = unit_hierarchy_level(child) else {
        return false;
    };
    if parent_level <= child_level {
        return false;
    }
    let parent_hierarchy = unit_hierarchy(parent);
    let child_hierarchy = unit_hierarchy(child);
    parent_hierarchy[parent_level..]
        .iter()
        .zip(&child_hierarchy[parent_level..])
        .all(|(parent, child)| {
            let parent = parent.trim();
            parent.is_empty()
                || parent.to_lowercase() == child.trim().to_lowercase()
        })
}

fn unit_hierarchy(unit: &sigint_unit::Model) -> [&str; 7] {
    [
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.division.as_str(),
        unit.army.as_str(),
        unit.military_district.as_str(),
        unit.army_region.as_str(),
    ]
}

#[post("/api/sigint/unit/delete")]
pub async fn delete_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Unit>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    let unit =
        delete_unit_for_login(&env.dbx, &login, req.into_inner()).await?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let mut unit = render_unit(&unit)?;
    if !orbit::can_view_orbit_data(&env.dbx, &login).await? {
        redact_unit_orbit_data(&mut unit);
    }
    Ok(Json(unit))
}

async fn delete_unit_for_login(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    unit_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let transaction = dbx.begin().await.context(h!())?;
    let unit = sigint_unit::Entity::find_by_id(unit_id)
        .one(&transaction)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let previous_unit = unit.clone();
    let unit_json_old = unit_json(&transaction, unit.id).await?;
    let mut unit = unit.into_active_model();
    unit.deleted = Set(true);
    let unit = unit.update(&transaction).await.context(h!())?;
    let unit_json_new = unit_json(&transaction, unit.id).await?;
    sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login_id: Set(*login),
        action: Set("delete".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&transaction)
    .await
    .context(h!())?;
    if previous_unit.active {
        reconcile_parent_unit_activity(
            &transaction,
            login,
            std::slice::from_ref(&previous_unit),
        )
        .await?;
    }
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await?;
    transaction.commit().await.context(h!())?;
    Ok(unit)
}

#[post("/api/sigint/unit/delete-duplicate")]
pub async fn delete_unit_duplicate(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteUnitDuplicateReq>,
) -> Result<Json<Unit>, AppError> {
    let dbx = &env.dbx;
    ensure_rer_role(dbx, &user).await.c(h!())?;
    has_role(dbx, &login_id_from_identity(&user)?, "UnitsEditor")
        .await
        .c(h!())?;
    let login = login_id_from_identity(&user)?;
    let req: DeleteUnitDuplicateReq = req.into_inner();
    let unit_to_delete_id = req.clone_to_delete_id;
    let original_id = req.original_id;

    let unit = merge_units(login, dbx, unit_to_delete_id, original_id)
        .await
        .c(h!())?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let mut unit = render_unit(&unit)?;
    if orbit::can_view_orbit_data(dbx, &login).await? {
        unit.has_orbit = orbit::unit_has_orbit(dbx, unit.id).await?;
    } else {
        redact_unit_orbit_data(&mut unit);
    }
    Ok(Json(unit))
}

pub async fn merge_units(
    login: uuid::Uuid,
    dbx: &DatabaseConnection,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let unit_to_delete =
        find_unit(dbx, unit_to_delete_id).await.context(h!())?;
    let unit_original = find_unit(dbx, original_id).await.context(h!())?;
    let previous_unit_original = unit_original.clone();
    let unit_original =
        update_original_unit(unit_original, &unit_to_delete, dbx)
            .await
            .context(h!())?;

    swap_units(unit_to_delete_id, original_id, login, dbx)
        .await
        .context(h!())?;

    let unit_json_old = sigint_unit::Entity::find_by_id(unit_to_delete_id)
        .into_json()
        .one(dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let unit_json_new = sigint_unit::Entity::find_by_id(original_id)
        .into_json()
        .one(dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let mut unit = unit_to_delete.clone().into_active_model();
    unit.deleted = Set(true);
    unit.update(dbx).await.context(h!())?;

    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit_to_delete_id),
        login_id: Set(login),
        action: Set("delete_duplicate".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(dbx)
    .await
    .context(h!())?;
    reconcile_parent_unit_activity(
        dbx,
        &login,
        &[
            unit_to_delete,
            previous_unit_original,
            unit_original.clone(),
        ],
    )
    .await?;
    crate::orbit::reevaluate_sigint_unit_deduplicate_candidate(
        dbx,
        unit_original.id,
    )
    .await?;
    find_unit(dbx, unit_original.id).await
}

pub async fn find_unit(
    dbx: &DbConn,
    unit_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let unit = sigint_unit::Entity::find_by_id(unit_id)
        .one(dbx)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(unit)
}

pub fn render_unit(unit: &sigint_unit::Model) -> Result<Unit, AppError> {
    Ok(Unit {
        id: unit.id,
        company: unit.company.clone(),
        battalion: unit.battalion.clone(),
        regiment: unit.regiment.clone(),
        division: unit.division.clone(),
        army: unit.army.clone(),
        military_district: unit.military_district.clone(),
        army_region: unit.army_region.clone(),
        active: unit.active,
        is_deduplicate_candidate: unit.is_deduplicate_candidate,
        comment: unit.comment.clone(),
        orbit_note: unit.orbit_note.clone(),
        name: unit.name.clone(),
        created_at: unit.created_at.and_utc().timestamp_millis(),
        created_by_login_id: unit.created_by_login_id.to_string(),
        has_orbit: false,
        orbit_unit_ids: Vec::new(),
    })
}

pub(crate) fn redact_unit_orbit_data(unit: &mut Unit) {
    unit.has_orbit = false;
    unit.orbit_unit_ids.clear();
    unit.orbit_note = None;
    unit.is_deduplicate_candidate = None;
}

async fn swap_units(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let callsigns = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::UnitId.eq(old_unit_id))
        .all(dbx)
        .await
        .context(h!())?;
    for callsign in callsigns {
        let id = callsign.id;
        let json_old = sigint_callsign::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        let mut callsign = callsign.into_active_model();
        callsign.unit_id = Set(new_unit_id);
        callsign.update(dbx).await.context(h!())?;
        let json_new = sigint_callsign::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_callsign_changelog::ActiveModel {
            id: NotSet,
            sigint_callsign_id: Set(id),
            login_id: Set(login),
            action: Set("update".to_string()),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(dbx)
        .await
        .context(h!())?;
    }

    let signals = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::Unit.eq(old_unit_id))
        .all(dbx)
        .await
        .context(h!())?;
    for signal in signals {
        let id = signal.id;
        let json_old = sigint_signal::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        let mut signal = signal.into_active_model();
        signal.unit = Set(Some(new_unit_id));
        signal.update(dbx).await.context(h!())?;
        let json_new = sigint_signal::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_signal_changelog::ActiveModel {
            id: NotSet,
            sigint_signal_id: Set(id),
            login_id: Set(login),
            action: Set(
                sea_orm_active_enums::SigintSignalChangelogActionEnum::Update,
            ),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(dbx)
        .await
        .context(h!())?;
    }

    let network_units = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::UnitId.eq(old_unit_id))
        .all(dbx)
        .await
        .context(h!())?;
    for network_unit in network_units {
        let id = network_unit.id;
        let json_old = sigint_network_unit::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        let mut network_unit = network_unit.into_active_model();
        network_unit.unit_id = Set(new_unit_id);
        network_unit.update(dbx).await.context(h!())?;
        let json_new = sigint_network_unit::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_network_unit_changelog::ActiveModel {
            id: NotSet,
            sigint_network_unit_id: Set(id),
            login_id: Set(login),
            action: Set("update".to_string()),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(dbx)
        .await
        .context(h!())?;
    }

    sigint_unit_attachment::Entity::update_many()
        .col_expr(
            sigint_unit_attachment::Column::UnitId,
            Expr::value(new_unit_id),
        )
        .filter(sigint_unit_attachment::Column::UnitId.eq(old_unit_id))
        .exec(dbx)
        .await
        .context(h!())?;

    move_orbit_unit_links(old_unit_id, new_unit_id, dbx).await?;
    swap_unit_devices(old_unit_id, new_unit_id, dbx).await?;

    Ok(())
}

async fn swap_unit_devices(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    device::Entity::update_many()
        .col_expr(device::Column::UnitId, Expr::value(Some(new_unit_id)))
        .col_expr(
            device::Column::UpdatedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(device::Column::UnitId.eq(old_unit_id))
        .exec(dbx)
        .await
        .context(h!())?;
    Ok(())
}

async fn move_orbit_unit_links(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    if old_unit_id == new_unit_id {
        return Ok(());
    }
    let transaction = dbx.begin().await.context(h!())?;
    let links = orbit_unit_sigint_unit::Entity::find()
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(old_unit_id))
        .all(&transaction)
        .await
        .context(h!())?;
    if !links.is_empty() {
        let existing_links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(new_unit_id),
            )
            .all(&transaction)
            .await
            .context(h!())?
            .into_iter()
            .map(|link| (link.orbit_unit_id, link))
            .collect::<HashMap<_, _>>();
        let links = links.into_iter().map(|link| {
            let existing_link = existing_links.get(&link.orbit_unit_id);
            let is_manual = link.is_manual
                || existing_link.is_some_and(|link| link.is_manual);
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(link.orbit_unit_id),
                sigint_unit_id: Set(new_unit_id),
                is_manual: Set(is_manual),
                is_suppressed: Set(!is_manual
                    && (link.is_suppressed
                        || existing_link
                            .is_some_and(|link| link.is_suppressed))),
            }
        });
        orbit_unit_sigint_unit::Entity::insert_many(links)
            .on_conflict(
                OnConflict::columns([
                    orbit_unit_sigint_unit::Column::OrbitUnitId,
                    orbit_unit_sigint_unit::Column::SigintUnitId,
                ])
                .update_columns([
                    orbit_unit_sigint_unit::Column::IsManual,
                    orbit_unit_sigint_unit::Column::IsSuppressed,
                ])
                .to_owned(),
            )
            .exec_without_returning(&transaction)
            .await
            .context(h!())?;
    }
    orbit_unit_sigint_unit::Entity::delete_many()
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(old_unit_id))
        .exec(&transaction)
        .await
        .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(())
}

async fn update_original_unit(
    unit_original: sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
    dbx: &DatabaseConnection,
) -> anyhow::Result<sigint_unit::Model> {
    let mut unit = unit_original.clone().into_active_model();
    unit.name = Set(unit_name_from_hierarchy([
        merged_unit_value(&unit_original.company, &unit_to_merge.company),
        merged_unit_value(&unit_original.battalion, &unit_to_merge.battalion),
        merged_unit_value(&unit_original.regiment, &unit_to_merge.regiment),
        merged_unit_value(&unit_original.division, &unit_to_merge.division),
        merged_unit_value(&unit_original.army, &unit_to_merge.army),
        merged_unit_value(
            &unit_original.military_district,
            &unit_to_merge.military_district,
        ),
        merged_unit_value(
            &unit_original.army_region,
            &unit_to_merge.army_region,
        ),
    ]));

    if unit_original.company.is_empty() && !unit_to_merge.company.is_empty() {
        unit.company = Set(unit_to_merge.company.clone());
    }
    if unit_original.regiment.is_empty() && !unit_to_merge.regiment.is_empty() {
        unit.regiment = Set(unit_to_merge.regiment.clone());
    }
    if unit_original.battalion.is_empty() && !unit_to_merge.battalion.is_empty()
    {
        unit.battalion = Set(unit_to_merge.battalion.clone());
    }
    if unit_original.division.is_empty() && !unit_to_merge.division.is_empty() {
        unit.division = Set(unit_to_merge.division.clone());
    }
    if unit_original.army.is_empty() && !unit_to_merge.army.is_empty() {
        unit.army = Set(unit_to_merge.army.clone());
    }
    if unit_original.military_district.is_empty()
        && !unit_to_merge.military_district.is_empty()
    {
        unit.military_district = Set(unit_to_merge.military_district.clone());
    }
    if unit_original.army_region.is_empty()
        && !unit_to_merge.army_region.is_empty()
    {
        unit.army_region = Set(unit_to_merge.army_region.clone());
    }
    if unit_original.comment.is_empty() && !unit_to_merge.comment.is_empty() {
        unit.comment = Set(unit_to_merge.comment.clone());
    }
    if unit_original
        .orbit_note
        .as_ref()
        .is_none_or(|note| note.trim().is_empty())
        && unit_to_merge
            .orbit_note
            .as_ref()
            .is_some_and(|note| !note.trim().is_empty())
    {
        unit.orbit_note = Set(unit_to_merge.orbit_note.clone());
    }
    if unit_original.deleted && !unit_to_merge.deleted {
        unit.deleted = Set(false);
    }

    let unit = unit.update(dbx).await.context(h!())?;
    unit_after_insert_update(dbx, unit.id).await.context(h!())?;
    Ok(unit)
}

fn merged_unit_value<'a>(original: &'a str, to_merge: &'a str) -> &'a str {
    if original.is_empty() {
        to_merge
    } else {
        original
    }
}

/// Oneoff function to reprocess the search index for units.
pub async fn oneoff_reprocess_units_search_index(
    mode: Mode,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let pool = dbx.get_postgres_connection_pool();

    let update_query =
        "UPDATE sigint_unit SET search_tsv = to_tsvector('russian', name);";

    sqlx::query(update_query)
        .execute(pool)
        .await
        .context(h!())?;

    println!("Sigint_unit search index updated successfully.");

    Ok(())
}

/// Updates the search_tsv field for a specific unit after insert or update.
pub async fn unit_after_insert_update<'a, 'async_trait, C>(
    txn: &'a C,
    unit_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE sigint_unit
                SET search_tsv = to_tsvector('russian', name)
                WHERE id = $1"#,
        [unit_id.into()],
    );
    txn.execute_raw(statement).await.context(h!())?;
    Ok(())
}

/// АПІ ендпоінт для пошуку підрозділів за назвою (використовується websearch)
///
/// # API URL
/// - POST: /api/sigint/unit/search
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<UnitSearchReq>`] - де [`UnitSearchReq`] Тіло запиту, що містить параметри пошуку підрозділу за назвою.
///
/// # Тіло запиту
///
/// Запит використовує структуру [`UnitSearchReq`], яка має наступні поля:
///
/// * `search`: `String` - пошукова строка.
///
///
/// # Повертає
///
/// У випадку успішного виконання, функція повертає `Json<ListUnitsByIdRsp>`, де [`ListUnitsByIdRsp`] - вектор підрозділів `Vec<Unit>`.
///
/// # Помилки
///
/// Функція повертає [`AppError`] у випадку виникнення помилок, таких як:
/// * Помилки під час взаємодії з базою даних.
/// * Недостатньо прав доступу у користувача для виконання цієї операції.
///
/// # Дозволи
///
/// Для доступу до цього ендпоінту користувач повинен мати роль: "Rer".
#[post("/api/sigint/unit/search")]
pub async fn units_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UnitSearchReq>,
) -> Result<Json<ListUnitsByIdRsp>, AppError> {
    let login = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &login, vec!["Rer"]).await.c(h!())?;
    let can_view_orbit = orbit::can_view_orbit_data(&env.dbx, &login).await?;

    let search_phrase = req.search.trim();
    let mut q = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));

    if !search_phrase.is_empty() {
        q = q.filter(Expr::cust_with_values(
            "search_tsv::tsvector @@ websearch_to_tsquery('russian', $1) OR lower(\"sigint_unit\".\"name\") LIKE lower($2) ESCAPE '\\'",
            vec![
                search_phrase.to_string(),
                format!("%{}%", search_phrase.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")),
            ],
        ));
    }

    q = q.order_by_asc(sigint_unit::Column::Name).limit(50);

    // debug!(
    //     ">find units query: {}",
    //     q.build(DbBackend::Postgres).to_string()
    // );

    let units = q.all(&env.dbx).await.context(h!())?;

    let mut res = vec![];
    for unit in units {
        let mut unit = render_unit(&unit)?;
        if !can_view_orbit {
            redact_unit_orbit_data(&mut unit);
        }
        res.push(unit);
    }
    Ok(Json(ListUnitsByIdRsp { units: res }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        sigint_network, sigint_network_unit, system_settings,
    };
    use crate::functest::tests::cleanup;
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, NotSet,
        PaginatorTrait, QueryFilter, Set,
    };
    use serial_test::serial;
    use std::collections::BTreeSet;

    const TEST_LOGIN: &str = "Tester";

    async fn test_login_id(env: &Env) -> uuid::Uuid {
        crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap()
    }

    fn unit_req() -> CreateUnitReq {
        CreateUnitReq {
            company: "2 шр".to_string(),
            battalion: "3 ошб".to_string(),
            regiment: "44 осбр".to_string(),
            division: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            active: true,
            is_deduplicate_candidate: None,
            comment: "main section".to_string(),
            orbit_note: None,
        }
    }

    fn auto_req(
        skip_network_creation: bool,
        locations: Vec<&str>,
        unit_mask: Vec<&str>,
    ) -> CreateUnitWithAutoNetworkReq {
        CreateUnitWithAutoNetworkReq {
            unit: unit_req(),
            skip_network_creation,
            locations: locations.into_iter().map(str::to_string).collect(),
            unit_mask: unit_mask.into_iter().map(str::to_string).collect(),
        }
    }

    async fn insert_settings(dbx: &DatabaseConnection, enabled: bool) {
        let now = Utc::now().naive_utc();
        system_settings::ActiveModel {
            id: NotSet,
            rer_analysis_units_exact_match_only_default: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            updated_by_login_id: Set(None),
            deleted: Set(false),
            rer_duty_test_enabled: Set(false),
            rer_duty_test_since_ms: Set(0),
            rer_duty_test_limit: Set(0),
            rer_duty_poll_interval_sec: Set(0),
            rer_duty_test_replay_interval_sec: Set(1),
            rer_duty_insert_historical_interceptions: Set(false),
            short_url_enabled: Set(false),
            support_non_rer_interceptions: Set(false),
            peleng_bounds_enabled: Set(false),
            peleng_bounds_top_left_lat: Set(None),
            peleng_bounds_top_left_lng: Set(None),
            peleng_bounds_bottom_right_lat: Set(None),
            peleng_bounds_bottom_right_lng: Set(None),
            default_neo_analysis: Set(false),
            echo_im_sync_since: Set(now),
            autofix_echoim_missing_messages: Set(false),
            echo_im_sync_since_inbox_message_id: Set(0),
            devices_section_enabled: Set(enabled),
            echo_restapi_error_discord_webhook_url: Set(None),
            sigint_comment_parsing_enabled: Set(true),
            do_not_store_duplicate_echoim_failures: Set(false),
            goi_association_message_uid_worker_enabled: Set(false),
            report_chunking_hours: Set(
                crate::config::RER_REPORT_CHUNKING_HOURS_DEFAULT as i32,
            ),
            limit_big_reports: Set(false),
            enable_audio_transcription: Set(false),
            show_classic_duty: Set(true),
            show_classic_analysis: Set(true),
            hide_orbit_data: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    async fn network_count(dbx: &DatabaseConnection) -> u64 {
        sigint_network::Entity::find().count(dbx).await.unwrap()
    }

    async fn unit_count(dbx: &DatabaseConnection) -> u64 {
        sigint_unit::Entity::find().count(dbx).await.unwrap()
    }

    struct OrbitHierarchyFixture {
        root_unit_id: uuid::Uuid,
        unit_ids: Vec<uuid::Uuid>,
        echelon_ids: Vec<uuid::Uuid>,
    }

    async fn insert_orbit_hierarchy(
        dbx: &DatabaseConnection,
    ) -> OrbitHierarchyFixture {
        let levels = [
            ("company", "1 рота"),
            ("battalion", "2 бат"),
            ("brigade", "55 мбр"),
            ("division", "45 див"),
            ("fieldArmy", "20 ЗВА"),
            ("militaryDistrict", "Західний ВО"),
            ("armyRegion", "ЗС РФ"),
        ];
        let echelon_ids = levels
            .iter()
            .map(|_| uuid::Uuid::new_v4())
            .collect::<Vec<_>>();
        orbit_unit_echelon::Entity::insert_many(
            levels
                .iter()
                .zip(&echelon_ids)
                .map(|((key, name), echelon_id)| {
                    orbit_unit_echelon::ActiveModel {
                        id: Set(*echelon_id),
                        key: Set((*key).to_string()),
                        name: Set(format!("{name}-{}", uuid::Uuid::new_v4())),
                        ..Default::default()
                    }
                }),
        )
        .exec(dbx)
        .await
        .unwrap();

        let unit_ids = levels
            .iter()
            .map(|_| uuid::Uuid::new_v4())
            .collect::<Vec<_>>();
        orbit_unit::Entity::insert_many(levels.iter().enumerate().map(
            |(index, (_, name))| orbit_unit::ActiveModel {
                unit_id: Set(unit_ids[index]),
                unit_name: Set(Some(format!("Повна назва {name}"))),
                unit_name_short: Set(Some((*name).to_string())),
                unit_echelon_id: Set(Some(echelon_ids[index])),
                operational_parent_unit_id: Set(
                    unit_ids.get(index + 1).copied(),
                ),
                ..Default::default()
            },
        ))
        .exec(dbx)
        .await
        .unwrap();
        OrbitHierarchyFixture {
            root_unit_id: unit_ids[0],
            unit_ids,
            echelon_ids,
        }
    }

    async fn update_orbit_parents(
        dbx: &DatabaseConnection,
        unit_id: uuid::Uuid,
        generative_parent_unit_id: Option<uuid::Uuid>,
        operational_parent_unit_id: Option<uuid::Uuid>,
    ) {
        let unit = orbit_unit::Entity::find_by_id(unit_id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap();
        let mut unit = unit.into_active_model();
        unit.generative_parent_unit_id = Set(generative_parent_unit_id);
        unit.operational_parent_unit_id = Set(operational_parent_unit_id);
        unit.update(dbx).await.unwrap();
    }

    async fn split_orbit_parent_chains(
        dbx: &DatabaseConnection,
        orbit_fixture: &OrbitHierarchyFixture,
    ) {
        let ids = &orbit_fixture.unit_ids;
        for (index, generative_parent_index, operational_parent_index) in [
            (0, Some(2), Some(1)),
            (1, None, Some(5)),
            (2, Some(3), None),
            (3, Some(4), None),
            (4, Some(6), None),
            (5, None, Some(6)),
        ] {
            update_orbit_parents(
                dbx,
                ids[index],
                generative_parent_index.map(|parent_index| ids[parent_index]),
                operational_parent_index.map(|parent_index| ids[parent_index]),
            )
            .await;
        }
    }

    async fn active_full_hierarchy_unit(
        dbx: &DatabaseConnection,
    ) -> sigint_unit::Model {
        crate::functest::tests::mk_sigint_unit(
            dbx,
            sigint_unit::ActiveModel {
                company: Set("1 рота".to_string()),
                battalion: Set("2 бат".to_string()),
                regiment: Set("55 мбр".to_string()),
                division: Set("45 див".to_string()),
                army: Set("20 ЗВА".to_string()),
                military_district: Set("Західний ВО".to_string()),
                army_region: Set("ЗС РФ".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn assert_full_active_orbit_hierarchy(
        dbx: &DatabaseConnection,
        orbit_unit_ids: Vec<uuid::Uuid>,
    ) {
        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_unit_ids),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .all(dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), 7);
        let linked_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), 7);
        assert!(linked_units.iter().all(|unit| unit.active));
        assert!(linked_units
            .iter()
            .all(|unit| unit.is_deduplicate_candidate == Some(false)));
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_rejects_when_setting_missing() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;

        let err = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(false, vec!["Роботине"], vec!["2 шр"]),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_rejects_when_setting_disabled() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, false).await;
        let login_id = test_login_id(&env).await;

        let err = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(false, vec!["Роботине"], vec!["2 шр"]),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_can_skip_network_creation() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;

        let rsp = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(true, vec![], vec![]),
        )
        .await
        .unwrap();

        assert_eq!(rsp.unit.name, "2 шр 3 ошб 44 осбр");
        assert_eq!(rsp.network_id, None);
        assert_eq!(unit_count(&env.dbx).await, 1);
        assert_eq!(network_count(&env.dbx).await, 0);
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_ignores_orbit_note_when_orbit_data_is_hidden() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let settings = system_settings::Entity::find()
            .filter(system_settings::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut settings = settings.into_active_model();
        settings.hide_orbit_data = Set(true);
        settings.update(&env.dbx).await.unwrap();
        let login_id = test_login_id(&env).await;
        let mut req = auto_req(true, vec![], vec![]);
        req.unit.active = false;
        req.unit.orbit_note = Some("Hidden note".to_string());

        let rsp = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap();
        let unit = sigint_unit::Entity::find_by_id(rsp.unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(unit.orbit_note, None);
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_rejects_missing_locations() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;

        let err = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(false, vec![" ", ","], vec!["2 шр"]),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(unit_count(&env.dbx).await, 0);
        assert_eq!(network_count(&env.dbx).await, 0);
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_persists_network_details() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;

        let rsp = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(
                false,
                vec![" Роботине ", "Копані, Роботине"],
                vec![
                    "2 шр 3 ошб 44 осбр",
                    "44 осбр 3 ошб 2 шр",
                    "2 шр 3 ошб 44 осбр",
                ],
            ),
        )
        .await
        .unwrap();
        let network_id = rsp.network_id.unwrap();

        let network = sigint_network::Entity::find_by_id(network_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.name, SIGINT_UNIT_AUTO_CYBER_NETWORK_NAME);
        assert_eq!(network.location, "Роботине, Копані");
        assert!(network.do_not_archive);
        assert!(!network.deleted);
        assert_eq!(network.active_to, None);
        let unit_mask: Vec<String> =
            serde_json::from_value(network.unit_mask.clone()).unwrap();
        assert_eq!(unit_mask, vec!["2 шр 3 ошб 44 осбр", "44 осбр 3 ошб 2 шр"]);

        let relation = sigint_network_unit::Entity::find()
            .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(relation.unit_id, rsp.unit.id);
    }

    #[tokio::test]
    #[serial]
    async fn create_device_network_allows_replacing_inactive_network() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let unit = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(true, vec![], vec![]),
        )
        .await
        .unwrap()
        .unit;
        let req = CreateDeviceNetworkReq {
            unit_id: unit.id,
            locations: vec![" Роботине ".to_string()],
            unit_mask: vec!["2 шр 3 ошб 44 осбр".to_string()],
        };

        let rsp = create_device_network_for_login(&login_id, &env, req.clone())
            .await
            .unwrap();

        let network = sigint_network::Entity::find_by_id(rsp.network_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.location, "Роботине");
        assert!(unit_has_active_network(&env.dbx, unit.id).await.unwrap());

        let mut network = network.into_active_model();
        network.active_to = Set(Some(Utc::now().naive_utc()));
        network.update(&env.dbx).await.unwrap();
        assert!(!unit_has_active_network(&env.dbx, unit.id).await.unwrap());

        create_device_network_for_login(&login_id, &env, req.clone())
            .await
            .unwrap();

        let err = create_device_network_for_login(&login_id, &env, req)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(network_count(&env.dbx).await, 2);
    }

    #[tokio::test]
    #[serial]
    async fn create_device_network_rejects_when_setting_disabled() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, false).await;
        let login_id = test_login_id(&env).await;

        let err = create_device_network_for_login(
            &login_id,
            &env,
            CreateDeviceNetworkReq {
                unit_id: 1,
                locations: vec!["Роботине".to_string()],
                unit_mask: vec![],
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Forbidden(_)));
        assert_eq!(network_count(&env.dbx).await, 0);
    }

    #[tokio::test]
    #[serial]
    async fn orbit_import_creates_hierarchy_ancestors_and_enabled_network() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let mut orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        let unsupported_echelon_id = uuid::Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(unsupported_echelon_id),
            key: Set("other".to_string()),
            name: Set(format!("Інше-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let unsupported_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(unsupported_unit_id),
            unit_name_short: Set(Some("ВМФ".to_string())),
            unit_echelon_id: Set(Some(unsupported_echelon_id)),
            operational_parent_unit_id: Set(Some(orbit_fixture.unit_ids[5])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        update_orbit_parents(
            &env.dbx,
            orbit_fixture.unit_ids[4],
            None,
            Some(unsupported_unit_id),
        )
        .await;
        orbit_fixture.unit_ids.push(unsupported_unit_id);
        orbit_fixture.echelon_ids.push(unsupported_echelon_id);

        let rsp = orbit::import_orbit_unit_for_login(
            &login_id,
            &env,
            orbit_fixture.root_unit_id,
        )
        .await
        .unwrap();

        assert_eq!(rsp.unit.company, "1 рота");
        assert_eq!(rsp.unit.battalion, "2 бат");
        assert_eq!(rsp.unit.regiment, "55 мбр");
        assert_eq!(rsp.unit.division, "45 див");
        assert_eq!(rsp.unit.army, "20 ЗВА");
        assert_eq!(rsp.unit.military_district, "Західний ВО");
        assert_eq!(rsp.unit.army_region, "ЗС РФ");
        assert!(rsp.unit.active);
        assert!(orbit::unit_has_orbit(&env.dbx, rsp.unit.id).await.unwrap());
        let link = orbit_unit_sigint_unit::Entity::find_by_id((
            orbit_fixture.root_unit_id,
            rsp.unit.id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(link.is_manual);
        assert!(!link.is_suppressed);
        let network =
            sigint_network::Entity::find_by_id(rsp.network_id.unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(network.location, "");
        assert_eq!(
            serde_json::from_value::<Vec<String>>(network.unit_mask).unwrap(),
            vec![
                "1 рота 2 бат 55 мбр 45 див 20 ЗВА Західний ВО ЗС РФ",
                "ЗС РФ Західний ВО 20 ЗВА 45 див 55 мбр 2 бат 1 рота",
            ]
        );
        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_fixture.unit_ids.clone()),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), 7);
        assert!(!links
            .iter()
            .any(|link| link.orbit_unit_id == unsupported_unit_id));
        let linked_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), 7);
        assert!(linked_units.iter().all(|unit| unit.active));
        let unit_count_before_retry = unit_count(&env.dbx).await;
        let network_count_before_retry = network_count(&env.dbx).await;
        let err = orbit::import_orbit_unit_for_login(
            &login_id,
            &env,
            orbit_fixture.root_unit_id,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(unit_count(&env.dbx).await, unit_count_before_retry);
        assert_eq!(network_count(&env.dbx).await, network_count_before_retry);
        orbit_unit::Entity::delete_many()
            .filter(orbit_unit::Column::UnitId.is_in(orbit_fixture.unit_ids))
            .exec(&env.dbx)
            .await
            .unwrap();
        orbit_unit_echelon::Entity::delete_many()
            .filter(
                orbit_unit_echelon::Column::Id.is_in(orbit_fixture.echelon_ids),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn orbit_import_links_existing_legacy_ancestor_without_duplicate() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, false).await;
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        let existing_parent = extended_hierarchy_unit(
            &env.dbx,
            ["", "", "", "", " 20 зва ", "Західний ВО", ""],
        )
        .await;

        orbit::import_orbit_unit_for_login(
            &login_id,
            &env,
            orbit_fixture.root_unit_id,
        )
        .await
        .unwrap();

        assert_eq!(unit_count(&env.dbx).await, 7);
        let link = orbit_unit_sigint_unit::Entity::find_by_id((
            orbit_fixture.unit_ids[4],
            existing_parent.id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(link.is_manual);
        assert!(!link.is_suppressed);
    }

    #[tokio::test]
    #[serial]
    async fn oneoff_imports_every_unlinked_orbit_unit_as_inactive() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        let existing_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_fixture.unit_ids[6]),
            sigint_unit_id: Set(existing_unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let imported = orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
            .await
            .unwrap();

        assert_eq!(imported, 6);
        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_fixture.unit_ids.clone()),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), 7);
        let imported_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .filter(|unit_id| *unit_id != existing_unit.id)
            .collect::<Vec<_>>();
        let imported_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(imported_unit_ids))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(imported_units.len(), 6);
        assert!(imported_units.iter().all(|unit| !unit.active));
        assert!(imported_units
            .iter()
            .all(|unit| unit.is_deduplicate_candidate == Some(false)));
        assert_eq!(network_count(&env.dbx).await, 0);
        assert_eq!(
            orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
                .await
                .unwrap(),
            0
        );
        orbit_unit::Entity::delete_many()
            .filter(orbit_unit::Column::UnitId.is_in(orbit_fixture.unit_ids))
            .exec(&env.dbx)
            .await
            .unwrap();
        orbit_unit_echelon::Entity::delete_many()
            .filter(
                orbit_unit_echelon::Column::Id.is_in(orbit_fixture.echelon_ids),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn oneoff_skips_unsupported_orbit_units_and_imports_later_units() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        let unsupported_unit_id = uuid::Uuid::from_u128(1);
        orbit_unit::ActiveModel {
            unit_id: Set(unsupported_unit_id),
            unit_name: Set(Some("Unsupported unit".to_string())),
            operational_parent_unit_id: Set(Some(orbit_fixture.unit_ids[6])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let imported = orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
            .await
            .unwrap();

        assert_eq!(imported, orbit_fixture.unit_ids.len());
        assert!(orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(unsupported_unit_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            orbit_unit_sigint_unit::Entity::find()
                .filter(
                    orbit_unit_sigint_unit::Column::OrbitUnitId
                        .is_in(orbit_fixture.unit_ids),
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            imported as u64
        );
    }

    #[tokio::test]
    #[serial]
    async fn manual_orbit_link_creates_and_activates_both_parent_chains() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        split_orbit_parent_chains(&env.dbx, &orbit_fixture).await;
        let linked_unit = active_full_hierarchy_unit(&env.dbx).await;

        orbit::link_orbit_unit_for_login(
            &login_id,
            &env.dbx,
            linked_unit.id,
            orbit_fixture.root_unit_id,
        )
        .await
        .unwrap();

        assert_full_active_orbit_hierarchy(&env.dbx, orbit_fixture.unit_ids)
            .await;
    }

    #[tokio::test]
    #[serial]
    async fn automatic_orbit_link_creates_and_activates_both_parent_chains() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        split_orbit_parent_chains(&env.dbx, &orbit_fixture).await;
        let linked_unit = active_full_hierarchy_unit(&env.dbx).await;
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_fixture.root_unit_id),
            sigint_unit_id: Set(linked_unit.id),
            is_manual: Set(false),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        orbit::materialize_automatic_link_parent_chains(
            &env.dbx,
            &login_id,
            &BTreeSet::from([orbit_fixture.root_unit_id]),
        )
        .await
        .unwrap();

        assert_full_active_orbit_hierarchy(&env.dbx, orbit_fixture.unit_ids)
            .await;
    }

    #[tokio::test]
    #[serial]
    async fn oneoff_activates_linked_orbit_ancestors_in_both_hierarchies() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_fixture = insert_orbit_hierarchy(&env.dbx).await;
        update_orbit_parents(
            &env.dbx,
            orbit_fixture.unit_ids[0],
            Some(orbit_fixture.unit_ids[2]),
            Some(orbit_fixture.unit_ids[1]),
        )
        .await;
        update_orbit_parents(&env.dbx, orbit_fixture.unit_ids[1], None, None)
            .await;
        update_orbit_parents(
            &env.dbx,
            orbit_fixture.unit_ids[2],
            Some(orbit_fixture.unit_ids[3]),
            None,
        )
        .await;
        update_orbit_parents(
            &env.dbx,
            orbit_fixture.unit_ids[3],
            Some(orbit_fixture.unit_ids[4]),
            None,
        )
        .await;
        let existing_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_fixture.root_unit_id),
            sigint_unit_id: Set(existing_unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let imported = orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
            .await
            .unwrap();

        assert_eq!(imported, 6);
        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_fixture.unit_ids.clone()),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), 7);
        let linked_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), 7);
        assert!(linked_units.iter().all(|unit| unit.active));
    }

    #[tokio::test]
    #[serial]
    async fn orbit_link_reconciliation_updates_existing_candidates() {
        let env = cleanup().await.unwrap();
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let explicit_false = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_deduplicate_candidate: Set(Some(false)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unlinked = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let explicit_true = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_deduplicate_candidate: Set(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many(
            [first.id, second.id, explicit_false.id].map(|sigint_unit_id| {
                orbit_unit_sigint_unit::ActiveModel {
                    orbit_unit_id: Set(orbit_unit_id),
                    sigint_unit_id: Set(sigint_unit_id),
                    is_manual: Set(true),
                    is_suppressed: Set(false),
                }
            }),
        )
        .exec(&env.dbx)
        .await
        .unwrap();

        crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&env.dbx)
            .await
            .unwrap();

        let units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in([
                first.id,
                second.id,
                explicit_false.id,
                unlinked.id,
                explicit_true.id,
            ]))
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|unit| (unit.id, unit.is_deduplicate_candidate))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(units[&first.id], Some(true));
        assert_eq!(units[&second.id], Some(true));
        assert_eq!(units[&explicit_false.id], Some(true));
        assert_eq!(units[&unlinked.id], Some(false));
        assert_eq!(units[&explicit_true.id], Some(false));

        crate::orbit::unlink_sigint_unit_with_lock(
            &env.dbx,
            explicit_false.id,
            orbit_unit_id,
        )
        .await
        .unwrap();
        crate::orbit::unlink_sigint_unit_with_lock(
            &env.dbx,
            second.id,
            orbit_unit_id,
        )
        .await
        .unwrap();

        let remaining = sigint_unit::Entity::find_by_id(first.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(remaining.is_deduplicate_candidate, Some(false));
    }

    #[tokio::test]
    #[serial]
    async fn delete_unit_reconciles_remaining_deduplicate_candidate() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many([first.id, second.id].map(
            |sigint_unit_id| orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(orbit_unit_id),
                sigint_unit_id: Set(sigint_unit_id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        ))
        .exec(&env.dbx)
        .await
        .unwrap();
        crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&env.dbx)
            .await
            .unwrap();

        delete_unit_for_login(&env.dbx, &login_id, second.id)
            .await
            .unwrap();

        let remaining = sigint_unit::Entity::find_by_id(first.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(remaining.is_deduplicate_candidate, Some(false));
    }

    async fn hierarchy_unit(
        dbx: &DatabaseConnection,
        hierarchy: [&str; 5],
    ) -> sigint_unit::Model {
        extended_hierarchy_unit(
            dbx,
            [
                hierarchy[0],
                hierarchy[1],
                hierarchy[2],
                hierarchy[3],
                hierarchy[4],
                "",
                "",
            ],
        )
        .await
    }

    async fn extended_hierarchy_unit(
        dbx: &DatabaseConnection,
        hierarchy: [&str; 7],
    ) -> sigint_unit::Model {
        crate::functest::tests::mk_sigint_unit(
            dbx,
            sigint_unit::ActiveModel {
                company: Set(hierarchy[0].to_string()),
                battalion: Set(hierarchy[1].to_string()),
                regiment: Set(hierarchy[2].to_string()),
                division: Set(hierarchy[3].to_string()),
                army: Set(hierarchy[4].to_string()),
                military_district: Set(hierarchy[5].to_string()),
                army_region: Set(hierarchy[6].to_string()),
                active: Set(false),
                name: Set(hierarchy
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn set_activity(
        dbx: &DatabaseConnection,
        login_id: &uuid::Uuid,
        unit: &sigint_unit::Model,
        active: bool,
    ) {
        let mut req = render_unit(unit).unwrap();
        req.active = active;
        let req = UpdateUnitReq::from(req);
        update_unit_for_login(dbx, login_id, &req, true)
            .await
            .unwrap();
    }

    async fn active(dbx: &DatabaseConnection, unit_id: i64) -> bool {
        sigint_unit::Entity::find_by_id(unit_id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap()
            .active
    }

    #[tokio::test]
    #[serial]
    async fn unit_activity_propagates_to_parents() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let army = hierarchy_unit(&env.dbx, ["", "", "", "", "20 ЗВА"]).await;
        let division =
            hierarchy_unit(&env.dbx, ["", "", "", "45 див", "20 ЗВА"]).await;
        let regiment =
            hierarchy_unit(&env.dbx, ["", "", "55 мбр", "45 див", "20 ЗВА"])
                .await;
        let battalion = hierarchy_unit(
            &env.dbx,
            ["", "2 бат", "55 мбр", "45 див", "20 ЗВА"],
        )
        .await;
        let first_company = hierarchy_unit(
            &env.dbx,
            ["1 рота", "2 бат", "55 мбр", "45 див", "20 ЗВА"],
        )
        .await;
        let second_company = hierarchy_unit(
            &env.dbx,
            ["2 рота", "2 бат", "55 мбр", "45 див", "20 ЗВА"],
        )
        .await;

        set_activity(&env.dbx, &login_id, &first_company, true).await;
        for parent_id in [army.id, division.id, regiment.id, battalion.id] {
            assert!(active(&env.dbx, parent_id).await);
        }
        set_activity(&env.dbx, &login_id, &second_company, true).await;
        set_activity(&env.dbx, &login_id, &first_company, false).await;
        for parent_id in [army.id, division.id, regiment.id, battalion.id] {
            assert!(active(&env.dbx, parent_id).await);
        }
        set_activity(&env.dbx, &login_id, &second_company, false).await;
        for parent_id in [army.id, division.id, regiment.id, battalion.id] {
            assert!(!active(&env.dbx, parent_id).await);
        }
    }

    #[tokio::test]
    #[serial]
    async fn unit_activity_propagates_to_legacy_parent_without_army_region() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let legacy_parent = extended_hierarchy_unit(
            &env.dbx,
            ["", "", "", "", "20 ЗВА", "Західний ВО", ""],
        )
        .await;
        let other_district_parent = extended_hierarchy_unit(
            &env.dbx,
            ["", "", "", "", "20 ЗВА", "Південний ВО", ""],
        )
        .await;
        let child = extended_hierarchy_unit(
            &env.dbx,
            [
                "1 рота",
                "2 бат",
                "55 мбр",
                "45 див",
                "20 ЗВА",
                "Західний ВО",
                "ЗС РФ",
            ],
        )
        .await;

        set_activity(&env.dbx, &login_id, &child, true).await;

        assert!(active(&env.dbx, legacy_parent.id).await);
        assert!(!active(&env.dbx, other_district_parent.id).await);

        set_activity(&env.dbx, &login_id, &child, false).await;

        assert!(!active(&env.dbx, legacy_parent.id).await);
    }

    #[tokio::test]
    #[serial]
    async fn unit_activity_reconciles_create_move_and_delete() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let old_regiment =
            hierarchy_unit(&env.dbx, ["", "", "44 осбр", "", ""]).await;
        let old_battalion =
            hierarchy_unit(&env.dbx, ["", "3 ошб", "44 осбр", "", ""]).await;
        let new_regiment =
            hierarchy_unit(&env.dbx, ["", "", "45 осбр", "", ""]).await;
        let new_battalion =
            hierarchy_unit(&env.dbx, ["", "4 ошб", "45 осбр", "", ""]).await;

        let created = create_unit_with_auto_network_for_login(
            &login_id,
            &env,
            auto_req(true, vec![], vec![]),
        )
        .await
        .unwrap()
        .unit;
        assert!(active(&env.dbx, old_battalion.id).await);
        assert!(active(&env.dbx, old_regiment.id).await);

        let mut moved = created;
        moved.battalion = "4 ошб".to_string();
        moved.regiment = "45 осбр".to_string();
        let moved = UpdateUnitReq::from(moved);
        let moved = update_unit_for_login(&env.dbx, &login_id, &moved, true)
            .await
            .unwrap();
        assert!(!active(&env.dbx, old_battalion.id).await);
        assert!(!active(&env.dbx, old_regiment.id).await);
        assert!(active(&env.dbx, new_battalion.id).await);
        assert!(active(&env.dbx, new_regiment.id).await);

        delete_unit_for_login(&env.dbx, &login_id, moved.id)
            .await
            .unwrap();
        assert!(!active(&env.dbx, new_battalion.id).await);
        assert!(!active(&env.dbx, new_regiment.id).await);
    }

    #[tokio::test]
    #[serial]
    async fn merge_units_reconciles_enriched_survivor_hierarchy() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let old_parent =
            hierarchy_unit(&env.dbx, ["", "2 бат", "", "", ""]).await;
        let new_parent =
            hierarchy_unit(&env.dbx, ["", "2 бат", "55 мбр", "", ""]).await;
        let surviving =
            hierarchy_unit(&env.dbx, ["1 рота", "2 бат", "", "", ""]).await;
        let duplicate =
            hierarchy_unit(&env.dbx, ["", "", "55 мбр", "", ""]).await;
        set_unit_activity(&env.dbx, &login_id, &old_parent, true)
            .await
            .unwrap();
        let surviving =
            set_unit_activity(&env.dbx, &login_id, &surviving, true)
                .await
                .unwrap();

        let merged =
            merge_units(login_id, &env.dbx, duplicate.id, surviving.id)
                .await
                .unwrap();

        assert_eq!(merged.regiment, "55 мбр");
        assert_eq!(merged.name, "1 рота 2 бат 55 мбр");
        assert!(active(&env.dbx, old_parent.id).await);
        assert!(active(&env.dbx, new_parent.id).await);
    }

    #[tokio::test]
    #[serial]
    async fn merge_units_updates_name_and_search_for_extended_hierarchy() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let surviving = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                company: Set("CompanyToken".to_string()),
                name: Set("CompanyToken".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                military_district: Set("DistrictToken".to_string()),
                army_region: Set("RegionToken".to_string()),
                name: Set("DistrictToken RegionToken".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let merged =
            merge_units(login_id, &env.dbx, duplicate.id, surviving.id)
                .await
                .unwrap();

        assert_eq!(merged.name, "CompanyToken DistrictToken RegionToken");
        let search_matches = env
            .dbx
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT search_tsv @@ plainto_tsquery('russian', $1) AS matches FROM sigint_unit WHERE id = $2",
                ["DistrictToken".into(), merged.id.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<bool>("", "matches")
            .unwrap();
        assert!(search_matches);
    }

    #[tokio::test]
    #[serial]
    async fn hide_orbit_data_disables_orbit_visibility() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, false).await;
        let login_id = test_login_id(&env).await;
        assert!(orbit::can_view_orbit_data(&env.dbx, &login_id)
            .await
            .unwrap());
        let settings = system_settings::Entity::find()
            .filter(system_settings::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut settings = settings.into_active_model();
        settings.hide_orbit_data = Set(true);
        settings.update(&env.dbx).await.unwrap();

        assert!(!orbit::can_view_orbit_data(&env.dbx, &login_id)
            .await
            .unwrap());
    }

    #[tokio::test]
    #[serial]
    async fn unit_update_preserves_server_derived_deduplicate_candidate() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_deduplicate_candidate: Set(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut req = render_unit(&unit).unwrap();
        req.is_deduplicate_candidate = Some(false);
        req.comment = "updated".to_string();
        let req = UpdateUnitReq::from(req);

        let unit = update_unit_for_login(&env.dbx, &login_id, &req, true)
            .await
            .unwrap();

        assert_eq!(unit.comment, "updated");
        assert_eq!(unit.is_deduplicate_candidate, Some(true));
    }

    #[tokio::test]
    #[serial]
    async fn unit_update_preserves_redacted_orbit_note() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                orbit_note: Set(Some("Orbit note".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut req = render_unit(&unit).unwrap();
        redact_unit_orbit_data(&mut req);
        req.comment = "updated".to_string();
        let req = UpdateUnitReq::from(req);

        let unit = update_unit_for_login(&env.dbx, &login_id, &req, false)
            .await
            .unwrap();

        assert_eq!(unit.comment, "updated");
        assert_eq!(unit.orbit_note.as_deref(), Some("Orbit note"));
    }

    #[tokio::test]
    #[serial]
    async fn unit_update_preserves_fields_omitted_by_older_clients() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                military_district: Set("Західний ВО".to_string()),
                army_region: Set("ЗС РФ".to_string()),
                orbit_note: Set(Some("Orbit note".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let req: UpdateUnitReq = serde_json::from_value(serde_json::json!({
            "id": unit.id,
            "company": unit.company,
            "battalion": unit.battalion,
            "regiment": unit.regiment,
            "division": unit.division,
            "army": unit.army,
            "active": unit.active,
            "comment": "updated"
        }))
        .unwrap();

        let unit = update_unit_for_login(&env.dbx, &login_id, &req, true)
            .await
            .unwrap();

        assert_eq!(unit.military_district, "Західний ВО");
        assert_eq!(unit.army_region, "ЗС РФ");
        assert_eq!(unit.orbit_note.as_deref(), Some("Orbit note"));
        assert_eq!(unit.comment, "updated");
    }

    #[test]
    fn redact_unit_orbit_data_hides_orbit_fields() {
        let mut unit = Unit {
            id: 1,
            company: String::new(),
            battalion: String::new(),
            regiment: String::new(),
            division: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            comment: String::new(),
            orbit_note: Some("Orbit note".to_string()),
            name: String::new(),
            active: true,
            is_deduplicate_candidate: Some(true),
            created_at: 0,
            created_by_login_id: String::new(),
            has_orbit: true,
            orbit_unit_ids: vec![Uuid::nil().to_string()],
        };

        redact_unit_orbit_data(&mut unit);

        assert!(!unit.has_orbit);
        assert!(unit.orbit_unit_ids.is_empty());
        assert_eq!(unit.orbit_note, None);
        assert_eq!(unit.is_deduplicate_candidate, None);
    }

    #[tokio::test]
    #[serial]
    async fn merge_units_moves_orbit_links_and_returns_surviving_unit() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                orbit_note: Set(Some("Duplicate Orbit note".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let surviving = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_deduplicate_candidate: Set(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let remaining_duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_deduplicate_candidate: Set(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let first_orbit_unit_id = uuid::Uuid::new_v4();
        let second_orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit::ActiveModel {
                unit_id: Set(first_orbit_unit_id),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(second_orbit_unit_id),
                ..Default::default()
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many([
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(first_orbit_unit_id),
                sigint_unit_id: Set(duplicate.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(second_orbit_unit_id),
                sigint_unit_id: Set(duplicate.id),
                is_manual: Set(false),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(second_orbit_unit_id),
                sigint_unit_id: Set(surviving.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(second_orbit_unit_id),
                sigint_unit_id: Set(remaining_duplicate.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();

        let merged =
            merge_units(login_id, &env.dbx, duplicate.id, surviving.id)
                .await
                .unwrap();

        assert_eq!(merged.id, surviving.id);
        assert!(!merged.deleted);
        assert_eq!(merged.is_deduplicate_candidate, Some(true));
        assert_eq!(merged.orbit_note.as_deref(), Some("Duplicate Orbit note"));
        assert!(orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(duplicate.id)
            )
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
        let surviving_links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(surviving.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        let surviving_orbit_unit_ids = surviving_links
            .iter()
            .map(|link| link.orbit_unit_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            surviving_orbit_unit_ids,
            BTreeSet::from([first_orbit_unit_id, second_orbit_unit_id])
        );
        assert!(surviving_links.iter().all(|link| link.is_manual));
        let merged = merge_units(
            login_id,
            &env.dbx,
            remaining_duplicate.id,
            surviving.id,
        )
        .await
        .unwrap();
        assert_eq!(merged.is_deduplicate_candidate, Some(false));
        assert!(
            sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            sigint_unit::Entity::find_by_id(remaining_duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );

        orbit_unit::Entity::delete_many()
            .filter(
                orbit_unit::Column::UnitId
                    .is_in([first_orbit_unit_id, second_orbit_unit_id]),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }
}
