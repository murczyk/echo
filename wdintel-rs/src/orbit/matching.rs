use crate::config::{
    ORBIT_MATCHING_SIGINT_NAME_BLACKLIST, ORBIT_TEST_LINK_UNITS_MAX_RATING,
    ORBIT_TEST_LINK_UNITS_NUMBER_MATCH_PENALTY,
};
use crate::entities::sigint_unit;
use crate::orbit::types::SourceUnit;
use crate::orbit::{echo_echelon, EchoEchelon};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MatchScore {
    echelon_distance: Option<usize>,
    matched_names: usize,
}

struct ComparablePath {
    names_by_echelon: HashMap<EchoEchelon, HashSet<String>>,
    all_names: HashSet<String>,
    root_names: HashSet<String>,
    root_echelon: Option<EchoEchelon>,
}

pub(super) fn sigint_hierarchy(
    unit: &sigint_unit::Model,
) -> [(EchoEchelon, &str); 14] {
    [
        (EchoEchelon::Other, unit.other.as_str()),
        (EchoEchelon::TeamOrCrew, unit.team_or_crew.as_str()),
        (EchoEchelon::Section, unit.section.as_str()),
        (EchoEchelon::Squad, unit.squad.as_str()),
        (EchoEchelon::Platoon, unit.platoon.as_str()),
        (EchoEchelon::Company, unit.company.as_str()),
        (EchoEchelon::Battalion, unit.battalion.as_str()),
        (EchoEchelon::Regiment, unit.regiment.as_str()),
        (EchoEchelon::Brigade, unit.brigade.as_str()),
        (EchoEchelon::Division, unit.division.as_str()),
        (EchoEchelon::Corps, unit.corps.as_str()),
        (EchoEchelon::Army, unit.army.as_str()),
        (
            EchoEchelon::MilitaryDistrict,
            unit.military_district.as_str(),
        ),
        (EchoEchelon::ArmyRegion, unit.army_region.as_str()),
    ]
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
        if unit
            .operational_unit_name_full
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .is_none()
        {
            anyhow::bail!(
                "$[{index}].operational_unit_name_full is required and cannot be blank"
            );
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
    let (sigint_echelon, sigint_name) = sigint_unit_identity(sigint_unit)?;
    if !names_match(sigint_echelon, &path.root_names, &sigint_name) {
        return None;
    }
    let mut matched_names = 0;
    let matches = sigint_hierarchy(sigint_unit).into_iter().all(
        |(echelon, echo_name)| {
            let echo_name =
                normalize_sigint_name_for_echelon(echelon, echo_name);
            if echo_name.is_empty() {
                return true;
            }
            if names_match(echelon, &path.all_names, &echo_name) {
                matched_names += 1;
                return true;
            }
            path.names_by_echelon
                .get(&echelon)
                .is_none_or(HashSet::is_empty)
        },
    );
    let required_matches = if parent_signature(sigint_unit).is_empty() {
        1
    } else {
        2
    };
    if !matches || matched_names < required_matches {
        return None;
    }
    Some(MatchScore {
        echelon_distance: path
            .root_echelon
            .map(|orbit| orbit.index().abs_diff(sigint_echelon.index())),
        matched_names,
    })
}

#[cfg(test)]
pub fn matching_sigint_unit_ids(
    orbit_units: &[SourceUnit],
    sigint_units: &[sigint_unit::Model],
) -> HashMap<uuid::Uuid, BTreeSet<i64>> {
    let mut matches_by_sigint_unit =
        HashMap::<i64, Vec<(&SourceUnit, MatchScore)>>::new();
    for orbit_unit in orbit_units {
        for (sigint_unit_id, score) in
            best_matching_sigint_units(orbit_unit, sigint_units)
        {
            matches_by_sigint_unit
                .entry(sigint_unit_id)
                .or_default()
                .push((orbit_unit, score));
        }
    }
    let mut result = HashMap::<uuid::Uuid, BTreeSet<i64>>::new();
    for (sigint_unit_id, matches) in matches_by_sigint_unit {
        for orbit_unit_id in best_matching_orbit_units(matches) {
            result
                .entry(orbit_unit_id)
                .or_default()
                .insert(sigint_unit_id);
        }
    }
    result
}

pub fn matching_orbit_unit_ids(
    orbit_units: &[SourceUnit],
    sigint_unit: &sigint_unit::Model,
) -> BTreeSet<uuid::Uuid> {
    best_matching_orbit_units(
        orbit_units
            .iter()
            .filter_map(|orbit_unit| {
                match_score(orbit_unit, sigint_unit)
                    .map(|score| (orbit_unit, score))
            })
            .collect(),
    )
    .into_iter()
    .collect()
}

struct TestLinkCandidate<'a> {
    orbit_unit: &'a SourceUnit,
    path: ComparablePath,
}

pub(super) struct TestLinkMatcher<'a> {
    candidates: Vec<TestLinkCandidate<'a>>,
    exact_index: HashMap<(EchoEchelon, String), Vec<usize>>,
    number_index: HashMap<(EchoEchelon, String), Vec<usize>>,
}

impl<'a> TestLinkMatcher<'a> {
    pub fn new(orbit_units: &'a [SourceUnit]) -> Self {
        let mut candidates = Vec::new();
        let mut exact_index = HashMap::new();
        let mut number_index = HashMap::new();
        for orbit_unit in orbit_units {
            let Ok(path) = comparable_path(orbit_unit) else {
                continue;
            };
            let candidate_index = candidates.len();
            index_test_link_candidate(
                candidate_index,
                &path,
                &mut exact_index,
                &mut number_index,
            );
            candidates.push(TestLinkCandidate { orbit_unit, path });
        }
        Self {
            candidates,
            exact_index,
            number_index,
        }
    }

    pub fn best_matches(
        &self,
        sigint_hierarchy: &[(EchoEchelon, &str)],
    ) -> Vec<(&'a SourceUnit, u8)> {
        let matches = self.potential_matches(sigint_hierarchy);
        let Some(max_rating) = matches.iter().map(|(_, rating)| *rating).max()
        else {
            return Vec::new();
        };
        matches
            .into_iter()
            .filter(|(_, rating)| *rating == max_rating)
            .collect()
    }

    pub fn potential_matches(
        &self,
        sigint_hierarchy: &[(EchoEchelon, &str)],
    ) -> Vec<(&'a SourceUnit, u8)> {
        let Some((echelon, name)) = first_test_link_echelon(sigint_hierarchy)
        else {
            return Vec::new();
        };
        let mut candidate_indices = self
            .exact_index
            .get(&(echelon, name.clone()))
            .into_iter()
            .flatten()
            .copied()
            .collect::<BTreeSet<_>>();
        if let Some(number) = numbered_echelon_number(&name) {
            candidate_indices.extend(
                self.number_index
                    .get(&(echelon, number.to_string()))
                    .into_iter()
                    .flatten()
                    .copied(),
            );
        }
        let matches = candidate_indices
            .into_iter()
            .filter_map(|index| {
                let candidate = &self.candidates[index];
                test_link_rating(&candidate.path, sigint_hierarchy)
                    .map(|rating| (candidate, rating))
            })
            .collect::<Vec<_>>();
        matches
            .into_iter()
            .filter(|(candidate, _)| {
                candidate.path.root_echelon == Some(echelon)
            })
            .map(|(candidate, rating)| (candidate.orbit_unit, rating))
            .collect()
    }
}

fn index_test_link_candidate(
    candidate_index: usize,
    path: &ComparablePath,
    exact_index: &mut HashMap<(EchoEchelon, String), Vec<usize>>,
    number_index: &mut HashMap<(EchoEchelon, String), Vec<usize>>,
) {
    for (echelon, names) in &path.names_by_echelon {
        for name in names {
            exact_index
                .entry((*echelon, name.clone()))
                .or_default()
                .push(candidate_index);
            if let Some(number) = leading_number(name) {
                number_index
                    .entry((*echelon, number.to_string()))
                    .or_default()
                    .push(candidate_index);
            }
        }
    }
}

fn first_test_link_echelon(
    sigint_hierarchy: &[(EchoEchelon, &str)],
) -> Option<(EchoEchelon, String)> {
    sigint_hierarchy.iter().find_map(|(echelon, name)| {
        let name = normalize_name(name);
        (!name.is_empty()).then_some((*echelon, name))
    })
}

fn test_link_rating(
    path: &ComparablePath,
    sigint_hierarchy: &[(EchoEchelon, &str)],
) -> Option<u8> {
    let mut rating = ORBIT_TEST_LINK_UNITS_MAX_RATING;
    let mut has_echelon = false;
    for (echelon, sigint_name) in sigint_hierarchy {
        let sigint_name = normalize_name(sigint_name);
        if sigint_name.is_empty() {
            continue;
        }
        has_echelon = true;
        let orbit_names = path.names_by_echelon.get(echelon)?;
        if orbit_names.contains(&sigint_name) {
            continue;
        }
        let number = numbered_echelon_number(&sigint_name)?;
        if !orbit_names
            .iter()
            .filter_map(|name| leading_number(name))
            .any(|orbit_number| orbit_number == number)
        {
            return None;
        }
        rating =
            rating.saturating_sub(ORBIT_TEST_LINK_UNITS_NUMBER_MATCH_PENALTY);
    }
    has_echelon.then_some(rating)
}

fn numbered_echelon_number(value: &str) -> Option<&str> {
    let mut parts = value.split_whitespace();
    let number = parts.next()?;
    let word = parts.next()?;
    (number.chars().all(|character| character.is_ascii_digit())
        && word.chars().any(char::is_alphabetic))
    .then_some(number)
}

fn leading_number(value: &str) -> Option<&str> {
    value
        .split_whitespace()
        .next()
        .filter(|part| part.chars().all(|character| character.is_ascii_digit()))
}

pub fn closest_orbit_matches<'a>(
    orbit_units: &'a [SourceUnit],
    sigint_unit: &sigint_unit::Model,
) -> Vec<&'a SourceUnit> {
    let Some((sigint_echelon, _)) = sigint_unit_identity(sigint_unit) else {
        return Vec::new();
    };
    let mut candidates = orbit_units
        .iter()
        .filter_map(|orbit_unit| {
            search_score(orbit_unit, sigint_unit, sigint_echelon)
                .map(|score| (orbit_unit, score))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(orbit_unit, score)| {
        (
            std::cmp::Reverse(score.matched_names),
            score.echelon_distance.unwrap_or(usize::MAX),
            orbit_unit.unit_id,
        )
    });
    let Some((_, best_score)) = candidates.first() else {
        return Vec::new();
    };
    let best_quality = (best_score.matched_names, best_score.echelon_distance);
    candidates
        .into_iter()
        .take_while(|(_, score)| {
            (score.matched_names, score.echelon_distance) == best_quality
        })
        .map(|(orbit_unit, _)| orbit_unit)
        .collect()
}

fn search_score(
    orbit_unit: &SourceUnit,
    sigint_unit: &sigint_unit::Model,
    sigint_echelon: EchoEchelon,
) -> Option<MatchScore> {
    let path = comparable_path(orbit_unit).ok()?;
    let matched_names = sigint_hierarchy(sigint_unit)
        .into_iter()
        .filter(|(echelon, name)| {
            let name = normalize_sigint_name_for_echelon(*echelon, name);
            !name.is_empty() && names_match(*echelon, &path.all_names, &name)
        })
        .count();
    (matched_names > 0).then_some(MatchScore {
        echelon_distance: path
            .root_echelon
            .map(|orbit| orbit.index().abs_diff(sigint_echelon.index())),
        matched_names,
    })
}

#[cfg(test)]
fn best_matching_sigint_units(
    orbit_unit: &SourceUnit,
    sigint_units: &[sigint_unit::Model],
) -> Vec<(i64, MatchScore)> {
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
    let Some((_, best_score)) = candidates.first() else {
        return Vec::new();
    };
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
        return Vec::new();
    }
    closest
        .into_iter()
        .map(|sigint_unit| (sigint_unit.id, *best_score))
        .collect()
}

fn best_matching_orbit_units(
    mut matches: Vec<(&SourceUnit, MatchScore)>,
) -> Vec<uuid::Uuid> {
    matches.sort_by_key(|(orbit_unit, score)| {
        (
            score.echelon_distance.unwrap_or(usize::MAX),
            std::cmp::Reverse(score.matched_names),
            orbit_unit.unit_id,
        )
    });
    let Some((_, best_score)) = matches.first() else {
        return Vec::new();
    };
    let best_quality = (best_score.echelon_distance, best_score.matched_names);
    let closest = matches
        .into_iter()
        .take_while(|(_, score)| {
            (score.echelon_distance, score.matched_names) == best_quality
        })
        .map(|(orbit_unit, _)| orbit_unit)
        .collect::<Vec<_>>();
    let mut units_by_parent_signature = BTreeMap::new();
    for orbit_unit in closest {
        units_by_parent_signature
            .entry(orbit_parent_signature(orbit_unit))
            .or_insert(orbit_unit.unit_id);
    }
    let signatures = units_by_parent_signature.keys().collect::<Vec<_>>();
    if signatures.iter().enumerate().any(|(index, left)| {
        signatures
            .iter()
            .skip(index + 1)
            .any(|right| !parent_signatures_are_extensions(left, right))
    }) {
        return Vec::new();
    }
    signatures
        .iter()
        .find(|candidate| {
            signatures
                .iter()
                .all(|signature| signature_is_extension(candidate, signature))
        })
        .and_then(|signature| units_by_parent_signature.get(*signature))
        .copied()
        .into_iter()
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
        .chain(&unit.unit_number)
        .chain(unit.unit_alternate_names.iter().flatten())
        .map(|name| normalize_name(name))
        .collect()
}

fn comparable_path(unit: &SourceUnit) -> anyhow::Result<ComparablePath> {
    let operational_full_name =
        unit.operational_unit_name_full.as_deref().ok_or_else(|| {
            anyhow::anyhow!("operational_unit_name_full is missing")
        })?;
    let operational_segments = split_path(operational_full_name);
    let generative_segments = unit
        .generative_unit_name_full
        .as_deref()
        .map(split_path)
        .unwrap_or_default();
    let mut root_names = descriptor_names(unit);
    if let Some(root_segment) = operational_segments.first() {
        root_names.insert(root_segment.clone());
    }
    if let Some(root_segment) = generative_segments.first() {
        root_names.insert(root_segment.clone());
    }
    let mut descriptors = vec![unit];
    let mut parents = unit
        .operational_parent_units
        .iter()
        .chain(&unit.generative_parent_units)
        .collect::<Vec<_>>();
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.path_level));
    descriptors.extend(parents);
    let mut result = HashMap::<EchoEchelon, HashSet<String>>::new();
    let mut all_names = operational_segments
        .into_iter()
        .chain(generative_segments)
        .collect::<HashSet<_>>();
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
        let Some(echelon) = echo_echelon(key) else {
            continue;
        };
        let names = result.entry(echelon).or_default();
        names.extend(descriptor_names);
    }
    Ok(ComparablePath {
        names_by_echelon: result,
        all_names,
        root_names,
        root_echelon: unit
            .unit_echelon
            .as_ref()
            .and_then(|value| value.key.as_str())
            .and_then(echo_echelon),
    })
}

fn sigint_unit_echelon(unit: &sigint_unit::Model) -> Option<EchoEchelon> {
    sigint_unit_identity(unit).map(|(echelon, _)| echelon)
}

fn sigint_unit_identity(
    unit: &sigint_unit::Model,
) -> Option<(EchoEchelon, String)> {
    sigint_hierarchy(unit)
        .into_iter()
        .find_map(|(echelon, name)| {
            let name = normalize_sigint_name_for_echelon(echelon, name);
            (!name.is_empty()).then_some((echelon, name))
        })
}

fn parent_signature(unit: &sigint_unit::Model) -> Vec<(EchoEchelon, String)> {
    let unit_echelon = sigint_unit_echelon(unit);
    sigint_hierarchy(unit)
        .into_iter()
        .filter(|(echelon, name)| {
            unit_echelon.is_some_and(|unit_echelon| {
                echelon.index() > unit_echelon.index()
                    && !normalize_sigint_name_for_echelon(*echelon, name)
                        .is_empty()
            })
        })
        .map(|(echelon, name)| {
            (echelon, normalize_sigint_name_for_echelon(echelon, name))
        })
        .collect()
}

fn split_path(value: &str) -> Vec<String> {
    value
        .split(" / ")
        .map(normalize_name)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn orbit_parent_signature(unit: &SourceUnit) -> (Vec<String>, Vec<String>) {
    let operational = unit
        .operational_unit_name_full
        .as_deref()
        .map(split_path)
        .unwrap_or_default()
        .into_iter()
        .skip(1)
        .map(|name| normalize_army_name(&name))
        .collect();
    let generative = unit
        .generative_unit_name_full
        .as_deref()
        .map(split_path)
        .unwrap_or_default()
        .into_iter()
        .skip(1)
        .map(|name| normalize_army_name(&name))
        .collect();
    (operational, generative)
}

fn parent_signatures_are_extensions(
    left: &(Vec<String>, Vec<String>),
    right: &(Vec<String>, Vec<String>),
) -> bool {
    signature_is_extension(left, right) || signature_is_extension(right, left)
}

fn signature_is_extension(
    shorter: &(Vec<String>, Vec<String>),
    longer: &(Vec<String>, Vec<String>),
) -> bool {
    is_subsequence(&shorter.0, &longer.0)
        && is_subsequence(&shorter.1, &longer.1)
}

fn is_subsequence(shorter: &[String], longer: &[String]) -> bool {
    let mut shorter = shorter.iter();
    let mut expected = shorter.next();
    for value in longer {
        if expected == Some(value) {
            expected = shorter.next();
        }
    }
    expected.is_none()
}

fn normalize_name(value: &str) -> String {
    crate::unit::normalize_unit_formation_name(value)
}

fn normalize_sigint_name(value: &str) -> String {
    let mut value = value.to_lowercase();
    for blacklisted in ORBIT_MATCHING_SIGINT_NAME_BLACKLIST {
        value = value.replace(&blacklisted.to_lowercase(), "");
    }
    normalize_name(&value)
}

fn normalize_sigint_name_for_echelon(
    echelon: EchoEchelon,
    value: &str,
) -> String {
    let value = normalize_sigint_name(value);
    if echelon == EchoEchelon::Army {
        normalize_army_name(&value)
    } else {
        value
    }
}

fn normalize_army_name(value: &str) -> String {
    let value = normalize_name(value);
    let Some((number, suffix)) = value.split_once(' ') else {
        return value;
    };
    if number.chars().all(|character| character.is_ascii_digit())
        && suffix.ends_with('а')
    {
        format!("{number} а")
    } else {
        value
    }
}

fn names_match(
    echelon: EchoEchelon,
    names: &HashSet<String>,
    candidate: &str,
) -> bool {
    if echelon == EchoEchelon::Army {
        names
            .iter()
            .any(|name| normalize_army_name(name) == candidate)
    } else {
        names.contains(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::DictionaryValue;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn test_link_rating_penalizes_number_only_echelon_matches() {
        let orbit_unit = source_unit(
            "2 батальйон / 45 мотострілецький полк / 45 армія",
            vec![
                ("battalion", "2 батальйон", 0),
                ("regiment", "45 мотострілецький полк", 1),
                ("fieldArmy", "45 армія", 2),
            ],
        );
        let hierarchy = [
            (EchoEchelon::Battalion, "2 мсб"),
            (EchoEchelon::Regiment, "45 мсп"),
            (EchoEchelon::Army, "45 армія"),
        ];

        assert_eq!(
            test_link_rating(
                &comparable_path(&orbit_unit).unwrap(),
                &hierarchy
            ),
            Some(98)
        );
    }

    #[test]
    fn test_link_matches_keep_all_candidates_at_the_maximum_rating() {
        let exact_first = source_unit(
            "2 мсб / 45 мсп",
            vec![("battalion", "2 мсб", 0), ("regiment", "45 мсп", 1)],
        );
        let exact_second = source_unit(
            "2 мсб / 45 мсп alternative",
            vec![("battalion", "2 мсб", 0), ("regiment", "45 мсп", 1)],
        );
        let number_only = source_unit(
            "2 батальйон / 45 мсп",
            vec![("battalion", "2 батальйон", 0), ("regiment", "45 мсп", 1)],
        );
        let hierarchy = [
            (EchoEchelon::Battalion, "2 мсб"),
            (EchoEchelon::Regiment, "45 мсп"),
        ];

        let orbit_units =
            [number_only, exact_first.clone(), exact_second.clone()];
        assert_eq!(
            TestLinkMatcher::new(&orbit_units).best_matches(&hierarchy),
            vec![
                (&exact_first, ORBIT_TEST_LINK_UNITS_MAX_RATING),
                (&exact_second, ORBIT_TEST_LINK_UNITS_MAX_RATING),
            ]
        );
    }

    #[test]
    fn test_link_potential_matches_keep_lower_rated_candidates() {
        let exact = source_unit(
            "2 мсб / 45 мсп",
            vec![("battalion", "2 мсб", 0), ("regiment", "45 мсп", 1)],
        );
        let number_only = source_unit(
            "2 батальйон / 45 мсп",
            vec![("battalion", "2 батальйон", 0), ("regiment", "45 мсп", 1)],
        );
        let hierarchy = [
            (EchoEchelon::Battalion, "2 мсб"),
            (EchoEchelon::Regiment, "45 мсп"),
        ];
        let orbit_units = [exact.clone(), number_only.clone()];

        assert_eq!(
            TestLinkMatcher::new(&orbit_units).potential_matches(&hierarchy),
            vec![
                (&exact, ORBIT_TEST_LINK_UNITS_MAX_RATING),
                (
                    &number_only,
                    ORBIT_TEST_LINK_UNITS_MAX_RATING
                        - ORBIT_TEST_LINK_UNITS_NUMBER_MATCH_PENALTY,
                ),
            ]
        );
    }

    #[test]
    fn test_link_matches_equivalent_punctuated_unit_notions_exactly() {
        let orbit_unit = source_unit(
            "обБпС / 2 ОА",
            vec![("battalion", "обБпС", 0), ("fieldArmy", "2 ОА", 1)],
        );
        let hierarchy = [
            (EchoEchelon::Battalion, "(об БпС)"),
            (EchoEchelon::Army, "2 ЗВА"),
        ];

        assert_eq!(
            TestLinkMatcher::new(std::slice::from_ref(&orbit_unit))
                .best_matches(&hierarchy),
            vec![(&orbit_unit, ORBIT_TEST_LINK_UNITS_MAX_RATING)]
        );
    }

    #[test]
    fn test_link_matches_require_same_root_echelon() {
        let battalion = source_unit(
            "4 мсб / 752 мсп / 3 мсд / 20 ЗВА",
            vec![
                ("battalion", "4 мсб", 0),
                ("regiment", "752 мсп", 1),
                ("division", "3 мсд", 2),
                ("fieldArmy", "20 ЗВА", 3),
            ],
        );
        let company = source_unit(
            "10 мср / 4 мсб / 752 мсп / 3 мсд / 20 ЗВА",
            vec![
                ("company", "10 мср", 0),
                ("battalion", "4 мсб", 1),
                ("regiment", "752 мсп", 2),
                ("division", "3 мсд", 3),
                ("fieldArmy", "20 ЗВА", 4),
            ],
        );
        let hierarchy = [
            (EchoEchelon::Battalion, "4 мсб"),
            (EchoEchelon::Regiment, "752 мсп"),
            (EchoEchelon::Division, "3 мсд"),
            (EchoEchelon::Army, "20 ЗВА"),
        ];

        let orbit_units = [company, battalion.clone()];

        assert_eq!(
            TestLinkMatcher::new(&orbit_units).best_matches(&hierarchy),
            vec![(&battalion, ORBIT_TEST_LINK_UNITS_MAX_RATING)]
        );

        assert!(TestLinkMatcher::new(&orbit_units[..1])
            .best_matches(&hierarchy)
            .is_empty());
    }

    #[test]
    fn test_link_rejects_non_numeric_echelon_mismatches() {
        let orbit_unit = source_unit(
            "перший батальйон",
            vec![("battalion", "перший батальйон", 0)],
        );
        let hierarchy = [(EchoEchelon::Battalion, "другий батальйон")];

        assert_eq!(
            test_link_rating(
                &comparable_path(&orbit_unit).unwrap(),
                &hierarchy
            ),
            None
        );
    }

    #[test]
    fn sample_matches_collapsed_echo_echelons() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, _) = crate::orbit::types::parse_units(sample).unwrap();
        validate_source(&units).unwrap();
        let sigint_unit = echo_unit("", "батрурлр", "53 зрбр", "", "20 ЗВА");
        assert!(matches_sigint_unit(&units[0], &sigint_unit));

        let platoon = source_unit("1 взвод", vec![("platoon", "1 взвод", 0)]);
        assert!(matches_sigint_unit(
            &platoon,
            &echo_unit("1 взвод", "", "", "", "")
        ));

        let brigade = source_unit("53 зрбр", vec![("brigade", "53 зрбр", 0)]);
        assert!(matches_sigint_unit(
            &brigade,
            &echo_unit("", "", "53 зрбр", "", "")
        ));

        let corps = source_unit("11 АК", vec![("corps", "11 АК", 0)]);
        assert!(matches_sigint_unit(
            &corps,
            &echo_unit("", "", "", "", "11 АК")
        ));
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
    fn missing_parent_name_evidence_is_rejected() {
        let unit = source_unit(
            "взвод / округ",
            vec![("platoon", "взвод", 1), ("militaryDistrict", "округ", 0)],
        );
        assert!(!matches_sigint_unit(&unit, &echo_unit("", "", "", "", "")));
        assert!(!matches_sigint_unit(
            &unit,
            &echo_unit("взвод", "", "", "", "невідомо")
        ));
    }

    #[test]
    fn extended_orbit_echelons_participate_in_matching() {
        let unit = source_unit(
            "1 рота / Західний ВО / ЗС РФ",
            vec![
                ("company", "1 рота", 2),
                ("militaryDistrict", "Західний ВО", 1),
                ("armyRegion", "ЗС РФ", 0),
            ],
        );
        let mut sigint_unit = echo_unit("1 рота", "", "", "", "");
        sigint_unit.military_district = "Західний ВО".to_string();
        sigint_unit.army_region = "ЗС РФ".to_string();
        assert!(matches_sigint_unit(&unit, &sigint_unit));

        sigint_unit.military_district = "Східний ВО".to_string();
        assert!(!matches_sigint_unit(&unit, &sigint_unit));
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
    fn duplicate_matches_with_same_parents_return_all_candidates() {
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
            HashMap::from([(first.unit_id, BTreeSet::from([1, 2]))])
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
            matching_sigint_unit_ids(
                std::slice::from_ref(&unit),
                &[battalion, brigade],
            ),
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
    fn matching_parent_names_override_incorrect_echelon_metadata() {
        let unit = source_unit(
            "1 рота / 1111 бр",
            vec![("company", "1 рота", 1), ("battalion", "1111 бр", 0)],
        );
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("1 рота", "", "1111 бр", "", "")
        ));
    }

    #[test]
    fn sigint_name_blacklist_is_removed_case_insensitively() {
        let unit = source_unit(
            "1 рота / 1111 бр",
            vec![("company", "1 рота", 1), ("brigade", "1111 бр", 0)],
        );
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("1 рота (АТ)", "", "1111 бр ТерО", "", "")
        ));
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("1 рота", "", "1111 бр ТрО", "", "")
        ));
    }

    #[test]
    fn generative_parent_names_participate_in_matching() {
        let mut unit = source_unit(
            "1 мсб / 4 омсбр / УВ(с) \"Дзержинск\"",
            vec![
                ("battalion", "1 мсб", 2),
                ("brigade", "4 омсбр", 1),
                ("corps", "УВ(с) \"Дзержинск\"", 0),
            ],
        );
        unit.generative_unit_name_full =
            Some("1 мсб / 4 омсбр / 3 ЗВА / ПдВО".to_string());
        unit.generative_parent_units = vec![
            parent_unit("militaryDistrict", "ПдВО", 0),
            parent_unit("fieldArmy", "3 ЗВА", 1),
            parent_unit("brigade", "4 омсбр", 2),
        ];
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("", "1 мсб ТрО", "4 омсбр", "", "3 ЗВА")
        ));
    }

    #[test]
    fn army_suffix_variants_match_by_number() {
        let unit = source_unit(
            "1111 бр / 58 ЗВА",
            vec![("brigade", "1111 бр", 1), ("fieldArmy", "58 ЗВА", 0)],
        );
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("", "", "1111 бр", "", "58 А")
        ));
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("", "", "1111 бр", "", "58 гв. ОА")
        ));
        assert!(!matches_sigint_unit(
            &unit,
            &echo_unit("", "", "1111 бр", "", "59 А")
        ));
    }

    #[test]
    fn army_root_suffix_variants_match_by_number() {
        let unit = source_unit("58 ЗВА", vec![("fieldArmy", "58 ЗВА", 0)]);
        assert!(matches_sigint_unit(
            &unit,
            &echo_unit("", "", "", "", "58 ОА")
        ));
    }

    #[test]
    fn unit_number_participates_in_candidate_matching() {
        let mut unit = source_unit("unknown", vec![("company", "unknown", 0)]);
        unit.unit_name = None;
        unit.unit_name_short = None;
        unit.unit_number = Some("5101".to_string());
        let sigint_unit = echo_unit("5101", "", "", "", "");

        assert_eq!(
            closest_orbit_matches(std::slice::from_ref(&unit), &sigint_unit),
            vec![&unit]
        );
    }

    #[test]
    fn manual_search_returns_every_equally_close_match() {
        let mut first = source_unit(
            "1 мсб / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "1 мсб", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        first.unit_id = Uuid::from_u128(1);
        let mut second = first.clone();
        second.unit_id = Uuid::from_u128(2);
        let weaker = source_unit(
            "2 мсб / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "2 мсб", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        let sigint_unit = echo_unit("", "1 мсб", "4 омсбр", "", "3 А");
        assert_eq!(
            closest_orbit_matches(
                &[second.clone(), weaker, first.clone()],
                &sigint_unit
            )
            .into_iter()
            .map(|unit| unit.unit_id)
            .collect::<Vec<_>>(),
            vec![first.unit_id, second.unit_id]
        );
    }

    #[test]
    fn parent_path_name_does_not_match_descendant_as_root() {
        let unit = source_unit(
            "2 мсб / 1111 бр",
            vec![("battalion", "2 мсб", 1), ("brigade", "1111 бр", 0)],
        );
        assert!(!matches_sigint_unit(
            &unit,
            &echo_unit("", "", "1111 бр", "", "")
        ));
    }

    #[test]
    fn closest_orbit_unit_wins_when_multiple_match_one_sigint_unit() {
        let less_specific = source_unit(
            "1111 бр / 45 д",
            vec![("brigade", "1111 бр", 1), ("division", "45 д", 0)],
        );
        let closest = source_unit(
            "1111 бр / 45 д / 56 А",
            vec![
                ("brigade", "1111 бр", 2),
                ("division", "45 д", 1),
                ("fieldArmy", "56 А", 0),
            ],
        );
        let sigint_unit = echo_unit("", "", "1111 бр", "45 д", "56 А");
        assert_eq!(
            matching_sigint_unit_ids(
                &[less_specific.clone(), closest.clone()],
                &[sigint_unit]
            ),
            HashMap::from([(closest.unit_id, BTreeSet::from([1]))])
        );
        assert_eq!(
            matching_orbit_unit_ids(
                &[less_specific, closest.clone()],
                &echo_unit("", "", "1111 бр", "45 д", "56 А")
            ),
            BTreeSet::from([closest.unit_id])
        );
    }

    #[test]
    fn equally_close_orbit_units_with_different_parents_are_skipped() {
        let first = source_unit(
            "1111 бр / 45 д",
            vec![("brigade", "1111 бр", 1), ("division", "45 д", 0)],
        );
        let second = source_unit(
            "1111 бр / 46 д",
            vec![("brigade", "1111 бр", 1), ("division", "46 д", 0)],
        );
        let sigint_unit = echo_unit("", "", "1111 бр", "", "");
        assert!(matching_sigint_unit_ids(&[first, second], &[sigint_unit])
            .is_empty());
    }

    #[test]
    fn equally_close_orbit_units_with_extended_paths_pick_shortest() {
        let mut direct = source_unit(
            "1 мсб / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "1 мсб", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        direct.generative_unit_name_full =
            Some("1 мсб / 4 омсбр / 3 ЗВА / ПдВО".to_string());
        let mut extended = source_unit(
            "1 мсб / 1194 мсп / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "1 мсб", 3),
                ("regiment", "1194 мсп", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        extended.generative_unit_name_full =
            Some("1 мсб / 1194 мсп / 4 омсбр / 3 ЗВА / ПдВО".to_string());
        let sigint_unit = echo_unit("", "1 мсб", "4 омсбр", "", "3 ЗВА");

        assert_eq!(
            matching_sigint_unit_ids(
                &[direct.clone(), extended.clone()],
                &[sigint_unit],
            ),
            HashMap::from([(direct.unit_id, BTreeSet::from([1]))])
        );
    }

    #[test]
    fn intermediate_parent_selects_extended_path() {
        let direct = source_unit(
            "1 мсб / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "1 мсб", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        let extended = source_unit(
            "1 мсб / 1194 мсп / 4 омсбр / 3 ЗВА",
            vec![
                ("battalion", "1 мсб", 3),
                ("regiment", "1194 мсп", 2),
                ("brigade", "4 омсбр", 1),
                ("fieldArmy", "3 ЗВА", 0),
            ],
        );
        let sigint_unit = echo_unit("", "1 мсб", "1194 мсп", "", "3 ЗВА");

        assert_eq!(
            matching_sigint_unit_ids(
                &[direct, extended.clone()],
                &[sigint_unit],
            ),
            HashMap::from([(extended.unit_id, BTreeSet::from([1]))])
        );
    }

    #[test]
    fn equally_close_orbit_units_with_same_parents_pick_lowest_id() {
        let mut first = source_unit(
            "1111 бр / 45 д",
            vec![("brigade", "1111 бр", 1), ("division", "45 д", 0)],
        );
        first.unit_id = Uuid::from_u128(1);
        let mut second = first.clone();
        second.unit_id = Uuid::from_u128(2);
        let sigint_unit = echo_unit("", "", "1111 бр", "45 д", "");
        assert_eq!(
            matching_sigint_unit_ids(&[second, first.clone()], &[sigint_unit]),
            HashMap::from([(first.unit_id, BTreeSet::from([1]))])
        );
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
    fn empty_exports_and_invalid_operational_paths_are_rejected() {
        assert!(validate_source(&[]).is_err());
        let mut unit = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        unit.operational_unit_name_full = None;
        assert!(validate_source(&[unit]).is_err());

        let mut unit = source_unit("1 рота", vec![("company", "1 рота", 0)]);
        unit.operational_unit_name_full = Some(" \t\n".to_string());
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

    fn parent_unit(key: &str, name: &str, path_level: i32) -> SourceUnit {
        SourceUnit {
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
            path_level: Some(path_level),
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
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: company.to_string(),
            battalion: battalion.to_string(),
            regiment: regiment.to_string(),
            brigade: String::new(),
            division: division.to_string(),
            corps: String::new(),
            army: army.to_string(),
            army_region: String::new(),
            military_district: String::new(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: Uuid::new_v4(),
            name: String::new(),
            comment: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            is_inconsistent: false,
            updated_at: Default::default(),
        }
    }
}
