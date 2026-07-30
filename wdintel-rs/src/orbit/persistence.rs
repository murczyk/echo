use crate::config::ORBIT_STALE_GRACE_SECONDS;
use crate::entities::orbit_unit;
use crate::error::AppError;
use crate::h;
use crate::orbit::dictionary::{DictionaryKind, DictionaryMaps};
use crate::orbit::hierarchy::HierarchyUnit;
use crate::types::ShortContext;
use chrono::{Duration, NaiveDateTime};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, QueryFilter,
};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportUnit {
    pub unit_id: Uuid,
    pub unit_name: Option<String>,
    pub unit_name_original: Option<String>,
    pub unit_name_short: Option<String>,
    pub operational_unit_name_full: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub unit_number: Option<String>,
    pub unit_alternate_names: Option<Vec<String>>,
    pub unit_alternate_numbers: Option<Vec<String>>,
    pub unit_echelon_id: Option<Uuid>,
    pub combat_unit_type_id: Option<Uuid>,
    pub grouping_of_forces_id: Option<Uuid>,
    pub generative_parent_unit_id: Option<Uuid>,
    pub operational_parent_unit_id: Option<Uuid>,
    pub partial: bool,
}

#[derive(Debug, Clone)]
pub enum ImportState {
    New,
    Unchanged(orbit_unit::Model),
    Changed(orbit_unit::Model),
    Deleted(orbit_unit::Model),
}

impl ImportUnit {
    pub fn from_hierarchy(
        unit: HierarchyUnit,
        dictionaries: &DictionaryMaps,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            unit_id: unit.data.unit_id,
            unit_name: unit.data.unit_name,
            unit_name_original: unit.data.unit_name_original,
            unit_name_short: unit.data.unit_name_short,
            operational_unit_name_full: unit.data.operational_unit_name_full,
            generative_unit_name_full: unit.data.generative_unit_name_full,
            unit_number: unit.data.unit_number,
            unit_alternate_names: unit.data.unit_alternate_names,
            unit_alternate_numbers: unit.data.unit_alternate_numbers,
            unit_echelon_id: dictionaries.resolve(
                DictionaryKind::UnitEchelon,
                unit.data.unit_echelon.as_ref(),
            )?,
            combat_unit_type_id: dictionaries.resolve(
                DictionaryKind::CombatUnitType,
                unit.data.combat_unit_type.as_ref(),
            )?,
            grouping_of_forces_id: dictionaries.resolve(
                DictionaryKind::GroupingOfForces,
                unit.data.grouping_of_forces.as_ref(),
            )?,
            generative_parent_unit_id: unit.generative_parent_unit_id,
            operational_parent_unit_id: unit.operational_parent_unit_id,
            partial: unit.partial,
        })
    }

    pub fn display_name(&self) -> String {
        self.unit_name_short
            .clone()
            .or_else(|| self.unit_name.clone())
            .unwrap_or_else(|| self.unit_id.to_string())
    }

    pub fn has_rejected_parent(
        &self,
        rejected: &std::collections::HashSet<Uuid>,
    ) -> bool {
        [
            self.generative_parent_unit_id,
            self.operational_parent_unit_id,
        ]
        .into_iter()
        .flatten()
        .any(|parent_id| rejected.contains(&parent_id))
    }
}

pub fn classify(
    unit: &ImportUnit,
    existing: Option<&orbit_unit::Model>,
) -> ImportState {
    let Some(existing) = existing else {
        return ImportState::New;
    };
    if existing.deleted {
        return ImportState::Deleted(existing.clone());
    }
    if same_data(unit, existing) {
        ImportState::Unchanged(existing.clone())
    } else {
        ImportState::Changed(existing.clone())
    }
}

pub async fn load_existing(
    db: &DatabaseConnection,
) -> Result<HashMap<Uuid, orbit_unit::Model>, AppError> {
    Ok(orbit_unit::Entity::find()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect())
}

pub async fn insert_unit(
    db: &DatabaseConnection,
    unit: &ImportUnit,
    started_at: NaiveDateTime,
) -> Result<orbit_unit::Model, AppError> {
    orbit_unit::ActiveModel {
        unit_id: Set(unit.unit_id),
        unit_name: Set(unit.unit_name.clone()),
        unit_name_original: Set(unit.unit_name_original.clone()),
        unit_name_short: Set(unit.unit_name_short.clone()),
        operational_unit_name_full: Set(unit
            .operational_unit_name_full
            .clone()),
        generative_unit_name_full: Set(unit.generative_unit_name_full.clone()),
        unit_number: Set(unit.unit_number.clone()),
        unit_alternate_names: Set(unit.unit_alternate_names.clone()),
        unit_alternate_numbers: Set(unit.unit_alternate_numbers.clone()),
        unit_echelon_id: Set(unit.unit_echelon_id),
        combat_unit_type_id: Set(unit.combat_unit_type_id),
        grouping_of_forces_id: Set(unit.grouping_of_forces_id),
        generative_parent_unit_id: Set(unit.generative_parent_unit_id),
        operational_parent_unit_id: Set(unit.operational_parent_unit_id),
        deleted: Set(false),
        created_at: Set(started_at),
        updated_at: Set(started_at),
    }
    .insert(db)
    .await
    .c(h!())
    .map_err(Into::into)
}

pub async fn update_unit(
    db: &DatabaseConnection,
    existing: orbit_unit::Model,
    unit: &ImportUnit,
    started_at: NaiveDateTime,
) -> Result<orbit_unit::Model, AppError> {
    let mut existing = existing.into_active_model();
    existing.unit_name = Set(unit.unit_name.clone());
    existing.unit_name_original = Set(unit.unit_name_original.clone());
    existing.unit_name_short = Set(unit.unit_name_short.clone());
    existing.operational_unit_name_full =
        Set(unit.operational_unit_name_full.clone());
    existing.generative_unit_name_full =
        Set(unit.generative_unit_name_full.clone());
    existing.unit_number = Set(unit.unit_number.clone());
    existing.unit_alternate_names = Set(unit.unit_alternate_names.clone());
    existing.unit_alternate_numbers = Set(unit.unit_alternate_numbers.clone());
    existing.unit_echelon_id = Set(unit.unit_echelon_id);
    existing.combat_unit_type_id = Set(unit.combat_unit_type_id);
    existing.grouping_of_forces_id = Set(unit.grouping_of_forces_id);
    existing.generative_parent_unit_id = Set(unit.generative_parent_unit_id);
    existing.operational_parent_unit_id = Set(unit.operational_parent_unit_id);
    existing.deleted = Set(false);
    existing.updated_at = Set(started_at);
    existing.update(db).await.c(h!()).map_err(Into::into)
}

pub async fn touch_unit(
    db: &DatabaseConnection,
    unit_id: Uuid,
    started_at: NaiveDateTime,
) -> Result<(), AppError> {
    orbit_unit::Entity::update_many()
        .col_expr(
            orbit_unit::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(started_at),
        )
        .filter(orbit_unit::Column::UnitId.eq(unit_id))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn load_stale(
    db: &DatabaseConnection,
    started_at: NaiveDateTime,
) -> Result<Vec<orbit_unit::Model>, AppError> {
    let stale_before =
        started_at - Duration::seconds(ORBIT_STALE_GRACE_SECONDS);
    orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::UpdatedAt.lt(stale_before))
        .all(db)
        .await
        .c(h!())
        .map_err(Into::into)
}

pub async fn soft_delete(
    db: &DatabaseConnection,
    unit: orbit_unit::Model,
    started_at: NaiveDateTime,
) -> Result<(), AppError> {
    let mut unit = unit.into_active_model();
    unit.deleted = Set(true);
    unit.updated_at = Set(started_at);
    unit.update(db).await.c(h!())?;
    Ok(())
}

pub fn diff_lines(
    unit: &ImportUnit,
    existing: Option<&orbit_unit::Model>,
    dictionaries: &DictionaryMaps,
    unit_names: &HashMap<Uuid, String>,
) -> Vec<String> {
    let new_values = import_details(unit, dictionaries, unit_names);
    let Some(existing) = existing else {
        return new_values
            .into_iter()
            .map(|(key, value)| format!("{key}: {value}"))
            .collect();
    };
    let old_values = model_details(existing, dictionaries, unit_names);
    new_values
        .into_iter()
        .filter_map(|(key, new)| {
            let old = old_values.get(&key).cloned().unwrap_or_default();
            (old != new).then(|| format!("{key}: {old} -> {new}"))
        })
        .collect()
}

fn same_data(unit: &ImportUnit, existing: &orbit_unit::Model) -> bool {
    unit.unit_name == existing.unit_name
        && unit.unit_name_original == existing.unit_name_original
        && unit.unit_name_short == existing.unit_name_short
        && unit.operational_unit_name_full
            == existing.operational_unit_name_full
        && unit.generative_unit_name_full == existing.generative_unit_name_full
        && unit.unit_number == existing.unit_number
        && unit.unit_alternate_names == existing.unit_alternate_names
        && unit.unit_alternate_numbers == existing.unit_alternate_numbers
        && unit.unit_echelon_id == existing.unit_echelon_id
        && unit.combat_unit_type_id == existing.combat_unit_type_id
        && unit.grouping_of_forces_id == existing.grouping_of_forces_id
        && unit.generative_parent_unit_id == existing.generative_parent_unit_id
        && unit.operational_parent_unit_id
            == existing.operational_parent_unit_id
}

fn import_details(
    unit: &ImportUnit,
    dictionaries: &DictionaryMaps,
    unit_names: &HashMap<Uuid, String>,
) -> BTreeMap<String, String> {
    DetailValues {
        unit_id: unit.unit_id,
        unit_name: unit.unit_name.as_deref(),
        unit_name_original: unit.unit_name_original.as_deref(),
        unit_name_short: unit.unit_name_short.as_deref(),
        operational_unit_name_full: unit.operational_unit_name_full.as_deref(),
        generative_unit_name_full: unit.generative_unit_name_full.as_deref(),
        unit_number: unit.unit_number.as_deref(),
        unit_alternate_names: unit.unit_alternate_names.as_deref(),
        unit_alternate_numbers: unit.unit_alternate_numbers.as_deref(),
        unit_echelon: dictionaries.summary(unit.unit_echelon_id),
        combat_unit_type: dictionaries.summary(unit.combat_unit_type_id),
        grouping_of_forces: dictionaries.summary(unit.grouping_of_forces_id),
        generative_parent: parent_summary(
            unit.generative_parent_unit_id,
            unit_names,
        ),
        operational_parent: parent_summary(
            unit.operational_parent_unit_id,
            unit_names,
        ),
    }
    .into_map()
}

fn model_details(
    unit: &orbit_unit::Model,
    dictionaries: &DictionaryMaps,
    unit_names: &HashMap<Uuid, String>,
) -> BTreeMap<String, String> {
    DetailValues {
        unit_id: unit.unit_id,
        unit_name: unit.unit_name.as_deref(),
        unit_name_original: unit.unit_name_original.as_deref(),
        unit_name_short: unit.unit_name_short.as_deref(),
        operational_unit_name_full: unit.operational_unit_name_full.as_deref(),
        generative_unit_name_full: unit.generative_unit_name_full.as_deref(),
        unit_number: unit.unit_number.as_deref(),
        unit_alternate_names: unit.unit_alternate_names.as_deref(),
        unit_alternate_numbers: unit.unit_alternate_numbers.as_deref(),
        unit_echelon: dictionaries.summary(unit.unit_echelon_id),
        combat_unit_type: dictionaries.summary(unit.combat_unit_type_id),
        grouping_of_forces: dictionaries.summary(unit.grouping_of_forces_id),
        generative_parent: parent_summary(
            unit.generative_parent_unit_id,
            unit_names,
        ),
        operational_parent: parent_summary(
            unit.operational_parent_unit_id,
            unit_names,
        ),
    }
    .into_map()
}

struct DetailValues<'a> {
    unit_id: Uuid,
    unit_name: Option<&'a str>,
    unit_name_original: Option<&'a str>,
    unit_name_short: Option<&'a str>,
    operational_unit_name_full: Option<&'a str>,
    generative_unit_name_full: Option<&'a str>,
    unit_number: Option<&'a str>,
    unit_alternate_names: Option<&'a [String]>,
    unit_alternate_numbers: Option<&'a [String]>,
    unit_echelon: String,
    combat_unit_type: String,
    grouping_of_forces: String,
    generative_parent: String,
    operational_parent: String,
}

impl DetailValues<'_> {
    fn into_map(self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("unit_id".to_string(), self.unit_id.to_string()),
            ("unit_name".to_string(), show(self.unit_name)),
            (
                "unit_name_original".to_string(),
                show(self.unit_name_original),
            ),
            ("unit_name_short".to_string(), show(self.unit_name_short)),
            (
                "operational_unit_name_full".to_string(),
                show(self.operational_unit_name_full),
            ),
            (
                "generative_unit_name_full".to_string(),
                show(self.generative_unit_name_full),
            ),
            ("unit_number".to_string(), show(self.unit_number)),
            (
                "unit_alternate_names".to_string(),
                show_list(self.unit_alternate_names),
            ),
            (
                "unit_alternate_numbers".to_string(),
                show_list(self.unit_alternate_numbers),
            ),
            ("unit_echelon".to_string(), self.unit_echelon),
            ("combat_unit_type".to_string(), self.combat_unit_type),
            ("grouping_of_forces".to_string(), self.grouping_of_forces),
            ("generative_parent".to_string(), self.generative_parent),
            ("operational_parent".to_string(), self.operational_parent),
        ])
    }
}

fn parent_summary(
    unit_id: Option<Uuid>,
    unit_names: &HashMap<Uuid, String>,
) -> String {
    unit_id
        .map(|unit_id| {
            let name = unit_names
                .get(&unit_id)
                .cloned()
                .unwrap_or_else(|| "?".to_string());
            format!("{name} ({unit_id})")
        })
        .unwrap_or_else(|| "-".to_string())
}

fn show(value: Option<&str>) -> String {
    value.unwrap_or("-").to_string()
}

fn show_list(value: Option<&[String]>) -> String {
    value
        .map(|values| values.join(", "))
        .unwrap_or_else(|| "-".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::DictionaryValue;
    use crate::types::Mode;
    use chrono::{Timelike, Utc};
    use serde_json::json;

    #[test]
    fn classifies_equal_changed_and_deleted_rows() {
        let import = import_unit();
        let existing = model(&import, false);
        assert!(matches!(
            classify(&import, Some(&existing)),
            ImportState::Unchanged(_)
        ));
        let mut changed = import.clone();
        changed.unit_name = Some("changed".to_string());
        assert!(matches!(
            classify(&changed, Some(&existing)),
            ImportState::Changed(_)
        ));
        assert!(matches!(
            classify(&import, Some(&model(&import, true))),
            ImportState::Deleted(_)
        ));
        assert!(matches!(classify(&import, None), ImportState::New));
    }

    #[test]
    fn stale_cutoff_is_five_seconds_before_start() {
        let started_at = Utc::now().naive_utc();
        let started_at = started_at
            .with_nanosecond(started_at.nanosecond() / 1_000 * 1_000)
            .unwrap();
        let cutoff = started_at - Duration::seconds(ORBIT_STALE_GRACE_SECONDS);
        assert_eq!(
            started_at.signed_duration_since(cutoff),
            Duration::seconds(5)
        );
        assert!(cutoff - Duration::milliseconds(1) < cutoff);
    }

    #[tokio::test]
    async fn persists_hierarchy_touches_reactivation_and_soft_delete() {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let dictionaries = DictionaryMaps::load(&db).await.unwrap();
        let echelon_id = dictionaries
            .resolve(
                DictionaryKind::UnitEchelon,
                Some(&DictionaryValue {
                    key: json!("battalion"),
                    name: json!("Батальйон / дивізіон"),
                }),
            )
            .unwrap()
            .unwrap();

        let started_at = Utc::now().naive_utc();
        let started_at = started_at
            .with_nanosecond(started_at.nanosecond() / 1_000 * 1_000)
            .unwrap();
        let parent = import_unit();
        let mut child = import_unit();
        child.generative_parent_unit_id = Some(parent.unit_id);
        child.unit_echelon_id = Some(echelon_id);
        insert_unit(&db, &parent, started_at).await.unwrap();
        let child_row = insert_unit(&db, &child, started_at).await.unwrap();
        assert_eq!(child_row.created_at, started_at);
        assert_eq!(child_row.updated_at, started_at);
        assert!(matches!(
            classify(&child, Some(&child_row)),
            ImportState::Unchanged(_)
        ));

        let touched_at = started_at + Duration::seconds(1);
        touch_unit(&db, child.unit_id, touched_at).await.unwrap();
        let child_row = orbit_unit::Entity::find_by_id(child.unit_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(child_row.updated_at, touched_at);

        soft_delete(&db, child_row, touched_at).await.unwrap();
        let child_row = orbit_unit::Entity::find_by_id(child.unit_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(child_row.deleted);
        let child_row = update_unit(&db, child_row, &child, touched_at)
            .await
            .unwrap();
        assert!(!child_row.deleted);
        assert_eq!(child_row.created_at, started_at);

        soft_delete(&db, child_row, touched_at + Duration::seconds(1))
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(child.unit_id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(parent.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    fn import_unit() -> ImportUnit {
        ImportUnit {
            unit_id: Uuid::new_v4(),
            unit_name: Some("unit".to_string()),
            unit_name_original: None,
            unit_name_short: Some("u".to_string()),
            operational_unit_name_full: Some("u".to_string()),
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon_id: None,
            combat_unit_type_id: None,
            grouping_of_forces_id: None,
            generative_parent_unit_id: None,
            operational_parent_unit_id: None,
            partial: false,
        }
    }

    fn model(unit: &ImportUnit, deleted: bool) -> orbit_unit::Model {
        orbit_unit::Model {
            unit_id: unit.unit_id,
            unit_name: unit.unit_name.clone(),
            unit_name_original: unit.unit_name_original.clone(),
            unit_name_short: unit.unit_name_short.clone(),
            operational_unit_name_full: unit.operational_unit_name_full.clone(),
            generative_unit_name_full: unit.generative_unit_name_full.clone(),
            unit_number: unit.unit_number.clone(),
            unit_alternate_names: unit.unit_alternate_names.clone(),
            unit_alternate_numbers: unit.unit_alternate_numbers.clone(),
            unit_echelon_id: unit.unit_echelon_id,
            combat_unit_type_id: unit.combat_unit_type_id,
            grouping_of_forces_id: unit.grouping_of_forces_id,
            generative_parent_unit_id: unit.generative_parent_unit_id,
            operational_parent_unit_id: unit.operational_parent_unit_id,
            deleted,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }
}
