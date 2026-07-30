use super::types::{OrbitDictionaryValue, OrbitUnitDetails};
use crate::config::ROLE_ADMIN;
use crate::entities::*;
use crate::error::AppError;
use crate::users::has_role;
use crate::{h, types::ShortContext};
use sea_orm::*;
use std::collections::HashSet;
use uuid::Uuid;

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
