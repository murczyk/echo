use crate::entities::{
    orbit_combat_unit_type, orbit_grouping_of_forces, orbit_unit_echelon,
};
use crate::orbit::types::{DictionaryValue, SourceUnit};
use crate::types::ShortContext;
use crate::{h, AppError};
use sea_orm::{ActiveValue::Set, ConnectionTrait, EntityTrait};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictionaryEntry {
    pub id: Uuid,
    pub key: String,
    pub name: String,
}

pub type DictionaryEntries = BTreeMap<DictionaryKind, Vec<DictionaryEntry>>;

#[derive(Debug, Clone)]
pub struct DictionaryMaps {
    grouping_of_forces: HashMap<DictionaryKey, Uuid>,
    combat_unit_type: HashMap<DictionaryKey, Uuid>,
    unit_echelon: HashMap<DictionaryKey, Uuid>,
    unit_echelon_values: HashMap<Uuid, DictionaryValue>,
}

impl DictionaryMaps {
    pub async fn load<C>(db: &C) -> Result<Self, AppError>
    where
        C: ConnectionTrait,
    {
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
        let grouping_of_forces = grouping
            .into_iter()
            .map(|row| {
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
                (
                    DictionaryKey {
                        key: row.key,
                        name: row.name,
                    },
                    row.id,
                )
            })
            .collect();
        let mut unit_echelon_values = HashMap::new();
        let unit_echelon = echelon
            .into_iter()
            .map(|row| {
                unit_echelon_values.insert(
                    row.id,
                    DictionaryValue {
                        key: Value::String(row.key.clone()),
                        name: Value::String(row.name.clone()),
                    },
                );
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
            unit_echelon_values,
        })
    }

    pub fn unit_echelon_value(
        &self,
        id: Option<Uuid>,
    ) -> Option<DictionaryValue> {
        id.and_then(|id| self.unit_echelon_values.get(&id)).cloned()
    }

    pub fn unit_echelon_key(&self, id: Option<Uuid>) -> Option<&str> {
        id.and_then(|id| self.unit_echelon_values.get(&id))
            .and_then(|value| value.key.as_str())
    }

    #[cfg(test)]
    pub fn for_unit_echelons(
        values: impl IntoIterator<Item = (Uuid, &'static str)>,
    ) -> Self {
        Self {
            grouping_of_forces: HashMap::new(),
            combat_unit_type: HashMap::new(),
            unit_echelon: HashMap::new(),
            unit_echelon_values: values
                .into_iter()
                .map(|(id, key)| {
                    (
                        id,
                        DictionaryValue {
                            key: Value::String(key.to_string()),
                            name: Value::String(key.to_string()),
                        },
                    )
                })
                .collect(),
        }
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
}

impl DictionaryKind {
    pub fn table_name(self) -> &'static str {
        match self {
            Self::GroupingOfForces => "orbit_grouping_of_forces",
            Self::CombatUnitType => "orbit_combat_unit_type",
            Self::UnitEchelon => "orbit_unit_echelon",
        }
    }

    pub fn all() -> [Self; 3] {
        [
            Self::GroupingOfForces,
            Self::CombatUnitType,
            Self::UnitEchelon,
        ]
    }
}

pub async fn ensure_dictionary_entries<C>(
    db: &C,
    entries: &DictionaryEntries,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    ensure_grouping_of_forces(
        db,
        entries
            .get(&DictionaryKind::GroupingOfForces)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .await
    .c(h!())?;
    ensure_combat_unit_types(
        db,
        entries
            .get(&DictionaryKind::CombatUnitType)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .await
    .c(h!())?;
    ensure_unit_echelons(
        db,
        entries
            .get(&DictionaryKind::UnitEchelon)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn ensure_grouping_of_forces<C>(
    db: &C,
    entries: &[DictionaryEntry],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let existing = orbit_grouping_of_forces::Entity::find()
        .all(db)
        .await
        .c(h!())?;
    validate_dictionary_ids(
        DictionaryKind::GroupingOfForces,
        entries,
        existing.iter().map(|row| (row.id, &row.key, &row.name)),
    )?;
    let existing_keys = existing
        .into_iter()
        .map(|row| DictionaryKey {
            key: row.key,
            name: row.name,
        })
        .collect::<BTreeSet<_>>();
    for entry in entries {
        if existing_keys.contains(&entry.key_value()) {
            continue;
        }
        orbit_grouping_of_forces::Entity::insert(
            orbit_grouping_of_forces::ActiveModel {
                id: Set(entry.id),
                key: Set(entry.key.clone()),
                name: Set(entry.name.clone()),
                ..Default::default()
            },
        )
        .exec(db)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn ensure_combat_unit_types<C>(
    db: &C,
    entries: &[DictionaryEntry],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let existing = orbit_combat_unit_type::Entity::find()
        .all(db)
        .await
        .c(h!())?;
    validate_dictionary_ids(
        DictionaryKind::CombatUnitType,
        entries,
        existing.iter().map(|row| (row.id, &row.key, &row.name)),
    )?;
    let existing_keys = existing
        .into_iter()
        .map(|row| DictionaryKey {
            key: row.key,
            name: row.name,
        })
        .collect::<BTreeSet<_>>();
    for entry in entries {
        if existing_keys.contains(&entry.key_value()) {
            continue;
        }
        orbit_combat_unit_type::Entity::insert(
            orbit_combat_unit_type::ActiveModel {
                id: Set(entry.id),
                key: Set(entry.key.clone()),
                name: Set(entry.name.clone()),
                ..Default::default()
            },
        )
        .exec(db)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn ensure_unit_echelons<C>(
    db: &C,
    entries: &[DictionaryEntry],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let existing = orbit_unit_echelon::Entity::find().all(db).await.c(h!())?;
    validate_dictionary_ids(
        DictionaryKind::UnitEchelon,
        entries,
        existing.iter().map(|row| (row.id, &row.key, &row.name)),
    )?;
    let existing_keys = existing
        .into_iter()
        .map(|row| DictionaryKey {
            key: row.key,
            name: row.name,
        })
        .collect::<BTreeSet<_>>();
    for entry in entries {
        if existing_keys.contains(&entry.key_value()) {
            continue;
        }
        orbit_unit_echelon::Entity::insert(orbit_unit_echelon::ActiveModel {
            id: Set(entry.id),
            key: Set(entry.key.clone()),
            name: Set(entry.name.clone()),
            ..Default::default()
        })
        .exec(db)
        .await
        .c(h!())?;
    }
    Ok(())
}

fn validate_dictionary_ids<'a>(
    kind: DictionaryKind,
    entries: &[DictionaryEntry],
    existing: impl Iterator<Item = (Uuid, &'a String, &'a String)>,
) -> anyhow::Result<()> {
    let existing = existing
        .map(|(id, key, name)| {
            (
                id,
                DictionaryKey {
                    key: key.clone(),
                    name: name.clone(),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    for entry in entries {
        if let Some(value) = existing.get(&entry.id) {
            anyhow::ensure!(
                value == &entry.key_value(),
                "ORBIT {} dictionary ID {} belongs to ({}, {}), not ({}, {})",
                kind.table_name(),
                entry.id,
                value.key,
                value.name,
                entry.key,
                entry.name
            );
        }
    }
    Ok(())
}

impl DictionaryEntry {
    pub(crate) fn key_value(&self) -> DictionaryKey {
        DictionaryKey {
            key: self.key.clone(),
            name: self.name.clone(),
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

pub fn normalize_dictionary(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::parse_units;
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
}
