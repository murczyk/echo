use crate::entities::sigint_unit;
use crate::orbit::types::SourceUnit;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum EchoEchelon {
    Company,
    Battalion,
    Regiment,
    Division,
    Army,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MatchScore {
    echelon_distance: Option<usize>,
    matched_names: usize,
}

struct ComparablePath {
    names_by_echelon: HashMap<EchoEchelon, HashSet<String>>,
    all_names: HashSet<String>,
    root_echelon: Option<EchoEchelon>,
}

pub fn validate_source(units: &[SourceUnit]) -> anyhow::Result<()> {
    if units.is_empty() {
        anyhow::bail!("ORBIT export contains no units");
    }
    let mut ids = HashSet::new();
    for (index, unit) in units.iter().enumerate() {
        if unit.path_level.is_some() {
            anyhow::bail!("$[{index}].path_level is only valid for a parent");
        }
        if unit.operational_unit_name_full.is_none() {
            anyhow::bail!("$[{index}].operational_unit_name_full is required");
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

#[cfg(test)]
fn matches_sigint_unit(
    orbit_unit: &SourceUnit,
    sigint_unit: &sigint_unit::Model,
) -> bool {
    match_score(orbit_unit, sigint_unit).is_some()
}

fn match_score(
    orbit_unit: &SourceUnit,
    sigint_unit: &sigint_unit::Model,
) -> Option<MatchScore> {
    let Ok(path) = comparable_path(orbit_unit) else {
        return None;
    };
    let mut matched_names = 0;
    let matches = [
        (EchoEchelon::Company, sigint_unit.company.as_str()),
        (EchoEchelon::Battalion, sigint_unit.battalion.as_str()),
        (EchoEchelon::Regiment, sigint_unit.regiment.as_str()),
        (EchoEchelon::Division, sigint_unit.division.as_str()),
        (EchoEchelon::Army, sigint_unit.army.as_str()),
    ]
    .into_iter()
    .all(|(echelon, echo_name)| {
        let echo_name = normalize_name(echo_name);
        if echo_name.is_empty() {
            return true;
        }
        if path.all_names.contains(&echo_name) {
            matched_names += 1;
            return true;
        }
        path.names_by_echelon
            .get(&echelon)
            .is_none_or(HashSet::is_empty)
    });
    if !matches || matched_names == 0 {
        return None;
    }
    Some(MatchScore {
        echelon_distance: path
            .root_echelon
            .zip(sigint_unit_echelon(sigint_unit))
            .map(|(orbit, sigint)| orbit.index().abs_diff(sigint.index())),
        matched_names,
    })
}

pub fn matching_sigint_unit_ids(
    orbit_units: &[SourceUnit],
    sigint_units: &[sigint_unit::Model],
) -> HashMap<uuid::Uuid, BTreeSet<i64>> {
    orbit_units
        .iter()
        .filter_map(|orbit_unit| {
            best_matching_sigint_unit(orbit_unit, sigint_units).map(
                |sigint_unit_id| {
                    (orbit_unit.unit_id, BTreeSet::from([sigint_unit_id]))
                },
            )
        })
        .collect()
}

fn best_matching_sigint_unit(
    orbit_unit: &SourceUnit,
    sigint_units: &[sigint_unit::Model],
) -> Option<i64> {
    let mut candidates = sigint_units
        .iter()
        .filter_map(|sigint_unit| {
            match_score(orbit_unit, sigint_unit)
                .map(|score| (sigint_unit, score))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(sigint_unit, score)| {
        (
            score.echelon_distance.unwrap_or(usize::MAX),
            std::cmp::Reverse(score.matched_names),
            sigint_unit.id,
        )
    });
    let (_, best_score) = candidates.first()?;
    let best_quality = (best_score.echelon_distance, best_score.matched_names);
    let closest = candidates
        .iter()
        .take_while(|(_, score)| {
            (score.echelon_distance, score.matched_names) == best_quality
        })
        .map(|(sigint_unit, _)| *sigint_unit)
        .collect::<Vec<_>>();
    let closest_parent_signature = parent_signature(closest[0]);
    if closest.iter().skip(1).any(|sigint_unit| {
        parent_signature(sigint_unit) != closest_parent_signature
    }) {
        return None;
    }
    closest.first().map(|sigint_unit| sigint_unit.id)
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
    let mut descriptors = vec![unit];
    let mut parents = parents.iter().collect::<Vec<_>>();
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.path_level));
    descriptors.extend(parents);
    let mut segment_offset = 0;
    for (index, descriptor) in descriptors.into_iter().enumerate() {
        let names = descriptor_names(descriptor);
        if names.is_empty() {
            continue;
        }
        let Some(relative_index) = segments[segment_offset..]
            .iter()
            .position(|segment| names.contains(segment))
        else {
            anyhow::bail!(
                "{path} descriptor {index} for unit {} is absent from its full name",
                descriptor.unit_id
            );
        };
        segment_offset += relative_index + 1;
    }
    Ok(())
}

fn descriptor_names(unit: &SourceUnit) -> HashSet<String> {
    unit.unit_name_short
        .iter()
        .chain(&unit.unit_name)
        .chain(&unit.unit_name_original)
        .chain(unit.unit_alternate_names.iter().flatten())
        .map(|name| normalize_name(name))
        .collect()
}

fn comparable_path(unit: &SourceUnit) -> anyhow::Result<ComparablePath> {
    let full_name =
        unit.operational_unit_name_full.as_deref().ok_or_else(|| {
            anyhow::anyhow!("operational_unit_name_full is missing")
        })?;
    let segments = split_path(full_name);
    let mut descriptors = vec![unit];
    let mut parents = unit.operational_parent_units.iter().collect::<Vec<_>>();
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.path_level));
    descriptors.extend(parents);
    let mut result = HashMap::<EchoEchelon, HashSet<String>>::new();
    let mut all_names = segments.into_iter().collect::<HashSet<_>>();
    for descriptor in descriptors {
        let descriptor_names = descriptor_names(descriptor);
        all_names.extend(descriptor_names.iter().cloned());
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
        let names = result.entry(echelon).or_default();
        names.extend(descriptor_names);
    }
    Ok(ComparablePath {
        names_by_echelon: result,
        all_names,
        root_echelon: unit
            .unit_echelon
            .as_ref()
            .and_then(|value| value.key.as_str())
            .and_then(map_echelon),
    })
}

fn sigint_unit_echelon(unit: &sigint_unit::Model) -> Option<EchoEchelon> {
    [
        (EchoEchelon::Company, unit.company.as_str()),
        (EchoEchelon::Battalion, unit.battalion.as_str()),
        (EchoEchelon::Regiment, unit.regiment.as_str()),
        (EchoEchelon::Division, unit.division.as_str()),
        (EchoEchelon::Army, unit.army.as_str()),
    ]
    .into_iter()
    .find_map(|(echelon, name)| {
        (!normalize_name(name).is_empty()).then_some(echelon)
    })
}

fn parent_signature(unit: &sigint_unit::Model) -> Vec<(EchoEchelon, String)> {
    let unit_echelon = sigint_unit_echelon(unit);
    [
        (EchoEchelon::Company, unit.company.as_str()),
        (EchoEchelon::Battalion, unit.battalion.as_str()),
        (EchoEchelon::Regiment, unit.regiment.as_str()),
        (EchoEchelon::Division, unit.division.as_str()),
        (EchoEchelon::Army, unit.army.as_str()),
    ]
    .into_iter()
    .filter(|(echelon, name)| {
        unit_echelon.is_some_and(|unit_echelon| {
            echelon.index() > unit_echelon.index()
                && !normalize_name(name).is_empty()
        })
    })
    .map(|(echelon, name)| (echelon, normalize_name(name)))
    .collect()
}

impl EchoEchelon {
    fn index(self) -> usize {
        match self {
            Self::Company => 0,
            Self::Battalion => 1,
            Self::Regiment => 2,
            Self::Division => 3,
            Self::Army => 4,
        }
    }
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
        .split(" / ")
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
    fn sample_matches_operational_aliases() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, _) = crate::orbit::types::parse_units(sample).unwrap();
        validate_source(&units).unwrap();
        let sigint_unit = echo_unit("", "батрурлр", "53 зрбр", "", "20 ОА");
        assert!(matches_sigint_unit(&units[0], &sigint_unit));
    }

    #[test]
    fn missing_and_unsupported_levels_are_compatible() {
        let unit = source_unit(
            "взвод / округ",
            vec![("platoon", "взвод", 1), ("militaryDistrict", "округ", 0)],
        );
        assert!(!matches_sigint_unit(&unit, &echo_unit("", "", "", "", "")));
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
    fn duplicate_matches_with_same_parents_pick_lowest_id() {
        let first = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        let second = source_unit("2 рота", vec![("company", "2 рота", 0)]);
        let mut first_match = echo_unit("1 рота", "", "", "", "");
        first_match.id = 1;
        let mut second_match = echo_unit("1 рота", "", "", "", "");
        second_match.id = 2;
        let mut no_match = echo_unit("3 рота", "", "", "", "");
        no_match.id = 3;
        let matches = matching_sigint_unit_ids(
            &[first.clone(), second],
            &[first_match, second_match, no_match],
        );
        assert_eq!(
            matches,
            HashMap::from([(first.unit_id, BTreeSet::from([1]))])
        );
    }

    #[test]
    fn root_echelon_breaks_ties_between_matching_units() {
        let unit = source_unit(
            "1111 бр / 45 д / 56 А",
            vec![
                ("brigade", "1111 бр", 2),
                ("division", "45 д", 1),
                ("fieldArmy", "56 А", 0),
            ],
        );
        let mut battalion = echo_unit("", "2 бат", "1111 бр", "", "56 А");
        battalion.id = 1;
        let mut brigade = echo_unit("", "", "1111 бр", "", "56 А");
        brigade.id = 2;
        assert_eq!(
            matching_sigint_unit_ids(&[unit.clone()], &[battalion, brigade]),
            HashMap::from([(unit.unit_id, BTreeSet::from([2]))])
        );
    }

    #[test]
    fn equally_close_matches_with_different_parents_are_skipped() {
        let unit = source_unit("1111 бр", vec![("brigade", "1111 бр", 0)]);
        let mut first = echo_unit("", "", "1111 бр", "45 д", "");
        first.id = 1;
        let mut second = echo_unit("", "", "1111 бр", "46 д", "");
        second.id = 2;
        assert!(matching_sigint_unit_ids(&[unit], &[first, second]).is_empty());
    }

    #[test]
    fn matching_names_override_incorrect_echelon_metadata() {
        let unit = source_unit("1111 бр", vec![("battalion", "1111 бр", 0)]);
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("", "", "1111 бр", "", "")
        ));
    }

    #[test]
    fn omitted_descriptors_are_allowed_in_full_paths() {
        let unit = source_unit(
            "1111 бр / пропущений 1 / пропущений 2 / 56 А",
            vec![("brigade", "1111 бр", 1), ("fieldArmy", "56 А", 0)],
        );
        validate_source(&[unit]).unwrap();
    }

    #[test]
    fn slashes_inside_unit_names_are_not_path_delimiters() {
        let unit = source_unit(
            "2 р/ст Р-149БМРГ / 1 вз",
            vec![
                ("teamOrCrew", "2 р/ст Р-149БМРГ", 1),
                ("platoon", "1 вз", 0),
            ],
        );
        validate_source(&[unit]).unwrap();
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

    #[test]
    fn original_names_are_valid_path_segments() {
        let mut unit =
            source_unit("original", vec![("company", "translated", 0)]);
        unit.unit_name_original = Some("original".to_string());
        validate_source(&[unit]).unwrap();
    }

    #[test]
    fn empty_exports_and_missing_operational_paths_are_rejected() {
        assert!(validate_source(&[]).is_err());
        let mut unit = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        unit.operational_unit_name_full = None;
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
