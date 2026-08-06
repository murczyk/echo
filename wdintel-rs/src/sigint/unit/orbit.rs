use super::types::{
    CreateUnitReq, CreateUnitWithAutoNetworkReq, CreateUnitWithAutoNetworkRsp,
    ImportOrbitUnitReq, LinkOrbitUnitReq, OrbitDictionaryValue,
    OrbitParentUnit, OrbitUnitDetails, OrbitUnitLinkCandidate,
    OrbitUnitLinkCandidatesReq, OrbitUnitLinkCandidatesRsp, OrbitUnitSearchReq,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{warn, Env, Mode, ShortContext};
use crate::users::{ensure_rer_role, has_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const ORBIT_LINK_CANDIDATE_LIMIT: u64 = 100;
const ORBIT_LINK_SEARCH_WORD_LIMIT: usize = 8;

pub async fn can_view_orbit_data(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<bool, AppError> {
    if crate::system_settings::orbit_data_hidden(dbx)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    match has_role(dbx, login_id, "Rer").await {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(err) => Err(err),
    }
}

pub async fn unit_ids_with_orbit(
    dbx: &DatabaseConnection,
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    let mut unit_ids = HashMap::<i64, Vec<String>>::new();
    for link in orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .order_by_asc(orbit_unit_sigint_unit::Column::SigintUnitId)
        .order_by_asc(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .all(dbx)
        .await
        .c(h!())?
    {
        unit_ids
            .entry(link.sigint_unit_id)
            .or_default()
            .push(link.orbit_unit_id.to_string());
    }
    Ok(unit_ids)
}

pub async fn unit_has_orbit(
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
) -> Result<bool, AppError> {
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

pub async fn unit_orbit_details(
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
) -> Result<Vec<OrbitUnitDetails>, AppError> {
    let units = orbit_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit::Relation::OrbitUnitSigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .order_by_asc(orbit_unit::Column::OperationalUnitNameFull)
        .order_by_asc(orbit_unit::Column::UnitId)
        .all(dbx)
        .await
        .c(h!())?;
    let mut details = Vec::with_capacity(units.len());
    for unit in units {
        details.push(render_orbit_unit_details(dbx, unit).await?);
    }
    Ok(details)
}

async fn render_orbit_unit_details(
    dbx: &DatabaseConnection,
    unit: orbit_unit::Model,
) -> Result<OrbitUnitDetails, AppError> {
    let generative_parent_units = orbit_parent_units(
        dbx,
        unit.generative_parent_unit_id,
        OrbitParentKind::Generative,
    )
    .await?;
    let operational_parent_units = orbit_parent_units(
        dbx,
        unit.operational_parent_unit_id,
        OrbitParentKind::Operational,
    )
    .await?;
    let unit_echelon = unit
        .find_related(orbit_unit_echelon::Entity)
        .one(dbx)
        .await
        .c(h!())?
        .map(render_unit_echelon);
    let combat_unit_type = unit
        .find_related(orbit_combat_unit_type::Entity)
        .one(dbx)
        .await
        .c(h!())?
        .map(render_combat_unit_type);
    let grouping_of_forces = unit
        .find_related(orbit_grouping_of_forces::Entity)
        .order_by_asc(orbit_grouping_of_forces::Column::Name)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_grouping_of_forces)
        .collect();
    Ok(OrbitUnitDetails {
        unit_id: unit.unit_id.to_string(),
        unit_name: unit.unit_name,
        unit_name_original: unit.unit_name_original,
        unit_name_short: unit.unit_name_short,
        operational_unit_name_full: unit.operational_unit_name_full,
        generative_unit_name_full: unit.generative_unit_name_full,
        unit_number: unit.unit_number,
        unit_alternate_names: unit.unit_alternate_names,
        unit_alternate_numbers: unit.unit_alternate_numbers,
        unit_echelon,
        combat_unit_type,
        grouping_of_forces,
        generative_parent_unit_id: unit
            .generative_parent_unit_id
            .map(|unit_id| unit_id.to_string()),
        operational_parent_unit_id: unit
            .operational_parent_unit_id
            .map(|unit_id| unit_id.to_string()),
        generative_parent_units,
        operational_parent_units,
        deleted: unit.deleted,
        created_at: unit.created_at.and_utc().timestamp_millis(),
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    })
}

async fn orbit_parent_units(
    dbx: &DatabaseConnection,
    mut orbit_unit_id: Option<Uuid>,
    parent_kind: OrbitParentKind,
) -> Result<Vec<OrbitParentUnit>, AppError> {
    let mut parents = Vec::new();
    let mut seen = HashSet::new();
    while let Some(parent_unit_id) = orbit_unit_id {
        if !seen.insert(parent_unit_id) {
            break;
        }
        let Some(parent) = orbit_unit::Entity::find_by_id(parent_unit_id)
            .filter(orbit_unit::Column::Deleted.eq(false))
            .one(dbx)
            .await
            .c(h!())?
        else {
            break;
        };
        let sigint_unit_id = orbit_unit_sigint_unit::Entity::find()
            .join(
                JoinType::InnerJoin,
                orbit_unit_sigint_unit::Relation::SigintUnit.def(),
            )
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId.eq(parent_unit_id),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .filter(sigint_unit::Column::Deleted.eq(false))
            .order_by_asc(orbit_unit_sigint_unit::Column::SigintUnitId)
            .one(dbx)
            .await
            .c(h!())?
            .map(|link| link.sigint_unit_id);
        let name = parent
            .unit_name
            .clone()
            .or(parent.unit_name_short.clone())
            .or(parent.unit_number.clone())
            .unwrap_or_else(|| parent.unit_id.to_string());
        parents.push(OrbitParentUnit {
            sigint_unit_id,
            name,
        });
        orbit_unit_id = parent_kind.parent_id(&parent);
    }
    Ok(parents)
}

fn render_unit_echelon(
    value: orbit_unit_echelon::Model,
) -> OrbitDictionaryValue {
    render_dictionary(value.id, value.key, value.name)
}

fn render_combat_unit_type(
    value: orbit_combat_unit_type::Model,
) -> OrbitDictionaryValue {
    render_dictionary(value.id, value.key, value.name)
}

fn render_grouping_of_forces(
    value: orbit_grouping_of_forces::Model,
) -> OrbitDictionaryValue {
    render_dictionary(value.id, value.key, value.name)
}

fn render_dictionary(
    id: Uuid,
    key: String,
    name: String,
) -> OrbitDictionaryValue {
    OrbitDictionaryValue {
        id: id.to_string(),
        key,
        name,
    }
}

#[post("/api/sigint/unit/orbit-link-candidates")]
pub async fn orbit_link_candidates(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<OrbitUnitLinkCandidatesReq>,
) -> Result<Json<OrbitUnitLinkCandidatesRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_editor_access(&env.dbx, &login).await?;
    let req = req.into_inner();
    let unit = find_available_sigint_unit(&env.dbx, req.unit_id).await?;
    let units = match req.search.as_deref() {
        Some(search) => manual_orbit_link_candidates(&env.dbx, search).await?,
        None => automatic_orbit_link_candidates(&env.dbx, &unit).await?,
    };
    Ok(Json(OrbitUnitLinkCandidatesRsp { units }))
}

#[post("/api/sigint/unit/orbit-search")]
pub async fn search_orbit_units(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<OrbitUnitSearchReq>,
) -> Result<Json<OrbitUnitLinkCandidatesRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_editor_access(&env.dbx, &login).await?;
    let units = manual_orbit_link_candidates(&env.dbx, &req.search).await?;
    Ok(Json(OrbitUnitLinkCandidatesRsp { units }))
}

#[post("/api/sigint/unit/orbit-import")]
pub async fn import_orbit_unit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ImportOrbitUnitReq>,
) -> Result<Json<CreateUnitWithAutoNetworkRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_editor_access(&env.dbx, &login).await?;
    let orbit_unit_id = parse_orbit_unit_id(&req.orbit_unit_id)?;
    Ok(Json(
        import_orbit_unit_for_login(&login, &env, orbit_unit_id).await?,
    ))
}

#[post("/api/sigint/unit/orbit-link")]
pub async fn link_orbit_unit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<LinkOrbitUnitReq>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_editor_access(&env.dbx, &login).await?;
    let req = req.into_inner();
    let orbit_unit_id = parse_orbit_unit_id(&req.orbit_unit_id)?;
    find_available_sigint_unit(&env.dbx, req.sigint_unit_id).await?;
    find_available_orbit_unit(&env.dbx, orbit_unit_id).await?;
    crate::orbit::link_sigint_unit_if_unlinked_with_lock(
        &env.dbx,
        req.sigint_unit_id,
        orbit_unit_id,
    )
    .await?;
    super::fanout_unit_changed(&env).await?;
    Ok(Json(()))
}

#[post("/api/sigint/unit/orbit-unlink")]
pub async fn unlink_orbit_unit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<LinkOrbitUnitReq>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_editor_access(&env.dbx, &login).await?;
    let req = req.into_inner();
    let orbit_unit_id = parse_orbit_unit_id(&req.orbit_unit_id)?;
    find_available_sigint_unit(&env.dbx, req.sigint_unit_id).await?;
    find_available_orbit_unit(&env.dbx, orbit_unit_id).await?;
    crate::orbit::unlink_sigint_unit_with_lock(
        &env.dbx,
        req.sigint_unit_id,
        orbit_unit_id,
    )
    .await?;
    super::fanout_unit_changed(&env).await?;
    Ok(Json(()))
}

async fn ensure_orbit_access(
    dbx: &DatabaseConnection,
    login: &Uuid,
) -> Result<(), AppError> {
    if can_view_orbit_data(dbx, login).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden("ORBIT data access denied".to_string()))
    }
}

async fn ensure_orbit_editor_access(
    dbx: &DatabaseConnection,
    login: &Uuid,
) -> Result<(), AppError> {
    ensure_orbit_access(dbx, login).await?;
    has_role(dbx, login, "UnitsEditor").await?;
    Ok(())
}

fn parse_orbit_unit_id(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BL {
        msg: "Invalid ORBIT unit ID".to_string(),
    })
}

pub(super) async fn import_orbit_unit_for_login(
    login: &Uuid,
    env: &Env,
    orbit_unit_id: Uuid,
) -> Result<CreateUnitWithAutoNetworkRsp, AppError> {
    let transaction =
        crate::orbit::acquire_import_lock(&env.dbx).await.c(h!())?;
    let orbit_unit =
        find_available_orbit_unit(&transaction, orbit_unit_id).await?;
    if orbit_unit_has_active_sigint_link(&transaction, orbit_unit_id).await? {
        return Err(AppError::BL {
            msg: "ORBIT unit is already linked to a SIGINT unit".to_string(),
        });
    }
    import_missing_orbit_ancestors(&transaction, login, &orbit_unit).await?;
    let unit_req =
        create_unit_req_from_orbit(&transaction, &orbit_unit, true).await?;
    let unit =
        super::insert_unit_with_changelog(&transaction, login, &unit_req)
            .await
            .c(h!())?;
    let network =
        create_imported_unit_network(&transaction, login, &unit_req, unit.id)
            .await?;
    orbit_unit_sigint_unit::ActiveModel {
        orbit_unit_id: Set(orbit_unit_id),
        sigint_unit_id: Set(unit.id),
        is_manual: Set(true),
        is_suppressed: Set(false),
    }
    .insert(&transaction)
    .await
    .c(h!())?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await?;
    super::reconcile_parent_unit_activity(
        &transaction,
        login,
        std::slice::from_ref(&unit),
    )
    .await?;
    transaction.commit().await.c(h!())?;

    super::render_created_unit_with_optional_network(login, env, unit, network)
        .await
}

async fn import_missing_orbit_ancestors<C>(
    dbx: &C,
    login: &Uuid,
    root: &orbit_unit::Model,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    for ancestor in orbit_ancestors(dbx, root).await? {
        if orbit_unit_has_active_sigint_link(dbx, ancestor.unit_id).await? {
            continue;
        }
        let unit_req =
            create_unit_req_from_orbit(dbx, &ancestor, false).await?;
        let unit = super::insert_unit_with_changelog(dbx, login, &unit_req)
            .await
            .c(h!())?;
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(ancestor.unit_id),
            sigint_unit_id: Set(unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn orbit_ancestors<C>(
    dbx: &C,
    root: &orbit_unit::Model,
) -> Result<Vec<orbit_unit::Model>, AppError>
where
    C: ConnectionTrait,
{
    let mut seen = HashSet::from([root.unit_id]);
    let mut pending = [
        root.generative_parent_unit_id,
        root.operational_parent_unit_id,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let mut ancestors = Vec::new();
    while let Some(unit_id) = pending.pop() {
        if !seen.insert(unit_id) {
            continue;
        }
        let ancestor = find_available_orbit_unit(dbx, unit_id).await?;
        pending.extend(
            [
                ancestor.generative_parent_unit_id,
                ancestor.operational_parent_unit_id,
            ]
            .into_iter()
            .flatten(),
        );
        ancestors.push(ancestor);
    }
    Ok(ancestors)
}

pub async fn oneoff_import_unlinked_orbit_units(
    mode: Mode,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let login = crate::users::system_login_id(&dbx).await.c(h!())?;
    let imported = import_unlinked_orbit_units(&dbx, &login).await?;
    println!("Imported {imported} unlinked ORBIT units.");
    Ok(())
}

pub(super) async fn import_unlinked_orbit_units(
    dbx: &DatabaseConnection,
    login: &Uuid,
) -> Result<usize, AppError> {
    let transaction = crate::orbit::acquire_import_lock(dbx).await.c(h!())?;
    let active_linked_orbit_unit_ids = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .select_only()
        .column(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .into_tuple::<Uuid>()
        .all(&transaction)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let linked_orbit_unit_ids = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .column(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .into_tuple::<Uuid>()
        .all(&transaction)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let orbit_units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .order_by_asc(orbit_unit::Column::UnitId)
        .all(&transaction)
        .await
        .c(h!())?;
    let orbit_unit_ids_to_activate =
        orbit_unit_and_ancestor_ids(&orbit_units, active_linked_orbit_unit_ids);
    let mut imported = 0;
    for orbit_unit in &orbit_units {
        if linked_orbit_unit_ids.contains(&orbit_unit.unit_id) {
            continue;
        }
        let unit_req = match create_unit_req_from_orbit(
            &transaction,
            orbit_unit,
            false,
        )
        .await
        {
            Ok(unit_req) => unit_req,
            Err(err @ (AppError::BL { .. } | AppError::NotFound)) => {
                let orbit_unit_id = orbit_unit.unit_id;
                warn!("Skipping unsupported ORBIT unit {orbit_unit_id}: {err}");
                continue;
            }
            Err(err) => return Err(err),
        };
        let unit =
            super::insert_unit_with_changelog(&transaction, login, &unit_req)
                .await
                .c(h!())?;
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit.unit_id),
            sigint_unit_id: Set(unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&transaction)
        .await
        .c(h!())?;
        imported += 1;
    }
    activate_sigint_units_linked_to_orbit_units(
        &transaction,
        login,
        &orbit_unit_ids_to_activate,
    )
    .await?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await?;
    transaction.commit().await.c(h!())?;
    Ok(imported)
}

fn orbit_unit_and_ancestor_ids(
    orbit_units: &[orbit_unit::Model],
    mut unit_ids: HashSet<Uuid>,
) -> HashSet<Uuid> {
    let parent_ids_by_unit_id = orbit_units
        .iter()
        .map(|unit| {
            (
                unit.unit_id,
                [
                    unit.generative_parent_unit_id,
                    unit.operational_parent_unit_id,
                ],
            )
        })
        .collect::<HashMap<_, _>>();
    let mut pending = unit_ids.iter().copied().collect::<Vec<_>>();
    while let Some(unit_id) = pending.pop() {
        let Some(parent_ids) = parent_ids_by_unit_id.get(&unit_id) else {
            continue;
        };
        for parent_id in parent_ids.iter().flatten() {
            if parent_ids_by_unit_id.contains_key(parent_id)
                && unit_ids.insert(*parent_id)
            {
                pending.push(*parent_id);
            }
        }
    }
    unit_ids
}

async fn activate_sigint_units_linked_to_orbit_units<C>(
    dbx: &C,
    login: &Uuid,
    orbit_unit_ids: &HashSet<Uuid>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if orbit_unit_ids.is_empty() {
        return Ok(());
    }
    let sigint_unit_ids = orbit_unit_sigint_unit::Entity::find()
        .select_only()
        .column(orbit_unit_sigint_unit::Column::SigintUnitId)
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(
            orbit_unit_sigint_unit::Column::OrbitUnitId
                .is_in(orbit_unit_ids.iter().copied()),
        )
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids))
        .all(dbx)
        .await
        .c(h!())?;
    for unit in units {
        if !unit.active {
            super::set_unit_activity(dbx, login, &unit, true).await?;
        }
    }
    Ok(())
}

async fn create_imported_unit_network<C>(
    transaction: &C,
    login: &Uuid,
    unit: &CreateUnitReq,
    unit_id: i64,
) -> Result<Option<sigint_network::Model>, AppError>
where
    C: ConnectionTrait,
{
    if !crate::system_settings::devices_section_enabled(transaction)
        .await
        .c(h!())?
    {
        return Ok(None);
    }
    let req = CreateUnitWithAutoNetworkReq {
        unit: unit.clone(),
        skip_network_creation: false,
        locations: Vec::new(),
        unit_mask: imported_unit_masks(unit)?,
    };
    Ok(Some(
        super::insert_auto_cyber_network(
            transaction,
            login,
            &req,
            unit_id,
            Vec::new(),
            req.unit_mask.clone(),
        )
        .await
        .c(h!())?,
    ))
}

fn imported_unit_masks(unit: &CreateUnitReq) -> Result<Vec<String>, AppError> {
    let parts = [
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.division.as_str(),
        unit.army.as_str(),
        unit.military_district.as_str(),
        unit.army_region.as_str(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>();
    let forward = parts.join(" ");
    let backward = parts.into_iter().rev().collect::<Vec<_>>().join(" ");
    crate::sigint::unit_tag::normalize_unit_mask(vec![forward, backward])
}

async fn create_unit_req_from_orbit<C>(
    dbx: &C,
    orbit_unit: &orbit_unit::Model,
    active: bool,
) -> Result<CreateUnitReq, AppError>
where
    C: ConnectionTrait,
{
    let mut hierarchy = std::array::from_fn(|_| String::new());
    fill_orbit_hierarchy_level(dbx, orbit_unit, &mut hierarchy).await?;
    fill_orbit_parent_chain(
        dbx,
        orbit_unit,
        OrbitParentKind::Operational,
        &mut hierarchy,
    )
    .await?;
    fill_orbit_parent_chain(
        dbx,
        orbit_unit,
        OrbitParentKind::Generative,
        &mut hierarchy,
    )
    .await?;
    if hierarchy.iter().all(String::is_empty) {
        return Err(AppError::BL {
            msg: "ORBIT unit has no supported hierarchy levels".to_string(),
        });
    }
    let [company, battalion, regiment, division, army, military_district, army_region] =
        hierarchy;
    Ok(CreateUnitReq {
        company,
        battalion,
        regiment,
        division,
        army,
        military_district,
        army_region,
        active,
        is_deduplicate_candidate: None,
        comment: String::new(),
        orbit_note: None,
    })
}

#[derive(Clone, Copy)]
enum OrbitParentKind {
    Generative,
    Operational,
}

impl OrbitParentKind {
    fn parent_id(self, unit: &orbit_unit::Model) -> Option<Uuid> {
        match self {
            Self::Generative => unit.generative_parent_unit_id,
            Self::Operational => unit.operational_parent_unit_id,
        }
    }
}

async fn fill_orbit_parent_chain<C>(
    dbx: &C,
    root: &orbit_unit::Model,
    parent_kind: OrbitParentKind,
    hierarchy: &mut [String; 7],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let mut seen = HashSet::from([root.unit_id]);
    let mut parent_id = parent_kind.parent_id(root);
    while let Some(unit_id) = parent_id {
        if !seen.insert(unit_id) {
            return Err(AppError::BL {
                msg: "ORBIT unit hierarchy contains a cycle".to_string(),
            });
        }
        let parent = find_available_orbit_unit(dbx, unit_id).await?;
        parent_id = parent_kind.parent_id(&parent);
        fill_orbit_hierarchy_level(dbx, &parent, hierarchy).await?;
    }
    Ok(())
}

async fn fill_orbit_hierarchy_level<C>(
    dbx: &C,
    unit: &orbit_unit::Model,
    hierarchy: &mut [String; 7],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let Some(echelon_id) = unit.unit_echelon_id else {
        return Ok(());
    };
    let Some(echelon) = orbit_unit_echelon::Entity::find_by_id(echelon_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let Some(name) = preferred_orbit_unit_name(unit) else {
        return Ok(());
    };
    let Some(index) = crate::orbit::echo_echelon(&echelon.key)
        .map(crate::orbit::EchoEchelon::index)
    else {
        return Ok(());
    };
    if hierarchy[index].is_empty() {
        hierarchy[index] = name;
    }
    Ok(())
}

fn preferred_orbit_unit_name(unit: &orbit_unit::Model) -> Option<String> {
    [
        unit.unit_name_short.as_deref(),
        unit.unit_name.as_deref(),
        unit.unit_name_original.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|name| !name.is_empty())
    .map(ToString::to_string)
}

pub async fn has_any_orbit_unit(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    Ok(orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn automatic_orbit_link_candidates(
    dbx: &DatabaseConnection,
    sigint_unit: &sigint_unit::Model,
) -> Result<Vec<OrbitUnitLinkCandidate>, AppError> {
    let candidates =
        crate::orbit::closest_orbit_matches_for_sigint_unit(dbx, sigint_unit)
            .await
            .c(h!())?;
    Ok(candidates.into_iter().map(render_match_candidate).collect())
}

async fn manual_orbit_link_candidates(
    dbx: &DatabaseConnection,
    search: &str,
) -> Result<Vec<OrbitUnitLinkCandidate>, AppError> {
    let words = orbit_search_words(search);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let units = manual_orbit_link_candidates_query(&words)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(units.into_iter().map(render_orbit_unit_candidate).collect())
}

fn manual_orbit_link_candidates_query(
    words: &[String],
) -> Select<orbit_unit::Entity> {
    let mut condition =
        Condition::all().add(orbit_unit::Column::Deleted.eq(false));
    for word in words {
        let pattern = format!("%{word}%");
        condition = condition.add(
            Condition::any()
                .add(
                    Expr::col(orbit_unit::Column::UnitName)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(orbit_unit::Column::GenerativeUnitNameFull)
                        .ilike(pattern.clone()),
                )
                .add(
                    Expr::col(orbit_unit::Column::OperationalUnitNameFull)
                        .ilike(pattern),
                ),
        );
    }
    orbit_unit::Entity::find()
        .filter(condition)
        .order_by_desc(orbit_full_word_match_score(words))
        .order_by_asc(orbit_unit::Column::GenerativeUnitNameFull)
        .order_by_asc(orbit_unit::Column::OperationalUnitNameFull)
        .order_by_asc(orbit_unit::Column::UnitId)
        .limit(ORBIT_LINK_CANDIDATE_LIMIT)
}

fn orbit_full_word_match_score(words: &[String]) -> SimpleExpr {
    let mut words = words.iter();
    let first_word = words
        .next()
        .expect("manual Orbit search words must not be empty");
    words.fold(orbit_full_word_match(first_word), |score, word| {
        score.add(orbit_full_word_match(word))
    })
}

fn orbit_full_word_match(word: &str) -> SimpleExpr {
    let full_word_match = Expr::cust_with_exprs(
        "concat(' ', regexp_replace(lower(concat_ws(' ', $1, $2, $3)), '[[:punct:][:space:]]+', ' ', 'g'), ' ') ilike $4",
        [
            Expr::col(orbit_unit::Column::UnitName).into_simple_expr(),
            Expr::col(orbit_unit::Column::GenerativeUnitNameFull)
                .into_simple_expr(),
            Expr::col(orbit_unit::Column::OperationalUnitNameFull)
                .into_simple_expr(),
            Expr::val(format!("% {word} %")).into_simple_expr(),
        ],
    );
    Expr::case(full_word_match, 1).finally(0).into()
}

fn orbit_search_words(search: &str) -> Vec<String> {
    search
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(ORBIT_LINK_SEARCH_WORD_LIMIT)
        .map(ToString::to_string)
        .collect()
}

async fn find_available_sigint_unit<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn find_available_orbit_unit<C>(
    dbx: &C,
    orbit_unit_id: Uuid,
) -> Result<orbit_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    orbit_unit::Entity::find_by_id(orbit_unit_id)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn orbit_unit_has_active_sigint_link<C>(
    dbx: &C,
    orbit_unit_id: Uuid,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

fn render_match_candidate(
    unit: crate::orbit::OrbitMatchCandidate,
) -> OrbitUnitLinkCandidate {
    OrbitUnitLinkCandidate {
        unit_id: unit.unit_id.to_string(),
        full_name: unit.unit_name.unwrap_or_default(),
        generative_unit_name_full: unit
            .generative_unit_name_full
            .unwrap_or_default(),
        operational_unit_name_full: unit
            .operational_unit_name_full
            .unwrap_or_default(),
    }
}

fn render_orbit_unit_candidate(
    unit: orbit_unit::Model,
) -> OrbitUnitLinkCandidate {
    OrbitUnitLinkCandidate {
        unit_id: unit.unit_id.to_string(),
        full_name: unit.unit_name.unwrap_or_default(),
        generative_unit_name_full: unit
            .generative_unit_name_full
            .unwrap_or_default(),
        operational_unit_name_full: unit
            .operational_unit_name_full
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_login, mk_organism, mk_sigint_unit,
    };
    use serial_test::serial;

    async fn create_login_with_roles(
        dbx: &DatabaseConnection,
        login_name: &str,
        roles: &[&str],
    ) -> login::Model {
        let organism = mk_organism(
            dbx,
            organism::ActiveModel {
                name: Set(format!("{login_name} organism")),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_login(
            dbx,
            login::ActiveModel {
                login: Set(login_name.to_string()),
                roles: Set(serde_json::to_value(roles).unwrap()),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    #[test]
    fn orbit_search_words_splits_text_and_limits_terms() {
        assert_eq!(
            orbit_search_words("  53-зрбр / 20 ЗВА, МВО; extra words ignored"),
            vec![
                "53", "зрбр", "20", "ЗВА", "МВО", "extra", "words", "ignored"
            ]
        );
    }

    #[tokio::test]
    #[serial]
    async fn manual_search_prioritizes_full_word_matches() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let full_word_match_id = Uuid::new_v4();
        let substring_match_id = Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit::ActiveModel {
                unit_id: Set(full_word_match_id),
                unit_name: Set(Some("55 мбр".to_string())),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(substring_match_id),
                unit_name: Set(Some("1557 омбр".to_string())),
                ..Default::default()
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();

        let candidates = manual_orbit_link_candidates(&env.dbx, "55 мбр")
            .await
            .unwrap();

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].unit_id, full_word_match_id.to_string());
        assert_eq!(candidates[1].unit_id, substring_match_id.to_string());
    }

    #[tokio::test]
    #[serial]
    async fn parent_units_include_unlinked_parents_and_skip_deleted_links() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let outer_parent_id = Uuid::new_v4();
        let inner_parent_id = Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit::ActiveModel {
                unit_id: Set(outer_parent_id),
                unit_name: Set(Some("Outer parent".to_string())),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(inner_parent_id),
                unit_name: Set(Some("Inner parent".to_string())),
                operational_parent_unit_id: Set(Some(outer_parent_id)),
                ..Default::default()
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();
        let linked_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let deleted_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                deleted: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many([
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(outer_parent_id),
                sigint_unit_id: Set(linked_unit.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(inner_parent_id),
                sigint_unit_id: Set(deleted_unit.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();

        let parents = orbit_parent_units(
            &env.dbx,
            Some(inner_parent_id),
            OrbitParentKind::Operational,
        )
        .await
        .unwrap();

        assert_eq!(
            parents,
            vec![
                OrbitParentUnit {
                    sigint_unit_id: None,
                    name: "Inner parent".to_string(),
                },
                OrbitParentUnit {
                    sigint_unit_id: Some(linked_unit.id),
                    name: "Outer parent".to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    #[serial]
    async fn rer_role_and_admin_can_view_orbit_data() {
        let env = cleanup().await.unwrap();
        let admin_login =
            create_login_with_roles(&env.dbx, "orbit-admin", &["Admin"]).await;
        let rer_login =
            create_login_with_roles(&env.dbx, "orbit-rer", &["Rer"]).await;
        let basic_login =
            create_login_with_roles(&env.dbx, "orbit-basic", &[]).await;

        assert!(can_view_orbit_data(&env.dbx, &admin_login.id)
            .await
            .unwrap());
        assert!(can_view_orbit_data(&env.dbx, &rer_login.id).await.unwrap());
        assert!(!can_view_orbit_data(&env.dbx, &basic_login.id)
            .await
            .unwrap());
    }
}
