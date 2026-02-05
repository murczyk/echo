use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
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
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await
    .c(h!())?;
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
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;

    let unit = sigint_unit::ActiveModel {
        id: NotSet,
        company: Set(req.company.clone()),
        battalion: Set(req.battalion.clone()),
        regiment: Set(req.regiment.clone()),
        division: Set(req.division.clone()),
        army: Set(req.army.clone()),
        active: Set(req.active),
        created_at: NotSet,
        created_by: Set(user.id().c(h!())?.to_string()),
        comment: Set(req.comment.clone()),
        name: Set(unit_name_req(&req)),
        deleted: Set(false),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let unit_json = sigint_unit::Entity::find_by_id(unit.id)
        .into_json()
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit.id),
        login: Set(user.id().c(h!())?.to_string()),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;
    unit_after_insert_update(&env.dbx, unit.id)
        .await
        .context(h!())?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(render_unit(&unit)?))
}

#[post("/api/sigint/unit/update")]
pub async fn update_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Unit>,
) -> Result<Json<Unit>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;
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
        login: Set(user.id().c(h!())?.to_string()),
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

    Ok(Json(render_unit(&unit)?))
}

#[post("/api/sigint/unit/delete")]
pub async fn delete_unit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Unit>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
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
        login: Set(user.id().c(h!())?.to_string()),
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
    let login = user.id().c(h!())?.to_string();
    let dbx = &env.dbx;
    crate::users::has_role(dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;
    let req: DeleteUnitDuplicateReq = req.into_inner();
    let unit_to_delete_id = req.clone_to_delete_id;
    let original_id = req.original_id;

    let unit = merge_units(login, dbx, unit_to_delete_id, original_id)
        .await
        .c(h!())?;

    let event = EventMsg::new(EventType::ETUnitChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(render_unit(&unit)?))
}

pub async fn merge_units(
    login: String,
    dbx: &DatabaseConnection,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let unit_to_delete =
        find_unit(dbx, unit_to_delete_id).await.context(h!())?;
    let unit_original = find_unit(dbx, original_id).await.context(h!())?;
    update_original_unit(unit_original, &unit_to_delete, dbx)
        .await
        .context(h!())?;

    swap_units(unit_to_delete_id, original_id, login.clone(), dbx)
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
    let unit = unit.update(dbx).await.context(h!())?;

    let _changelog = sigint_unit_changelog::ActiveModel {
        id: NotSet,
        sigint_unit_id: Set(unit_to_delete_id),
        login: Set(login),
        action: Set("delete_duplicate".to_string()),
        created_at: NotSet,
        new_value: Set(Some(unit_json_new)),
        old_value: Set(Some(unit_json_old)),
        req: Set(None),
    }
    .insert(dbx)
    .await
    .context(h!())?;
    Ok(unit)
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
            login: Set(login.clone()),
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
            login: Set(login.clone()),
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
            login: Set(login.clone()),
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

    Ok(())
}

async fn update_original_unit(
    unit_original: sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
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
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Rer"])
        .await
        .c(h!())?;

    let search_phrase = req.search.trim();
    if search_phrase.is_empty() {
        return Ok(Json(ListUnitsByIdRsp { units: vec![] }));
    }

    let q = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            "search_tsv::tsvector @@ websearch_to_tsquery('russian', $1)",
            vec![search_phrase.to_string()],
        ))
        .order_by_desc(sigint_unit::Column::Name);

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
