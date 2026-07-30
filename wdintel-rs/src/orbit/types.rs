use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictionaryValue {
    pub key: Value,
    pub name: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceUnit {
    pub unit_id: Uuid,
    #[serde(default)]
    pub unit_name: Option<String>,
    #[serde(default)]
    pub unit_name_original: Option<String>,
    #[serde(default)]
    pub unit_name_short: Option<String>,
    #[serde(default)]
    pub operational_unit_name_full: Option<String>,
    #[serde(default)]
    pub generative_unit_name_full: Option<String>,
    #[serde(default)]
    pub unit_number: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_list")]
    pub unit_alternate_names: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_string_list")]
    pub unit_alternate_numbers: Option<Vec<String>>,
    #[serde(default)]
    pub unit_echelon: Option<DictionaryValue>,
    #[serde(default)]
    pub combat_unit_type: Option<DictionaryValue>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_dictionary_value"
    )]
    pub grouping_of_forces: Option<Vec<DictionaryValue>>,
    #[serde(default)]
    pub operational_parent_units: Vec<SourceUnit>,
    #[serde(default)]
    pub generative_parent_units: Vec<SourceUnit>,
    #[serde(default)]
    pub path_level: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceUnitData {
    pub unit_id: Uuid,
    pub unit_name: Option<String>,
    pub unit_name_original: Option<String>,
    pub unit_name_short: Option<String>,
    pub operational_unit_name_full: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub unit_number: Option<String>,
    pub unit_alternate_names: Option<Vec<String>>,
    pub unit_alternate_numbers: Option<Vec<String>>,
    pub unit_echelon: Option<DictionaryValue>,
    pub combat_unit_type: Option<DictionaryValue>,
    pub grouping_of_forces: Option<Vec<DictionaryValue>>,
}

impl From<&SourceUnit> for SourceUnitData {
    fn from(unit: &SourceUnit) -> Self {
        Self {
            unit_id: unit.unit_id,
            unit_name: unit.unit_name.clone(),
            unit_name_original: unit.unit_name_original.clone(),
            unit_name_short: unit.unit_name_short.clone(),
            operational_unit_name_full: unit.operational_unit_name_full.clone(),
            generative_unit_name_full: unit.generative_unit_name_full.clone(),
            unit_number: unit.unit_number.clone(),
            unit_alternate_names: unit.unit_alternate_names.clone(),
            unit_alternate_numbers: unit.unit_alternate_numbers.clone(),
            unit_echelon: unit.unit_echelon.clone(),
            combat_unit_type: unit.combat_unit_type.clone(),
            grouping_of_forces: unit.grouping_of_forces.clone(),
        }
    }
}

impl SourceUnitData {
    pub fn display_name(&self) -> String {
        self.unit_name_short
            .clone()
            .or_else(|| self.unit_name.clone())
            .or_else(|| self.unit_name_original.clone())
            .unwrap_or_else(|| self.unit_id.to_string())
    }

    pub fn merge(&mut self, other: &Self) -> anyhow::Result<()> {
        merge_field(
            self.unit_id,
            "unit_name",
            &mut self.unit_name,
            &other.unit_name,
        )?;
        merge_field(
            self.unit_id,
            "unit_name_original",
            &mut self.unit_name_original,
            &other.unit_name_original,
        )?;
        merge_field(
            self.unit_id,
            "unit_name_short",
            &mut self.unit_name_short,
            &other.unit_name_short,
        )?;
        merge_field(
            self.unit_id,
            "operational_unit_name_full",
            &mut self.operational_unit_name_full,
            &other.operational_unit_name_full,
        )?;
        merge_field(
            self.unit_id,
            "generative_unit_name_full",
            &mut self.generative_unit_name_full,
            &other.generative_unit_name_full,
        )?;
        merge_field(
            self.unit_id,
            "unit_number",
            &mut self.unit_number,
            &other.unit_number,
        )?;
        merge_field(
            self.unit_id,
            "unit_alternate_names",
            &mut self.unit_alternate_names,
            &other.unit_alternate_names,
        )?;
        merge_field(
            self.unit_id,
            "unit_alternate_numbers",
            &mut self.unit_alternate_numbers,
            &other.unit_alternate_numbers,
        )?;
        merge_field(
            self.unit_id,
            "unit_echelon",
            &mut self.unit_echelon,
            &other.unit_echelon,
        )?;
        merge_field(
            self.unit_id,
            "combat_unit_type",
            &mut self.combat_unit_type,
            &other.combat_unit_type,
        )?;
        merge_dictionary_values(
            &mut self.grouping_of_forces,
            &other.grouping_of_forces,
        );
        Ok(())
    }
}

fn merge_field<T>(
    unit_id: Uuid,
    field: &str,
    current: &mut Option<T>,
    other: &Option<T>,
) -> anyhow::Result<()>
where
    T: Clone + PartialEq,
{
    match (&current, other) {
        (Some(left), Some(right)) if left != right => anyhow::bail!(
            "ORBIT unit {unit_id} has conflicting values for {field}"
        ),
        (None, Some(value)) => *current = Some(value.clone()),
        _ => {}
    }
    Ok(())
}

fn merge_dictionary_values(
    current: &mut Option<Vec<DictionaryValue>>,
    other: &Option<Vec<DictionaryValue>>,
) {
    let Some(other) = other else {
        return;
    };
    let current = current.get_or_insert_with(Vec::new);
    for value in other {
        if !current.contains(value) {
            current.push(value.clone());
        }
    }
}

fn deserialize_optional_dictionary_value<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<DictionaryValue>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => serde_json::from_value(value)
            .map(|value| Some(vec![value]))
            .map_err(serde::de::Error::custom),
        Some(Value::Array(values)) => values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value).map_err(serde::de::Error::custom)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected dictionary object or array, got {other}"
        ))),
    }
}

fn deserialize_optional_string_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let values = value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok((!values.is_empty()).then_some(values))
        }
        Some(Value::Array(values)) => values
            .into_iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.trim().to_string()),
                other => Err(serde::de::Error::custom(format!(
                    "expected string in array, got {other}"
                ))),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|values| {
                values
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
            })
            .map(|values| (!values.is_empty()).then_some(values)),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected string or array of strings, got {other}"
        ))),
    }
}

pub fn parse_units(
    input: &str,
) -> anyhow::Result<(Vec<SourceUnit>, Vec<String>)> {
    let mut unknown_paths = Vec::new();
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let units = serde_ignored::deserialize(&mut deserializer, |path| {
        unknown_paths.push(path.to_string())
    })?;
    deserializer.end()?;
    unknown_paths.sort();
    unknown_paths.dedup();
    Ok((units, unknown_paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sample_and_accepts_string_or_array_alternates() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, unknown) = parse_units(sample).unwrap();
        assert_eq!(units.len(), 1);
        assert!(unknown.is_empty());
        assert_eq!(
            units[0].operational_parent_units[2].unit_alternate_names,
            Some(vec![
                "20 ОА".to_string(),
                "20 ОВА".to_string(),
                "20 А".to_string()
            ])
        );

        let input = format!(
            r#"[{{"unit_id":"{}","unit_alternate_numbers":"1, 2"}}]"#,
            Uuid::new_v4()
        );
        let (units, _) = parse_units(&input).unwrap();
        assert_eq!(
            units[0].unit_alternate_numbers,
            Some(vec!["1".to_string(), "2".to_string()])
        );
    }

    #[test]
    fn accepts_singleton_grouping_of_forces_array() {
        let input = format!(
            r#"[{{
                "unit_id":"{}",
                "grouping_of_forces":[{{
                    "key":"dnepr",
                    "name":"Днепр"
                }}]
            }}]"#,
            Uuid::new_v4()
        );

        let (units, unknown) = parse_units(&input).unwrap();

        assert!(unknown.is_empty());
        assert_eq!(
            units[0].grouping_of_forces,
            Some(vec![DictionaryValue {
                key: Value::String("dnepr".to_string()),
                name: Value::String("Днепр".to_string()),
            }])
        );
    }

    #[test]
    fn accepts_multiple_grouping_of_forces_values() {
        let input = format!(
            r#"[{{
                "unit_id":"{}",
                "grouping_of_forces":[
                    {{"key":"dnepr","name":"Днепр"}},
                    {{"key":"east","name":"Схід"}}
                ]
            }}]"#,
            Uuid::new_v4()
        );

        let (units, unknown) = parse_units(&input).unwrap();

        assert!(unknown.is_empty());
        assert_eq!(units[0].grouping_of_forces.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn reports_unknown_nested_paths() {
        let input = format!(
            r#"[{{
                "unit_id":"{}",
                "new_root":true,
                "operational_parent_units":[{{
                    "unit_id":"{}",
                    "path_level":0,
                    "new_parent":"value"
                }}]
            }}]"#,
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        let (_, unknown) = parse_units(&input).unwrap();
        assert_eq!(unknown.len(), 2);
        assert!(unknown.iter().any(|path| path.contains("new_root")));
        assert!(unknown.iter().any(|path| path.contains("new_parent")));
    }

    #[test]
    fn rejects_malformed_alternate_values() {
        let input = format!(
            r#"[{{"unit_id":"{}","unit_alternate_names":[1]}}]"#,
            Uuid::new_v4()
        );
        assert!(parse_units(&input).is_err());
    }

    #[test]
    fn rejects_trailing_json_data() {
        let input = format!(r#"[{{"unit_id":"{}"}}] true"#, Uuid::new_v4());
        assert!(parse_units(&input).is_err());
    }
}
