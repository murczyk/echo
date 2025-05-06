use self::types::*;
use crate::entities::sigint_unit::Model;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;
use sea_query::types::IntoColumnRef;
use sea_query::{Expr, SimpleExpr};

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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
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
                let before_unit = find_unit(&env.dbx, *before_unit_id).await?;
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
                let after_unit = find_unit(&env.dbx, *after_unit_id).await?;
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
                let after_unit = find_unit(&env.dbx, *after_unit_id).await?;
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
    let units = units.limit(LIMIT).all(&env.dbx).await?;
    let mut res = vec![];
    for unit in units {
        res.push(render_unit(&unit)?);
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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    if let Some(ids) = &req.ids {
        units = units.filter(sigint_unit::Column::Id.is_in(ids.clone()));
    }
    let units = units.all(&env.dbx).await?;

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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let unit = sigint_unit::ActiveModel {
        id: NotSet,
        company: Set(req.company.clone()),
        battalion: Set(req.battalion.clone()),
        regiment: Set(req.regiment.clone()),
        division: Set(req.division.clone()),
        army: Set(req.army.clone()),
        active: Set(req.active),
        created_at: NotSet,
        created_by: Set(user.id()?.to_string()),
        comment: Set(req.comment.clone()),
        name: Set(unit_name_req(&req)),
        deleted: Set(false),
    }
    .insert(&env.dbx)
    .await?;

    let unit_json = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login: Set(user.id()?.to_string()),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
    }
    .insert(&env.dbx)
    .await?;
    Ok(Json(render_unit(&unit)?))
}

#[post("/api/sigint/unit/update")]
pub async fn update_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Unit>,
) -> Result<Json<Unit>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;
    let unit = find_unit(&env.dbx, req.id).await?;
    let unit_json_old = sigint_unit::Entity::find_by_id(req.id)
        .into_json()
        .one(&env.dbx)
        .await?
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
    let unit = unit.update(&env.dbx).await?;
    let unit_json_new = sigint_unit::Entity::find_by_id(req.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(req.id),
        login: Set(user.id()?.to_string()),
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&env.dbx)
    .await?;
    Ok(Json(render_unit(&unit)?))
}

#[post("/api/sigint/unit/delete")]
pub async fn delete_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Unit>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;
    let unit = find_unit(&env.dbx, req.into_inner()).await?;
    let unit_json_old = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut unit = unit.into_active_model();
    unit.deleted = Set(true);
    let unit = unit.update(&env.dbx).await?;
    let unit_json_new = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login: Set(user.id()?.to_string()),
        action: Set("delete".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&env.dbx)
    .await?;
    Ok(Json(render_unit(&unit)?))
}

#[post("/api/sigint/unit/delete-duplicate")]
pub async fn delete_unit_duplicate(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteUnitDuplicateReq>,
) -> Result<Json<Unit>, AppError> {
    let login = user.id()?.to_string();
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;
    let req: DeleteUnitDuplicateReq = req.into_inner();
    let unit_to_delete = find_unit(&env.dbx, req.clone_to_delete_id).await?;
    let unit_original = find_unit(&env.dbx, req.original_id).await?;
    update_original_unit(unit_original, &unit_to_delete, &env.dbx).await?;

    swap_units(
        req.clone_to_delete_id,
        req.original_id,
        login.clone(),
        &env.dbx,
    )
    .await?;

    let unit_json_old = sigint_unit::Entity::find_by_id(req.clone_to_delete_id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let unit_json_new = sigint_unit::Entity::find_by_id(req.original_id)
        .into_json()
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let mut unit = unit_to_delete.into_active_model();
    unit.deleted = Set(true);
    let unit = unit.update(&env.dbx).await?;

    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(req.clone_to_delete_id),
        login: Set(login),
        action: Set("delete_duplicate".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(&env.dbx)
    .await?;
    Ok(Json(render_unit(&unit)?))
}

pub async fn find_unit(
    dbx: &DbConn,
    unit_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let unit = sigint_unit::Entity::find_by_id(unit_id)
        .one(dbx)
        .await?
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
        created_by: unit.created_by.clone(),
    })
}

async fn swap_units(
    old_unit_id: i64,
    new_unit_id: i64,
    login: String,
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
            .await?
            .ok_or(AppError::NotFound)?;
        let mut callsign = callsign.into_active_model();
        callsign.unit_id = Set(new_unit_id);
        callsign.update(dbx).await.context(h!())?;
        let json_new = sigint_callsign::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await?
            .ok_or(AppError::NotFound)?;
        sigint_callsign_changelog::ActiveModel {
            id: NotSet,
            sigint_callsign_id: Set(id),
            login: Set(login.clone()),
            action: Set("update".to_string()),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
        }
        .insert(dbx)
        .await?;
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
            .await?
            .ok_or(AppError::NotFound)?;
        let mut signal = signal.into_active_model();
        signal.unit = Set(Some(new_unit_id));
        signal.update(dbx).await.context(h!())?;
        let json_new = sigint_signal::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await?
            .ok_or(AppError::NotFound)?;
        sigint_signal_changelog::ActiveModel {
            id: NotSet,
            sigint_signal_id: Set(id),
            login: Set(login.clone()),
            action: Set(
                sea_orm_active_enums::SigintSignalChangelogActionEnum::Update,
            ),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
        }
        .insert(dbx)
        .await?;
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
            .await?
            .ok_or(AppError::NotFound)?;
        let mut network_unit = network_unit.into_active_model();
        network_unit.unit_id = Set(new_unit_id);
        network_unit.update(dbx).await.context(h!())?;
        let json_new = sigint_network_unit::Entity::find_by_id(id)
            .into_json()
            .one(dbx)
            .await?
            .ok_or(AppError::NotFound)?;
        sigint_network_unit_changelog::ActiveModel {
            id: NotSet,
            sigint_network_unit_id: Set(id),
            login: Set(login.clone()),
            action: Set("update".to_string()),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
        }
        .insert(dbx)
        .await?;
    }

    Ok(())
}

async fn update_original_unit(
    unit_original: Model,
    unit_to_merge: &Model,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
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
    if unit_original.created_by.is_empty()
        && !unit_to_merge.created_by.is_empty()
    {
        unit.created_by = Set(unit_to_merge.created_by.clone());
    }
    if unit_original.deleted && !unit_to_merge.deleted {
        unit.deleted = Set(false);
    }

    unit.update(dbx).await.context(h!())?;
    Ok(())
}
