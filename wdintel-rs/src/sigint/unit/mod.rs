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
use crate::utils::orm::ArrayColumnOps;
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
    let mut parts = vec![];
    if !unit.company.is_empty() {
        parts.push(unit.company.clone());
    }
    if !unit.battalion.is_empty() {
        parts.push(unit.battalion.clone());
    }
    if !unit.regiment.is_empty() {
        parts.push(unit.regiment.clone());
    }
    if !unit.division.is_empty() {
        parts.push(unit.division.clone());
    }
    if !unit.army.is_empty() {
        parts.push(unit.army.clone());
    }
    parts.join(" ")
}

pub fn unit_name_req(req: &CreateUnitReq) -> String {
    let mut parts = vec![];
    if !req.company.is_empty() {
        parts.push(req.company.clone());
    }
    if !req.battalion.is_empty() {
        parts.push(req.battalion.clone());
    }
    if !req.regiment.is_empty() {
        parts.push(req.regiment.clone());
    }
    if !req.division.is_empty() {
        parts.push(req.division.clone());
    }
    if !req.army.is_empty() {
        parts.push(req.army.clone());
    }
    parts.join(" ")
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
                    find_unit(&env.dbx, *before_unit_id).await.c(h!())?;
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
                    find_unit(&env.dbx, *after_unit_id).await.c(h!())?;
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
                    find_unit(&env.dbx, *after_unit_id).await.c(h!())?;
                units = units.filter(
                    Expr::tuple([
                        sigint_unit::Column::Army.into_column_ref().into(),
                        sigint_unit::Column::Division.into_column_ref().into(),
                        sigint_unit::Column::Regiment.into_column_ref().into(),
                        sigint_unit::Column::Battalion.into_column_ref().into(),
                        sigint_unit::Column::Company.into_column_ref().into(),
                        sigint_unit::Column::Id.into_column_ref().into(),
                    ])
                    .gt(SimpleExpr::Tuple(vec![
                        after_unit.army.into(),
                        after_unit.division.into(),
                        after_unit.regiment.into(),
                        after_unit.battalion.into(),
                        after_unit.company.into(),
                        after_unit.id.into(),
                    ])),
                );
            }
            units = units.order_by_asc(sigint_unit::Column::Army);
            units = units.order_by_asc(sigint_unit::Column::Division);
            units = units.order_by_asc(sigint_unit::Column::Regiment);
            units = units.order_by_asc(sigint_unit::Column::Battalion);
            units = units.order_by_asc(sigint_unit::Column::Company);
            units = units.order_by_asc(sigint_unit::Column::Id);
        }
    }
    let units = units.limit(LIMIT).all(&env.dbx).await.c(h!())?;
    let orbit_unit_ids = if can_view_orbit {
        orbit::unit_ids_with_orbit(&env.dbx).await?
    } else {
        Default::default()
    };
    let mut res = vec![];
    for unit in units {
        let mut rendered = render_unit(&unit)?;
        rendered.has_orbit = orbit_unit_ids.contains(&unit.id);
        res.push(rendered);
    }
    Ok(Json(ListUnitsRsp {
        show_load_more: res.len() as u64 == LIMIT,
        units: res,
    }))
}

#[post("/api/sigint/units-by-id")]
pub async fn list_units_by_id(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListUnitsByIdReq>,
) -> Result<Json<ListUnitsByIdRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api"],
    )
    .await
    .c(h!())?;
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    if let Some(ids) = &req.ids {
        units = units.filter(sigint_unit::Column::Id.eq_any(ids.clone()));
    }
    let units = units.all(&env.dbx).await.c(h!())?;

    let mut res = vec![];
    for unit in units {
        res.push(render_unit(&unit)?);
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
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
        .await
        .c(h!())?;
    let login = login_id_from_identity(&user)?;

    let req = req.into_inner();
    let unit = insert_unit_with_changelog(&env.dbx, &login, &req).await?;

    if unit.active {
        crate::orbit::link_new_sigint_unit_with_lock(&env.dbx, unit.id)
            .await
            .c(h!())?;
    }

    fanout_unit_changed(&env).await?;

    let mut unit = render_unit(&unit)?;
    if orbit::can_view_orbit_data(&env.dbx, &login).await? {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
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

pub async fn create_unit_with_auto_network_for_login(
    login: &uuid::Uuid,
    env: &Env,
    req: CreateUnitWithAutoNetworkReq,
) -> Result<CreateUnitWithAutoNetworkRsp, AppError> {
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;

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
            insert_auto_cyber_network(&txn, login, &req, unit.id, locations)
                .await
                .c(h!())?,
        )
    };
    txn.commit().await.context(h!())?;

    if unit.active {
        crate::orbit::link_new_sigint_unit_with_lock(&env.dbx, unit.id)
            .await
            .c(h!())?;
    }

    fanout_unit_changed_data(env).await?;

    if let Some(network) = network.clone() {
        fanout_network_changed_data(env).await.c(h!())?;
        crate::sigint::network::etalon_calc::invalidate_network_inbox(
            network.clone(),
            vec![],
            &env.dbx,
            format!("created cyber network {}", network.id),
        )
        .await
        .c(h!())?;
        if !crate::sigint::unit_tag::sigint_network_unit_mask(&network)
            .is_empty()
        {
            crate::sigint::unit_tag::enqueue_recent_non_rer_unit_tag_recalculation(
                &env.dbx,
            )
            .await
            .c(h!())?;
        }
    }

    let mut unit = render_unit(&unit)?;
    if orbit::can_view_orbit_data(&env.dbx, login).await? {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
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
        active: Set(req.active),
        created_at: NotSet,
        created_by_login_id: Set(*login),
        comment: Set(req.comment.clone()),
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

async fn insert_auto_cyber_network<'a, 'async_trait, C>(
    txn: &'a C,
    login: &uuid::Uuid,
    req: &CreateUnitWithAutoNetworkReq,
    unit_id: i64,
    locations: Vec<String>,
) -> Result<sigint_network::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let unit_mask =
        crate::sigint::unit_tag::normalize_unit_mask(req.unit_mask.clone())
            .c(h!())?;
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
    req: Json<Unit>,
) -> Result<Json<Unit>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    let unit = find_unit(&env.dbx, req.id).await.context(h!())?;
    let unit_json_old = sigint_unit::Entity::find_by_id(req.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let mut unit = unit.into_active_model();
    unit.company = Set(req.company.clone());
    unit.battalion = Set(req.battalion.clone());
    unit.regiment = Set(req.regiment.clone());
    unit.division = Set(req.division.clone());
    unit.army = Set(req.army.clone());
    unit.active = Set(req.active);
    unit.name = Set(unit_name(&req));
    unit.comment = Set(req.comment.clone());
    let unit = unit.update(&env.dbx).await.context(h!())?;
    let unit_json_new = sigint_unit::Entity::find_by_id(req.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(req.id),
        login_id: Set(login),
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    unit_after_insert_update(&env.dbx, req.id)
        .await
        .context(h!())?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let mut unit = render_unit(&unit)?;
    if orbit::can_view_orbit_data(&env.dbx, &login).await? {
        unit.has_orbit = orbit::unit_has_orbit(&env.dbx, unit.id).await?;
    }
    Ok(Json(unit))
}

#[post("/api/sigint/unit/delete")]
pub async fn delete_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Unit>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    has_role(&env.dbx, &login_id_from_identity(&user)?, "UnitsEditor")
        .await
        .c(h!())?;
    let unit = find_unit(&env.dbx, req.into_inner()).await.context(h!())?;
    let unit_json_old = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let mut unit = unit.into_active_model();
    unit.deleted = Set(true);
    let unit = unit.update(&env.dbx).await.context(h!())?;
    let unit_json_new = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login_id: Set(login_id_from_identity(&user)?),
        action: Set("delete".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(render_unit(&unit)?))
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

    let mut unit = unit_to_delete.into_active_model();
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
    Ok(unit_original)
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
        active: unit.active,
        comment: unit.comment.clone(),
        name: unit.name.clone(),
        created_at: unit.created_at.and_utc().timestamp_millis(),
        created_by_login_id: unit.created_by_login_id.to_string(),
        has_orbit: false,
    })
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
            .do_nothing()
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
    if unit_original.comment.is_empty() && !unit_to_merge.comment.is_empty() {
        unit.comment = Set(unit_to_merge.comment.clone());
    }
    if unit_original.deleted && !unit_to_merge.deleted {
        unit.deleted = Set(false);
    }

    unit.update(dbx).await.context(h!())
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
    txn.execute(statement).await.context(h!())?;
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
    has_any_role(&env.dbx, &login_id_from_identity(&user)?, vec!["Rer"])
        .await
        .c(h!())?;

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
        res.push(render_unit(&unit)?);
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
            active: true,
            comment: "main section".to_string(),
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
    async fn merge_units_moves_orbit_links_and_returns_surviving_unit() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let surviving = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
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
        assert!(
            sigint_unit::Entity::find_by_id(duplicate.id)
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
