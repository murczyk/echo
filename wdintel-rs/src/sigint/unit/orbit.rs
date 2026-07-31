use super::types::{
    LinkOrbitUnitReq, OrbitDictionaryValue, OrbitUnitDetails,
    OrbitUnitLinkCandidate, OrbitUnitLinkCandidatesReq,
    OrbitUnitLinkCandidatesRsp,
};
use crate::config::ROLE_ADMIN;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_rer_role, has_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::*;
use sea_query::extension::postgres::PgExpr;
use sea_query::Expr;
use std::collections::HashSet;
use uuid::Uuid;

const ORBIT_LINK_CANDIDATE_LIMIT: u64 = 100;
const ORBIT_LINK_SEARCH_WORD_LIMIT: usize = 8;

pub async fn can_view_orbit_data(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<bool, AppError> {
    match has_role(dbx, login_id, ROLE_ADMIN).await {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(err) => Err(err),
    }
}

pub async fn unit_ids_with_orbit(
    dbx: &DatabaseConnection,
) -> Result<HashSet<i64>, AppError> {
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| link.sigint_unit_id)
        .collect())
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
        deleted: unit.deleted,
        created_at: unit.created_at.and_utc().timestamp_millis(),
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    })
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
    ensure_orbit_access(&env.dbx, &login).await?;
    let req = req.into_inner();
    let unit = find_available_sigint_unit(&env.dbx, req.unit_id).await?;
    let units = match req.search.as_deref() {
        Some(search) => manual_orbit_link_candidates(&env.dbx, search).await?,
        None => automatic_orbit_link_candidates(&env.dbx, &unit).await?,
    };
    Ok(Json(OrbitUnitLinkCandidatesRsp { units }))
}

#[post("/api/sigint/unit/orbit-link")]
pub async fn link_orbit_unit(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<LinkOrbitUnitReq>,
) -> Result<Json<()>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    ensure_orbit_access(&env.dbx, &login).await?;
    let req = req.into_inner();
    let orbit_unit_id =
        Uuid::parse_str(&req.orbit_unit_id).map_err(|_| AppError::BL {
            msg: "Invalid ORBIT unit ID".to_string(),
        })?;
    find_available_sigint_unit(&env.dbx, req.sigint_unit_id).await?;
    find_available_orbit_unit(&env.dbx, orbit_unit_id).await?;
    crate::orbit::link_sigint_unit_if_unlinked_with_lock(
        &env.dbx,
        req.sigint_unit_id,
        orbit_unit_id,
    )
    .await
    .c(h!())?;
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
    let mut condition =
        Condition::all().add(orbit_unit::Column::Deleted.eq(false));
    for word in words {
        let pattern = format!("%{word}%");
        condition = condition.add(
            Condition::any()
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
    let units = orbit_unit::Entity::find()
        .filter(condition)
        .order_by_asc(orbit_unit::Column::GenerativeUnitNameFull)
        .order_by_asc(orbit_unit::Column::OperationalUnitNameFull)
        .order_by_asc(orbit_unit::Column::UnitId)
        .limit(ORBIT_LINK_CANDIDATE_LIMIT)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(units.into_iter().map(render_orbit_unit_candidate).collect())
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

    #[test]
    fn orbit_search_words_splits_text_and_limits_terms() {
        assert_eq!(
            orbit_search_words("  53-зрбр / 20 ЗВА, МВО; extra words ignored"),
            vec![
                "53", "зрбр", "20", "ЗВА", "МВО", "extra", "words", "ignored"
            ]
        );
    }
}
