use crate::entities::sigint_unit;
use crate::orbit::types::SourceUnit;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum EchoEchelon {
    Company,
    Battalion,
    Regiment,
    Division,
    Army,
}

pub fn validate_source(units: &[SourceUnit]) -> anyhow::Result<()> {
    let mut ids = HashSet::new();
    for (index, unit) in units.iter().enumerate() {
        if unit.path_level.is_some() {
            anyhow::bail!("$[{index}].path_level is only valid for a parent");
        }
        if !ids.insert(unit.unit_id) {
            anyhow::bail!(
                "$[{index}].unit_id duplicates top-level unit {}",
                unit.unit_id
            );
        }
        validate_unit(unit, &format!("$[{index}]"))?;
    }
    Ok(())
}

pub fn matches_sigint_unit(
    orbit_unit: &SourceUnit,
    sigint_unit: &sigint_unit::Model,
) -> bool {
    let Ok(path) = comparable_path(orbit_unit) else {
        return false;
    };
    [
        (EchoEchelon::Company, sigint_unit.company.as_str()),
        (EchoEchelon::Battalion, sigint_unit.battalion.as_str()),
        (EchoEchelon::Regiment, sigint_unit.regiment.as_str()),
        (EchoEchelon::Division, sigint_unit.division.as_str()),
        (EchoEchelon::Army, sigint_unit.army.as_str()),
    ]
    .into_iter()
    .all(|(echelon, echo_name)| {
        let echo_name = normalize_name(echo_name);
        let orbit_names = path.get(&echelon);
        echo_name.is_empty()
            || orbit_names.is_none_or(|names| names.is_empty())
            || orbit_names.is_some_and(|names| {
                names.iter().any(|name| name == &echo_name)
            })
    })
}

pub fn matching_unit_ids(
    orbit_units: &[SourceUnit],
    sigint_units: &[sigint_unit::Model],
) -> HashSet<uuid::Uuid> {
    orbit_units
        .iter()
        .filter(|orbit_unit| {
            sigint_units
                .iter()
                .any(|sigint_unit| matches_sigint_unit(orbit_unit, sigint_unit))
        })
        .map(|orbit_unit| orbit_unit.unit_id)
        .collect()
}

fn validate_unit(unit: &SourceUnit, path: &str) -> anyhow::Result<()> {
    validate_parent_chain(
        unit,
        &unit.operational_parent_units,
        unit.operational_unit_name_full.as_deref(),
        &format!("{path}.operational_parent_units"),
    )?;
    validate_parent_chain(
        unit,
        &unit.generative_parent_units,
        unit.generative_unit_name_full.as_deref(),
        &format!("{path}.generative_parent_units"),
    )?;
    for (index, parent) in unit.operational_parent_units.iter().enumerate() {
        validate_unit(
            parent,
            &format!("{path}.operational_parent_units[{index}]"),
        )?;
    }
    for (index, parent) in unit.generative_parent_units.iter().enumerate() {
        validate_unit(
            parent,
            &format!("{path}.generative_parent_units[{index}]"),
        )?;
    }
    Ok(())
}

fn validate_parent_chain(
    unit: &SourceUnit,
    parents: &[SourceUnit],
    full_name: Option<&str>,
    path: &str,
) -> anyhow::Result<()> {
    let mut levels = Vec::new();
    let mut ids = HashSet::from([unit.unit_id]);
    for (index, parent) in parents.iter().enumerate() {
        let level = parent.path_level.ok_or_else(|| {
            anyhow::anyhow!("{path}[{index}].path_level is required")
        })?;
        if level < 0 {
            anyhow::bail!("{path}[{index}].path_level cannot be negative");
        }
        if !levels.contains(&level) {
            levels.push(level);
        } else {
            anyhow::bail!("{path} contains duplicate path_level {level}");
        }
        if !ids.insert(parent.unit_id) {
            anyhow::bail!("{path} contains duplicate unit {}", parent.unit_id);
        }
    }
    levels.sort_unstable();
    let expected = (0..parents.len() as i32).collect::<Vec<_>>();
    if levels != expected {
        anyhow::bail!(
            "{path} path levels must be contiguous from 0; got {levels:?}"
        );
    }

    let Some(full_name) = full_name else {
        return Ok(());
    };
    let segments = split_path(full_name);
    if segments.len() != parents.len() + 1 {
        anyhow::bail!(
            "{path} has {} parents but its full name has {} segments",
            parents.len(),
            segments.len()
        );
    }
    let mut units = vec![unit];
    let mut parents = parents.iter().collect::<Vec<_>>();
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.path_level));
    units.extend(parents);
    for (index, (segment, descriptor)) in segments.iter().zip(units).enumerate()
    {
        let names = descriptor_names(descriptor);
        if !names.is_empty() && !names.contains(segment) {
            anyhow::bail!(
                "{path} segment {index} does not match unit {} names",
                descriptor.unit_id
            );
        }
    }
    Ok(())
}

fn descriptor_names(unit: &SourceUnit) -> HashSet<String> {
    unit.unit_name_short
        .iter()
        .chain(&unit.unit_name)
        .chain(unit.unit_alternate_names.iter().flatten())
        .map(|name| normalize_name(name))
        .collect()
}

fn comparable_path(
    unit: &SourceUnit,
) -> anyhow::Result<HashMap<EchoEchelon, Vec<String>>> {
    let full_name =
        unit.operational_unit_name_full.as_deref().ok_or_else(|| {
            anyhow::anyhow!("operational_unit_name_full is missing")
        })?;
    let segments = split_path(full_name);
    let mut descriptors = vec![unit];
    let mut parents = unit.operational_parent_units.iter().collect::<Vec<_>>();
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.path_level));
    descriptors.extend(parents);
    if segments.len() != descriptors.len() {
        anyhow::bail!(
            "operational path segment count does not match hierarchy"
        );
    }

    let mut result = HashMap::<EchoEchelon, Vec<String>>::new();
    for (segment, descriptor) in segments.into_iter().zip(descriptors) {
        let Some(key) = descriptor
            .unit_echelon
            .as_ref()
            .and_then(|value| value.key.as_str())
        else {
            continue;
        };
        let Some(echelon) = map_echelon(key) else {
            continue;
        };
        result.entry(echelon).or_default().push(segment);
    }
    Ok(result)
}

fn map_echelon(key: &str) -> Option<EchoEchelon> {
    match key {
        "platoon" | "company" => Some(EchoEchelon::Company),
        "battalion" => Some(EchoEchelon::Battalion),
        "regiment" | "brigade" => Some(EchoEchelon::Regiment),
        "division" => Some(EchoEchelon::Division),
        "corps" | "fieldArmy" => Some(EchoEchelon::Army),
        _ => None,
    }
}

fn split_path(value: &str) -> Vec<String> {
    value
        .split('/')
        .map(normalize_name)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn normalize_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::DictionaryValue;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn sample_matches_collapsed_echo_echelons() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, _) = crate::orbit::types::parse_units(sample).unwrap();
        validate_source(&units).unwrap();
        let sigint_unit = echo_unit("", "батрурлр", "53 зрбр", "", "20 ЗВА");
        assert!(matches_sigint_unit(&units[0], &sigint_unit));
    }

    #[test]
    fn missing_and_unsupported_levels_are_compatible() {
        let unit = source_unit(
            "взвод / округ",
            vec![("platoon", "взвод", 1), ("militaryDistrict", "округ", 0)],
        );
        assert!(matches_sigint_unit(&unit, &echo_unit("", "", "", "", "")));
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("взвод", "", "", "", "невідомо")
        ));
    }

    #[test]
    fn populated_comparable_mismatch_is_rejected() {
        let unit = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        assert!(!matches_sigint_unit(
            &unit,
            &echo_unit("2 рота", "", "", "", "")
        ));
    }

    #[test]
    fn multi_match_filter_retains_each_matching_orbit_unit_once() {
        let first = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        let second = source_unit("2 рота", vec![("company", "2 рота", 0)]);
        let sigint_units = vec![
            echo_unit("1 рота", "", "", "", ""),
            echo_unit("1 рота", "", "", "", ""),
            echo_unit("3 рота", "", "", "", ""),
        ];
        let selected =
            matching_unit_ids(&[first.clone(), second], &sigint_units);
        assert_eq!(selected, HashSet::from([first.unit_id]));
    }

    #[test]
    fn duplicate_and_non_contiguous_levels_are_rejected() {
        let mut unit = source_unit(
            "1 рота / 1 полк",
            vec![("company", "1 рота", 1), ("regiment", "1 полк", 0)],
        );
        unit.operational_parent_units[0].path_level = Some(2);
        assert!(validate_source(&[unit]).is_err());
    }

    fn source_unit(
        full_name: &str,
        descriptors: Vec<(&str, &str, i32)>,
    ) -> SourceUnit {
        let mut descriptors = descriptors;
        let (key, name, _) = descriptors.remove(0);
        let unit_id = Uuid::new_v4();
        let parents = descriptors
            .into_iter()
            .map(|(key, name, level)| SourceUnit {
                unit_id: Uuid::new_v4(),
                unit_name: Some(name.to_string()),
                unit_name_original: None,
                unit_name_short: Some(name.to_string()),
                operational_unit_name_full: None,
                generative_unit_name_full: None,
                unit_number: None,
                unit_alternate_names: None,
                unit_alternate_numbers: None,
                unit_echelon: Some(dictionary(key)),
                combat_unit_type: None,
                grouping_of_forces: None,
                operational_parent_units: vec![],
                generative_parent_units: vec![],
                path_level: Some(level),
            })
            .collect();
        SourceUnit {
            unit_id,
            unit_name: Some(name.to_string()),
            unit_name_original: None,
            unit_name_short: Some(name.to_string()),
            operational_unit_name_full: Some(full_name.to_string()),
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon: Some(dictionary(key)),
            combat_unit_type: None,
            grouping_of_forces: None,
            operational_parent_units: parents,
            generative_parent_units: vec![],
            path_level: None,
        }
    }

    fn dictionary(key: &str) -> DictionaryValue {
        DictionaryValue {
            key: json!(key),
            name: json!(key),
        }
    }

    fn echo_unit(
        company: &str,
        battalion: &str,
        regiment: &str,
        division: &str,
        army: &str,
    ) -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            company: company.to_string(),
            battalion: battalion.to_string(),
            regiment: regiment.to_string(),
            division: division.to_string(),
            army: army.to_string(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: Uuid::new_v4(),
            name: String::new(),
            comment: String::new(),
            sigint_origin_id: None,
            original_id: None,
        }
    }
}
