use crate::entities::{
    orbit_combat_unit_type, orbit_grouping_of_forces, orbit_unit_echelon,
};
use crate::orbit::types::{DictionaryValue, SourceUnit};
use crate::types::ShortContext;
use crate::{h, AppError};
use chrono::NaiveDateTime;
use sea_orm::{DatabaseConnection, EntityTrait};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DictionaryKey {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DictionaryKind {
    GroupingOfForces,
    CombatUnitType,
    UnitEchelon,
}

#[derive(Debug, Clone)]
pub struct DictionaryMaps {
    grouping_of_forces: HashMap<DictionaryKey, Uuid>,
    combat_unit_type: HashMap<DictionaryKey, Uuid>,
    unit_echelon: HashMap<DictionaryKey, Uuid>,
    summaries: HashMap<Uuid, String>,
}

impl DictionaryMaps {
    pub async fn load(db: &DatabaseConnection) -> Result<Self, AppError> {
        let grouping = orbit_grouping_of_forces::Entity::find()
            .all(db)
            .await
            .c(h!())?;
        let combat = orbit_combat_unit_type::Entity::find()
            .all(db)
            .await
            .c(h!())?;
        let echelon =
            orbit_unit_echelon::Entity::find().all(db).await.c(h!())?;
        let mut summaries = HashMap::new();
        let grouping_of_forces = grouping
            .into_iter()
            .map(|row| {
                summaries.insert(row.id, format!("{} ({})", row.name, row.key));
                (
                    DictionaryKey {
                        key: row.key,
                        name: row.name,
                    },
                    row.id,
                )
            })
            .collect();
        let combat_unit_type = combat
            .into_iter()
            .map(|row| {
                summaries.insert(row.id, format!("{} ({})", row.name, row.key));
                (
                    DictionaryKey {
                        key: row.key,
                        name: row.name,
                    },
                    row.id,
                )
            })
            .collect();
        let unit_echelon = echelon
            .into_iter()
            .map(|row| {
                summaries.insert(row.id, format!("{} ({})", row.name, row.key));
                (
                    DictionaryKey {
                        key: row.key,
                        name: row.name,
                    },
                    row.id,
                )
            })
            .collect();
        Ok(Self {
            grouping_of_forces,
            combat_unit_type,
            unit_echelon,
            summaries,
        })
    }

    pub fn resolve(
        &self,
        kind: DictionaryKind,
        value: Option<&DictionaryValue>,
    ) -> anyhow::Result<Option<Uuid>> {
        let Some(value) = value else {
            return Ok(None);
        };
        let key = normalize_dictionary(value)?;
        let values = match kind {
            DictionaryKind::GroupingOfForces => &self.grouping_of_forces,
            DictionaryKind::CombatUnitType => &self.combat_unit_type,
            DictionaryKind::UnitEchelon => &self.unit_echelon,
        };
        values.get(&key).copied().map(Some).ok_or_else(|| {
            anyhow::anyhow!(
                "missing ORBIT {} dictionary value ({}, {})",
                kind.table_name(),
                key.key,
                key.name
            )
        })
    }

    pub fn resolve_all(
        &self,
        kind: DictionaryKind,
        values: Option<&[DictionaryValue]>,
    ) -> anyhow::Result<Option<BTreeSet<Uuid>>> {
        values
            .map(|values| {
                values
                    .iter()
                    .map(|value| {
                        self.resolve(kind, Some(value))?.ok_or_else(|| {
                            anyhow::anyhow!(
                                "missing ORBIT {} dictionary value",
                                kind.table_name()
                            )
                        })
                    })
                    .collect()
            })
            .transpose()
    }

    pub fn summary(&self, id: Option<Uuid>) -> String {
        id.and_then(|id| self.summaries.get(&id).cloned())
            .unwrap_or_else(|| "-".to_string())
    }

    pub fn summaries(&self, ids: Option<&BTreeSet<Uuid>>) -> String {
        let mut summaries = ids
            .into_iter()
            .flatten()
            .filter_map(|id| self.summaries.get(id).cloned())
            .collect::<Vec<_>>();
        summaries.sort();
        if summaries.is_empty() {
            "-".to_string()
        } else {
            summaries.join(", ")
        }
    }

    fn contains(&self, kind: DictionaryKind, key: &DictionaryKey) -> bool {
        match kind {
            DictionaryKind::GroupingOfForces => {
                self.grouping_of_forces.contains_key(key)
            }
            DictionaryKind::CombatUnitType => {
                self.combat_unit_type.contains_key(key)
            }
            DictionaryKind::UnitEchelon => self.unit_echelon.contains_key(key),
        }
    }
}

impl DictionaryKind {
    pub fn table_name(self) -> &'static str {
        match self {
            Self::GroupingOfForces => "orbit_grouping_of_forces",
            Self::CombatUnitType => "orbit_combat_unit_type",
            Self::UnitEchelon => "orbit_unit_echelon",
        }
    }
}

pub fn collect_dictionary_values(
    units: &[SourceUnit],
) -> anyhow::Result<BTreeMap<DictionaryKind, BTreeSet<DictionaryKey>>> {
    let mut result = BTreeMap::new();
    for unit in units {
        collect_unit_dictionary_values(unit, &mut result)?;
    }
    Ok(result)
}

pub fn missing_dictionary_values(
    units: &[SourceUnit],
    dictionaries: &DictionaryMaps,
) -> anyhow::Result<BTreeMap<DictionaryKind, Vec<DictionaryKey>>> {
    let values = collect_dictionary_values(units)?;
    Ok(values
        .into_iter()
        .filter_map(|(kind, values)| {
            let missing = values
                .into_iter()
                .filter(|value| !dictionaries.contains(kind, value))
                .collect::<Vec<_>>();
            (!missing.is_empty()).then_some((kind, missing))
        })
        .collect())
}

pub fn print_dictionary_migration(
    missing: &BTreeMap<DictionaryKind, Vec<DictionaryKey>>,
    started_at: NaiveDateTime,
) {
    println!("{}", format_dictionary_migration(missing, started_at));
}

fn format_dictionary_migration(
    missing: &BTreeMap<DictionaryKind, Vec<DictionaryKey>>,
    started_at: NaiveDateTime,
) -> String {
    let timestamp = started_at.format("%Y%m%d_%H%M%S");
    let module = format!("m{timestamp}_add_orbit_dictionary_values");
    let mut up_sql = String::new();
    let mut inserted = Vec::new();
    for (kind, values) in missing {
        for value in values {
            let id = Uuid::new_v4();
            up_sql.push_str(&format!(
                "insert into {} (id, key, name) values ('{}', '{}', '{}');\n",
                kind.table_name(),
                id,
                escape_sql(&value.key),
                escape_sql(&value.name),
            ));
            inserted.push((kind.table_name(), id));
        }
    }
    let down_sql = inserted
        .into_iter()
        .rev()
        .map(|(table, id)| format!("delete from {table} where id = '{id}';\n"))
        .collect::<String>();
    format!(
        r###"
New ORBIT dictionary values were found. Add this file as
echo-migration/src/{module}.rs, register it, apply migrations, and rerun:

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {{
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {{
        manager.get_connection().execute_unprepared(r##"
{up_sql}"##).await?;
        Ok(())
    }}

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {{
        manager.get_connection().execute_unprepared(r##"
{down_sql}"##).await?;
        Ok(())
    }}
}}

echo-migration/src/lib.rs:
mod {module};
Box::new({module}::Migration),
"###
    )
}

fn collect_unit_dictionary_values(
    unit: &SourceUnit,
    values: &mut BTreeMap<DictionaryKind, BTreeSet<DictionaryKey>>,
) -> anyhow::Result<()> {
    add_values(
        values,
        DictionaryKind::GroupingOfForces,
        unit.grouping_of_forces.as_deref(),
    )?;
    add_value(
        values,
        DictionaryKind::CombatUnitType,
        unit.combat_unit_type.as_ref(),
    )?;
    add_value(
        values,
        DictionaryKind::UnitEchelon,
        unit.unit_echelon.as_ref(),
    )?;
    for parent in unit
        .generative_parent_units
        .iter()
        .chain(&unit.operational_parent_units)
    {
        collect_unit_dictionary_values(parent, values)?;
    }
    Ok(())
}

fn add_values(
    values: &mut BTreeMap<DictionaryKind, BTreeSet<DictionaryKey>>,
    kind: DictionaryKind,
    dictionary_values: Option<&[DictionaryValue]>,
) -> anyhow::Result<()> {
    if let Some(dictionary_values) = dictionary_values {
        for value in dictionary_values {
            add_value(values, kind, Some(value))?;
        }
    }
    Ok(())
}

fn add_value(
    values: &mut BTreeMap<DictionaryKind, BTreeSet<DictionaryKey>>,
    kind: DictionaryKind,
    value: Option<&DictionaryValue>,
) -> anyhow::Result<()> {
    if let Some(value) = value {
        values
            .entry(kind)
            .or_default()
            .insert(normalize_dictionary(value)?);
    }
    Ok(())
}

fn normalize_dictionary(
    value: &DictionaryValue,
) -> anyhow::Result<DictionaryKey> {
    Ok(DictionaryKey {
        key: stringify(&value.key)?,
        name: stringify(&value.name)?,
    })
}

fn stringify(value: &Value) -> anyhow::Result<String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        _ => stringify_json(&canonicalize(value)),
    }
}

fn stringify_json(value: &Value) -> anyhow::Result<String> {
    match value {
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(stringify_json)
                .collect::<anyhow::Result<Vec<_>>>()?
                .join(", ")
        )),
        Value::Object(values) => Ok(format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}: {}",
                        serde_json::to_string(key)?,
                        stringify_json(value)?
                    ))
                })
                .collect::<anyhow::Result<Vec<_>>>()?
                .join(", ")
        )),
        _ => Ok(serde_json::to_string(value)?),
    }
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.iter().map(canonicalize).collect())
        }
        Value::Object(values) => {
            let sorted = values
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn escape_sql(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::parse_units;
    use chrono::NaiveDate;
    use serde_json::json;

    #[test]
    fn sample_collects_all_three_dictionary_kinds() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, _) = parse_units(sample).unwrap();
        let values = collect_dictionary_values(&units).unwrap();
        assert_eq!(
            values
                .get(&DictionaryKind::GroupingOfForces)
                .map_or(0, BTreeSet::len),
            0
        );
        assert_eq!(values[&DictionaryKind::CombatUnitType].len(), 1);
        assert_eq!(values[&DictionaryKind::UnitEchelon].len(), 5);
    }

    #[test]
    fn canonicalizes_non_string_dictionary_values() {
        let value = DictionaryValue {
            key: json!({"b": 2, "a": 1}),
            name: json!(7),
        };
        assert_eq!(
            normalize_dictionary(&value).unwrap(),
            DictionaryKey {
                key: r#"{"a": 1, "b": 2}"#.to_string(),
                name: "7".to_string(),
            }
        );
    }

    #[test]
    fn migration_escapes_sql_and_includes_registration() {
        let missing = BTreeMap::from([(
            DictionaryKind::UnitEchelon,
            vec![DictionaryKey {
                key: "new'key".to_string(),
                name: "New name".to_string(),
            }],
        )]);
        let started_at = NaiveDate::from_ymd_opt(2026, 7, 29)
            .unwrap()
            .and_hms_opt(17, 5, 44)
            .unwrap();
        let output = format_dictionary_migration(&missing, started_at);
        assert!(output.contains("new''key"));
        assert!(output.contains("m20260729_170544_add_orbit_dictionary_values"));
        assert!(output.contains("delete from orbit_unit_echelon where id ="));
    }
}
