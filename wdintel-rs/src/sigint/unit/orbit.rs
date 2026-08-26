use super::types::{
    CreateUnitReq, CreateUnitWithAutoNetworkReq, CreateUnitWithAutoNetworkRsp,
    ImportOrbitUnitReq, InconsistentUnit, LinkOrbitUnitReq,
    ListInconsistentUnitsRsp, ListUnitDuplicatesRsp, ListUnitsByIdRsp,
    OrbitChildUnit, OrbitDictionaryValue, OrbitParentUnit, OrbitUnitDetails,
    OrbitUnitLinkCandidate, OrbitUnitLinkCandidatesReq,
    OrbitUnitLinkCandidatesRsp, OrbitUnitSearchReq, UnitDetailsReq,
    UnitDuplicate, UnitOrbitChildrenRsp,
};
use crate::config::{
    SIGINT_UNIT_INCONSISTENCY_LOWER_ORBIT_ECHELON_REASON_UK,
    SIGINT_UNIT_INCONSISTENCY_MULTIPLE_ORBIT_LINKS_REASON_UK,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
#[cfg(test)]
use crate::types::warn;
use crate::types::{debug, Env, ShortContext};
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, OnConflict, SimpleExpr};
use sea_orm::*;
#[cfg(test)]
use std::collections::BTreeMap;
use std::collections::{BTreeSet, HashMap, HashSet};
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitOrbitLink {
    pub orbit_unit_id: String,
    pub generative_unit_name_full: String,
}

#[derive(FromQueryResult)]
struct UnitOrbitLinkRow {
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
    generative_unit_name_full: Option<String>,
}

pub async fn unit_orbit_links(
    dbx: &DatabaseConnection,
    sigint_unit_ids: &[i64],
) -> Result<HashMap<i64, Vec<UnitOrbitLink>>, AppError> {
    if sigint_unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut unit_links = HashMap::<i64, Vec<UnitOrbitLink>>::new();
    let sql = r#"
        select
            link.sigint_unit_id,
            link.orbit_unit_id,
            nullif(btrim(unit.generative_unit_name_full), '') as generative_unit_name_full
        from orbit_unit_sigint_unit link
        inner join orbit_unit unit on unit.unit_id = link.orbit_unit_id
        where link.is_suppressed = false
            and link.sigint_unit_id = any($1::bigint[])
            and unit.deleted = false
        order by link.sigint_unit_id, unit.generative_unit_name_full nulls last, link.orbit_unit_id
    "#;
    for link in
        UnitOrbitLinkRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [sigint_unit_ids.to_vec().into()],
        ))
        .all(dbx)
        .await
        .c(h!())?
    {
        unit_links.entry(link.sigint_unit_id).or_default().push(
            UnitOrbitLink {
                orbit_unit_id: link.orbit_unit_id.to_string(),
                generative_unit_name_full: link
                    .generative_unit_name_full
                    .unwrap_or_default(),
            },
        );
    }
    Ok(unit_links)
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

#[post("/api/admin/unit-duplicates")]
pub async fn list_unit_duplicates(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<ListUnitDuplicatesRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_access(&env.dbx, &login).await?;
    Ok(Json(ListUnitDuplicatesRsp {
        units: load_unit_duplicates(&env.dbx).await?,
    }))
}

#[post("/api/admin/unit-inconsistent")]
pub async fn list_inconsistent_units(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<ListInconsistentUnitsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    ensure_orbit_access(&env.dbx, &login).await.c(h!())?;
    Ok(Json(ListInconsistentUnitsRsp {
        units: load_inconsistent_units(&env.dbx).await.c(h!())?,
    }))
}

async fn load_inconsistent_units(
    dbx: &DatabaseConnection,
) -> Result<Vec<InconsistentUnit>, AppError> {
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::IsInconsistent.eq(true))
        .order_by_asc(sigint_unit::Column::Name)
        .order_by_asc(sigint_unit::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let unit_ids = units.iter().map(|unit| unit.id).collect::<Vec<_>>();
    let mut orbit_units_by_sigint_unit_id =
        linked_orbit_units_by_sigint_unit_ids(dbx, &unit_ids)
            .await
            .c(h!())?;
    let echelon_ids = orbit_units_by_sigint_unit_id
        .values()
        .flatten()
        .filter_map(|unit| unit.unit_echelon_id)
        .collect::<BTreeSet<_>>();
    let echelons = load_orbit_echelons(dbx, &echelon_ids).await.c(h!())?;
    let mut result = Vec::with_capacity(units.len());
    for unit in units {
        let orbit_units = orbit_units_by_sigint_unit_id
            .remove(&unit.id)
            .unwrap_or_default();
        let details = unit_inconsistency_details_from_links(
            &unit,
            &orbit_units,
            &echelons,
        );
        result.push(InconsistentUnit {
            sigint_unit_id: unit.id,
            name: unit.name,
            reasons: details.reasons,
            problematic_echelons: details.problematic_echelons,
        });
    }
    Ok(result)
}

async fn linked_orbit_units_by_sigint_unit_ids<C>(
    dbx: &C,
    sigint_unit_ids: &[i64],
) -> Result<HashMap<i64, Vec<orbit_unit::Model>>, AppError>
where
    C: ConnectionTrait,
{
    if sigint_unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let links = orbit_unit_sigint_unit::Model::find_by_statement(
        Statement::from_sql_and_values(
            dbx.get_database_backend(),
            r#"
                select link.*
                from orbit_unit_sigint_unit link
                where link.sigint_unit_id = any($1::bigint[])
                    and link.is_suppressed = false
            "#,
            [sigint_unit_ids.to_vec().into()],
        ),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id)
        .collect::<BTreeSet<_>>();
    if orbit_unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let orbit_units =
        orbit_unit::Model::find_by_statement(Statement::from_sql_and_values(
            dbx.get_database_backend(),
            r#"
                select unit.*
                from orbit_unit unit
                where unit.unit_id = any($1::uuid[])
                    and unit.deleted = false
            "#,
            [orbit_unit_ids.into_iter().collect::<Vec<_>>().into()],
        ))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect::<HashMap<_, _>>();
    let mut units_by_sigint_unit_id =
        HashMap::<i64, Vec<orbit_unit::Model>>::new();
    for link in links {
        let Some(orbit_unit) = orbit_units.get(&link.orbit_unit_id) else {
            continue;
        };
        units_by_sigint_unit_id
            .entry(link.sigint_unit_id)
            .or_default()
            .push(orbit_unit.clone());
    }
    Ok(units_by_sigint_unit_id)
}

async fn load_unit_duplicates(
    dbx: &DatabaseConnection,
) -> Result<Vec<UnitDuplicate>, AppError> {
    let orbit_unit_ids = duplicate_orbit_unit_ids(dbx).await?;
    if orbit_unit_ids.is_empty() {
        return Ok(Vec::new());
    }
    let orbit_units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::UnitId.is_in(orbit_unit_ids.clone()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect::<HashMap<_, _>>();
    let links = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(
            orbit_unit_sigint_unit::Column::OrbitUnitId.is_in(orbit_unit_ids),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let sigint_units = sigint_unit::Entity::find()
        .filter(
            sigint_unit::Column::Id
                .is_in(links.iter().map(|link| link.sigint_unit_id)),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<HashMap<_, _>>();
    render_unit_duplicates(links, orbit_units, sigint_units)
}

async fn duplicate_orbit_unit_ids(
    dbx: &DatabaseConnection,
) -> Result<Vec<Uuid>, AppError> {
    Ok(orbit_unit_sigint_unit::Entity::find()
        .select_only()
        .column(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .group_by(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .having(
            Expr::col(orbit_unit_sigint_unit::Column::SigintUnitId)
                .count_distinct()
                .gte(2),
        )
        .into_tuple::<Uuid>()
        .all(dbx)
        .await
        .c(h!())?)
}

fn render_unit_duplicates(
    links: Vec<orbit_unit_sigint_unit::Model>,
    orbit_units: HashMap<Uuid, orbit_unit::Model>,
    sigint_units: HashMap<i64, sigint_unit::Model>,
) -> Result<Vec<UnitDuplicate>, AppError> {
    let mut units = links
        .into_iter()
        .map(|link| {
            let orbit_unit = orbit_units.get(&link.orbit_unit_id).c(h!())?;
            let sigint_unit = sigint_units.get(&link.sigint_unit_id).c(h!())?;
            Ok(UnitDuplicate {
                sigint_unit: super::render_unit(sigint_unit)?,
                orbit_unit_id: orbit_unit.unit_id.to_string(),
                orbit_unit_full_name: orbit_candidate_full_name(
                    orbit_unit.unit_name.clone(),
                    orbit_unit.unit_number.clone(),
                ),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    units.sort_by(|left, right| {
        left.orbit_unit_full_name
            .cmp(&right.orbit_unit_full_name)
            .then_with(|| left.sigint_unit.name.cmp(&right.sigint_unit.name))
            .then_with(|| left.sigint_unit.id.cmp(&right.sigint_unit.id))
    });
    Ok(units)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnitInconsistencyDetails {
    reasons: Vec<String>,
    problematic_echelons: Vec<String>,
}

pub(crate) struct UnitOrbitReconcileOutcome {
    pub unit: sigint_unit::Model,
    #[cfg(test)]
    pub hierarchy_updated: bool,
    #[cfg(test)]
    pub orbit_link_count: usize,
}

pub(crate) async fn reconcile_sigint_unit_orbit<C>(
    dbx: &C,
    login: &Uuid,
    sigint_unit_id: i64,
    propagate_hierarchy: bool,
) -> Result<UnitOrbitReconcileOutcome, AppError>
where
    C: ConnectionTrait,
{
    reconcile_sigint_unit_orbit_inner(
        dbx,
        login,
        sigint_unit_id,
        propagate_hierarchy,
        None,
    )
    .await
}

#[cfg(test)]
async fn reconcile_sigint_unit_orbit_with_reviewed_change<C>(
    dbx: &C,
    login: &Uuid,
    change: &OrbitUnitHierarchyChange,
) -> Result<UnitOrbitReconcileOutcome, AppError>
where
    C: ConnectionTrait,
{
    reconcile_sigint_unit_orbit_inner(
        dbx,
        login,
        change.sigint_unit_id,
        false,
        Some(change),
    )
    .await
}

async fn reconcile_sigint_unit_orbit_inner<C>(
    dbx: &C,
    login: &Uuid,
    sigint_unit_id: i64,
    propagate_hierarchy: bool,
    reviewed_change: Option<&OrbitUnitHierarchyChange>,
) -> Result<UnitOrbitReconcileOutcome, AppError>
where
    C: ConnectionTrait,
{
    super::changelog::set_author(dbx, login).await.c(h!())?;
    let mut unit = sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let previous_unit = unit.clone();
    let orbit_units = linked_orbit_units(dbx, sigint_unit_id).await.c(h!())?;
    let hierarchy_updated = if let Some(change) = reviewed_change {
        apply_reviewed_orbit_hierarchy_change(&mut unit, change)
    } else {
        propagate_hierarchy
            && propagate_single_orbit_hierarchy(dbx, &orbit_units, &mut unit)
                .await
                .c(h!())?
    };
    let details =
        unit_inconsistency_details_for_links(dbx, &unit, &orbit_units)
            .await
            .c(h!())?;
    let is_inconsistent = !details.reasons.is_empty();
    let inconsistency_updated = unit.is_inconsistent != is_inconsistent;
    if !hierarchy_updated && !inconsistency_updated {
        return Ok(UnitOrbitReconcileOutcome {
            unit,
            #[cfg(test)]
            hierarchy_updated,
            #[cfg(test)]
            orbit_link_count: orbit_units.len(),
        });
    }

    let old_value = super::unit_json(dbx, unit.id).await.c(h!())?;
    let mut unit_act = unit.clone().into_active_model();
    if hierarchy_updated {
        set_active_hierarchy(&mut unit_act, &unit);
    }
    if inconsistency_updated {
        unit_act.is_inconsistent = Set(is_inconsistent);
    }
    let unit = unit_act.update(dbx).await.c(h!())?;
    if hierarchy_updated {
        super::unit_after_insert_update(dbx, unit.id)
            .await
            .c(h!())?;
    }
    let new_value = super::unit_json(dbx, unit.id).await.c(h!())?;
    super::insert_unit_update_changelog(
        dbx, login, unit.id, old_value, new_value,
    )
    .await
    .c(h!())?;
    if hierarchy_updated {
        super::reconcile_parent_unit_activity(
            dbx,
            login,
            &[previous_unit, unit.clone()],
        )
        .await
        .c(h!())?;
    }
    Ok(UnitOrbitReconcileOutcome {
        unit,
        #[cfg(test)]
        hierarchy_updated,
        #[cfg(test)]
        orbit_link_count: orbit_units.len(),
    })
}

fn apply_reviewed_orbit_hierarchy_change(
    unit: &mut sigint_unit::Model,
    change: &OrbitUnitHierarchyChange,
) -> bool {
    let mut updated = false;
    for attribute in &change.attributes {
        let current = match attribute.attribute {
            "name" => &mut unit.name,
            "other" => &mut unit.other,
            "team_or_crew" => &mut unit.team_or_crew,
            "section" => &mut unit.section,
            "squad" => &mut unit.squad,
            "platoon" => &mut unit.platoon,
            "company" => &mut unit.company,
            "battalion" => &mut unit.battalion,
            "regiment" => &mut unit.regiment,
            "brigade" => &mut unit.brigade,
            "division" => &mut unit.division,
            "corps" => &mut unit.corps,
            "army" => &mut unit.army,
            "military_district" => &mut unit.military_district,
            "army_region" => &mut unit.army_region,
            attribute => {
                unreachable!("unknown reviewed unit attribute {attribute}")
            }
        };
        if *current != attribute.proposed {
            current.clone_from(&attribute.proposed);
            updated = true;
        }
    }
    updated
}

async fn propagate_single_orbit_hierarchy<C>(
    dbx: &C,
    orbit_units: &[orbit_unit::Model],
    unit: &mut sigint_unit::Model,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let [orbit_unit] = orbit_units else {
        return Ok(false);
    };
    let orbit_hierarchy =
        match create_unit_req_from_orbit(dbx, orbit_unit, true).await {
            Ok(req) => create_unit_req_hierarchy(req),
            Err(AppError::BL { .. }) => return Ok(false),
            Err(err) => return Err(err),
        };
    let update_name = super::unit_name_is_derived(unit);
    let mut hierarchy = owned_sigint_unit_hierarchy(unit);
    let mut updated = false;
    let other_level = crate::orbit::EchoEchelon::Other.index();
    if hierarchy[other_level].trim().is_empty()
        && !orbit_hierarchy[other_level].trim().is_empty()
    {
        hierarchy[other_level] = orbit_hierarchy[other_level].clone();
        updated = true;
    }
    if let Some(lowest_level) = lowest_standard_hierarchy_level(&hierarchy) {
        for level in (lowest_level + 1)..hierarchy.len() {
            if hierarchy[level].trim().is_empty()
                && !orbit_hierarchy[level].trim().is_empty()
            {
                hierarchy[level] = orbit_hierarchy[level].clone();
                updated = true;
            }
        }
    }
    if updated {
        apply_owned_sigint_unit_hierarchy(unit, hierarchy, update_name);
    }
    Ok(updated)
}

fn lowest_standard_hierarchy_level(hierarchy: &[String; 14]) -> Option<usize> {
    hierarchy
        .iter()
        .enumerate()
        .skip(crate::orbit::EchoEchelon::Other.index() + 1)
        .find_map(|(level, value)| (!value.trim().is_empty()).then_some(level))
}

fn create_unit_req_hierarchy(req: CreateUnitReq) -> [String; 14] {
    [
        req.other,
        req.team_or_crew,
        req.section,
        req.squad,
        req.platoon,
        req.company,
        req.battalion,
        req.regiment,
        req.brigade,
        req.division,
        req.corps,
        req.army,
        req.military_district,
        req.army_region,
    ]
}

fn owned_sigint_unit_hierarchy(unit: &sigint_unit::Model) -> [String; 14] {
    super::unit_hierarchy(unit).map(ToString::to_string)
}

fn apply_owned_sigint_unit_hierarchy(
    unit: &mut sigint_unit::Model,
    hierarchy: [String; 14],
    update_name: bool,
) {
    let [other, team_or_crew, section, squad, platoon, company, battalion, regiment, brigade, division, corps, army, military_district, army_region] =
        hierarchy;
    unit.other = other;
    unit.team_or_crew = team_or_crew;
    unit.section = section;
    unit.squad = squad;
    unit.platoon = platoon;
    unit.company = company;
    unit.battalion = battalion;
    unit.regiment = regiment;
    unit.brigade = brigade;
    unit.division = division;
    unit.corps = corps;
    unit.army = army;
    unit.military_district = military_district;
    unit.army_region = army_region;
    if update_name {
        unit.name =
            super::unit_name_from_hierarchy(super::unit_hierarchy(unit));
    }
}

fn set_active_hierarchy(
    unit_act: &mut sigint_unit::ActiveModel,
    unit: &sigint_unit::Model,
) {
    unit_act.other = Set(unit.other.clone());
    unit_act.team_or_crew = Set(unit.team_or_crew.clone());
    unit_act.section = Set(unit.section.clone());
    unit_act.squad = Set(unit.squad.clone());
    unit_act.platoon = Set(unit.platoon.clone());
    unit_act.company = Set(unit.company.clone());
    unit_act.battalion = Set(unit.battalion.clone());
    unit_act.regiment = Set(unit.regiment.clone());
    unit_act.brigade = Set(unit.brigade.clone());
    unit_act.division = Set(unit.division.clone());
    unit_act.corps = Set(unit.corps.clone());
    unit_act.army = Set(unit.army.clone());
    unit_act.military_district = Set(unit.military_district.clone());
    unit_act.army_region = Set(unit.army_region.clone());
    unit_act.name = Set(unit.name.clone());
}

#[cfg(test)]
async fn unit_inconsistency_details<C>(
    dbx: &C,
    unit: &sigint_unit::Model,
) -> Result<UnitInconsistencyDetails, AppError>
where
    C: ConnectionTrait,
{
    let orbit_units = linked_orbit_units(dbx, unit.id).await.c(h!())?;
    Ok(
        unit_inconsistency_details_for_links(dbx, unit, &orbit_units)
            .await
            .c(h!())?,
    )
}

async fn unit_inconsistency_details_for_links<C>(
    dbx: &C,
    unit: &sigint_unit::Model,
    orbit_units: &[orbit_unit::Model],
) -> Result<UnitInconsistencyDetails, AppError>
where
    C: ConnectionTrait,
{
    let echelon_ids = orbit_units
        .iter()
        .filter_map(|unit| unit.unit_echelon_id)
        .collect::<BTreeSet<_>>();
    let echelons = load_orbit_echelons(dbx, &echelon_ids).await.c(h!())?;
    Ok(unit_inconsistency_details_from_links(
        unit,
        orbit_units,
        &echelons,
    ))
}

async fn load_orbit_echelons<C>(
    dbx: &C,
    echelon_ids: &BTreeSet<Uuid>,
) -> Result<HashMap<Uuid, orbit_unit_echelon::Model>, AppError>
where
    C: ConnectionTrait,
{
    if echelon_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(orbit_unit_echelon::Entity::find()
        .filter(
            orbit_unit_echelon::Column::Id.is_in(echelon_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|echelon| (echelon.id, echelon))
        .collect())
}

fn unit_inconsistency_details_from_links(
    unit: &sigint_unit::Model,
    orbit_units: &[orbit_unit::Model],
    echelons: &HashMap<Uuid, orbit_unit_echelon::Model>,
) -> UnitInconsistencyDetails {
    let mut reasons = Vec::new();
    if orbit_units.len() > 1 {
        reasons.push(
            SIGINT_UNIT_INCONSISTENCY_MULTIPLE_ORBIT_LINKS_REASON_UK
                .to_string(),
        );
    }
    let hierarchy = owned_sigint_unit_hierarchy(unit);
    let Some(sigint_level) = lowest_standard_hierarchy_level(&hierarchy) else {
        return UnitInconsistencyDetails {
            reasons,
            problematic_echelons: Vec::new(),
        };
    };
    let mut problematic_echelons = BTreeSet::new();
    for orbit_unit in orbit_units {
        let Some(echelon) = orbit_unit
            .unit_echelon_id
            .and_then(|echelon_id| echelons.get(&echelon_id))
        else {
            continue;
        };
        let Some(level) = crate::orbit::echo_echelon(&echelon.key) else {
            continue;
        };
        if level == crate::orbit::EchoEchelon::Other {
            continue;
        }
        if level.index() < sigint_level {
            problematic_echelons.insert((level.index(), echelon.name.clone()));
        }
    }
    if !problematic_echelons.is_empty() {
        reasons.push(
            SIGINT_UNIT_INCONSISTENCY_LOWER_ORBIT_ECHELON_REASON_UK.to_string(),
        );
    }
    UnitInconsistencyDetails {
        reasons,
        problematic_echelons: problematic_echelons
            .into_iter()
            .map(|(_, name)| name)
            .collect(),
    }
}

async fn linked_orbit_units<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> Result<Vec<orbit_unit::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit::Entity::find()
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
        .c(h!())?)
}

pub async fn unit_orbit_details(
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
) -> Result<Vec<OrbitUnitDetails>, AppError> {
    let units = linked_orbit_units(dbx, sigint_unit_id).await.c(h!())?;
    let mut details = Vec::with_capacity(units.len());
    for unit in units {
        details.push(render_orbit_unit_details(dbx, unit).await.c(h!())?);
    }
    Ok(details)
}

#[derive(FromQueryResult)]
struct OrbitChildUnitRow {
    orbit_unit_id: Uuid,
    sigint_unit_id: i64,
    name: String,
    active: bool,
    is_generative: bool,
    is_operational: bool,
}

#[post("/api/sigint/unit/orbit-children")]
pub async fn unit_orbit_children(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UnitDetailsReq>,
) -> Result<Json<UnitOrbitChildrenRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    if !can_view_orbit_data(&env.dbx, &login).await? {
        return Err(AppError::Forbidden(
            "ORBIT data access denied".to_string(),
        ));
    }
    let unit = super::find_unit(&env.dbx, req.unit_id).await?;
    if unit.deleted {
        return Err(AppError::NotFound);
    }
    Ok(Json(load_unit_orbit_children(&env.dbx, unit.id).await?))
}

async fn load_unit_orbit_children(
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
) -> Result<UnitOrbitChildrenRsp, AppError> {
    let sql = r#"
        select
            child.unit_id as orbit_unit_id,
            child_link.sigint_unit_id,
            child_sigint.name,
            child_sigint.active,
            (child.generative_parent_unit_id = parent.unit_id) is true
                as is_generative,
            (child.operational_parent_unit_id = parent.unit_id) is true
                as is_operational
        from orbit_unit parent
        inner join orbit_unit_sigint_unit parent_link
            on parent_link.orbit_unit_id = parent.unit_id
            and parent_link.is_suppressed = false
        inner join orbit_unit child
            on child.generative_parent_unit_id = parent.unit_id
            or child.operational_parent_unit_id = parent.unit_id
        inner join orbit_unit_sigint_unit child_link
            on child_link.orbit_unit_id = child.unit_id
            and child_link.is_suppressed = false
        inner join sigint_unit child_sigint
            on child_sigint.id = child_link.sigint_unit_id
            and child_sigint.deleted = false
        where parent_link.sigint_unit_id = $1
            and parent.deleted = false
            and child.deleted = false
        order by child_sigint.name, child_link.sigint_unit_id, child.unit_id
    "#;
    let rows =
        OrbitChildUnitRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [sigint_unit_id.into()],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(render_unit_orbit_children(rows))
}

fn render_unit_orbit_children(
    rows: Vec<OrbitChildUnitRow>,
) -> UnitOrbitChildrenRsp {
    let mut units = Vec::<OrbitChildUnit>::new();
    let mut unit_indexes = HashMap::<i64, usize>::new();
    for row in rows {
        if let Some(index) = unit_indexes.get(&row.sigint_unit_id).copied() {
            let unit = &mut units[index];
            let orbit_unit_id = row.orbit_unit_id.to_string();
            if !unit
                .orbit_unit_ids
                .iter()
                .any(|unit_id| unit_id == &orbit_unit_id)
            {
                unit.orbit_unit_ids.push(orbit_unit_id);
            }
            unit.is_generative |= row.is_generative;
            unit.is_operational |= row.is_operational;
        } else {
            unit_indexes.insert(row.sigint_unit_id, units.len());
            units.push(OrbitChildUnit {
                sigint_unit_id: row.sigint_unit_id,
                name: row.name,
                active: row.active,
                orbit_unit_ids: vec![row.orbit_unit_id.to_string()],
                is_generative: row.is_generative,
                is_operational: row.is_operational,
            });
        }
    }
    UnitOrbitChildrenRsp { units }
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

#[post("/api/sigint/unit/create-duplicate-candidates")]
pub async fn create_unit_duplicate_candidates(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<CreateUnitReq>,
) -> Result<Json<ListUnitsByIdRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    if !can_view_orbit_data(&env.dbx, &login).await? {
        return Ok(Json(ListUnitsByIdRsp { units: Vec::new() }));
    }
    let units =
        create_unit_duplicate_candidates_for_req(&env.dbx, &req).await?;
    Ok(Json(ListUnitsByIdRsp { units }))
}

async fn create_unit_duplicate_candidates_for_req(
    dbx: &DatabaseConnection,
    req: &CreateUnitReq,
) -> Result<Vec<super::types::Unit>, AppError> {
    let units =
        create_unit_duplicate_candidate_models_for_req(dbx, req).await?;
    let unit_ids = units.iter().map(|unit| unit.id).collect::<Vec<_>>();
    let orbit_links = unit_orbit_links(dbx, &unit_ids).await?;
    units
        .into_iter()
        .map(|unit| {
            let mut unit = super::render_unit(&unit)?;
            let unit_id = unit.id;
            super::apply_unit_orbit_links(
                &mut unit,
                orbit_links.get(&unit_id).map(Vec::as_slice),
            );
            Ok(unit)
        })
        .collect()
}

pub(super) async fn create_unit_duplicate_candidate_ids_for_req<C>(
    dbx: &C,
    req: &CreateUnitReq,
) -> Result<BTreeSet<i64>, AppError>
where
    C: ConnectionTrait,
{
    Ok(create_unit_duplicate_candidate_models_for_req(dbx, req)
        .await?
        .into_iter()
        .map(|unit| unit.id)
        .collect())
}

async fn create_unit_duplicate_candidate_models_for_req<C>(
    dbx: &C,
    req: &CreateUnitReq,
) -> Result<Vec<sigint_unit::Model>, AppError>
where
    C: ConnectionTrait,
{
    if !req.active {
        return Ok(Vec::new());
    }
    let sigint_unit = sigint_unit_for_orbit_matching(req);
    let orbit_unit_ids = crate::orbit::matching_orbit_unit_ids_for_sigint_unit(
        dbx,
        &sigint_unit,
    )
    .await
    .c(h!())?;
    if orbit_unit_ids.is_empty() {
        return Ok(Vec::new());
    }
    let units = sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::OrbitUnitSigintUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(
            orbit_unit_sigint_unit::Column::OrbitUnitId
                .is_in(orbit_unit_ids.iter().copied()),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Name)
        .order_by_asc(sigint_unit::Column::Id)
        .distinct()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(units)
}

fn sigint_unit_for_orbit_matching(req: &CreateUnitReq) -> sigint_unit::Model {
    sigint_unit::Model {
        id: i64::MAX,
        other: req.other.clone(),
        team_or_crew: req.team_or_crew.clone(),
        section: req.section.clone(),
        squad: req.squad.clone(),
        platoon: req.platoon.clone(),
        company: req.company.clone(),
        battalion: req.battalion.clone(),
        regiment: req.regiment.clone(),
        brigade: req.brigade.clone(),
        division: req.division.clone(),
        corps: req.corps.clone(),
        army: req.army.clone(),
        military_district: req.military_district.clone(),
        army_region: req.army_region.clone(),
        active: req.active,
        deleted: false,
        created_at: chrono::Utc::now().naive_utc(),
        created_by_login_id: Uuid::nil(),
        name: super::unit_name_req(req),
        comment: req.comment.clone(),
        search_tsv: None,
        sigint_origin_id: None,
        original_id: None,
        is_deduplicate_candidate: req.is_deduplicate_candidate,
        orbit_note: req.orbit_note.clone(),
        is_inconsistent: false,
        updated_at: chrono::Utc::now().naive_utc(),
    }
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
    link_orbit_unit_for_login(
        &login,
        &env.dbx,
        req.sigint_unit_id,
        orbit_unit_id,
    )
    .await?;
    super::fanout_unit_changed(&env).await?;
    Ok(Json(()))
}

pub(super) async fn link_orbit_unit_for_login(
    login: &Uuid,
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError> {
    let transaction = crate::orbit::acquire_import_lock(dbx).await.c(h!())?;
    link_orbit_unit_in_transaction(
        &transaction,
        login,
        sigint_unit_id,
        orbit_unit_id,
    )
    .await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn link_orbit_unit_in_transaction<C>(
    dbx: &C,
    login: &Uuid,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    super::changelog::set_author(dbx, login).await.c(h!())?;
    let sigint_unit = find_available_sigint_unit(dbx, sigint_unit_id).await?;
    let orbit_unit = find_available_orbit_unit(dbx, orbit_unit_id).await?;
    crate::orbit::link_sigint_unit_if_unlinked(
        dbx,
        sigint_unit_id,
        orbit_unit_id,
    )
    .await?;
    import_missing_orbit_ancestors(dbx, login, &orbit_unit).await?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(dbx).await?;
    let sigint_unit =
        reconcile_sigint_unit_orbit(dbx, login, sigint_unit.id, true)
            .await
            .c(h!())?
            .unit;
    if sigint_unit.active {
        super::reconcile_parent_unit_activity(
            dbx,
            login,
            std::slice::from_ref(&sigint_unit),
        )
        .await?;
    }
    Ok(sigint_unit)
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
        &login,
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
    super::changelog::set_author(&transaction, login)
        .await
        .c(h!())?;
    let orbit_unit =
        find_available_orbit_unit(&transaction, orbit_unit_id).await?;
    if orbit_unit_has_active_sigint_link(&transaction, orbit_unit_id).await? {
        return Err(AppError::BL {
            msg: "ORBIT unit is already linked to a SIGINT unit".to_string(),
        });
    }
    let unit_req =
        create_unit_req_from_orbit(&transaction, &orbit_unit, true).await?;
    let unit =
        super::insert_unit_with_changelog(&transaction, login, &unit_req)
            .await
            .c(h!())?;
    let network =
        create_imported_unit_network(&transaction, login, &unit_req, unit.id)
            .await?;
    let unit = link_orbit_unit_in_transaction(
        &transaction,
        login,
        unit.id,
        orbit_unit_id,
    )
    .await?;
    transaction.commit().await.c(h!())?;

    let network_id = network.as_ref().map(|network| network.id);
    super::render_created_unit_with_optional_network(
        login, env, unit, network_id, network,
    )
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
    let mut import_state = OrbitAncestorImportState::default();
    import_missing_orbit_ancestors_with_state(
        dbx,
        login,
        root,
        &mut import_state,
    )
    .await
}

async fn import_missing_orbit_ancestors_with_state<C>(
    dbx: &C,
    login: &Uuid,
    root: &orbit_unit::Model,
    import_state: &mut OrbitAncestorImportState,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    for ancestor in orbit_ancestors(dbx, root).await? {
        if orbit_unit_has_active_sigint_link(dbx, ancestor.unit_id).await? {
            activate_sigint_units_linked_to_orbit_units(
                dbx,
                login,
                &HashSet::from([ancestor.unit_id]),
            )
            .await?;
            continue;
        }
        let unit_req = match create_unit_req_from_orbit(dbx, &ancestor, true)
            .await
        {
            Ok(unit_req) => unit_req,
            Err(err @ AppError::BL { .. }) => {
                let orbit_unit_id = ancestor.unit_id;
                if import_state.should_log_unsupported_ancestor(orbit_unit_id) {
                    debug!(
                        "Skipping unsupported ORBIT ancestor {orbit_unit_id}: {err}"
                    );
                }
                continue;
            }
            Err(err) => return Err(err),
        };
        let unit = match find_existing_sigint_unit(dbx, &unit_req).await? {
            Some(unit) => unit,
            None => super::insert_unit_with_changelog(dbx, login, &unit_req)
                .await
                .c(h!())?,
        };
        if !unit.active {
            super::set_unit_activity(dbx, login, &unit, true).await?;
        }
        link_orbit_ancestor(dbx, ancestor.unit_id, unit.id).await?;
        reconcile_sigint_unit_orbit(dbx, login, unit.id, true)
            .await
            .c(h!())?;
    }
    Ok(())
}

#[derive(Default)]
struct OrbitAncestorImportState {
    reported_unsupported_orbit_ancestor_ids: HashSet<Uuid>,
}

impl OrbitAncestorImportState {
    fn should_log_unsupported_ancestor(&mut self, orbit_unit_id: Uuid) -> bool {
        self.reported_unsupported_orbit_ancestor_ids
            .insert(orbit_unit_id)
    }
}

async fn find_existing_sigint_unit<C>(
    dbx: &C,
    unit: &CreateUnitReq,
) -> Result<Option<sigint_unit::Model>, AppError>
where
    C: ConnectionTrait,
{
    let hierarchy = [
        (sigint_unit::Column::Other, unit.other.as_str()),
        (sigint_unit::Column::TeamOrCrew, unit.team_or_crew.as_str()),
        (sigint_unit::Column::Section, unit.section.as_str()),
        (sigint_unit::Column::Squad, unit.squad.as_str()),
        (sigint_unit::Column::Platoon, unit.platoon.as_str()),
        (sigint_unit::Column::Company, unit.company.as_str()),
        (sigint_unit::Column::Battalion, unit.battalion.as_str()),
        (sigint_unit::Column::Regiment, unit.regiment.as_str()),
        (sigint_unit::Column::Brigade, unit.brigade.as_str()),
        (sigint_unit::Column::Division, unit.division.as_str()),
        (sigint_unit::Column::Corps, unit.corps.as_str()),
        (sigint_unit::Column::Army, unit.army.as_str()),
        (
            sigint_unit::Column::MilitaryDistrict,
            unit.military_district.as_str(),
        ),
        (sigint_unit::Column::ArmyRegion, unit.army_region.as_str()),
    ];
    let Some(unit_level) = hierarchy
        .iter()
        .position(|(_, value)| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let mut query = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    for (level, (column, value)) in hierarchy.into_iter().enumerate() {
        let value_eq = normalized_hierarchy_value_eq(column, value);
        query = if level > unit_level {
            query.filter(
                Condition::any()
                    .add(value_eq)
                    .add(normalized_hierarchy_value_eq(column, "")),
            )
        } else {
            query.filter(value_eq)
        };
    }
    Ok(query
        .order_by_asc(sigint_unit::Column::Id)
        .one(dbx)
        .await
        .c(h!())?)
}

fn normalized_hierarchy_value_eq(
    column: sigint_unit::Column,
    value: &str,
) -> SimpleExpr {
    Expr::cust_with_exprs(
        "lower(btrim($1)) = $2",
        [
            Expr::col(column).into_simple_expr(),
            Expr::val(value.trim().to_lowercase()).into_simple_expr(),
        ],
    )
}

async fn link_orbit_ancestor<C>(
    dbx: &C,
    orbit_unit_id: Uuid,
    sigint_unit_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    orbit_unit_sigint_unit::Entity::insert(
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(sigint_unit_id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        },
    )
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
    .exec_without_returning(dbx)
    .await
    .c(h!())?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn materialize_automatic_link_parent_chains<C>(
    dbx: &C,
    login: &Uuid,
    orbit_unit_ids: &BTreeSet<Uuid>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if orbit_unit_ids.is_empty() {
        return Ok(());
    }
    let links = orbit_unit_sigint_unit::Entity::find()
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(false))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(
            orbit_unit_sigint_unit::Column::OrbitUnitId
                .is_in(orbit_unit_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let linked_orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id)
        .collect::<HashSet<_>>();
    let linked_orbit_units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::UnitId.is_in(linked_orbit_unit_ids))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let mut import_state = OrbitAncestorImportState::default();
    for orbit_unit in linked_orbit_units {
        import_missing_orbit_ancestors_with_state(
            dbx,
            login,
            &orbit_unit,
            &mut import_state,
        )
        .await?;
    }
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(dbx).await?;
    let linked_sigint_unit_ids = links
        .into_iter()
        .map(|link| link.sigint_unit_id)
        .collect::<HashSet<_>>();
    let linked_sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(linked_sigint_unit_ids))
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    super::reconcile_parent_unit_activity(dbx, login, &linked_sigint_units)
        .await?;
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
    let mut pending = root
        .generative_parent_unit_id
        .into_iter()
        .collect::<Vec<_>>();
    let mut ancestors = Vec::new();
    while let Some(unit_id) = pending.pop() {
        if !seen.insert(unit_id) {
            continue;
        }
        let ancestor = find_available_orbit_unit(dbx, unit_id).await.c(h!())?;
        pending.extend(ancestor.generative_parent_unit_id);
        ancestors.push(ancestor);
    }
    Ok(ancestors)
}

#[cfg(test)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OrbitUnitReconcileStats {
    pub scanned: usize,
    pub hierarchy_updated: usize,
    pub inconsistent: usize,
    pub multiple_links_skipped: usize,
    pub merged: usize,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrbitUnitAttributeChange {
    pub attribute: &'static str,
    pub current: String,
    pub proposed: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrbitUnitHierarchyChange {
    pub sigint_unit_id: i64,
    pub sigint_unit_name: String,
    pub attributes: Vec<OrbitUnitAttributeChange>,
}

#[cfg(test)]
pub(crate) async fn proposed_orbit_hierarchy_changes<C>(
    dbx: &C,
) -> Result<Vec<OrbitUnitHierarchyChange>, AppError>
where
    C: ConnectionTrait,
{
    let mut changes = Vec::new();
    for sigint_unit_id in linked_sigint_unit_ids(dbx).await.c(h!())? {
        if let Some(change) =
            proposed_orbit_hierarchy_change(dbx, sigint_unit_id)
                .await
                .c(h!())?
        {
            changes.push(change);
        }
    }
    Ok(changes)
}

#[cfg(test)]
async fn proposed_orbit_hierarchy_change<C>(
    dbx: &C,
    sigint_unit_id: i64,
) -> Result<Option<OrbitUnitHierarchyChange>, AppError>
where
    C: ConnectionTrait,
{
    let Some(unit) = sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let orbit_units = linked_orbit_units(dbx, sigint_unit_id).await.c(h!())?;
    let mut proposed = unit.clone();
    if !propagate_single_orbit_hierarchy(dbx, &orbit_units, &mut proposed)
        .await
        .c(h!())?
    {
        return Ok(None);
    }
    Ok(Some(OrbitUnitHierarchyChange {
        sigint_unit_id,
        sigint_unit_name: unit.name.clone(),
        attributes: changed_unit_attributes(&unit, &proposed),
    }))
}

#[cfg(test)]
fn changed_unit_attributes(
    current: &sigint_unit::Model,
    proposed: &sigint_unit::Model,
) -> Vec<OrbitUnitAttributeChange> {
    named_unit_attributes(current)
        .into_iter()
        .zip(named_unit_attributes(proposed))
        .filter(|((_, current), (_, proposed))| current != proposed)
        .map(
            |((attribute, current), (_, proposed))| OrbitUnitAttributeChange {
                attribute,
                current: current.to_string(),
                proposed: proposed.to_string(),
            },
        )
        .collect()
}

#[cfg(test)]
fn named_unit_attributes(
    unit: &sigint_unit::Model,
) -> [(&'static str, &str); 15] {
    [
        ("name", unit.name.as_str()),
        ("other", unit.other.as_str()),
        ("team_or_crew", unit.team_or_crew.as_str()),
        ("section", unit.section.as_str()),
        ("squad", unit.squad.as_str()),
        ("platoon", unit.platoon.as_str()),
        ("company", unit.company.as_str()),
        ("battalion", unit.battalion.as_str()),
        ("regiment", unit.regiment.as_str()),
        ("brigade", unit.brigade.as_str()),
        ("division", unit.division.as_str()),
        ("corps", unit.corps.as_str()),
        ("army", unit.army.as_str()),
        ("military_district", unit.military_district.as_str()),
        ("army_region", unit.army_region.as_str()),
    ]
}

#[cfg(test)]
pub(crate) async fn reconcile_selected_orbit_hierarchy_changes(
    dbx: &DatabaseConnection,
    login: &Uuid,
    accepted_changes: &[OrbitUnitHierarchyChange],
) -> Result<OrbitUnitReconcileStats, AppError> {
    reconcile_orbit_linked_units(dbx, login, Some(accepted_changes)).await
}

#[cfg(test)]
async fn reconcile_orbit_linked_units(
    dbx: &DatabaseConnection,
    login: &Uuid,
    accepted_changes: Option<&[OrbitUnitHierarchyChange]>,
) -> Result<OrbitUnitReconcileStats, AppError> {
    let accepted_changes = accepted_changes.map(|changes| {
        changes
            .iter()
            .map(|change| (change.sigint_unit_id, change))
            .collect::<BTreeMap<_, _>>()
    });
    let sigint_unit_ids = sigint_unit_ids_requiring_reconciliation(dbx)
        .await
        .c(h!())?;
    let mut stats = OrbitUnitReconcileStats {
        scanned: sigint_unit_ids.len(),
        ..Default::default()
    };
    for sigint_unit_id in sigint_unit_ids {
        let outcome = match &accepted_changes {
            None => {
                reconcile_sigint_unit_orbit_committed(
                    dbx,
                    login,
                    sigint_unit_id,
                    true,
                )
                .await
            }
            Some(changes) => match changes.get(&sigint_unit_id) {
                Some(change) => {
                    reconcile_reviewed_sigint_unit_orbit_committed(
                        dbx, login, change,
                    )
                    .await
                }
                None => {
                    reconcile_sigint_unit_orbit_committed(
                        dbx,
                        login,
                        sigint_unit_id,
                        false,
                    )
                    .await
                }
            },
        }
        .c(h!())?;
        stats.hierarchy_updated += usize::from(outcome.hierarchy_updated);
        stats.multiple_links_skipped +=
            usize::from(outcome.orbit_link_count > 1);
    }
    reconcile_sigint_unit_deduplicate_candidates_committed(dbx)
        .await
        .c(h!())?;
    stats.merged = merge_identical_duplicate_candidates(dbx, login)
        .await
        .c(h!())?;
    reconcile_sigint_unit_deduplicate_candidates_committed(dbx)
        .await
        .c(h!())?;
    for sigint_unit_id in sigint_unit_ids_requiring_reconciliation(dbx)
        .await
        .c(h!())?
    {
        reconcile_sigint_unit_orbit_committed(
            dbx,
            login,
            sigint_unit_id,
            false,
        )
        .await
        .c(h!())?;
    }
    stats.inconsistent = usize::try_from(
        sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::IsInconsistent.eq(true))
            .count(dbx)
            .await
            .c(h!())?,
    )
    .c(h!())?;
    Ok(stats)
}

#[cfg(test)]
async fn reconcile_sigint_unit_orbit_committed(
    dbx: &DatabaseConnection,
    login: &Uuid,
    sigint_unit_id: i64,
    update_hierarchy: bool,
) -> Result<UnitOrbitReconcileOutcome, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let outcome = reconcile_sigint_unit_orbit(
        &transaction,
        login,
        sigint_unit_id,
        update_hierarchy,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(outcome)
}

#[cfg(test)]
async fn reconcile_reviewed_sigint_unit_orbit_committed(
    dbx: &DatabaseConnection,
    login: &Uuid,
    change: &OrbitUnitHierarchyChange,
) -> Result<UnitOrbitReconcileOutcome, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    let outcome = reconcile_sigint_unit_orbit_with_reviewed_change(
        &transaction,
        login,
        change,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(outcome)
}

#[cfg(test)]
async fn reconcile_sigint_unit_deduplicate_candidates_committed(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

#[cfg(test)]
async fn sigint_unit_ids_requiring_reconciliation<C>(
    dbx: &C,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    let mut sigint_unit_ids = linked_sigint_unit_ids(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<BTreeSet<_>>();
    sigint_unit_ids.extend(
        sigint_unit::Entity::find()
            .select_only()
            .column(sigint_unit::Column::Id)
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::IsInconsistent.eq(true))
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?,
    );
    Ok(sigint_unit_ids.into_iter().collect())
}

#[cfg(test)]
async fn linked_sigint_unit_ids<C>(dbx: &C) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .select_only()
        .column(orbit_unit_sigint_unit::Column::SigintUnitId)
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .group_by(orbit_unit_sigint_unit::Column::SigintUnitId)
        .order_by_asc(orbit_unit_sigint_unit::Column::SigintUnitId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

#[cfg(test)]
async fn merge_identical_duplicate_candidates(
    dbx: &DatabaseConnection,
    login: &Uuid,
) -> Result<usize, AppError> {
    let links = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::IsDeduplicateCandidate.eq(true))
        .all(dbx)
        .await
        .c(h!())?;
    let unit_ids = links
        .iter()
        .map(|link| link.sigint_unit_id)
        .collect::<BTreeSet<_>>();
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(unit_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    let components = identical_duplicate_components(&links, &units);
    let mut merged = 0;
    for component in components {
        let transaction = dbx.begin().await.c(h!())?;
        let mut candidates = component
            .into_iter()
            .filter_map(|unit_id| units.get(&unit_id).cloned())
            .collect::<Vec<_>>();
        candidates.sort_by_key(|unit| (!unit.active, unit.id));
        let Some(survivor) = candidates.first() else {
            continue;
        };
        let survivor_id = survivor.id;
        for duplicate in candidates.into_iter().skip(1) {
            super::merge_units_in_transaction(
                *login,
                &transaction,
                duplicate.id,
                survivor_id,
            )
            .await
            .c(h!())?;
            merged += 1;
        }
        transaction.commit().await.c(h!())?;
    }
    Ok(merged)
}

#[cfg(test)]
fn identical_duplicate_components(
    links: &[orbit_unit_sigint_unit::Model],
    units: &BTreeMap<i64, sigint_unit::Model>,
) -> Vec<BTreeSet<i64>> {
    let mut ids_by_orbit_and_name =
        BTreeMap::<(Uuid, String), BTreeSet<i64>>::new();
    for link in links {
        let Some(unit) = units.get(&link.sigint_unit_id) else {
            continue;
        };
        if unit.name.is_empty() {
            continue;
        }
        ids_by_orbit_and_name
            .entry((link.orbit_unit_id, unit.name.clone()))
            .or_default()
            .insert(unit.id);
    }
    let mut adjacent = BTreeMap::<i64, BTreeSet<i64>>::new();
    for unit_ids in ids_by_orbit_and_name.into_values() {
        if unit_ids.len() < 2 {
            continue;
        }
        for unit_id in &unit_ids {
            adjacent
                .entry(*unit_id)
                .or_default()
                .extend(unit_ids.iter().copied().filter(|id| id != unit_id));
        }
    }
    let mut components = Vec::new();
    let mut seen = BTreeSet::new();
    for root in adjacent.keys().copied() {
        if seen.contains(&root) {
            continue;
        }
        let mut component = BTreeSet::new();
        let mut pending = vec![root];
        while let Some(unit_id) = pending.pop() {
            if !seen.insert(unit_id) {
                continue;
            }
            component.insert(unit_id);
            pending
                .extend(adjacent.get(&unit_id).into_iter().flatten().copied());
        }
        if component.len() > 1 {
            components.push(component);
        }
    }
    components
}

#[cfg(test)]
pub(crate) async fn import_unlinked_orbit_units<C>(
    dbx: &C,
    login: &Uuid,
) -> Result<usize, AppError>
where
    C: ConnectionTrait,
{
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
        .all(dbx)
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
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let orbit_units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .order_by_asc(orbit_unit::Column::UnitId)
        .all(dbx)
        .await
        .c(h!())?;
    let orbit_unit_ids_to_activate =
        orbit_unit_and_ancestor_ids(&orbit_units, active_linked_orbit_unit_ids);
    let mut imported = 0;
    let mut skipped = 0;
    let mut first_skipped = None;
    for orbit_unit in &orbit_units {
        if linked_orbit_unit_ids.contains(&orbit_unit.unit_id) {
            continue;
        }
        let unit_req =
            match create_unit_req_from_orbit(dbx, orbit_unit, false).await {
                Ok(unit_req) => unit_req,
                Err(err @ (AppError::BL { .. } | AppError::NotFound)) => {
                    skipped += 1;
                    first_skipped.get_or_insert_with(|| {
                        (orbit_unit.unit_id, err.to_string())
                    });
                    continue;
                }
                Err(err) => return Err(err),
            };
        let unit = super::insert_unit_with_changelog(dbx, login, &unit_req)
            .await
            .c(h!())?;
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit.unit_id),
            sigint_unit_id: Set(unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(dbx)
        .await
        .c(h!())?;
        reconcile_sigint_unit_orbit(dbx, login, unit.id, true)
            .await
            .c(h!())?;
        imported += 1;
    }
    if let Some((orbit_unit_id, err)) = first_skipped {
        warn!(
            "Skipped {skipped} unsupported ORBIT units; first was {orbit_unit_id}: {err}"
        );
    }
    activate_sigint_units_linked_to_orbit_units(
        dbx,
        login,
        &orbit_unit_ids_to_activate,
    )
    .await
    .c(h!())?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(dbx)
        .await
        .c(h!())?;
    Ok(imported)
}

#[cfg(test)]
fn orbit_unit_and_ancestor_ids(
    orbit_units: &[orbit_unit::Model],
    mut unit_ids: HashSet<Uuid>,
) -> HashSet<Uuid> {
    let parent_ids_by_unit_id = orbit_units
        .iter()
        .map(|unit| (unit.unit_id, unit.generative_parent_unit_id))
        .collect::<HashMap<_, _>>();
    let mut pending = unit_ids.iter().copied().collect::<Vec<_>>();
    while let Some(unit_id) = pending.pop() {
        let Some(Some(parent_id)) = parent_ids_by_unit_id.get(&unit_id) else {
            continue;
        };
        if parent_ids_by_unit_id.contains_key(parent_id)
            && unit_ids.insert(*parent_id)
        {
            pending.push(*parent_id);
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
        unit.other.as_str(),
        unit.team_or_crew.as_str(),
        unit.section.as_str(),
        unit.squad.as_str(),
        unit.platoon.as_str(),
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.brigade.as_str(),
        unit.division.as_str(),
        unit.corps.as_str(),
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
    if !fill_orbit_hierarchy_level(dbx, orbit_unit, &mut hierarchy).await? {
        return Err(AppError::BL {
            msg: "ORBIT unit has no supported hierarchy level or name"
                .to_string(),
        });
    }
    fill_generative_orbit_parent_chain(dbx, orbit_unit, &mut hierarchy)
        .await
        .c(h!())?;
    if hierarchy.iter().all(String::is_empty) {
        return Err(AppError::BL {
            msg: "ORBIT unit has no supported hierarchy levels".to_string(),
        });
    }
    let [other, team_or_crew, section, squad, platoon, company, battalion, regiment, brigade, division, corps, army, military_district, army_region] =
        hierarchy;
    Ok(CreateUnitReq {
        name: None,
        other,
        team_or_crew,
        section,
        squad,
        platoon,
        company,
        battalion,
        regiment,
        brigade,
        division,
        corps,
        army,
        military_district,
        army_region,
        active,
        is_deduplicate_candidate: None,
        comment: String::new(),
        orbit_note: None,
        duplicate_unit_ids: Vec::new(),
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

async fn fill_generative_orbit_parent_chain<C>(
    dbx: &C,
    root: &orbit_unit::Model,
    hierarchy: &mut [String; 14],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let mut seen = HashSet::from([root.unit_id]);
    let mut parent_id = root.generative_parent_unit_id;
    while let Some(unit_id) = parent_id {
        if !seen.insert(unit_id) {
            return Err(AppError::BL {
                msg: "ORBIT unit hierarchy contains a cycle".to_string(),
            });
        }
        let parent = find_available_orbit_unit(dbx, unit_id).await.c(h!())?;
        parent_id = parent.generative_parent_unit_id;
        fill_orbit_hierarchy_level(dbx, &parent, hierarchy)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn fill_orbit_hierarchy_level<C>(
    dbx: &C,
    unit: &orbit_unit::Model,
    hierarchy: &mut [String; 14],
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let Some(echelon_id) = unit.unit_echelon_id else {
        return Ok(false);
    };
    let Some(echelon) = orbit_unit_echelon::Entity::find_by_id(echelon_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(false);
    };
    let Some(name) = preferred_orbit_unit_name(unit) else {
        return Ok(false);
    };
    let Some(index) = crate::orbit::echo_echelon(&echelon.key)
        .map(crate::orbit::EchoEchelon::index)
    else {
        return Ok(false);
    };
    if hierarchy[index].is_empty() {
        hierarchy[index] = name;
        return Ok(true);
    }
    Ok(false)
}

fn preferred_orbit_unit_name(unit: &orbit_unit::Model) -> Option<String> {
    [
        unit.unit_name_short.as_deref(),
        unit.unit_name.as_deref(),
        unit.unit_name_original.as_deref(),
        unit.unit_number.as_deref(),
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

pub(crate) async fn manual_orbit_link_candidates(
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
                        .ilike(pattern.clone()),
                )
                .add(Expr::col(orbit_unit::Column::UnitNumber).ilike(pattern)),
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
        "concat(' ', regexp_replace(lower(concat_ws(' ', $1, $2, $3, $4)), '[[:punct:][:space:]]+', ' ', 'g'), ' ') ilike $5",
        [
            Expr::col(orbit_unit::Column::UnitName).into_simple_expr(),
            Expr::col(orbit_unit::Column::GenerativeUnitNameFull)
                .into_simple_expr(),
            Expr::col(orbit_unit::Column::OperationalUnitNameFull)
                .into_simple_expr(),
            Expr::col(orbit_unit::Column::UnitNumber).into_simple_expr(),
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
    let full_name = orbit_candidate_full_name(unit.unit_name, unit.unit_number);
    OrbitUnitLinkCandidate {
        unit_id: unit.unit_id.to_string(),
        full_name,
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
    let full_name = orbit_candidate_full_name(unit.unit_name, unit.unit_number);
    OrbitUnitLinkCandidate {
        unit_id: unit.unit_id.to_string(),
        full_name,
        generative_unit_name_full: unit
            .generative_unit_name_full
            .unwrap_or_default(),
        operational_unit_name_full: unit
            .operational_unit_name_full
            .unwrap_or_default(),
    }
}

fn orbit_candidate_full_name(
    unit_name: Option<String>,
    unit_number: Option<String>,
) -> String {
    [unit_name, unit_number]
        .into_iter()
        .flatten()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
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

    async fn orbit_echelon(
        dbx: &DatabaseConnection,
        key: &str,
    ) -> orbit_unit_echelon::Model {
        if let Some(echelon) = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq(key))
            .one(dbx)
            .await
            .unwrap()
        {
            return echelon;
        }
        orbit_unit_echelon::ActiveModel {
            id: Set(Uuid::new_v4()),
            key: Set(key.to_string()),
            name: Set(format!("Test {key}")),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_orbit_unit(
        dbx: &DatabaseConnection,
        name: &str,
        echelon_id: Option<Uuid>,
        generative_parent_unit_id: Option<Uuid>,
    ) -> orbit_unit::Model {
        orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name: Set(Some(name.to_string())),
            unit_name_short: Set(Some(name.to_string())),
            unit_echelon_id: Set(echelon_id),
            generative_parent_unit_id: Set(generative_parent_unit_id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn link_orbit_unit(
        dbx: &DatabaseConnection,
        orbit_unit_id: Uuid,
        sigint_unit_id: i64,
    ) {
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(sigint_unit_id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    #[test]
    fn ancestor_import_state_reports_each_unsupported_ancestor_once() {
        let mut import_state = OrbitAncestorImportState::default();
        let first_unit_id = Uuid::from_u128(1);
        let second_unit_id = Uuid::from_u128(2);

        assert!(import_state.should_log_unsupported_ancestor(first_unit_id));
        assert!(!import_state.should_log_unsupported_ancestor(first_unit_id));
        assert!(import_state.should_log_unsupported_ancestor(second_unit_id));
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
    async fn existing_ancestor_lookup_distinguishes_extended_echelons() {
        // Regression: https://github.com/echoua/echo/issues/3113
        let env = cleanup().await.unwrap();
        for brigade in ["1 бригада", "2 бригада"] {
            mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    name: Set(format!("{brigade} 20 дивізія")),
                    brigade: Set(brigade.to_string()),
                    division: Set("20 дивізія".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let unit_req = CreateUnitReq {
            name: None,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            battalion: String::new(),
            regiment: String::new(),
            brigade: "2 бригада".to_string(),
            division: "20 дивізія".to_string(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            active: true,
            is_deduplicate_candidate: None,
            comment: String::new(),
            orbit_note: None,
            duplicate_unit_ids: Vec::new(),
        };

        let found = find_existing_sigint_unit(&env.dbx, &unit_req)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(found.brigade, "2 бригада");
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
    async fn manual_search_finds_and_names_number_only_units() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let unit_id = Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(unit_id),
            unit_number: Set(Some("5101".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let candidates = manual_orbit_link_candidates(&env.dbx, "5101")
            .await
            .unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].unit_id, unit_id.to_string());
        assert_eq!(candidates[0].full_name, "5101");
    }

    #[test]
    fn automatic_candidate_uses_number_when_name_is_blank() {
        let unit_id = Uuid::new_v4();
        let candidate =
            render_match_candidate(crate::orbit::OrbitMatchCandidate {
                unit_id,
                unit_name: Some(" ".to_string()),
                unit_number: Some("5101".to_string()),
                generative_unit_name_full: None,
                operational_unit_name_full: None,
            });

        assert_eq!(candidate.unit_id, unit_id.to_string());
        assert_eq!(candidate.full_name, "5101");
    }

    #[tokio::test]
    #[serial]
    async fn unit_duplicates_list_contains_only_shared_active_orbit_links() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let duplicate_orbit_unit_id = Uuid::new_v4();
        let single_orbit_unit_id = Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit::ActiveModel {
                unit_id: Set(duplicate_orbit_unit_id),
                unit_name: Set(Some("Shared Orbit unit".to_string())),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(single_orbit_unit_id),
                unit_name: Set(Some("Single Orbit unit".to_string())),
                ..Default::default()
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();
        let first = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("First SIGINT unit".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Second SIGINT unit".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let single = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Single SIGINT unit".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many([
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(duplicate_orbit_unit_id),
                sigint_unit_id: Set(first.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(duplicate_orbit_unit_id),
                sigint_unit_id: Set(second.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(duplicate_orbit_unit_id),
                sigint_unit_id: Set(single.id),
                is_manual: Set(true),
                is_suppressed: Set(true),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(single_orbit_unit_id),
                sigint_unit_id: Set(single.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();

        let units = load_unit_duplicates(&env.dbx).await.unwrap();

        assert_eq!(units.len(), 2);
        assert_eq!(units[0].sigint_unit.id, first.id);
        assert_eq!(units[1].sigint_unit.id, second.id);
        assert!(units
            .iter()
            .all(|unit| unit.orbit_unit_id
                == duplicate_orbit_unit_id.to_string()));
        assert!(units
            .iter()
            .all(|unit| unit.orbit_unit_full_name == "Shared Orbit unit"));
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
    async fn unit_orbit_links_accepts_more_than_postgres_bind_limit() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit_id = Uuid::new_v4();
        orbit_unit::Entity::insert(orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            generative_unit_name_full: Set(Some("106 пдд / МВО".to_string())),
            ..Default::default()
        })
        .exec(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert(
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(orbit_unit_id),
                sigint_unit_id: Set(sigint_unit.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        )
        .exec(&env.dbx)
        .await
        .unwrap();
        let mut unit_ids = vec![-1_i64; 69_999];
        unit_ids.push(sigint_unit.id);

        assert_eq!(
            unit_orbit_links(&env.dbx, &unit_ids).await.unwrap(),
            HashMap::from([(
                sigint_unit.id,
                vec![UnitOrbitLink {
                    orbit_unit_id: orbit_unit_id.to_string(),
                    generative_unit_name_full: "106 пдд / МВО".to_string(),
                }]
            )])
        );
        let linked_orbit_units =
            linked_orbit_units_by_sigint_unit_ids(&env.dbx, &unit_ids)
                .await
                .unwrap();
        assert_eq!(
            linked_orbit_units[&sigint_unit.id][0].unit_id,
            orbit_unit_id
        );
    }

    #[tokio::test]
    #[serial]
    async fn orbit_children_returns_linked_units_with_relationships() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let parent_sigint = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let generative_sigint = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("SIGINT generative".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let operational_sigint = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("SIGINT operational".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let parent_id = Uuid::new_v4();
        let generative_child_id = Uuid::new_v4();
        let operational_child_id = Uuid::new_v4();
        let unlinked_child_id = Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit::ActiveModel {
                unit_id: Set(parent_id),
                unit_name: Set(Some("Parent".to_string())),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(generative_child_id),
                unit_name: Set(Some("Generative child".to_string())),
                generative_parent_unit_id: Set(Some(parent_id)),
                operational_parent_unit_id: Set(Some(parent_id)),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(operational_child_id),
                unit_name: Set(Some("Operational child".to_string())),
                operational_parent_unit_id: Set(Some(parent_id)),
                ..Default::default()
            },
            orbit_unit::ActiveModel {
                unit_id: Set(unlinked_child_id),
                unit_name: Set(Some("Unlinked child".to_string())),
                generative_parent_unit_id: Set(Some(parent_id)),
                ..Default::default()
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert_many([
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(parent_id),
                sigint_unit_id: Set(parent_sigint.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(generative_child_id),
                sigint_unit_id: Set(generative_sigint.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(operational_child_id),
                sigint_unit_id: Set(operational_sigint.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            },
        ])
        .exec(&env.dbx)
        .await
        .unwrap();

        let children = load_unit_orbit_children(&env.dbx, parent_sigint.id)
            .await
            .unwrap();

        assert_eq!(
            children.units,
            vec![
                OrbitChildUnit {
                    sigint_unit_id: generative_sigint.id,
                    name: "SIGINT generative".to_string(),
                    active: true,
                    orbit_unit_ids: vec![generative_child_id.to_string()],
                    is_generative: true,
                    is_operational: true,
                },
                OrbitChildUnit {
                    sigint_unit_id: operational_sigint.id,
                    name: "SIGINT operational".to_string(),
                    active: false,
                    orbit_unit_ids: vec![operational_child_id.to_string()],
                    is_generative: false,
                    is_operational: true,
                },
            ]
        );
    }

    #[tokio::test]
    #[serial]
    async fn materializing_generative_parents_activates_an_inactive_linked_unit(
    ) {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-parent-activation", &[])
                .await;
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let parent_id = Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(parent_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let root = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            generative_parent_unit_id: Set(Some(parent_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(parent_id),
            sigint_unit_id: Set(sigint_unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        import_missing_orbit_ancestors(&env.dbx, &login.id, &root)
            .await
            .unwrap();

        let sigint_unit = sigint_unit::Entity::find_by_id(sigint_unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(sigint_unit.active);
    }

    #[tokio::test]
    #[serial]
    async fn reconciliation_propagates_other_and_higher_echelons() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-propagation", &[]).await;
        let other = orbit_echelon(&env.dbx, "other").await;
        let brigade = orbit_echelon(&env.dbx, "brigade").await;
        let platoon = orbit_echelon(&env.dbx, "platoon").await;
        let orbit_brigade = insert_orbit_unit(
            &env.dbx,
            "ORBIT brigade",
            Some(brigade.id),
            None,
        )
        .await;
        let orbit_platoon = insert_orbit_unit(
            &env.dbx,
            "ORBIT platoon",
            Some(platoon.id),
            Some(orbit_brigade.unit_id),
        )
        .await;
        let orbit_other = insert_orbit_unit(
            &env.dbx,
            "ORBIT other",
            Some(other.id),
            Some(orbit_platoon.unit_id),
        )
        .await;
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("SIGINT unit".to_string()),
                company: Set("Existing company".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let sigint_parent = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("ORBIT brigade".to_string()),
                brigade: Set("ORBIT brigade".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_orbit_unit(&env.dbx, orbit_other.unit_id, sigint_unit.id).await;

        let outcome = reconcile_sigint_unit_orbit(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            true,
        )
        .await
        .unwrap();

        assert!(outcome.hierarchy_updated);
        assert_eq!(outcome.unit.name, "SIGINT unit");
        assert_eq!(outcome.unit.other, "ORBIT other");
        assert!(outcome.unit.platoon.is_empty());
        assert_eq!(outcome.unit.company, "Existing company");
        assert_eq!(outcome.unit.brigade, "ORBIT brigade");
        assert!(!outcome.unit.is_inconsistent);
        assert!(
            sigint_unit::Entity::find_by_id(sigint_parent.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
    }

    #[tokio::test]
    #[serial]
    async fn reviewed_reconciliation_applies_only_displayed_changes() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login = create_login_with_roles(
            &env.dbx,
            "orbit-generative-propagation",
            &[],
        )
        .await;
        let company = orbit_echelon(&env.dbx, "company").await;
        let brigade = orbit_echelon(&env.dbx, "brigade").await;
        let division = orbit_echelon(&env.dbx, "division").await;
        let generative_brigade = insert_orbit_unit(
            &env.dbx,
            "Generative brigade",
            Some(brigade.id),
            None,
        )
        .await;
        let operational_division = insert_orbit_unit(
            &env.dbx,
            "Operational division",
            Some(division.id),
            None,
        )
        .await;
        let root = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name_short: Set(Some("ORBIT company".to_string())),
            unit_echelon_id: Set(Some(company.id)),
            generative_parent_unit_id: Set(Some(generative_brigade.unit_id)),
            operational_parent_unit_id: Set(Some(operational_division.unit_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                company: Set("Existing company".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_orbit_unit(&env.dbx, root.unit_id, sigint_unit.id).await;

        let changes = proposed_orbit_hierarchy_changes(&env.dbx).await.unwrap();
        let change = changes
            .iter()
            .find(|change| change.sigint_unit_id == sigint_unit.id)
            .unwrap();
        assert!(change.attributes.iter().any(|attribute| {
            attribute.attribute == "brigade"
                && attribute.proposed == "Generative brigade"
        }));
        assert!(!change
            .attributes
            .iter()
            .any(|attribute| attribute.attribute == "division"));

        let stats = reconcile_selected_orbit_hierarchy_changes(
            &env.dbx,
            &login.id,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(stats.hierarchy_updated, 0);
        let unchanged = sigint_unit::Entity::find_by_id(sigint_unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(unchanged.brigade.is_empty());

        let mut edited = unchanged.into_active_model();
        edited.platoon = Set("Edited platoon".to_string());
        edited.company = Set(String::new());
        edited.update(&env.dbx).await.unwrap();

        let stats = reconcile_selected_orbit_hierarchy_changes(
            &env.dbx,
            &login.id,
            std::slice::from_ref(change),
        )
        .await
        .unwrap();
        assert_eq!(stats.hierarchy_updated, 1);
        let unit = sigint_unit::Entity::find_by_id(sigint_unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(unit.platoon, "Edited platoon");
        assert!(unit.company.is_empty());
        assert_eq!(unit.brigade, "Generative brigade");
        assert!(unit.division.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn reconciliation_does_not_treat_other_as_the_lowest_echelon() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-existing-other", &[])
                .await;
        let other = orbit_echelon(&env.dbx, "other").await;
        let platoon = orbit_echelon(&env.dbx, "platoon").await;
        let brigade = orbit_echelon(&env.dbx, "brigade").await;
        let orbit_brigade = insert_orbit_unit(
            &env.dbx,
            "ORBIT brigade",
            Some(brigade.id),
            None,
        )
        .await;
        let orbit_platoon = insert_orbit_unit(
            &env.dbx,
            "ORBIT platoon",
            Some(platoon.id),
            Some(orbit_brigade.unit_id),
        )
        .await;
        let orbit_other = insert_orbit_unit(
            &env.dbx,
            "ORBIT other",
            Some(other.id),
            Some(orbit_platoon.unit_id),
        )
        .await;
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                other: Set("Existing other".to_string()),
                company: Set("Existing company".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_orbit_unit(&env.dbx, orbit_other.unit_id, sigint_unit.id).await;

        let outcome = reconcile_sigint_unit_orbit(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            true,
        )
        .await
        .unwrap();

        assert_eq!(outcome.unit.other, "Existing other");
        assert!(outcome.unit.platoon.is_empty());
        assert_eq!(outcome.unit.company, "Existing company");
        assert_eq!(outcome.unit.brigade, "ORBIT brigade");
        assert!(!outcome.unit.is_inconsistent);
    }

    #[tokio::test]
    #[serial]
    async fn reconciliation_marks_and_clears_lower_orbit_echelon() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-inconsistency", &[]).await;
        let company = orbit_echelon(&env.dbx, "company").await;
        let orbit_company = insert_orbit_unit(
            &env.dbx,
            "ORBIT company",
            Some(company.id),
            None,
        )
        .await;
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                other: Set("Existing other".to_string()),
                battalion: Set("SIGINT battalion".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_orbit_unit(&env.dbx, orbit_company.unit_id, sigint_unit.id).await;

        let outcome = reconcile_sigint_unit_orbit(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            true,
        )
        .await
        .unwrap();
        assert!(outcome.unit.is_inconsistent);
        let details = unit_inconsistency_details(&env.dbx, &outcome.unit)
            .await
            .unwrap();
        assert_eq!(
            details.reasons,
            vec![SIGINT_UNIT_INCONSISTENCY_LOWER_ORBIT_ECHELON_REASON_UK]
        );
        assert_eq!(details.problematic_echelons, vec![company.name]);
        assert_eq!(
            load_inconsistent_units(&env.dbx).await.unwrap(),
            vec![InconsistentUnit {
                sigint_unit_id: outcome.unit.id,
                name: outcome.unit.name.clone(),
                reasons: details.reasons,
                problematic_echelons: details.problematic_echelons,
            }]
        );

        let mut sigint_unit = outcome.unit.into_active_model();
        sigint_unit.company = Set("Corrected company".to_string());
        let sigint_unit = sigint_unit.update(&env.dbx).await.unwrap();
        let outcome = reconcile_sigint_unit_orbit(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            false,
        )
        .await
        .unwrap();
        assert!(!outcome.unit.is_inconsistent);
        assert!(load_inconsistent_units(&env.dbx).await.unwrap().is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn multiple_orbit_links_are_inconsistent_and_all_are_returned() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-multiple-links", &[])
                .await;
        let brigade = orbit_echelon(&env.dbx, "brigade").await;
        let first = insert_orbit_unit(
            &env.dbx,
            "First ORBIT unit",
            Some(brigade.id),
            None,
        )
        .await;
        let second = insert_orbit_unit(
            &env.dbx,
            "Second ORBIT unit",
            Some(brigade.id),
            None,
        )
        .await;
        let sigint_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set("Existing regiment".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_orbit_unit(&env.dbx, first.unit_id, sigint_unit.id).await;
        link_orbit_unit(&env.dbx, second.unit_id, sigint_unit.id).await;

        let outcome = reconcile_sigint_unit_orbit(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            true,
        )
        .await
        .unwrap();
        assert_eq!(outcome.orbit_link_count, 2);
        assert!(outcome.unit.is_inconsistent);
        assert!(outcome.unit.brigade.is_empty());
        let details = unit_inconsistency_details(&env.dbx, &outcome.unit)
            .await
            .unwrap();
        assert_eq!(
            details.reasons,
            vec![SIGINT_UNIT_INCONSISTENCY_MULTIPLE_ORBIT_LINKS_REASON_UK]
        );
        assert_eq!(
            unit_orbit_details(&env.dbx, sigint_unit.id)
                .await
                .unwrap()
                .len(),
            2
        );

        crate::orbit::unlink_sigint_unit_with_lock(
            &env.dbx,
            &login.id,
            sigint_unit.id,
            first.unit_id,
        )
        .await
        .unwrap();
        let sigint_unit = sigint_unit::Entity::find_by_id(sigint_unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!sigint_unit.is_inconsistent);
        assert_eq!(sigint_unit.brigade, "Second ORBIT unit");
        assert_eq!(
            unit_orbit_details(&env.dbx, sigint_unit.id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn batch_merges_only_exact_names_sharing_an_orbit_unit() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login =
            create_login_with_roles(&env.dbx, "orbit-batch-merge", &[]).await;
        let orbit_unit =
            insert_orbit_unit(&env.dbx, "Shared ORBIT", None, None).await;
        let inactive_oldest = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Exact name".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let active_newer = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Exact name".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let different_name = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("exact name".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let stale_inconsistent = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                is_inconsistent: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for sigint_unit_id in
            [inactive_oldest.id, active_newer.id, different_name.id]
        {
            link_orbit_unit(&env.dbx, orbit_unit.unit_id, sigint_unit_id).await;
        }

        let stats = reconcile_orbit_linked_units(&env.dbx, &login.id, None)
            .await
            .unwrap();

        assert_eq!(stats.merged, 1);
        let inactive_oldest =
            sigint_unit::Entity::find_by_id(inactive_oldest.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let active_newer = sigint_unit::Entity::find_by_id(active_newer.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let different_name = sigint_unit::Entity::find_by_id(different_name.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let stale_inconsistent =
            sigint_unit::Entity::find_by_id(stale_inconsistent.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(inactive_oldest.deleted);
        assert!(!active_newer.deleted);
        assert!(!different_name.deleted);
        assert!(!stale_inconsistent.is_inconsistent);
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
