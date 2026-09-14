use self::types::*;
use crate::config::{
    SIGINT_UNIT_AUTO_CYBER_NETWORK_NAME, SIGINT_UNIT_LIST_DEFAULT_LIMIT,
    SIGINT_UNIT_LIST_MAX_LIMIT, SIGINT_UNIT_MERGE_ADVISORY_LOCK_NAMESPACE,
    SIGINT_UNIT_MERGE_ADVISORY_LOCK_POLL_MS,
    SIGINT_UNIT_NAME_ARMY_BLACKLIST_TERMS, SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX,
    SIGINT_UNIT_NAME_CORPS_BLACKLIST_TERMS,
    SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX,
    SIGINT_UNIT_NAME_FIRST_INCLUDED_ECHELON_INDEX,
};
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
use std::collections::{BTreeSet, HashMap};

pub mod attachment;
pub mod changelog;
pub mod labels;
mod merge_task;
pub(crate) use merge_task::guard_capacity as unit_merge_guard_capacity;
pub mod orbit;
pub mod types;

pub(crate) async fn recover_abandoned_merge_tasks(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    Ok(merge_task::recover_abandoned(dbx).await.c(h!())?)
}

pub fn unit_name(unit: &Unit) -> String {
    let unit_name = unit_name_from_hierarchy([
        &unit.other,
        &unit.team_or_crew,
        &unit.section,
        &unit.squad,
        &unit.platoon,
        &unit.company,
        &unit.battalion,
        &unit.regiment,
        &unit.brigade,
        &unit.division,
        &unit.corps,
        &unit.army,
        &unit.military_district,
        &unit.army_region,
    ]);
    if unit_name.is_empty() {
        unit.name.trim().to_string()
    } else {
        unit_name
    }
}

fn unit_name_is_derived(unit: &sigint_unit::Model) -> bool {
    unit.name.trim().is_empty() || unit.name == generated_unit_name(unit)
}

pub(crate) fn generated_unit_name(unit: &sigint_unit::Model) -> String {
    unit_name_from_hierarchy(unit_hierarchy(unit))
}

pub fn unit_name_req(req: &CreateUnitReq) -> String {
    if let Some(name) = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    required_unit_name_from_hierarchy(unit_req_hierarchy(req))
}

pub(crate) fn generated_unit_name_req(req: &CreateUnitReq) -> String {
    unit_name_from_hierarchy(unit_req_hierarchy(req))
}

fn unit_req_hierarchy(req: &CreateUnitReq) -> [&str; 14] {
    [
        &req.other,
        &req.team_or_crew,
        &req.section,
        &req.squad,
        &req.platoon,
        &req.company,
        &req.battalion,
        &req.regiment,
        &req.brigade,
        &req.division,
        &req.corps,
        &req.army,
        &req.military_district,
        &req.army_region,
    ]
}

fn unit_name_from_hierarchy(hierarchy: [&str; 14]) -> String {
    if !hierarchy_has_name_echelon_below_corps(&hierarchy) {
        return String::new();
    }
    hierarchy
        .into_iter()
        .enumerate()
        .skip(SIGINT_UNIT_NAME_FIRST_INCLUDED_ECHELON_INDEX)
        .take(
            SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX
                - SIGINT_UNIT_NAME_FIRST_INCLUDED_ECHELON_INDEX
                + 1,
        )
        .filter(|(echelon, part)| {
            !part.is_empty() && !unit_name_part_is_blacklisted(*echelon, part)
        })
        .map(|(_, part)| part)
        .collect::<Vec<_>>()
        .join(" ")
}

fn hierarchy_has_name_echelon_below_corps(hierarchy: &[&str; 14]) -> bool {
    hierarchy[SIGINT_UNIT_NAME_FIRST_INCLUDED_ECHELON_INDEX
        ..SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX]
        .iter()
        .any(|part| !part.is_empty())
}

pub(crate) fn unit_has_name_echelon_below_corps(
    unit: &sigint_unit::Model,
) -> bool {
    hierarchy_has_name_echelon_below_corps(&unit_hierarchy(unit))
}

fn required_unit_name_from_hierarchy(hierarchy: [&str; 14]) -> String {
    let generated_name = unit_name_from_hierarchy(hierarchy);
    if !generated_name.is_empty() {
        return generated_name;
    }
    hierarchy
        .into_iter()
        .enumerate()
        .skip(SIGINT_UNIT_NAME_FIRST_INCLUDED_ECHELON_INDEX)
        .filter(|(echelon, part)| {
            !part.is_empty()
                && !unit_name_echelon_is_blacklisted(*echelon, part)
        })
        .map(|(_, part)| part)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn unit_name_echelon_is_blacklisted(
    echelon: usize,
    value: &str,
) -> bool {
    let blacklist_terms = match echelon {
        SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX => {
            SIGINT_UNIT_NAME_CORPS_BLACKLIST_TERMS
        }
        SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX => {
            SIGINT_UNIT_NAME_ARMY_BLACKLIST_TERMS
        }
        _ => return false,
    };
    unit_name_value_is_blacklisted(value, blacklist_terms)
}

fn unit_name_part_is_blacklisted(echelon: usize, value: &str) -> bool {
    unit_name_echelon_is_blacklisted(echelon, value)
        || echelon != SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX
            && echelon != SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX
            && (unit_name_value_is_blacklisted(
                value,
                SIGINT_UNIT_NAME_CORPS_BLACKLIST_TERMS,
            ) || unit_name_value_is_blacklisted(
                value,
                SIGINT_UNIT_NAME_ARMY_BLACKLIST_TERMS,
            ))
}

fn unit_name_value_is_blacklisted(
    value: &str,
    blacklist_terms: &[&str],
) -> bool {
    let value = value.to_lowercase();
    let value_words = value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    blacklist_terms.iter().any(|blacklisted| {
        let blacklisted_words = blacklisted
            .split(|character: char| !character.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>();
        value_words
            .windows(blacklisted_words.len())
            .any(|words| words == blacklisted_words)
    })
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
    let mut response =
        read_units_with_orbit_visibility(&env.dbx, &req, can_view_orbit)
            .await?;
    if can_view_orbit {
        let unit_ids = response
            .units
            .iter()
            .map(|unit| unit.id)
            .collect::<Vec<_>>();
        let orbit_links = orbit::unit_orbit_links(&env.dbx, &unit_ids)
            .await
            .context(h!())?;
        for unit in &mut response.units {
            apply_unit_orbit_links(
                unit,
                orbit_links.get(&unit.id).map(Vec::as_slice),
            );
        }
    } else {
        for unit in &mut response.units {
            redact_unit_orbit_data(unit);
        }
    }
    Ok(Json(response))
}

#[post("/api/sigint/units/status-counts")]
pub async fn unit_status_counts(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<UnitStatusCountsRsp>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    has_any_role(&env.dbx, &login_id, vec!["Rer", "Api"])
        .await
        .c(h!())?;
    Ok(Json(read_unit_status_counts(&env.dbx).await?))
}

async fn read_unit_status_counts(
    dbx: &DatabaseConnection,
) -> Result<UnitStatusCountsRsp, AppError> {
    count_unit_statuses(dbx, available_units_query(true)).await
}

async fn count_unit_statuses(
    dbx: &DatabaseConnection,
    units: Select<sigint_unit::Entity>,
) -> Result<UnitStatusCountsRsp, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        active: i64,
        inactive: i64,
    }

    let counts = units
        .select_only()
        .column_as(
            Expr::cust("COUNT(*) FILTER (WHERE sigint_unit.active = true)"),
            "active",
        )
        .column_as(
            Expr::cust("COUNT(*) FILTER (WHERE sigint_unit.active = false)"),
            "inactive",
        )
        .into_model::<Row>()
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;

    Ok(UnitStatusCountsRsp {
        active: counts.active,
        inactive: counts.inactive,
    })
}

pub(crate) async fn read_units(
    dbx: &DatabaseConnection,
    req: &ListUnitsReq,
) -> Result<ListUnitsRsp, AppError> {
    read_units_with_orbit_visibility(dbx, req, true).await
}

async fn read_units_with_orbit_visibility(
    dbx: &DatabaseConnection,
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Result<ListUnitsRsp, AppError> {
    let mut units = available_units_query(true);
    units = apply_unit_list_filters(units, req, can_view_orbit);
    let status_counts = count_unit_statuses(dbx, units.clone()).await?;
    if let Some(active) = req.filter_active {
        units = units.filter(sigint_unit::Column::Active.eq(active));
    } else if !req.include_inactive {
        units = units.filter(sigint_unit::Column::Active.eq(true));
    }
    let total_count = selected_unit_count(req, &status_counts);
    let total_count_u64 = u64::try_from(total_count).c(h!())?;
    let sort_by = unit_list_sort(req.sort_by.as_ref(), can_view_orbit);
    if matches!(sort_by, ListUnitsSortBy::NaturalMilitarySortAsc)
        && has_unit_global_search(req)
    {
        units = apply_unit_search_cursor(dbx, units, req, can_view_orbit)
            .await
            .c(h!())?;
        units = apply_unit_search_order(units, req, can_view_orbit);
    } else if let Some((column, order)) = simple_unit_list_sort(&sort_by) {
        units = units
            .order_by(column, order.clone())
            .order_by(sigint_unit::Column::Id, order);
    } else {
        match sort_by {
            ListUnitsSortBy::CreatedAtDesc => {
                if let Some(before_unit_id) = &req.before_unit_id {
                    let before_unit =
                        find_unit(dbx, *before_unit_id).await.c(h!())?;
                    units = units.filter(
                        Expr::tuple([
                            sigint_unit::Column::CreatedAt
                                .into_column_ref()
                                .into(),
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
                            sigint_unit::Column::CreatedAt
                                .into_column_ref()
                                .into(),
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
                            sigint_unit::Column::Corps.into_column_ref().into(),
                            sigint_unit::Column::Division
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Brigade
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Regiment
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Battalion
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Company
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Platoon
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Squad.into_column_ref().into(),
                            sigint_unit::Column::Section
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::TeamOrCrew
                                .into_column_ref()
                                .into(),
                            sigint_unit::Column::Other.into_column_ref().into(),
                            sigint_unit::Column::Id.into_column_ref().into(),
                        ])
                        .gt(SimpleExpr::Tuple(vec![
                            after_unit.army_region.into(),
                            after_unit.military_district.into(),
                            after_unit.army.into(),
                            after_unit.corps.into(),
                            after_unit.division.into(),
                            after_unit.brigade.into(),
                            after_unit.regiment.into(),
                            after_unit.battalion.into(),
                            after_unit.company.into(),
                            after_unit.platoon.into(),
                            after_unit.squad.into(),
                            after_unit.section.into(),
                            after_unit.team_or_crew.into(),
                            after_unit.other.into(),
                            after_unit.id.into(),
                        ])),
                    );
                }
                units = units.order_by_asc(sigint_unit::Column::ArmyRegion);
                units =
                    units.order_by_asc(sigint_unit::Column::MilitaryDistrict);
                units = units.order_by_asc(sigint_unit::Column::Army);
                units = units.order_by_asc(sigint_unit::Column::Corps);
                units = units.order_by_asc(sigint_unit::Column::Division);
                units = units.order_by_asc(sigint_unit::Column::Brigade);
                units = units.order_by_asc(sigint_unit::Column::Regiment);
                units = units.order_by_asc(sigint_unit::Column::Battalion);
                units = units.order_by_asc(sigint_unit::Column::Company);
                units = units.order_by_asc(sigint_unit::Column::Platoon);
                units = units.order_by_asc(sigint_unit::Column::Squad);
                units = units.order_by_asc(sigint_unit::Column::Section);
                units = units.order_by_asc(sigint_unit::Column::TeamOrCrew);
                units = units.order_by_asc(sigint_unit::Column::Other);
                units = units.order_by_asc(sigint_unit::Column::Id);
            }
            ListUnitsSortBy::UnitNameLengthAsc => {
                units = units
                    .order_by_asc(Expr::cust(
                        "char_length(\"sigint_unit\".\"name\")",
                    ))
                    .order_by_asc(sigint_unit::Column::Name)
                    .order_by_asc(sigint_unit::Column::Id);
            }
            ListUnitsSortBy::UnitOrbitLinkedAsc => {
                units = units
                    .order_by_asc(Expr::cust(unit_has_orbit_sql()))
                    .order_by_asc(sigint_unit::Column::Name)
                    .order_by_asc(sigint_unit::Column::Id);
            }
            ListUnitsSortBy::UnitOrbitLinkedDesc => {
                units = units
                    .order_by_desc(Expr::cust(unit_has_orbit_sql()))
                    .order_by_asc(sigint_unit::Column::Name)
                    .order_by_asc(sigint_unit::Column::Id);
            }
            _ => unreachable!("simple unit list sorts are handled above"),
        }
    }
    let limit = req
        .limit
        .and_then(|limit| u64::try_from(limit).ok())
        .unwrap_or(SIGINT_UNIT_LIST_DEFAULT_LIMIT)
        .clamp(1, SIGINT_UNIT_LIST_MAX_LIMIT);
    let offset = req
        .offset
        .and_then(|offset| u64::try_from(offset).ok())
        .unwrap_or(0);
    let units = units.limit(limit).offset(offset).all(dbx).await.c(h!())?;
    let mut res = vec![];
    for unit in units {
        res.push(render_unit(&unit)?);
    }
    let show_load_more =
        if req.after_unit_id.is_some() || req.before_unit_id.is_some() {
            res.len() as u64 == limit
        } else {
            offset.saturating_add(res.len() as u64) < total_count_u64
        };
    Ok(ListUnitsRsp {
        show_load_more,
        total_count,
        status_counts,
        units: res,
    })
}

fn selected_unit_count(
    req: &ListUnitsReq,
    status_counts: &UnitStatusCountsRsp,
) -> i64 {
    match req.filter_active {
        Some(true) => status_counts.active,
        Some(false) => status_counts.inactive,
        None if req.include_inactive => {
            status_counts.active.saturating_add(status_counts.inactive)
        }
        None => status_counts.active,
    }
}

fn unit_list_sort(
    sort_by: Option<&ListUnitsSortBy>,
    can_view_orbit: bool,
) -> ListUnitsSortBy {
    match sort_by {
        Some(
            ListUnitsSortBy::UnitOrbitNoteAsc
            | ListUnitsSortBy::UnitOrbitNoteDesc
            | ListUnitsSortBy::UnitOrbitLinkedAsc
            | ListUnitsSortBy::UnitOrbitLinkedDesc,
        ) if !can_view_orbit => ListUnitsSortBy::NaturalMilitarySortAsc,
        Some(sort_by) => sort_by.clone(),
        None => ListUnitsSortBy::NaturalMilitarySortAsc,
    }
}

fn simple_unit_list_sort(
    sort_by: &ListUnitsSortBy,
) -> Option<(sigint_unit::Column, Order)> {
    use ListUnitsSortBy::*;

    Some(match sort_by {
        UnitNameAsc => (sigint_unit::Column::Name, Order::Asc),
        UnitNameDesc => (sigint_unit::Column::Name, Order::Desc),
        UnitOtherAsc => (sigint_unit::Column::Other, Order::Asc),
        UnitOtherDesc => (sigint_unit::Column::Other, Order::Desc),
        UnitTeamOrCrewAsc => (sigint_unit::Column::TeamOrCrew, Order::Asc),
        UnitTeamOrCrewDesc => (sigint_unit::Column::TeamOrCrew, Order::Desc),
        UnitSectionAsc => (sigint_unit::Column::Section, Order::Asc),
        UnitSectionDesc => (sigint_unit::Column::Section, Order::Desc),
        UnitSquadAsc => (sigint_unit::Column::Squad, Order::Asc),
        UnitSquadDesc => (sigint_unit::Column::Squad, Order::Desc),
        UnitPlatoonAsc => (sigint_unit::Column::Platoon, Order::Asc),
        UnitPlatoonDesc => (sigint_unit::Column::Platoon, Order::Desc),
        UnitCompanyAsc => (sigint_unit::Column::Company, Order::Asc),
        UnitCompanyDesc => (sigint_unit::Column::Company, Order::Desc),
        UnitBattalionAsc => (sigint_unit::Column::Battalion, Order::Asc),
        UnitBattalionDesc => (sigint_unit::Column::Battalion, Order::Desc),
        UnitRegimentAsc => (sigint_unit::Column::Regiment, Order::Asc),
        UnitRegimentDesc => (sigint_unit::Column::Regiment, Order::Desc),
        UnitBrigadeAsc => (sigint_unit::Column::Brigade, Order::Asc),
        UnitBrigadeDesc => (sigint_unit::Column::Brigade, Order::Desc),
        UnitDivisionAsc => (sigint_unit::Column::Division, Order::Asc),
        UnitDivisionDesc => (sigint_unit::Column::Division, Order::Desc),
        UnitCorpsAsc => (sigint_unit::Column::Corps, Order::Asc),
        UnitCorpsDesc => (sigint_unit::Column::Corps, Order::Desc),
        UnitArmyAsc => (sigint_unit::Column::Army, Order::Asc),
        UnitArmyDesc => (sigint_unit::Column::Army, Order::Desc),
        UnitMilitaryDistrictAsc => {
            (sigint_unit::Column::MilitaryDistrict, Order::Asc)
        }
        UnitMilitaryDistrictDesc => {
            (sigint_unit::Column::MilitaryDistrict, Order::Desc)
        }
        UnitArmyRegionAsc => (sigint_unit::Column::ArmyRegion, Order::Asc),
        UnitArmyRegionDesc => (sigint_unit::Column::ArmyRegion, Order::Desc),
        UnitCommentAsc => (sigint_unit::Column::Comment, Order::Asc),
        UnitCommentDesc => (sigint_unit::Column::Comment, Order::Desc),
        UnitOrbitNoteAsc => (sigint_unit::Column::OrbitNote, Order::Asc),
        UnitOrbitNoteDesc => (sigint_unit::Column::OrbitNote, Order::Desc),
        CreatedAtDesc
        | CreatedAtAsc
        | NaturalMilitarySortAsc
        | UnitNameLengthAsc
        | UnitOrbitLinkedAsc
        | UnitOrbitLinkedDesc => return None,
    })
}

fn unit_has_orbit_sql() -> &'static str {
    r#"EXISTS (
        SELECT 1
        FROM orbit_unit_sigint_unit link
        INNER JOIN orbit_unit ON orbit_unit.unit_id = link.orbit_unit_id
        WHERE link.sigint_unit_id = "sigint_unit"."id"
            AND link.is_suppressed = false
            AND orbit_unit.deleted = false
    )"#
}

fn apply_unit_presence_filters(
    mut units: Select<sigint_unit::Entity>,
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Select<sigint_unit::Entity> {
    if !can_view_orbit {
        return units;
    }

    if let Some(is_candidate) = req.filter_is_deduplicate_candidate {
        units = if is_candidate {
            units.filter(sigint_unit::Column::IsDeduplicateCandidate.eq(true))
        } else {
            units.filter(
                Condition::any()
                    .add(sigint_unit::Column::IsDeduplicateCandidate.eq(false))
                    .add(sigint_unit::Column::IsDeduplicateCandidate.is_null()),
            )
        };
    }
    if let Some(has_orbit) = req.filter_has_orbit {
        let condition = Expr::cust(unit_has_orbit_sql());
        units = units.filter(if has_orbit {
            condition
        } else {
            condition.not()
        });
    }
    if let Some(has_note) = req.filter_has_orbit_note {
        let operator = if has_note { "<>" } else { "=" };
        units = units.filter(Expr::cust(format!(
            "btrim(coalesce(\"sigint_unit\".\"orbit_note\", '')) {operator} ''"
        )));
    }
    units
}

fn apply_unit_list_filters(
    mut units: Select<sigint_unit::Entity>,
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Select<sigint_unit::Entity> {
    let mode = req
        .search_mode
        .as_ref()
        .unwrap_or(&ListUnitsSearchMode::Strict);
    let global_filter_columns = unit_global_filter_columns(can_view_orbit);
    let orbit_note_filter = if can_view_orbit {
        req.filter_orbit_note.as_deref()
    } else {
        None
    };
    let filters = [
        (global_filter_columns, req.filter_text.as_deref()),
        (r#""sigint_unit"."name""#, req.filter_name.as_deref()),
        (r#""sigint_unit"."other""#, req.filter_other.as_deref()),
        (
            r#""sigint_unit"."team_or_crew""#,
            req.filter_team_or_crew.as_deref(),
        ),
        (r#""sigint_unit"."section""#, req.filter_section.as_deref()),
        (r#""sigint_unit"."squad""#, req.filter_squad.as_deref()),
        (r#""sigint_unit"."platoon""#, req.filter_platoon.as_deref()),
        (r#""sigint_unit"."company""#, req.filter_company.as_deref()),
        (
            r#""sigint_unit"."battalion""#,
            req.filter_battalion.as_deref(),
        ),
        (
            r#""sigint_unit"."regiment""#,
            req.filter_regiment.as_deref(),
        ),
        (r#""sigint_unit"."brigade""#, req.filter_brigade.as_deref()),
        (
            r#""sigint_unit"."division""#,
            req.filter_division.as_deref(),
        ),
        (r#""sigint_unit"."corps""#, req.filter_corps.as_deref()),
        (r#""sigint_unit"."army""#, req.filter_army.as_deref()),
        (
            r#""sigint_unit"."military_district""#,
            req.filter_military_district.as_deref(),
        ),
        (
            r#""sigint_unit"."army_region""#,
            req.filter_army_region.as_deref(),
        ),
        (r#""sigint_unit"."comment""#, req.filter_comment.as_deref()),
        (
            r#"coalesce("sigint_unit"."orbit_note", '')"#,
            orbit_note_filter,
        ),
    ];

    for (column_sql, value) in filters {
        if let Some(condition) = unit_text_filter(column_sql, value, mode) {
            units = units.filter(condition);
        }
    }
    apply_unit_presence_filters(units, req, can_view_orbit)
}

fn unit_text_filter(
    column_sql: &str,
    value: Option<&str>,
    mode: &ListUnitsSearchMode,
) -> Option<Condition> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }

    match mode {
        ListUnitsSearchMode::Strict => {
            let (match_sql, patterns) =
                unit_exact_match_sql_and_patterns(column_sql, value)?;
            Some(
                Condition::all()
                    .add(Expr::cust_with_values(match_sql, [patterns])),
            )
        }
        ListUnitsSearchMode::Relaxed => {
            let escaped = value
                .to_lowercase()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            Some(Condition::any().add(Expr::cust_with_values(
                format!(
                    "lower({column_sql}) LIKE $1 ESCAPE E'\\\\' OR word_similarity(lower($2), lower({column_sql})) > 0.3"
                ),
                [format!("%{escaped}%"), value.to_lowercase()],
            )))
        }
    }
}

fn unit_global_filter_columns(can_view_orbit: bool) -> &'static str {
    if can_view_orbit {
        r#"concat_ws(' ', "sigint_unit"."name", "sigint_unit"."other", "sigint_unit"."team_or_crew", "sigint_unit"."section", "sigint_unit"."squad", "sigint_unit"."platoon", "sigint_unit"."company", "sigint_unit"."battalion", "sigint_unit"."regiment", "sigint_unit"."brigade", "sigint_unit"."division", "sigint_unit"."corps", "sigint_unit"."army", "sigint_unit"."military_district", "sigint_unit"."army_region", "sigint_unit"."comment", "sigint_unit"."orbit_note")"#
    } else {
        r#"concat_ws(' ', "sigint_unit"."name", "sigint_unit"."other", "sigint_unit"."team_or_crew", "sigint_unit"."section", "sigint_unit"."squad", "sigint_unit"."platoon", "sigint_unit"."company", "sigint_unit"."battalion", "sigint_unit"."regiment", "sigint_unit"."brigade", "sigint_unit"."division", "sigint_unit"."corps", "sigint_unit"."army", "sigint_unit"."military_district", "sigint_unit"."army_region", "sigint_unit"."comment")"#
    }
}

fn unit_search_tokens(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn has_unit_global_search(req: &ListUnitsReq) -> bool {
    req.filter_text
        .as_deref()
        .is_some_and(|value| !unit_search_tokens(value).is_empty())
}

fn unit_exact_match_sql_and_patterns(
    column_sql: &str,
    value: &str,
) -> Option<(String, Vec<String>)> {
    let tokens = unit_search_tokens(value);
    if tokens.is_empty() {
        return None;
    }
    let normalized_sql = format!(
        "concat(' ', regexp_replace(lower({column_sql}), '[[:punct:][:space:]]+', ' ', 'g'), ' ')"
    );
    let match_sql = format!("{normalized_sql} LIKE ALL ($1)");
    let patterns = tokens
        .into_iter()
        .map(|token| format!("% {token} %"))
        .collect();
    Some((match_sql, patterns))
}

fn unit_name_prefix_match_sql_and_pattern(
    value: &str,
) -> Option<(String, String)> {
    let tokens = unit_search_tokens(value);
    if tokens.is_empty() {
        return None;
    }
    let normalized_name_sql = r#"concat(btrim(regexp_replace(lower("sigint_unit"."name"), '[[:punct:][:space:]]+', ' ', 'g')), ' ')"#;
    Some((
        format!("{normalized_name_sql} LIKE $1"),
        format!("{} %", tokens.join(" ")),
    ))
}

fn unit_echelon_sort_rank_sql() -> &'static str {
    r#"CASE
        WHEN btrim("sigint_unit"."other") <> '' THEN 13
        WHEN btrim("sigint_unit"."team_or_crew") <> '' THEN 12
        WHEN btrim("sigint_unit"."section") <> '' THEN 11
        WHEN btrim("sigint_unit"."squad") <> '' THEN 10
        WHEN btrim("sigint_unit"."platoon") <> '' THEN 9
        WHEN btrim("sigint_unit"."company") <> '' THEN 8
        WHEN btrim("sigint_unit"."battalion") <> '' THEN 7
        WHEN btrim("sigint_unit"."regiment") <> '' THEN 6
        WHEN btrim("sigint_unit"."brigade") <> '' THEN 5
        WHEN btrim("sigint_unit"."division") <> '' THEN 4
        WHEN btrim("sigint_unit"."corps") <> '' THEN 3
        WHEN btrim("sigint_unit"."army") <> '' THEN 2
        WHEN btrim("sigint_unit"."military_district") <> '' THEN 1
        WHEN btrim("sigint_unit"."army_region") <> '' THEN 0
        ELSE 14
    END"#
}

fn unit_echelon_sort_rank(unit: &sigint_unit::Model) -> i32 {
    [
        (&unit.other, 13),
        (&unit.team_or_crew, 12),
        (&unit.section, 11),
        (&unit.squad, 10),
        (&unit.platoon, 9),
        (&unit.company, 8),
        (&unit.battalion, 7),
        (&unit.regiment, 6),
        (&unit.brigade, 5),
        (&unit.division, 4),
        (&unit.corps, 3),
        (&unit.army, 2),
        (&unit.military_district, 1),
        (&unit.army_region, 0),
    ]
    .into_iter()
    .find_map(|(value, rank)| {
        (!value.trim_matches(' ').is_empty()).then_some(rank)
    })
    .unwrap_or(14)
}

fn unit_search_sort_expressions(
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Vec<SimpleExpr> {
    let mut expressions = Vec::with_capacity(18);
    if let Some((match_sql, pattern)) = req
        .filter_text
        .as_deref()
        .and_then(unit_name_prefix_match_sql_and_pattern)
    {
        expressions.push(Expr::cust_with_values(
            format!("CASE WHEN {match_sql} THEN 0 ELSE 1 END"),
            [pattern],
        ));
    }
    if matches!(req.search_mode, Some(ListUnitsSearchMode::Relaxed)) {
        if let Some((match_sql, patterns)) =
            req.filter_text.as_deref().and_then(|value| {
                unit_exact_match_sql_and_patterns(
                    unit_global_filter_columns(can_view_orbit),
                    value,
                )
            })
        {
            expressions.push(Expr::cust_with_values(
                format!("CASE WHEN {match_sql} THEN 0 ELSE 1 END"),
                [patterns],
            ));
        }
    }
    expressions.extend([
        Expr::cust(unit_echelon_sort_rank_sql()),
        sigint_unit::Column::ArmyRegion.into_column_ref().into(),
        sigint_unit::Column::MilitaryDistrict
            .into_column_ref()
            .into(),
        sigint_unit::Column::Army.into_column_ref().into(),
        sigint_unit::Column::Corps.into_column_ref().into(),
        sigint_unit::Column::Division.into_column_ref().into(),
        sigint_unit::Column::Brigade.into_column_ref().into(),
        sigint_unit::Column::Regiment.into_column_ref().into(),
        sigint_unit::Column::Battalion.into_column_ref().into(),
        sigint_unit::Column::Company.into_column_ref().into(),
        sigint_unit::Column::Platoon.into_column_ref().into(),
        sigint_unit::Column::Squad.into_column_ref().into(),
        sigint_unit::Column::Section.into_column_ref().into(),
        sigint_unit::Column::TeamOrCrew.into_column_ref().into(),
        sigint_unit::Column::Other.into_column_ref().into(),
        sigint_unit::Column::Id.into_column_ref().into(),
    ]);
    expressions
}

fn unit_name_prefix_match_rank(
    unit: &sigint_unit::Model,
    req: &ListUnitsReq,
) -> Option<i32> {
    let search_tokens = unit_search_tokens(req.filter_text.as_deref()?);
    if search_tokens.is_empty() {
        return None;
    }
    let unit_tokens = unit_search_tokens(&unit.name);
    Some(if unit_tokens.starts_with(&search_tokens) {
        0
    } else {
        1
    })
}

async fn unit_search_cursor_exact_match_rank(
    dbx: &DatabaseConnection,
    req: &ListUnitsReq,
    can_view_orbit: bool,
    after_unit_id: i64,
) -> Result<Option<i32>, AppError> {
    if !matches!(req.search_mode, Some(ListUnitsSearchMode::Relaxed)) {
        return Ok(None);
    }
    let Some((match_sql, patterns)) =
        req.filter_text.as_deref().and_then(|value| {
            unit_exact_match_sql_and_patterns(
                unit_global_filter_columns(can_view_orbit),
                value,
            )
        })
    else {
        return Ok(None);
    };
    let exact_match = sigint_unit::Entity::find_by_id(after_unit_id)
        .filter(Expr::cust_with_values(match_sql, [patterns]))
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    Ok(Some(if exact_match { 0 } else { 1 }))
}

fn unit_search_cursor_values(
    unit: &sigint_unit::Model,
    prefix_match_rank: Option<i32>,
    exact_match_rank: Option<i32>,
) -> Vec<SimpleExpr> {
    let mut values = Vec::with_capacity(18);
    if let Some(prefix_match_rank) = prefix_match_rank {
        values.push(prefix_match_rank.into());
    }
    if let Some(exact_match_rank) = exact_match_rank {
        values.push(exact_match_rank.into());
    }
    values.extend([
        unit_echelon_sort_rank(unit).into(),
        unit.army_region.clone().into(),
        unit.military_district.clone().into(),
        unit.army.clone().into(),
        unit.corps.clone().into(),
        unit.division.clone().into(),
        unit.brigade.clone().into(),
        unit.regiment.clone().into(),
        unit.battalion.clone().into(),
        unit.company.clone().into(),
        unit.platoon.clone().into(),
        unit.squad.clone().into(),
        unit.section.clone().into(),
        unit.team_or_crew.clone().into(),
        unit.other.clone().into(),
        unit.id.into(),
    ]);
    values
}

async fn apply_unit_search_cursor(
    dbx: &DatabaseConnection,
    units: Select<sigint_unit::Entity>,
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Result<Select<sigint_unit::Entity>, AppError> {
    let Some(after_unit_id) = req.after_unit_id else {
        return Ok(units);
    };
    let after_unit = find_unit(dbx, after_unit_id).await.c(h!())?;
    let prefix_match_rank = unit_name_prefix_match_rank(&after_unit, req);
    let exact_match_rank = unit_search_cursor_exact_match_rank(
        dbx,
        req,
        can_view_orbit,
        after_unit_id,
    )
    .await
    .c(h!())?;
    Ok(units.filter(
        Expr::tuple(unit_search_sort_expressions(req, can_view_orbit)).gt(
            SimpleExpr::Tuple(unit_search_cursor_values(
                &after_unit,
                prefix_match_rank,
                exact_match_rank,
            )),
        ),
    ))
}

fn apply_unit_search_order(
    mut units: Select<sigint_unit::Entity>,
    req: &ListUnitsReq,
    can_view_orbit: bool,
) -> Select<sigint_unit::Entity> {
    for expression in unit_search_sort_expressions(req, can_view_orbit) {
        units = units.order_by_asc(expression);
    }
    units
}

fn available_units_query(
    include_inactive: bool,
) -> Select<sigint_unit::Entity> {
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false));
    if include_inactive {
        units
    } else {
        units.filter(sigint_unit::Column::Active.eq(true))
    }
}

fn units_by_id_query(ids: Option<&[i64]>) -> Select<sigint_unit::Entity> {
    let mut units = available_units_query(true);
    if let Some(ids) = ids {
        units = units.filter(sigint_unit::Column::Id.eq_any(ids.to_vec()));
    }
    units
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
    let units = units_by_id_query(req.ids.as_deref())
        .all(&env.dbx)
        .await
        .c(h!())?;

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

    let (unit, can_view_orbit) =
        create_unit_for_login(&login, &env, req.into_inner()).await?;

    fanout_unit_changed(&env).await?;

    let mut unit = render_unit(&unit)?;
    apply_unit_orbit_visibility(&env.dbx, &mut unit, can_view_orbit)
        .await
        .context(h!())?;
    Ok(Json(unit))
}

async fn create_unit_for_login(
    login: &uuid::Uuid,
    env: &Env,
    mut req: CreateUnitReq,
) -> Result<(sigint_unit::Model, bool), AppError> {
    let can_view_orbit =
        clear_create_unit_orbit_note_if_hidden(&env.dbx, login, &mut req)
            .await?;
    let transaction = begin_unit_creation_transaction(&env.dbx, &req).await?;
    let unit = insert_merge_link_unit(&transaction, login, &req).await?;
    transaction.commit().await.context(h!())?;
    Ok((unit, can_view_orbit))
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
    let network_locations = if req.skip_network_creation {
        None
    } else {
        let locations = normalize_network_locations(req.locations.clone());
        if locations.is_empty() {
            return Err(AppError::BL {
                msg: "network locations are required".to_string(),
            });
        }
        Some(locations)
    };

    let transaction =
        begin_unit_creation_transaction(&env.dbx, &req.unit).await?;
    let unit = insert_merge_link_unit(&transaction, login, &req.unit).await?;
    let (network_id, created_network) = match network_locations {
        None => (None, None),
        Some(locations) => {
            if let Some(network) =
                active_network_for_unit(&transaction, unit.id).await?
            {
                (Some(network.id), None)
            } else {
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
                (Some(network.id), Some(network))
            }
        }
    };
    transaction.commit().await.context(h!())?;

    render_created_unit_with_optional_network(
        login,
        env,
        unit,
        network_id,
        created_network,
    )
    .await
}

async fn begin_unit_creation_transaction(
    dbx: &DatabaseConnection,
    req: &CreateUnitReq,
) -> Result<DatabaseTransaction, AppError> {
    if req.active {
        Ok(
            begin_orbit_unit_merge_transaction(dbx, &req.duplicate_unit_ids)
                .await
                .c(h!())?,
        )
    } else {
        Ok(begin_unit_merge_transaction(dbx, &req.duplicate_unit_ids)
            .await
            .c(h!())?)
    }
}

async fn insert_merge_link_unit(
    transaction: &DatabaseTransaction,
    login: &uuid::Uuid,
    req: &CreateUnitReq,
) -> Result<sigint_unit::Model, AppError> {
    let duplicate_unit_ids =
        validated_duplicate_unit_ids(transaction, req).await?;
    let unit = insert_unit_with_changelog(transaction, login, req)
        .await
        .c(h!())?;
    if unit.active {
        reconcile_parent_unit_activity(
            transaction,
            login,
            std::slice::from_ref(&unit),
        )
        .await?;
    }
    let unit = merge_requested_duplicate_units(
        *login,
        transaction,
        unit.id,
        duplicate_unit_ids,
    )
    .await?;
    Ok(unit)
}

async fn validated_duplicate_unit_ids<C>(
    dbx: &C,
    req: &CreateUnitReq,
) -> Result<BTreeSet<i64>, AppError>
where
    C: ConnectionTrait,
{
    let duplicate_unit_ids = req
        .duplicate_unit_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if duplicate_unit_ids.is_empty() {
        return Ok(duplicate_unit_ids);
    }
    let candidate_ids =
        orbit::create_unit_duplicate_candidate_ids_for_req(dbx, req).await?;
    if !duplicate_unit_ids.is_subset(&candidate_ids) {
        return Err(AppError::BL {
            msg: "Selected duplicate units are no longer available".to_string(),
        });
    }
    Ok(duplicate_unit_ids)
}

async fn merge_requested_duplicate_units<C>(
    login: uuid::Uuid,
    dbx: &C,
    unit_id: i64,
    duplicate_unit_ids: BTreeSet<i64>,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    if duplicate_unit_ids.contains(&unit_id) {
        return Err(AppError::BL {
            msg: "new unit cannot be merged into itself".to_string(),
        });
    }
    acquire_unit_merge_locks_for_ids(
        dbx,
        &duplicate_unit_ids
            .iter()
            .copied()
            .chain(std::iter::once(unit_id))
            .collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    for duplicate_unit_id in duplicate_unit_ids {
        merge_units_in_transaction(login, dbx, duplicate_unit_id, unit_id)
            .await
            .c(h!())?;
    }
    active_network_for_unit(dbx, unit_id).await?;
    find_unit(dbx, unit_id).await
}

async fn clear_create_unit_orbit_note_if_hidden(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &mut CreateUnitReq,
) -> Result<bool, AppError> {
    let can_view_orbit = orbit::can_view_orbit_data(dbx, login).await?;
    if !can_view_orbit {
        req.orbit_note = None;
        req.present_in_orbit = None;
        req.duplicate_unit_ids.clear();
    }
    Ok(can_view_orbit)
}

async fn render_created_unit_with_optional_network(
    login: &uuid::Uuid,
    env: &Env,
    unit: sigint_unit::Model,
    network_id: Option<i64>,
    created_network: Option<sigint_network::Model>,
) -> Result<CreateUnitWithAutoNetworkRsp, AppError> {
    fanout_unit_changed_data(env).await?;

    if let Some(network) = created_network {
        fanout_created_network(env, network).await?;
    }

    let unit = sigint_unit::Entity::find_by_id(unit.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut unit = render_unit(&unit)?;
    let can_view_orbit = orbit::can_view_orbit_data(&env.dbx, login).await?;
    apply_unit_orbit_visibility(&env.dbx, &mut unit, can_view_orbit)
        .await
        .context(h!())?;
    Ok(CreateUnitWithAutoNetworkRsp { unit, network_id })
}

async fn insert_unit_with_changelog<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    req: &CreateUnitReq,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    changelog::set_author(dbx, login).await.c(h!())?;
    let unit = sigint_unit::ActiveModel {
        id: NotSet,
        other: Set(req.other.clone()),
        team_or_crew: Set(req.team_or_crew.clone()),
        section: Set(req.section.clone()),
        squad: Set(req.squad.clone()),
        platoon: Set(req.platoon.clone()),
        company: Set(req.company.clone()),
        battalion: Set(req.battalion.clone()),
        regiment: Set(req.regiment.clone()),
        brigade: Set(req.brigade.clone()),
        division: Set(req.division.clone()),
        corps: Set(req.corps.clone()),
        army: Set(req.army.clone()),
        military_district: Set(req.military_district.clone()),
        army_region: Set(req.army_region.clone()),
        active: Set(req.active),
        is_deduplicate_candidate: Set(req.is_deduplicate_candidate),
        created_at: NotSet,
        created_by_login_id: Set(*login),
        comment: Set(req.comment.clone()),
        orbit_note: Set(req.orbit_note.clone()),
        present_in_orbit: Set(req.present_in_orbit),
        name: Set(unit_name_req(req)),
        deleted: Set(false),
        sigint_origin_id: NotSet,
        original_id: NotSet,
        is_inconsistent: NotSet,
        updated_at: NotSet,
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
        last_active_at: NotSet,
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
    Ok(active_network_for_unit(dbx, unit_id).await?.is_some())
}

async fn active_network_for_unit<C>(
    dbx: &C,
    unit_id: i64,
) -> Result<Option<sigint_network::Model>, AppError>
where
    C: ConnectionTrait,
{
    let mut networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::UnitId.eq(unit_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .limit(2)
        .all(dbx)
        .await
        .c(h!())?;
    if networks.len() > 1 {
        return Err(AppError::BL {
            msg: "unit has multiple active networks".to_string(),
        });
    }
    Ok(networks.pop())
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

pub(crate) async fn fanout_unit_changed_data(
    env: &Env,
) -> Result<(), AppError> {
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
    apply_unit_orbit_visibility(&env.dbx, &mut unit, can_update_orbit_note)
        .await
        .context(h!())?;
    Ok(Json(unit))
}

async fn update_unit_for_login(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &UpdateUnitReq,
    can_update_orbit_note: bool,
) -> Result<sigint_unit::Model, AppError> {
    let transaction = dbx.begin().await.context(h!())?;
    changelog::set_author(&transaction, login).await.c(h!())?;
    let unit = sigint_unit::Entity::find_by_id(req.id)
        .one(&transaction)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let other = req.other.clone().unwrap_or_else(|| unit.other.clone());
    let team_or_crew = req
        .team_or_crew
        .clone()
        .unwrap_or_else(|| unit.team_or_crew.clone());
    let section = req.section.clone().unwrap_or_else(|| unit.section.clone());
    let squad = req.squad.clone().unwrap_or_else(|| unit.squad.clone());
    let platoon = req.platoon.clone().unwrap_or_else(|| unit.platoon.clone());
    let brigade = req.brigade.clone().unwrap_or_else(|| unit.brigade.clone());
    let corps = req.corps.clone().unwrap_or_else(|| unit.corps.clone());
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
                other.as_str(),
                team_or_crew.as_str(),
                section.as_str(),
                squad.as_str(),
                platoon.as_str(),
                req.company.as_str(),
                req.battalion.as_str(),
                req.regiment.as_str(),
                brigade.as_str(),
                req.division.as_str(),
                corps.as_str(),
                req.army.as_str(),
                military_district.as_str(),
                army_region.as_str(),
            ];
    let unit_json_old = unit_json(&transaction, req.id).await?;
    let mut unit = unit.into_active_model();
    unit.other = Set(other.clone());
    unit.team_or_crew = Set(team_or_crew.clone());
    unit.section = Set(section.clone());
    unit.squad = Set(squad.clone());
    unit.platoon = Set(platoon.clone());
    unit.company = Set(req.company.clone());
    unit.battalion = Set(req.battalion.clone());
    unit.regiment = Set(req.regiment.clone());
    unit.brigade = Set(brigade.clone());
    unit.division = Set(req.division.clone());
    unit.corps = Set(corps.clone());
    unit.army = Set(req.army.clone());
    unit.military_district = Set(military_district.clone());
    unit.army_region = Set(army_region.clone());
    unit.active = Set(req.active);
    unit.updated_at = Set(chrono::Utc::now().naive_utc());
    unit.name = Set(if req.name.trim().is_empty() {
        let generated_name = unit_name_from_hierarchy([
            &other,
            &team_or_crew,
            &section,
            &squad,
            &platoon,
            &req.company,
            &req.battalion,
            &req.regiment,
            &brigade,
            &req.division,
            &corps,
            &req.army,
            &military_district,
            &army_region,
        ]);
        if generated_name.is_empty() {
            previous_unit.name.clone()
        } else {
            generated_name
        }
    } else {
        req.name.trim().to_string()
    });
    unit.comment = Set(req.comment.clone());
    if can_update_orbit_note {
        if let Some(orbit_note) = &req.orbit_note {
            unit.orbit_note = Set(orbit_note.clone());
        }
        if let Some(present_in_orbit) = req.present_in_orbit {
            unit.present_in_orbit = Set(present_in_orbit);
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
    let unit =
        orbit::reconcile_sigint_unit_orbit(&transaction, login, unit.id, false)
            .await
            .c(h!())?
            .unit;
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
    changelog::set_author(dbx, login).await.c(h!())?;
    let old_value = unit_json(dbx, unit.id).await?;
    let mut unit = unit.clone().into_active_model();
    unit.active = Set(active);
    let unit = unit.update(dbx).await.context(h!())?;
    let new_value = unit_json(dbx, unit.id).await?;
    insert_unit_update_changelog(dbx, login, unit.id, old_value, new_value)
        .await?;
    Ok(unit)
}

pub(crate) async fn activate_unit_for_login<C>(
    dbx: &C,
    login: &uuid::Uuid,
    unit: &sigint_unit::Model,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    if unit.active {
        return Ok(unit.clone());
    }
    let unit = set_unit_activity(dbx, login, unit, true)
        .await
        .context(h!())?;
    reconcile_parent_unit_activity(dbx, login, std::slice::from_ref(&unit))
        .await
        .context(h!())?;
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

pub(crate) fn unit_hierarchy(unit: &sigint_unit::Model) -> [&str; 14] {
    [
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
    let transaction = begin_unit_merge_transaction(dbx, &[unit_id])
        .await
        .c(h!())?;
    merge_task::ensure_no_conflicting_merge(&transaction, unit_id, unit_id)
        .await
        .context(h!())?;
    changelog::set_author(&transaction, login).await.c(h!())?;
    let unit = sigint_unit::Entity::find_by_id(unit_id)
        .one(&transaction)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let previous_unit = unit.clone();
    let unit_json_old = unit_json(&transaction, unit.id).await?;
    crate::stats::enqueue_group_stats_recalculation_for_linked_unit(
        &transaction,
        unit.id,
        format!("deleted unit {}", unit.id),
    )
    .await
    .context(h!())?;
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
) -> Result<Json<i64>, AppError> {
    let dbx = &env.dbx;
    ensure_rer_role(dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).context(h!())?;
    has_role(dbx, &login, "UnitsEditor").await.c(h!())?;
    let req: DeleteUnitDuplicateReq = req.into_inner();
    let unit_to_delete_id = req.clone_to_delete_id;
    let original_id = req.original_id;

    Ok(Json(
        merge_task::start(&env, login, unit_to_delete_id, original_id)
            .await
            .c(h!())?,
    ))
}

pub async fn merge_units(
    login: uuid::Uuid,
    dbx: &DatabaseConnection,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<sigint_unit::Model, AppError> {
    let transaction =
        begin_unit_merge_transaction(dbx, &[unit_to_delete_id, original_id])
            .await
            .c(h!())?;
    let unit = merge_units_in_transaction(
        login,
        &transaction,
        unit_to_delete_id,
        original_id,
    )
    .await
    .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(unit)
}

async fn acquire_unit_merge_locks<C>(
    transaction: &C,
    unit_to_delete_id: i64,
    original_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    acquire_unit_merge_locks_for_ids(
        transaction,
        &[unit_to_delete_id, original_id],
    )
    .await
    .c(h!())
}

pub(crate) async fn acquire_unit_merge_locks_for_ids<C>(
    transaction: &C,
    unit_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    anyhow::ensure!(
        try_acquire_unit_merge_locks_for_ids(transaction, unit_ids)
            .await
            .c(h!())?,
        "unit merge lock is busy"
    );
    Ok(())
}

pub(crate) async fn begin_unit_merge_transaction(
    dbx: &DatabaseConnection,
    unit_ids: &[i64],
) -> anyhow::Result<DatabaseTransaction> {
    begin_unit_merge_transaction_with_import_lock(dbx, unit_ids, false).await
}

pub(crate) async fn begin_orbit_unit_merge_transaction(
    dbx: &DatabaseConnection,
    unit_ids: &[i64],
) -> anyhow::Result<DatabaseTransaction> {
    begin_unit_merge_transaction_with_import_lock(dbx, unit_ids, true).await
}

async fn begin_unit_merge_transaction_with_import_lock(
    dbx: &DatabaseConnection,
    unit_ids: &[i64],
    import_lock: bool,
) -> anyhow::Result<DatabaseTransaction> {
    loop {
        let transaction = dbx.begin().await.c(h!())?;
        let import_lock_acquired = if import_lock {
            let row = transaction
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "select pg_try_advisory_xact_lock($1) as acquired",
                    [crate::config::ORBIT_IMPORT_ADVISORY_LOCK_KEY.into()],
                ))
                .await
                .c(h!())?
                .c(h!())?;
            row.try_get::<bool>("", "acquired").c(h!())?
        } else {
            true
        };
        if import_lock_acquired
            && try_acquire_unit_merge_locks_for_ids(&transaction, unit_ids)
                .await
                .c(h!())?
        {
            return Ok(transaction);
        }
        transaction.rollback().await.c(h!())?;
        tokio::time::sleep(std::time::Duration::from_millis(
            SIGINT_UNIT_MERGE_ADVISORY_LOCK_POLL_MS,
        ))
        .await;
    }
}

async fn try_acquire_unit_merge_locks_for_ids<C>(
    transaction: &C,
    unit_ids: &[i64],
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    for unit_id in unit_ids.iter().copied().collect::<BTreeSet<_>>() {
        let lock_name = format!("unit:{unit_id}");
        let row = transaction
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select pg_try_advisory_xact_lock(hashtextextended($1::text || $2::text, 0)) as acquired",
                [
                    SIGINT_UNIT_MERGE_ADVISORY_LOCK_NAMESPACE.into(),
                    lock_name.into(),
                ],
            ))
            .await
            .c(h!())?
            .c(h!())?;
        if !row.try_get::<bool>("", "acquired").c(h!())? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) async fn merge_units_in_transaction<C>(
    login: uuid::Uuid,
    dbx: &C,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    merge_units_in_transaction_with_name_policy(
        login,
        dbx,
        unit_to_delete_id,
        original_id,
        MergeUnitNamePolicy::RegenerateDerived,
    )
    .await
}

pub(crate) async fn merge_units_in_transaction_preserving_name<C>(
    login: uuid::Uuid,
    dbx: &C,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    merge_units_in_transaction_with_name_policy(
        login,
        dbx,
        unit_to_delete_id,
        original_id,
        MergeUnitNamePolicy::PreserveOriginal,
    )
    .await
}

#[derive(Clone, Copy)]
enum MergeUnitNamePolicy {
    RegenerateDerived,
    PreserveOriginal,
}

async fn merge_units_in_transaction_with_name_policy<C>(
    login: uuid::Uuid,
    dbx: &C,
    unit_to_delete_id: i64,
    original_id: i64,
    name_policy: MergeUnitNamePolicy,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    if unit_to_delete_id == original_id {
        return Err(AppError::BL {
            msg: "unit cannot be merged into itself".to_string(),
        });
    }
    acquire_unit_merge_locks(dbx, unit_to_delete_id, original_id)
        .await
        .c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_linked_unit(
        dbx,
        unit_to_delete_id,
        format!("merged unit {unit_to_delete_id} into {original_id}"),
    )
    .await
    .c(h!())?;
    let unit = complete_unit_merge_in_transaction(
        login,
        dbx,
        unit_to_delete_id,
        original_id,
        name_policy,
        true,
    )
    .await
    .context(h!())?;
    Ok(unit)
}

async fn complete_unit_merge_in_transaction<C>(
    login: uuid::Uuid,
    dbx: &C,
    unit_to_delete_id: i64,
    original_id: i64,
    name_policy: MergeUnitNamePolicy,
    move_references: bool,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
    changelog::set_author(dbx, &login).await.c(h!())?;
    let (unit_to_delete, unit_original) =
        find_units_for_merge(dbx, unit_to_delete_id, original_id)
            .await
            .context(h!())?;
    merge_task::ensure_pinned_survivor(dbx, unit_to_delete_id, original_id)
        .await
        .context(h!())?;
    merge_task::ensure_no_conflicting_merge(
        dbx,
        unit_to_delete_id,
        original_id,
    )
    .await
    .context(h!())?;
    let previous_unit_original = unit_original.clone();
    let unit_original =
        update_original_unit(unit_original, &unit_to_delete, dbx, name_policy)
            .await
            .context(h!())?;

    if move_references {
        swap_units(unit_to_delete_id, original_id, login, dbx)
            .await
            .context(h!())?;
    }

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
    unit.is_deduplicate_candidate = Set(Some(false));
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
    .await
    .context(h!())?;
    crate::orbit::reevaluate_sigint_unit_deduplicate_candidate(
        dbx,
        unit_original.id,
    )
    .await
    .context(h!())?;
    Ok(
        orbit::reconcile_sigint_unit_orbit(dbx, &login, unit_original.id, true)
            .await
            .c(h!())?
            .unit,
    )
}

async fn find_units_for_merge<C>(
    dbx: &C,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<(sigint_unit::Model, sigint_unit::Model), AppError>
where
    C: ConnectionTrait,
{
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in([unit_to_delete_id, original_id]))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Id)
        .lock_exclusive()
        .all(dbx)
        .await
        .context(format!(
            "{} clone_id={unit_to_delete_id} original_id={original_id}",
            h!()
        ))?;
    let unit_to_delete = units
        .iter()
        .find(|unit| unit.id == unit_to_delete_id)
        .cloned()
        .ok_or(AppError::NotFound)?;
    let unit_original = units
        .into_iter()
        .find(|unit| unit.id == original_id)
        .ok_or(AppError::NotFound)?;
    Ok((unit_to_delete, unit_original))
}

pub async fn find_unit<C>(
    dbx: &C,
    unit_id: i64,
) -> Result<sigint_unit::Model, AppError>
where
    C: ConnectionTrait,
{
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
        other: unit.other.clone(),
        team_or_crew: unit.team_or_crew.clone(),
        section: unit.section.clone(),
        squad: unit.squad.clone(),
        platoon: unit.platoon.clone(),
        company: unit.company.clone(),
        battalion: unit.battalion.clone(),
        regiment: unit.regiment.clone(),
        brigade: unit.brigade.clone(),
        division: unit.division.clone(),
        corps: unit.corps.clone(),
        army: unit.army.clone(),
        military_district: unit.military_district.clone(),
        army_region: unit.army_region.clone(),
        active: unit.active,
        is_deduplicate_candidate: unit.is_deduplicate_candidate,
        comment: unit.comment.clone(),
        orbit_note: unit.orbit_note.clone(),
        present_in_orbit: unit.present_in_orbit,
        name: unit.name.clone(),
        created_at: unit.created_at.and_utc().timestamp_millis(),
        created_by_login_id: unit.created_by_login_id.to_string(),
        has_orbit: false,
        orbit_unit_ids: Vec::new(),
        orbit_unit_generative_names: Vec::new(),
    })
}

pub(crate) fn apply_unit_orbit_links(
    unit: &mut Unit,
    links: Option<&[orbit::UnitOrbitLink]>,
) {
    let Some(links) = links else {
        return;
    };
    unit.orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id.clone())
        .collect();
    unit.orbit_unit_generative_names = links
        .iter()
        .filter(|link| !link.generative_unit_name_full.is_empty())
        .map(|link| link.generative_unit_name_full.clone())
        .collect();
    unit.has_orbit = !unit.orbit_unit_ids.is_empty();
}

pub(crate) async fn apply_unit_orbit_visibility(
    dbx: &DatabaseConnection,
    unit: &mut Unit,
    can_view_orbit: bool,
) -> Result<(), AppError> {
    if !can_view_orbit {
        redact_unit_orbit_data(unit);
        return Ok(());
    }
    let unit_id = unit.id;
    let orbit_links = orbit::unit_orbit_links(dbx, &[unit_id])
        .await
        .context(h!())?;
    apply_unit_orbit_links(unit, orbit_links.get(&unit_id).map(Vec::as_slice));
    Ok(())
}

pub(crate) fn redact_unit_orbit_data(unit: &mut Unit) {
    unit.has_orbit = false;
    unit.orbit_unit_ids.clear();
    unit.orbit_unit_generative_names.clear();
    unit.orbit_note = None;
    unit.present_in_orbit = None;
    unit.is_deduplicate_candidate = None;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UnitReferenceStep {
    Callsigns,
    Signals,
    NetworkUnits,
    NetworkCallsigns,
    Attachments,
    Labels,
    InboxLinks,
    OrbitLinks,
    Devices,
}

impl UnitReferenceStep {
    const ALL: [Self; 9] = [
        Self::Callsigns,
        Self::Signals,
        Self::NetworkUnits,
        Self::NetworkCallsigns,
        Self::Attachments,
        Self::Labels,
        Self::InboxLinks,
        Self::OrbitLinks,
        Self::Devices,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Callsigns => "Позивні",
            Self::Signals => "Сигнали",
            Self::NetworkUnits => "Підрозділи мереж",
            Self::NetworkCallsigns => "Позивні мереж",
            Self::Attachments => "Файли",
            Self::Labels => "Мітки",
            Self::InboxLinks => "Прив’язки повідомлень",
            Self::OrbitLinks => "Прив’язки ORBIT",
            Self::Devices => "Пристрої",
        }
    }
}

async fn swap_units<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for step in UnitReferenceStep::ALL {
        swap_unit_references_step(
            step,
            old_unit_id,
            new_unit_id,
            login,
            dbx,
            None,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn swap_unit_references_step<C>(
    step: UnitReferenceStep,
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let moved = match step {
        UnitReferenceStep::Callsigns => {
            move_unit_callsigns(old_unit_id, new_unit_id, login, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::Signals => {
            move_unit_signals(old_unit_id, new_unit_id, login, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::NetworkUnits => {
            move_unit_networks(old_unit_id, new_unit_id, login, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::NetworkCallsigns => move_unit_network_callsigns(
            old_unit_id,
            new_unit_id,
            login,
            dbx,
            limit,
        )
        .await
        .c(h!())?,
        UnitReferenceStep::Attachments => {
            move_unit_attachments(old_unit_id, new_unit_id, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::Labels => {
            move_unit_labels(old_unit_id, new_unit_id, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::InboxLinks => move_inbox_item_unit_links(
            old_unit_id,
            new_unit_id,
            dbx,
            limit,
            None,
        )
        .await
        .c(h!())?,
        UnitReferenceStep::OrbitLinks => {
            move_orbit_unit_links(old_unit_id, new_unit_id, dbx, limit)
                .await
                .c(h!())?
        }
        UnitReferenceStep::Devices => {
            swap_unit_devices(old_unit_id, new_unit_id, dbx, limit)
                .await
                .c(h!())?
        }
    };
    Ok(moved)
}

async fn move_unit_callsigns<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut query = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::UnitId.eq(old_unit_id))
        .order_by_asc(sigint_callsign::Column::Id);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let callsigns = query.all(dbx).await.context(h!())?;
    let moved = callsigns.len() as u64;
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
    Ok(moved)
}

async fn move_unit_signals<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut query = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::Unit.eq(old_unit_id))
        .order_by_asc(sigint_signal::Column::Id);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let signals = query.all(dbx).await.context(h!())?;
    let moved = signals.len() as u64;
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
    Ok(moved)
}

async fn move_unit_networks<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut query = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::UnitId.eq(old_unit_id))
        .order_by_asc(sigint_network_unit::Column::Id);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let network_units = query.all(dbx).await.context(h!())?;
    let moved = network_units.len() as u64;
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
    Ok(moved)
}

async fn move_unit_network_callsigns<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    login: uuid::Uuid,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut query = sigint_network_callsign::Entity::find()
        .filter(sigint_network_callsign::Column::UnitId.eq(old_unit_id))
        .order_by_asc(sigint_network_callsign::Column::Id);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let network_callsigns = query.all(dbx).await.c(h!())?;
    let moved = network_callsigns.len() as u64;
    for network_callsign in network_callsigns {
        let id = network_callsign.id;
        let json_old = serde_json::to_value(&network_callsign).c(h!())?;
        let mut network_callsign = network_callsign.into_active_model();
        network_callsign.unit_id = Set(Some(new_unit_id));
        let network_callsign = network_callsign.update(dbx).await.c(h!())?;
        sigint_network_callsign_changelog::ActiveModel {
            id: NotSet,
            sigint_network_callsign_id: Set(id),
            login_id: Set(login),
            action: Set(ChangelogActionEnum::Update),
            created_at: NotSet,
            new_value: Set(Some(
                serde_json::to_value(network_callsign).c(h!())?,
            )),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(moved)
}

async fn move_unit_attachments<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut update = sigint_unit_attachment::Entity::update_many()
        .col_expr(
            sigint_unit_attachment::Column::UnitId,
            Expr::value(new_unit_id),
        )
        .filter(sigint_unit_attachment::Column::UnitId.eq(old_unit_id));
    if let Some(limit) = limit {
        let ids = sigint_unit_attachment::Entity::find()
            .filter(sigint_unit_attachment::Column::UnitId.eq(old_unit_id))
            .order_by_asc(sigint_unit_attachment::Column::Id)
            .limit(limit)
            .select_only()
            .column(sigint_unit_attachment::Column::Id)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?;
        if ids.is_empty() {
            return Ok(0);
        }
        update = update.filter(sigint_unit_attachment::Column::Id.is_in(ids));
    }
    let result = update.exec(dbx).await.context(h!())?;
    Ok(result.rows_affected)
}

async fn move_unit_labels<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut update = sigint_unit_label::Entity::update_many()
        .col_expr(
            sigint_unit_label::Column::SigintUnitId,
            Expr::value(new_unit_id),
        )
        .filter(sigint_unit_label::Column::SigintUnitId.eq(old_unit_id));
    if let Some(limit) = limit {
        let ids = sigint_unit_label::Entity::find()
            .filter(sigint_unit_label::Column::SigintUnitId.eq(old_unit_id))
            .order_by_asc(sigint_unit_label::Column::Id)
            .limit(limit)
            .select_only()
            .column(sigint_unit_label::Column::Id)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?;
        if ids.is_empty() {
            return Ok(0);
        }
        update = update.filter(sigint_unit_label::Column::Id.is_in(ids));
    }
    let result = update.exec(dbx).await.context(h!())?;
    Ok(result.rows_affected)
}

async fn move_inbox_item_unit_links<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &C,
    limit: Option<u64>,
    link_ids: Option<&[i64]>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item_unit::Entity::find()
        .filter(sigint_inbox_item_unit::Column::UnitId.eq(old_unit_id))
        .order_by_asc(sigint_inbox_item_unit::Column::Id);
    if let Some(link_ids) = link_ids {
        query = query.filter(
            sigint_inbox_item_unit::Column::Id.is_in(link_ids.iter().copied()),
        );
    } else if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let links = query.all(dbx).await.context(h!())?;
    let moved = links.len() as u64;
    for link in links {
        let duplicate = sigint_inbox_item_unit::Entity::find()
            .filter(sigint_inbox_item_unit::Column::ItemId.eq(link.item_id))
            .filter(sigint_inbox_item_unit::Column::UnitId.eq(new_unit_id))
            .filter(sigint_inbox_item_unit::Column::Kind.eq(link.kind.clone()))
            .one(dbx)
            .await
            .context(h!())?;
        if duplicate.is_some() {
            link.delete(dbx).await.context(h!())?;
            continue;
        }
        let mut link = link.into_active_model();
        link.unit_id = Set(new_unit_id);
        link.update(dbx).await.context(h!())?;
    }
    Ok(moved)
}

async fn swap_unit_devices<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let mut update = device::Entity::update_many()
        .col_expr(device::Column::UnitId, Expr::value(Some(new_unit_id)))
        .col_expr(
            device::Column::UpdatedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(device::Column::UnitId.eq(old_unit_id));
    if let Some(limit) = limit {
        let ids = device::Entity::find()
            .filter(device::Column::UnitId.eq(old_unit_id))
            .order_by_asc(device::Column::Id)
            .limit(limit)
            .select_only()
            .column(device::Column::Id)
            .into_tuple::<uuid::Uuid>()
            .all(dbx)
            .await
            .c(h!())?;
        if ids.is_empty() {
            return Ok(0);
        }
        update = update.filter(device::Column::Id.is_in(ids));
    }
    let result = update.exec(dbx).await.context(h!())?;
    Ok(result.rows_affected)
}

async fn move_orbit_unit_links<C>(
    old_unit_id: i64,
    new_unit_id: i64,
    dbx: &C,
    limit: Option<u64>,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    if old_unit_id == new_unit_id {
        return Ok(0);
    }
    let mut query = orbit_unit_sigint_unit::Entity::find()
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(old_unit_id))
        .order_by_asc(orbit_unit_sigint_unit::Column::OrbitUnitId);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    let links = query.all(dbx).await.context(h!())?;
    let moved = links.len() as u64;
    let orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id)
        .collect::<Vec<_>>();
    if !links.is_empty() {
        let existing_links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(new_unit_id),
            )
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_unit_ids.iter().copied()),
            )
            .all(dbx)
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
            .exec_without_returning(dbx)
            .await
            .context(h!())?;
    }
    if !orbit_unit_ids.is_empty() {
        orbit_unit_sigint_unit::Entity::delete_many()
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId.eq(old_unit_id),
            )
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_unit_ids),
            )
            .exec(dbx)
            .await
            .context(h!())?;
    }
    Ok(moved)
}

async fn update_original_unit<C>(
    unit_original: sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
    dbx: &C,
    name_policy: MergeUnitNamePolicy,
) -> anyhow::Result<sigint_unit::Model>
where
    C: ConnectionTrait,
{
    let projected = project_merged_unit_with_name_policy(
        &unit_original,
        unit_to_merge,
        name_policy,
    );
    let mut unit = unit_original.into_active_model();
    unit.name.set_if_not_equals(projected.name);
    unit.other.set_if_not_equals(projected.other);
    unit.team_or_crew.set_if_not_equals(projected.team_or_crew);
    unit.section.set_if_not_equals(projected.section);
    unit.squad.set_if_not_equals(projected.squad);
    unit.platoon.set_if_not_equals(projected.platoon);
    unit.company.set_if_not_equals(projected.company);
    unit.battalion.set_if_not_equals(projected.battalion);
    unit.regiment.set_if_not_equals(projected.regiment);
    unit.brigade.set_if_not_equals(projected.brigade);
    unit.division.set_if_not_equals(projected.division);
    unit.corps.set_if_not_equals(projected.corps);
    unit.army.set_if_not_equals(projected.army);
    unit.military_district
        .set_if_not_equals(projected.military_district);
    unit.army_region.set_if_not_equals(projected.army_region);
    unit.comment.set_if_not_equals(projected.comment);
    unit.orbit_note.set_if_not_equals(projected.orbit_note);
    unit.deleted.set_if_not_equals(projected.deleted);

    let unit = unit.update(dbx).await.context(h!())?;
    unit_after_insert_update(dbx, unit.id).await.context(h!())?;
    Ok(unit)
}

pub(crate) fn project_merged_unit_preserving_name(
    unit_original: &sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
) -> sigint_unit::Model {
    project_merged_unit_with_name_policy(
        unit_original,
        unit_to_merge,
        MergeUnitNamePolicy::PreserveOriginal,
    )
}

fn project_merged_unit_with_name_policy(
    unit_original: &sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
    name_policy: MergeUnitNamePolicy,
) -> sigint_unit::Model {
    let mut unit = unit_original.clone();
    if matches!(name_policy, MergeUnitNamePolicy::RegenerateDerived)
        && unit_name_is_derived(unit_original)
    {
        let merged_name = merged_unit_name(unit_original, unit_to_merge);
        if !merged_name.is_empty() {
            unit.name = merged_name;
        }
    }

    unit.other =
        merged_unit_value(&unit.other, &unit_to_merge.other).to_string();
    unit.team_or_crew =
        merged_unit_value(&unit.team_or_crew, &unit_to_merge.team_or_crew)
            .to_string();
    unit.section =
        merged_unit_value(&unit.section, &unit_to_merge.section).to_string();
    unit.squad =
        merged_unit_value(&unit.squad, &unit_to_merge.squad).to_string();
    unit.platoon =
        merged_unit_value(&unit.platoon, &unit_to_merge.platoon).to_string();
    unit.company =
        merged_unit_value(&unit.company, &unit_to_merge.company).to_string();
    unit.battalion =
        merged_unit_value(&unit.battalion, &unit_to_merge.battalion)
            .to_string();
    unit.regiment =
        merged_unit_value(&unit.regiment, &unit_to_merge.regiment).to_string();
    unit.brigade =
        merged_unit_value(&unit.brigade, &unit_to_merge.brigade).to_string();
    unit.division =
        merged_unit_value(&unit.division, &unit_to_merge.division).to_string();
    unit.corps =
        merged_unit_value(&unit.corps, &unit_to_merge.corps).to_string();
    unit.army = merged_unit_value(&unit.army, &unit_to_merge.army).to_string();
    unit.military_district = merged_unit_value(
        &unit.military_district,
        &unit_to_merge.military_district,
    )
    .to_string();
    unit.army_region =
        merged_unit_value(&unit.army_region, &unit_to_merge.army_region)
            .to_string();
    unit.comment =
        merged_unit_value(&unit.comment, &unit_to_merge.comment).to_string();
    if unit
        .orbit_note
        .as_ref()
        .is_none_or(|note| note.trim().is_empty())
        && unit_to_merge
            .orbit_note
            .as_ref()
            .is_some_and(|note| !note.trim().is_empty())
    {
        unit.orbit_note.clone_from(&unit_to_merge.orbit_note);
    }
    if unit.deleted && !unit_to_merge.deleted {
        unit.deleted = false;
    }
    unit
}

fn merged_unit_name(
    unit_original: &sigint_unit::Model,
    unit_to_merge: &sigint_unit::Model,
) -> String {
    unit_name_from_hierarchy([
        merged_unit_value(&unit_original.other, &unit_to_merge.other),
        merged_unit_value(
            &unit_original.team_or_crew,
            &unit_to_merge.team_or_crew,
        ),
        merged_unit_value(&unit_original.section, &unit_to_merge.section),
        merged_unit_value(&unit_original.squad, &unit_to_merge.squad),
        merged_unit_value(&unit_original.platoon, &unit_to_merge.platoon),
        merged_unit_value(&unit_original.company, &unit_to_merge.company),
        merged_unit_value(&unit_original.battalion, &unit_to_merge.battalion),
        merged_unit_value(&unit_original.regiment, &unit_to_merge.regiment),
        merged_unit_value(&unit_original.brigade, &unit_to_merge.brigade),
        merged_unit_value(&unit_original.division, &unit_to_merge.division),
        merged_unit_value(&unit_original.corps, &unit_to_merge.corps),
        merged_unit_value(&unit_original.army, &unit_to_merge.army),
        merged_unit_value(
            &unit_original.military_district,
            &unit_to_merge.military_district,
        ),
        merged_unit_value(
            &unit_original.army_region,
            &unit_to_merge.army_region,
        ),
    ])
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
    let mut q = available_units_query(false);

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
    use crate::functest::tests::{cleanup, cleanup_locked};
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, NotSet,
        PaginatorTrait, QueryFilter, Set,
    };
    use serial_test::serial;
    use std::collections::BTreeSet;

    const TEST_LOGIN: &str = "Tester";

    #[test]
    fn generated_unit_names_do_not_append_echelons_above_army() {
        let mut hierarchy = [""; 14];
        hierarchy[0] = "ВМФ";
        hierarchy[6] = "2 бат";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX] = "20 ЗВА";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX + 1] = "Західний ВО";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX + 2] = "ЗС РФ";

        assert_eq!(unit_name_from_hierarchy(hierarchy), "2 бат 20 ЗВА");
    }

    #[test]
    fn generated_unit_names_keep_echelon_value_matching_other() {
        let mut hierarchy = [""; 14];
        hierarchy[crate::orbit::EchoEchelon::Other.index()] = "1 р";
        hierarchy[crate::orbit::EchoEchelon::Company.index()] = "1 р";

        assert_eq!(unit_name_from_hierarchy(hierarchy), "1 р");
    }

    #[test]
    fn generated_unit_names_keep_echelon_containing_other_value() {
        let mut hierarchy = [""; 14];
        hierarchy[crate::orbit::EchoEchelon::Other.index()] = "1";
        hierarchy[crate::orbit::EchoEchelon::Company.index()] = "1 р";

        assert_eq!(unit_name_from_hierarchy(hierarchy), "1 р");
    }

    #[test]
    fn generated_unit_names_exclude_blacklisted_army_and_corps_values() {
        for echelon in [
            SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX,
            SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX,
        ] {
            for value in ["УВ(с)", "УВ", "ТН"] {
                let mut hierarchy = [""; 14];
                hierarchy[6] = "2 бат";
                hierarchy[echelon] = value;

                assert_eq!(unit_name_from_hierarchy(hierarchy), "2 бат");
            }
        }
    }

    #[test]
    fn generated_unit_names_include_military_district_abbreviations_in_army_or_corps(
    ) {
        for echelon in [
            SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX,
            SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX,
        ] {
            for value in
                ["ПдВО", "ЛВО", "СхВО", "МВО", "ЦВО", "ПВО", "ЗхВО", "ЗВО"]
            {
                let mut hierarchy = [""; 14];
                hierarchy[6] = "2 бат";
                hierarchy[echelon] = value;

                assert_eq!(
                    unit_name_from_hierarchy(hierarchy),
                    format!("2 бат {value}")
                );
            }
        }
    }

    #[test]
    fn generated_unit_names_require_an_echelon_below_corps() {
        let mut hierarchy = [""; 14];
        hierarchy[SIGINT_UNIT_NAME_CORPS_ECHELON_INDEX] = "11 АК";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX] = "20 ЗВА";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX + 1] = "Західний ВО";

        assert_eq!(unit_name_from_hierarchy(hierarchy), "");
        assert_eq!(
            required_unit_name_from_hierarchy(hierarchy),
            "11 АК 20 ЗВА Західний ВО"
        );
    }

    #[test]
    fn required_unit_names_fall_back_to_the_full_high_echelon_hierarchy() {
        let mut hierarchy = [""; 14];
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX + 1] = "Західний ВО";
        hierarchy[SIGINT_UNIT_NAME_ARMY_ECHELON_INDEX + 2] = "ЗС РФ";

        assert_eq!(unit_name_from_hierarchy(hierarchy), "");
        assert_eq!(
            required_unit_name_from_hierarchy(hierarchy),
            "Західний ВО ЗС РФ"
        );
    }

    async fn test_login_id(env: &Env) -> uuid::Uuid {
        crate::users::login_id_by_name(&env.dbx, TEST_LOGIN)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[serial]
    async fn unit_merge_lock_waiter_releases_pool_connection() {
        let env = cleanup().await.unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect_with(
                (*env.dbx.get_postgres_connection_pool().connect_options())
                    .clone(),
            )
            .await
            .unwrap();
        let dbx = sea_orm::SqlxPostgresConnector::from_sqlx_postgres_pool(
            pool.clone(),
        );
        let first = dbx.begin().await.unwrap();
        acquire_unit_merge_locks(&first, 1, 2).await.unwrap();
        let mut second = tokio::spawn(async move {
            begin_unit_merge_transaction(&dbx, &[2, 3]).await.unwrap()
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while pool.size() < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!second.is_finished());
        let connection = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(connection);

        first.commit().await.unwrap();
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            &mut second,
        )
        .await
        .unwrap()
        .unwrap();
        second.commit().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn orbit_merge_import_lock_waiter_releases_pool_connection() {
        let env = cleanup().await.unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect_with(
                (*env.dbx.get_postgres_connection_pool().connect_options())
                    .clone(),
            )
            .await
            .unwrap();
        let dbx = sea_orm::SqlxPostgresConnector::from_sqlx_postgres_pool(
            pool.clone(),
        );
        let first = crate::orbit::acquire_import_lock(&dbx).await.unwrap();
        let mut second = tokio::spawn(async move {
            begin_orbit_unit_merge_transaction(&dbx, &[2, 3])
                .await
                .unwrap()
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while pool.size() < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!second.is_finished());
        let connection = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(connection);

        first.rollback().await.unwrap();
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            &mut second,
        )
        .await
        .unwrap()
        .unwrap();
        second.rollback().await.unwrap();
    }

    fn unit_req() -> CreateUnitReq {
        CreateUnitReq {
            name: None,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: "2 шр".to_string(),
            battalion: "3 ошб".to_string(),
            regiment: "44 осбр".to_string(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            active: true,
            is_deduplicate_candidate: None,
            comment: "main section".to_string(),
            orbit_note: None,
            present_in_orbit: None,
            duplicate_unit_ids: Vec::new(),
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
            show_peleng_distance_to_battleline: Set(false),
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

    async fn link_current_duplicate_candidate(
        dbx: &DatabaseConnection,
        sigint_unit_id: i64,
    ) -> uuid::Uuid {
        let synced_at = Utc::now().naive_utc();
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            unit_name_short: Set(Some("2 шр".to_string())),
            operational_unit_name_full: Set(Some(
                "2 шр / 3 ошб / 44 осбр".to_string(),
            )),
            created_at: Set(synced_at),
            updated_at: Set(synced_at),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        orbit_sync::ActiveModel {
            synced_at: Set(synced_at),
            archive_md5: Set(uuid::Uuid::new_v4().simple().to_string()),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(sigint_unit_id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
        orbit_unit_id
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
                generative_parent_unit_id: Set(
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

    async fn listed_unit_ids(
        dbx: &DatabaseConnection,
        req: ListUnitsReq,
    ) -> Vec<i64> {
        read_units(dbx, &req)
            .await
            .unwrap()
            .units
            .into_iter()
            .map(|unit| unit.id)
            .collect()
    }

    async fn assert_listed_unit_ids(
        dbx: &DatabaseConnection,
        req: ListUnitsReq,
        expected: &[i64],
    ) {
        assert_eq!(listed_unit_ids(dbx, req).await, expected);
    }

    #[tokio::test]
    #[serial]
    async fn unit_list_excludes_inactive_units_unless_requested() {
        let env = cleanup().await.unwrap();
        let active_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Alpha unit".to_string()),
                active: Set(true),
                orbit_note: Set(Some("Protected orbit phrase".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inactive_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Beta unit".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let active_units = read_units(
            &env.dbx,
            &ListUnitsReq {
                sort_by: None,
                after_unit_id: None,
                before_unit_id: None,
                include_inactive: false,
                filter_active: None,
                filter_text: None,
                filter_name: None,
                filter_other: None,
                filter_team_or_crew: None,
                filter_section: None,
                filter_squad: None,
                filter_platoon: None,
                filter_company: None,
                filter_battalion: None,
                filter_regiment: None,
                filter_brigade: None,
                filter_division: None,
                filter_corps: None,
                filter_army: None,
                filter_military_district: None,
                filter_army_region: None,
                filter_comment: None,
                filter_orbit_note: None,
                filter_is_deduplicate_candidate: None,
                filter_has_orbit: None,
                filter_has_orbit_note: None,
                search_mode: None,
                limit: None,
                offset: None,
            },
        )
        .await
        .unwrap();
        assert!(active_units
            .units
            .iter()
            .any(|unit| unit.id == active_unit.id));
        assert!(active_units
            .units
            .iter()
            .all(|unit| unit.id != inactive_unit.id));
        assert_eq!(active_units.total_count, 1);
        assert_eq!(
            active_units.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 1,
            }
        );

        let all_units = read_units(
            &env.dbx,
            &ListUnitsReq {
                sort_by: None,
                after_unit_id: None,
                before_unit_id: None,
                include_inactive: true,
                filter_active: None,
                filter_text: None,
                filter_name: None,
                filter_other: None,
                filter_team_or_crew: None,
                filter_section: None,
                filter_squad: None,
                filter_platoon: None,
                filter_company: None,
                filter_battalion: None,
                filter_regiment: None,
                filter_brigade: None,
                filter_division: None,
                filter_corps: None,
                filter_army: None,
                filter_military_district: None,
                filter_army_region: None,
                filter_comment: None,
                filter_orbit_note: None,
                filter_is_deduplicate_candidate: None,
                filter_has_orbit: None,
                filter_has_orbit_note: None,
                search_mode: None,
                limit: None,
                offset: None,
            },
        )
        .await
        .unwrap();
        assert!(all_units.units.iter().any(|unit| unit.id == active_unit.id));
        assert!(all_units
            .units
            .iter()
            .any(|unit| unit.id == inactive_unit.id));
        assert_eq!(all_units.total_count, 2);
        assert_eq!(
            all_units.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 1,
            }
        );

        let inactive_page = read_units(
            &env.dbx,
            &ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::UnitNameAsc),
                include_inactive: true,
                filter_active: Some(false),
                limit: Some(1),
                offset: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(inactive_page.total_count, 1);
        assert_eq!(inactive_page.units.len(), 1);
        assert_eq!(inactive_page.units[0].id, inactive_unit.id);
        assert!(!inactive_page.show_load_more);
        assert_eq!(
            inactive_page.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 1,
            }
        );

        let filtered_page = read_units(
            &env.dbx,
            &ListUnitsReq {
                filter_text: Some("Alpha".to_string()),
                search_mode: Some(ListUnitsSearchMode::Relaxed),
                limit: Some(20),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered_page.total_count, 1);
        assert_eq!(filtered_page.units[0].id, active_unit.id);
        assert_eq!(
            filtered_page.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 0,
            }
        );

        let ignored_orbit_filter = read_units_with_orbit_visibility(
            &env.dbx,
            &ListUnitsReq {
                filter_orbit_note: Some("not present".to_string()),
                filter_is_deduplicate_candidate: Some(true),
                filter_has_orbit: Some(true),
                filter_has_orbit_note: Some(false),
                limit: Some(20),
                ..Default::default()
            },
            false,
        )
        .await
        .unwrap();
        assert_eq!(ignored_orbit_filter.total_count, 1);
        assert_eq!(ignored_orbit_filter.units[0].id, active_unit.id);
        assert_eq!(
            ignored_orbit_filter.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 1,
            }
        );

        let restricted_global_filter = read_units_with_orbit_visibility(
            &env.dbx,
            &ListUnitsReq {
                filter_text: Some("Protected orbit phrase".to_string()),
                limit: Some(20),
                ..Default::default()
            },
            false,
        )
        .await
        .unwrap();
        assert_eq!(restricted_global_filter.total_count, 0);
        assert_eq!(
            restricted_global_filter.status_counts,
            UnitStatusCountsRsp {
                active: 0,
                inactive: 0,
            }
        );

        let allowed_global_filter = read_units_with_orbit_visibility(
            &env.dbx,
            &ListUnitsReq {
                filter_text: Some("Protected orbit phrase".to_string()),
                limit: Some(20),
                ..Default::default()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(allowed_global_filter.total_count, 1);
        assert_eq!(
            allowed_global_filter.status_counts,
            UnitStatusCountsRsp {
                active: 1,
                inactive: 0,
            }
        );
        assert_eq!(
            unit_list_sort(Some(&ListUnitsSortBy::UnitOrbitNoteAsc), false),
            ListUnitsSortBy::NaturalMilitarySortAsc
        );
        assert_eq!(
            unit_list_sort(Some(&ListUnitsSortBy::UnitOrbitLinkedDesc), false),
            ListUnitsSortBy::NaturalMilitarySortAsc
        );

        let units_by_id = units_by_id_query(Some(&[inactive_unit.id]))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(
            units_by_id
                .into_iter()
                .map(|unit| unit.id)
                .collect::<Vec<_>>(),
            vec![inactive_unit.id]
        );

        assert_eq!(
            read_unit_status_counts(&env.dbx).await.unwrap(),
            UnitStatusCountsRsp {
                active: 1,
                inactive: 1,
            }
        );
    }

    #[tokio::test]
    #[serial]
    async fn unit_list_sorts_matching_sigint_names_by_length() {
        let env = cleanup().await.unwrap();
        let exact = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("20 army".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let child = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("brigade 20 army".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let grandchild = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("battalion brigade 20 army".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("unrelated".to_string()),
                active: Set(true),
                orbit_note: Set(Some("20 army".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::UnitNameLengthAsc),
                filter_name: Some("20 army".to_string()),
                limit: Some(3),
                ..Default::default()
            },
            &[exact.id, child.id, grandchild.id],
        )
        .await;
    }

    #[tokio::test]
    #[serial]
    async fn unit_list_exact_and_fuzzy_search_rank_by_match_and_echelon() {
        let env = cleanup().await.unwrap();
        let regiment = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("123 мсп".to_string()),
                regiment: Set("123 мсп".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let first_battalion = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("1 мсб 123 мсп".to_string()),
                battalion: Set("1 мсб".to_string()),
                regiment: Set("123 мсп".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_battalion = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("2 мсб 123 мсп".to_string()),
                battalion: Set("2 мсб".to_string()),
                regiment: Set("123 мсп".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let prefixed_number = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("1123 мсп".to_string()),
                regiment: Set("1123 мсп".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let suffixed_number = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("1234 мсп".to_string()),
                regiment: Set("1234 мсп".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::NaturalMilitarySortAsc),
                filter_text: Some("мсп 123".to_string()),
                ..Default::default()
            },
            &[regiment.id, first_battalion.id, second_battalion.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::NaturalMilitarySortAsc),
                filter_text: Some("123 мсп".to_string()),
                search_mode: Some(ListUnitsSearchMode::Relaxed),
                ..Default::default()
            },
            &[
                regiment.id,
                first_battalion.id,
                second_battalion.id,
                prefixed_number.id,
                suffixed_number.id,
            ],
        )
        .await;

        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::NaturalMilitarySortAsc),
                after_unit_id: Some(first_battalion.id),
                filter_text: Some("123 мсп".to_string()),
                search_mode: Some(ListUnitsSearchMode::Relaxed),
                limit: Some(2),
                ..Default::default()
            },
            &[second_battalion.id, prefixed_number.id],
        )
        .await;
        let final_page = read_units(
            &env.dbx,
            &ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::NaturalMilitarySortAsc),
                after_unit_id: Some(prefixed_number.id),
                filter_text: Some("123 мсп".to_string()),
                search_mode: Some(ListUnitsSearchMode::Relaxed),
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            final_page
                .units
                .into_iter()
                .map(|unit| unit.id)
                .collect::<Vec<_>>(),
            vec![suffixed_number.id]
        );
        assert!(!final_page.show_load_more);

        let misleading_division = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("2 мсб 1220 мсп 3 мсд 20 А".to_string()),
                battalion: Set("2 мсб".to_string()),
                regiment: Set("1220 мсп".to_string()),
                division: Set("3 мсд".to_string()),
                army: Set("20 А".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let matching_prefix = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("3 мсб 1220 мсп 3 мсд 20 А".to_string()),
                battalion: Set("3 мсб".to_string()),
                regiment: Set("1220 мсп".to_string()),
                division: Set("3 мсд".to_string()),
                army: Set("20 А".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::NaturalMilitarySortAsc),
                filter_text: Some("3 мсб 1220 мсп".to_string()),
                ..Default::default()
            },
            &[matching_prefix.id, misleading_division.id],
        )
        .await;
    }

    #[tokio::test]
    #[serial]
    async fn unit_list_filters_and_sorts_duplicate_and_orbit_states() {
        let env = cleanup().await.unwrap();
        let linked_candidate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("A linked candidate".to_string()),
                active: Set(true),
                is_deduplicate_candidate: Set(Some(true)),
                orbit_note: Set(Some("Orbit comment".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let regular = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("B regular".to_string()),
                active: Set(true),
                is_deduplicate_candidate: Set(Some(false)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unreviewed = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("C unreviewed".to_string()),
                active: Set(true),
                is_deduplicate_candidate: Set(None),
                orbit_note: Set(Some("Second comment".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, linked_candidate.id).await;

        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_is_deduplicate_candidate: Some(true),
                ..Default::default()
            },
            &[linked_candidate.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_is_deduplicate_candidate: Some(false),
                sort_by: Some(ListUnitsSortBy::UnitNameAsc),
                ..Default::default()
            },
            &[regular.id, unreviewed.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_has_orbit: Some(true),
                ..Default::default()
            },
            &[linked_candidate.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_has_orbit: Some(false),
                sort_by: Some(ListUnitsSortBy::UnitNameAsc),
                ..Default::default()
            },
            &[regular.id, unreviewed.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_has_orbit_note: Some(true),
                sort_by: Some(ListUnitsSortBy::UnitNameAsc),
                ..Default::default()
            },
            &[linked_candidate.id, unreviewed.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                filter_has_orbit_note: Some(false),
                ..Default::default()
            },
            &[regular.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::UnitOrbitLinkedDesc),
                ..Default::default()
            },
            &[linked_candidate.id, regular.id, unreviewed.id],
        )
        .await;
        assert_listed_unit_ids(
            &env.dbx,
            ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::UnitOrbitLinkedAsc),
                ..Default::default()
            },
            &[regular.id, unreviewed.id, linked_candidate.id],
        )
        .await;
    }

    async fn assert_only_active_orbit_hierarchy(
        dbx: &DatabaseConnection,
        orbit_unit_ids: &[uuid::Uuid],
        expected_active_orbit_unit_ids: &[uuid::Uuid],
    ) {
        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .is_in(orbit_unit_ids.iter().copied()),
            )
            .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
            .all(dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), expected_active_orbit_unit_ids.len());
        assert_eq!(
            links
                .iter()
                .map(|link| link.orbit_unit_id)
                .collect::<BTreeSet<_>>(),
            expected_active_orbit_unit_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
        );
        let linked_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), expected_active_orbit_unit_ids.len());
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
    async fn create_unit_merges_requested_duplicates_after_insert() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, duplicate.id).await;
        let mut req = auto_req(true, vec![], vec![]);
        req.unit.duplicate_unit_ids = vec![duplicate.id, duplicate.id];

        let rsp = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap();

        assert_ne!(rsp.unit.id, duplicate.id);
        assert!(
            sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            !sigint_unit::Entity::find_by_id(rsp.unit.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
    }

    #[tokio::test]
    #[serial]
    async fn unit_creation_rejects_suppressed_duplicate_candidate() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit_id =
            link_current_duplicate_candidate(&env.dbx, duplicate.id).await;
        let mut req = auto_req(true, vec![], vec![]);
        req.unit.duplicate_unit_ids = vec![duplicate.id];
        assert!(orbit::create_unit_duplicate_candidate_ids_for_req(
            &env.dbx, &req.unit,
        )
        .await
        .unwrap()
        .contains(&duplicate.id));
        let link = orbit_unit_sigint_unit::Entity::find_by_id((
            orbit_unit_id,
            duplicate.id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        let mut link = link.into_active_model();
        link.is_suppressed = Set(true);
        link.update(&env.dbx).await.unwrap();
        let unit_count_before = unit_count(&env.dbx).await;

        let err = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(unit_count(&env.dbx).await, unit_count_before);
        assert!(
            !sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
    }

    #[tokio::test]
    #[serial]
    async fn unit_creation_rolls_back_for_stale_duplicates() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let auto_duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, auto_duplicate.id).await;
        delete_unit_for_login(&env.dbx, &login_id, auto_duplicate.id)
            .await
            .unwrap();
        let mut req = auto_req(false, vec!["Роботине"], vec!["2 шр"]);
        req.unit.duplicate_unit_ids = vec![auto_duplicate.id];
        let unit_count_before = unit_count(&env.dbx).await;

        let err = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(unit_count(&env.dbx).await, unit_count_before);
        assert_eq!(network_count(&env.dbx).await, 0);

        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, duplicate.id).await;
        delete_unit_for_login(&env.dbx, &login_id, duplicate.id)
            .await
            .unwrap();
        let mut req = unit_req();
        req.duplicate_unit_ids = vec![duplicate.id];
        let unit_count_before = unit_count(&env.dbx).await;

        let err = create_unit_for_login(&login_id, &env, req)
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::BL { .. }));
        assert_eq!(unit_count(&env.dbx).await, unit_count_before);
        assert_eq!(
            sigint_unit::Entity::find()
                .filter(sigint_unit::Column::Deleted.eq(false))
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_with_auto_network_skips_network_after_merge() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, duplicate.id).await;
        let existing_network = create_device_network_for_login(
            &login_id,
            &env,
            CreateDeviceNetworkReq {
                unit_id: duplicate.id,
                locations: vec!["Роботине".to_string()],
                unit_mask: Vec::new(),
            },
        )
        .await
        .unwrap();
        let mut req = auto_req(false, vec!["Роботине"], vec!["2 шр"]);
        req.unit.duplicate_unit_ids = vec![duplicate.id];

        let rsp = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap();

        assert_eq!(rsp.network_id, Some(existing_network.network_id));
        assert_eq!(network_count(&env.dbx).await, 1);
        assert!(unit_has_active_network(&env.dbx, rsp.unit.id)
            .await
            .unwrap());
        let relation = sigint_network_unit::Entity::find()
            .filter(
                sigint_network_unit::Column::NetworkId
                    .eq(existing_network.network_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(relation.unit_id, rsp.unit.id);
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_rejects_multiple_inherited_active_networks() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let login_id = test_login_id(&env).await;
        let first_duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit_id =
            link_current_duplicate_candidate(&env.dbx, first_duplicate.id)
                .await;
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(second_duplicate.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        for unit_id in [first_duplicate.id, second_duplicate.id] {
            create_device_network_for_login(
                &login_id,
                &env,
                CreateDeviceNetworkReq {
                    unit_id,
                    locations: vec!["Роботине".to_string()],
                    unit_mask: Vec::new(),
                },
            )
            .await
            .unwrap();
        }
        let mut req = auto_req(false, vec!["Роботине"], vec!["2 шр"]);
        req.unit.duplicate_unit_ids =
            vec![first_duplicate.id, second_duplicate.id];
        let candidate_ids = orbit::create_unit_duplicate_candidate_ids_for_req(
            &env.dbx, &req.unit,
        )
        .await
        .unwrap();
        assert!(candidate_ids.contains(&first_duplicate.id));
        assert!(candidate_ids.contains(&second_duplicate.id));

        let err = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap_err();

        assert!(matches!(
            err,
            AppError::BL { msg } if msg == "unit has multiple active networks"
        ));
        assert_eq!(unit_count(&env.dbx).await, 2);
        assert_eq!(network_count(&env.dbx).await, 2);
        let network_unit_ids = sigint_network_unit::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|network_unit| network_unit.unit_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            network_unit_ids,
            BTreeSet::from([first_duplicate.id, second_duplicate.id])
        );
    }

    #[tokio::test]
    #[serial]
    async fn create_unit_ignores_orbit_fields_when_orbit_data_is_hidden() {
        let env = cleanup().await.unwrap();
        insert_settings(&env.dbx, true).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        link_current_duplicate_candidate(&env.dbx, duplicate.id).await;
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
        req.unit.orbit_note = Some("Hidden note".to_string());
        req.unit.present_in_orbit = Some(true);
        req.unit.duplicate_unit_ids = vec![duplicate.id];

        let rsp = create_unit_with_auto_network_for_login(&login_id, &env, req)
            .await
            .unwrap();
        let unit = sigint_unit::Entity::find_by_id(rsp.unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(unit.orbit_note, None);
        assert_eq!(unit.present_in_orbit, None);
        assert!(
            !sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
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
        let other_echelon_id = uuid::Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(other_echelon_id),
            key: Set("other".to_string()),
            name: Set(format!("Інше-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let other_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(other_unit_id),
            unit_name_short: Set(Some("ВМФ".to_string())),
            unit_echelon_id: Set(Some(other_echelon_id)),
            generative_parent_unit_id: Set(Some(orbit_fixture.unit_ids[5])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        update_orbit_parents(
            &env.dbx,
            orbit_fixture.unit_ids[4],
            Some(other_unit_id),
            None,
        )
        .await;
        orbit_fixture.unit_ids.push(other_unit_id);
        orbit_fixture.echelon_ids.push(other_echelon_id);

        let rsp = orbit::import_orbit_unit_for_login(
            &login_id,
            &env,
            orbit_fixture.root_unit_id,
        )
        .await
        .unwrap();

        assert_eq!(rsp.unit.company, "1 рота");
        assert_eq!(rsp.unit.battalion, "2 бат");
        assert_eq!(rsp.unit.brigade, "55 мбр");
        assert_eq!(rsp.unit.division, "45 див");
        assert_eq!(rsp.unit.army, "20 ЗВА");
        assert_eq!(rsp.unit.military_district, "Західний ВО");
        assert_eq!(rsp.unit.army_region, "ЗС РФ");
        assert_eq!(rsp.unit.other, "ВМФ");
        assert_eq!(rsp.unit.name, "1 рота 2 бат 55 мбр 45 див 20 ЗВА");
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
                "ВМФ 1 рота 2 бат 55 мбр 45 див 20 ЗВА Західний ВО ЗС РФ",
                "ЗС РФ Західний ВО 20 ЗВА 45 див 55 мбр 2 бат 1 рота ВМФ",
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
        assert_eq!(links.len(), 8);
        assert!(links.iter().any(|link| link.orbit_unit_id == other_unit_id));
        let linked_unit_ids = links
            .into_iter()
            .map(|link| link.sigint_unit_id)
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), 8);
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
    async fn imports_every_unlinked_orbit_unit_as_inactive() {
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
        assert!(imported_units.iter().all(|unit| !unit.name.is_empty()));
        let military_district = imported_units
            .iter()
            .find(|unit| {
                unit.army.is_empty() && !unit.military_district.is_empty()
            })
            .unwrap();
        assert_eq!(military_district.name, "Повна назва Західний ВО");
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
    async fn imports_corps_only_orbit_unit_with_its_full_name() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login_id = test_login_id(&env).await;
        let echelon_id = uuid::Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(echelon_id),
            key: Set("corps".to_string()),
            name: Set(format!("Корпус-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            unit_name: Set(Some("Повна назва армійського корпусу".to_string())),
            unit_name_short: Set(Some("11 АК".to_string())),
            unit_echelon_id: Set(Some(echelon_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert_eq!(
            orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
                .await
                .unwrap(),
            1
        );

        let link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let unit = sigint_unit::Entity::find_by_id(link.sigint_unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.corps, "11 АК");
        assert_eq!(unit.name, "Повна назва армійського корпусу");
        assert!(!unit.active);
    }

    #[tokio::test]
    #[serial]
    async fn imports_lower_orbit_echelon_using_unit_number() {
        let env = cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let login_id = test_login_id(&env).await;
        let echelon_id = uuid::Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(echelon_id),
            key: Set("teamOrCrew".to_string()),
            name: Set(format!("Розрахунок-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            unit_number: Set(Some("5101".to_string())),
            unit_echelon_id: Set(Some(echelon_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let imported = orbit::import_unlinked_orbit_units(&env.dbx, &login_id)
            .await
            .unwrap();

        assert_eq!(imported, 1);
        let link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let unit = sigint_unit::Entity::find_by_id(link.sigint_unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.team_or_crew, "5101");
        assert!(!unit.active);
    }

    #[tokio::test]
    #[serial]
    async fn skips_unsupported_orbit_units_and_imports_later_units() {
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
    async fn manual_orbit_link_creates_only_generative_parent_chain() {
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

        assert_only_active_orbit_hierarchy(
            &env.dbx,
            &orbit_fixture.unit_ids,
            &[
                orbit_fixture.unit_ids[0],
                orbit_fixture.unit_ids[2],
                orbit_fixture.unit_ids[3],
                orbit_fixture.unit_ids[4],
                orbit_fixture.unit_ids[6],
            ],
        )
        .await;
    }

    #[tokio::test]
    #[serial]
    async fn automatic_orbit_link_creates_only_generative_parent_chain() {
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

        assert_only_active_orbit_hierarchy(
            &env.dbx,
            &orbit_fixture.unit_ids,
            &[
                orbit_fixture.unit_ids[0],
                orbit_fixture.unit_ids[2],
                orbit_fixture.unit_ids[3],
                orbit_fixture.unit_ids[4],
                orbit_fixture.unit_ids[6],
            ],
        )
        .await;
    }

    #[tokio::test]
    #[serial]
    async fn oneoff_activates_only_linked_generative_ancestors() {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
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
        let linked_units_by_orbit_id = links
            .iter()
            .map(|link| (link.orbit_unit_id, link.sigint_unit_id))
            .collect::<HashMap<_, _>>();
        let linked_unit_ids = linked_units_by_orbit_id
            .values()
            .copied()
            .collect::<Vec<_>>();
        let linked_units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Id.is_in(linked_unit_ids))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(linked_units.len(), 7);
        let operational_unit_id =
            linked_units_by_orbit_id[&orbit_fixture.unit_ids[1]];
        assert!(linked_units
            .iter()
            .all(|unit| { unit.active == (unit.id != operational_unit_id) }));
    }

    #[tokio::test]
    #[serial]
    async fn orbit_link_reconciliation_updates_existing_candidates() {
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
            &login_id,
            explicit_false.id,
            orbit_unit_id,
        )
        .await
        .unwrap();
        crate::orbit::unlink_sigint_unit_with_lock(
            &env.dbx,
            &login_id,
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

    #[tokio::test]
    #[serial]
    async fn delete_unit_enqueues_linked_stats_recalculation() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group = crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(inbox_item.id),
                group_master_key: Set(Some(group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(inbox_item.id),
            unit_id: Set(unit.id),
            kind: Set(
                crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind::Parsed,
            ),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        delete_unit_for_login(&env.dbx, &login_id, unit.id)
            .await
            .unwrap();

        let task = group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::GroupMasterKey
                    .eq(group.master_key),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task.reason, format!("deleted unit {}", unit.id));
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
        let mut surviving = surviving.into_active_model();
        surviving.name = Set("Custom survivor".to_string());
        let surviving = surviving.update(&env.dbx).await.unwrap();
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
        assert_eq!(merged.name, "Custom survivor");
        assert!(active(&env.dbx, old_parent.id).await);
        assert!(active(&env.dbx, new_parent.id).await);
    }

    #[tokio::test]
    #[serial]
    async fn merge_units_keeps_higher_echelons_out_of_generated_name() {
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

        assert_eq!(merged.name, "CompanyToken");
        assert_eq!(merged.military_district, "DistrictToken");
        assert_eq!(merged.army_region, "RegionToken");
        let search_matches = env
            .dbx
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT search_tsv @@ plainto_tsquery('russian', $1) AS matches FROM sigint_unit WHERE id = $2",
                ["CompanyToken".into(), merged.id.into()],
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
    async fn orbit_merge_policy_preserves_a_derived_survivor_name() {
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
                brigade: Set("BrigadeToken".to_string()),
                name: Set("BrigadeToken".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let transaction = env.dbx.begin().await.unwrap();

        let merged = merge_units_in_transaction_preserving_name(
            login_id,
            &transaction,
            duplicate.id,
            surviving.id,
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();

        assert_eq!(merged.name, "CompanyToken");
        assert_eq!(merged.company, "CompanyToken");
        assert_eq!(merged.brigade, "BrigadeToken");
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
                present_in_orbit: Set(Some(true)),
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
        assert_eq!(unit.present_in_orbit, Some(true));
    }

    #[tokio::test]
    #[serial]
    async fn unit_update_changes_present_in_orbit() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                present_in_orbit: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut req = UpdateUnitReq::from(render_unit(&unit).unwrap());
        req.present_in_orbit = Some(Some(false));

        let unit = update_unit_for_login(&env.dbx, &login_id, &req, true)
            .await
            .unwrap();
        assert_eq!(unit.present_in_orbit, Some(false));

        let mut req = UpdateUnitReq::from(render_unit(&unit).unwrap());
        req.present_in_orbit = Some(None);
        let unit = update_unit_for_login(&env.dbx, &login_id, &req, true)
            .await
            .unwrap();
        assert_eq!(unit.present_in_orbit, None);
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
                present_in_orbit: Set(Some(false)),
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
        assert_eq!(unit.present_in_orbit, Some(false));
        assert_eq!(unit.comment, "updated");
    }

    #[tokio::test]
    #[serial]
    async fn blank_generated_name_preserves_the_existing_unit_name() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                other: Set("ВМФ".to_string()),
                corps: Set("11 АК".to_string()),
                military_district: Set("Західний ВО".to_string()),
                army_region: Set("ЗС РФ".to_string()),
                name: Set("Повна назва підрозділу".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let rendered = render_unit(&unit).unwrap();
        assert_eq!(unit_name(&rendered), "Повна назва підрозділу");
        let mut req = UpdateUnitReq::from(rendered);
        req.name.clear();

        let unit = update_unit_for_login(&env.dbx, &login_id, &req, true)
            .await
            .unwrap();

        assert_eq!(unit.name, "Повна назва підрозділу");
    }

    #[test]
    fn redact_unit_orbit_data_hides_orbit_fields() {
        let mut unit = Unit {
            id: 1,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            battalion: String::new(),
            regiment: String::new(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            comment: String::new(),
            orbit_note: Some("Orbit note".to_string()),
            present_in_orbit: Some(true),
            name: String::new(),
            active: true,
            is_deduplicate_candidate: Some(true),
            created_at: 0,
            created_by_login_id: String::new(),
            has_orbit: true,
            orbit_unit_ids: vec![Uuid::nil().to_string()],
            orbit_unit_generative_names: vec!["106 пдд / МВО".to_string()],
        };

        redact_unit_orbit_data(&mut unit);

        assert!(!unit.has_orbit);
        assert!(unit.orbit_unit_ids.is_empty());
        assert!(unit.orbit_unit_generative_names.is_empty());
        assert_eq!(unit.orbit_note, None);
        assert_eq!(unit.present_in_orbit, None);
        assert_eq!(unit.is_deduplicate_candidate, None);
    }

    #[tokio::test]
    #[serial]
    async fn orbit_visibility_populates_and_redacts_all_orbit_fields() {
        let env = cleanup().await.unwrap();
        let sigint_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                orbit_note: Set(Some("Orbit note".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit_id = uuid::Uuid::new_v4();
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
        let mut unit = render_unit(&sigint_unit).unwrap();

        apply_unit_orbit_visibility(&env.dbx, &mut unit, true)
            .await
            .unwrap();

        assert!(unit.has_orbit);
        assert_eq!(unit.orbit_unit_ids, vec![orbit_unit_id.to_string()]);
        assert_eq!(
            unit.orbit_unit_generative_names,
            vec!["106 пдд / МВО".to_string()]
        );

        apply_unit_orbit_visibility(&env.dbx, &mut unit, false)
            .await
            .unwrap();

        assert!(!unit.has_orbit);
        assert!(unit.orbit_unit_ids.is_empty());
        assert!(unit.orbit_unit_generative_names.is_empty());
        assert_eq!(unit.orbit_note, None);
    }

    #[tokio::test]
    #[serial]
    async fn unit_merge_transaction_rolls_back_related_data() {
        let env = cleanup().await.unwrap();
        let login_id = test_login_id(&env).await;
        let duplicate = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let surviving = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(duplicate.id),
            label: Set(format!("merge-label-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let transaction = env.dbx.begin().await.unwrap();
        merge_units_in_transaction(
            login_id,
            &transaction,
            duplicate.id,
            surviving.id,
        )
        .await
        .unwrap();
        transaction.rollback().await.unwrap();

        assert_eq!(
            sigint_unit_label::Entity::find_by_id(label.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .sigint_unit_id,
            duplicate.id
        );
        assert!(
            !sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
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
        let unrelated = crate::functest::tests::mk_sigint_unit(
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
        let label = sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(duplicate.id),
            label: Set(format!("merge-label-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let inbox_item_unit = sigint_inbox_item_unit::ActiveModel {
            item_id: Set(inbox_item.id),
            unit_id: Set(duplicate.id),
            kind: Set(
                crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind::Parsed,
            ),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let merged =
            merge_units(login_id, &env.dbx, duplicate.id, surviving.id)
                .await
                .unwrap();

        assert_eq!(merged.id, surviving.id);
        assert!(!merged.deleted);
        assert_eq!(merged.is_deduplicate_candidate, Some(true));
        assert_eq!(
            sigint_unit::Entity::find_by_id(unrelated.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .is_deduplicate_candidate,
            Some(true)
        );
        assert_eq!(merged.orbit_note.as_deref(), Some("Duplicate Orbit note"));
        assert_eq!(
            sigint_unit_label::Entity::find_by_id(label.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .sigint_unit_id,
            surviving.id
        );
        assert_eq!(
            sigint_inbox_item_unit::Entity::find_by_id(inbox_item_unit.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .unit_id,
            surviving.id
        );
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
