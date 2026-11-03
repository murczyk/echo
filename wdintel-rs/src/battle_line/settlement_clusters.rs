use super::{settlement_max_distance_m, LocationResolutionDraft};
use crate::battle_line::types::BattleLineCoordinate;
use crate::config::{
    BATTLE_LINE_SETTLEMENT_CLUSTER_MAX_DISTANCE_METERS,
    BATTLE_LINE_SETTLEMENT_ELECTION_MAX_NAMES,
    BATTLE_LINE_SETTLEMENT_ELECTION_MAX_STATES,
    BATTLE_LINE_SETTLEMENT_ELECTION_TIE_METERS,
};
use crate::settlement::{coordinate_distance_m, normalize_name};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub(super) struct SettlementAnchor {
    pub settlement_id: i32,
    pub coordinate: BattleLineCoordinate,
}

#[derive(Clone)]
struct Candidate {
    settlement_id: i32,
    coordinate: BattleLineCoordinate,
    battle_line_distance_m: f64,
    anchor_distance_m: f64,
}

struct Group {
    draft_indices: Vec<usize>,
    candidates: Vec<Candidate>,
    fixed: bool,
}

#[derive(Clone, Default)]
struct Combination {
    choices: BTreeMap<usize, Candidate>,
    distance_m: f64,
    battle_line_distance_m: f64,
    anchor_distance_m: f64,
}

impl Combination {
    fn rank(&self, other: &Self, anchored: bool) -> Ordering {
        other
            .choices
            .len()
            .cmp(&self.choices.len())
            .then_with(|| {
                self.primary_distance(anchored)
                    .total_cmp(&other.primary_distance(anchored))
            })
            .then_with(|| {
                self.secondary_distance(anchored)
                    .total_cmp(&other.secondary_distance(anchored))
            })
    }

    fn primary_distance(&self, anchored: bool) -> f64 {
        if anchored {
            self.anchor_distance_m
        } else {
            self.distance_m
        }
    }

    fn secondary_distance(&self, anchored: bool) -> f64 {
        if anchored {
            self.distance_m
        } else {
            self.battle_line_distance_m
        }
    }

    fn extend(
        &self,
        group_index: usize,
        candidate: &Candidate,
        anchored: bool,
    ) -> Option<Self> {
        let mut distance_m = self.distance_m;
        for choice in self.choices.values() {
            let distance =
                distance_between(&choice.coordinate, &candidate.coordinate);
            if !anchored
                && distance
                    >= BATTLE_LINE_SETTLEMENT_CLUSTER_MAX_DISTANCE_METERS
            {
                return None;
            }
            distance_m += distance;
        }
        let mut extended = self.clone();
        extended.choices.insert(group_index, candidate.clone());
        extended.distance_m = distance_m;
        extended.battle_line_distance_m += candidate.battle_line_distance_m;
        extended.anchor_distance_m += candidate.anchor_distance_m;
        Some(extended)
    }
}

#[derive(Default)]
struct Election {
    best: Combination,
    tied: bool,
    visited: usize,
    exhausted: bool,
    minimum_votes: usize,
    anchored: bool,
    primary_limit: Option<f64>,
}

impl Election {
    fn search(
        &mut self,
        groups: &[Group],
        index: usize,
        current: &Combination,
    ) {
        self.visited += 1;
        if self.visited > BATTLE_LINE_SETTLEMENT_ELECTION_MAX_STATES {
            self.exhausted = true;
            return;
        }
        let maximum_votes = current.choices.len() + groups.len() - index;
        if maximum_votes < self.minimum_votes
            || maximum_votes < self.best.choices.len()
            || self.primary_limit.is_some_and(|limit| {
                current.primary_distance(self.anchored) > limit
            })
        {
            return;
        }
        if index == groups.len() {
            self.consider(current);
            return;
        }
        for candidate in &groups[index].candidates {
            if let Some(extended) =
                current.extend(index, candidate, self.anchored)
            {
                self.search(groups, index + 1, &extended);
            }
            if self.exhausted {
                return;
            }
        }
        if !groups[index].fixed {
            self.search(groups, index + 1, current);
        }
    }

    fn consider(&mut self, current: &Combination) {
        if self.primary_limit.is_none() {
            if current.rank(&self.best, self.anchored) == Ordering::Less {
                self.best = current.clone();
            }
            return;
        }
        if current.choices.len() != self.minimum_votes {
            return;
        }
        if self.best.choices.is_empty() {
            self.best = current.clone();
            return;
        }
        let distance = current.secondary_distance(self.anchored);
        let previous = self.best.secondary_distance(self.anchored);
        let tied = compare_distance(distance, previous) == Ordering::Equal;
        if distance < previous {
            self.best = current.clone();
            self.tied = tied;
        } else if tied {
            self.tied = true;
        }
    }
}

pub(super) fn elect_settlements(
    drafts: &[LocationResolutionDraft],
    anchors: &[SettlementAnchor],
) -> Vec<Option<usize>> {
    elect_settlements_with_fixed(drafts, anchors, &BTreeMap::new())
}

fn elect_settlements_with_fixed(
    drafts: &[LocationResolutionDraft],
    anchors: &[SettlementAnchor],
    fixed: &BTreeMap<String, i32>,
) -> Vec<Option<usize>> {
    let mut groups = eligible_groups(drafts);
    for group in &mut groups {
        let name = normalize_name(&drafts[group.draft_indices[0]].location);
        if let Some(settlement_id) = fixed.get(&name) {
            group.fixed = true;
            group
                .candidates
                .retain(|candidate| candidate.settlement_id == *settlement_id);
        }
    }
    let mut chosen = vec![None; drafts.len()];
    if groups.is_empty()
        || groups.len() > BATTLE_LINE_SETTLEMENT_ELECTION_MAX_NAMES
    {
        return chosen;
    }
    groups.retain(|group| group.fixed || !group.candidates.is_empty());
    if groups.len() == 1 && anchors.is_empty() {
        if let [candidate] = groups[0].candidates.as_slice() {
            apply_choice(drafts, &groups[0], candidate, &mut chosen);
        }
        return chosen;
    }
    groups.sort_by_key(|group| group.candidates.len());
    let anchored = !anchors.is_empty();
    if anchored {
        apply_anchor_distances(&mut groups, anchors);
    }
    let mut election = Election {
        minimum_votes: if anchored { 1 } else { groups.len() / 2 + 1 },
        anchored,
        ..Default::default()
    };
    election.search(&groups, 0, &Combination::default());
    if election.exhausted || election.best.choices.is_empty() {
        return chosen;
    }
    let mut election = Election {
        minimum_votes: election.best.choices.len(),
        anchored,
        visited: election.visited,
        primary_limit: Some(
            election.best.primary_distance(anchored)
                + BATTLE_LINE_SETTLEMENT_ELECTION_TIE_METERS,
        ),
        ..Default::default()
    };
    election.search(&groups, 0, &Combination::default());
    if election.exhausted || election.tied {
        return chosen;
    }
    for (group_index, candidate) in &election.best.choices {
        apply_choice(drafts, &groups[*group_index], candidate, &mut chosen);
    }
    chosen
}

pub(super) fn resolve_cluster(
    drafts: &mut [LocationResolutionDraft],
    anchors: &[SettlementAnchor],
) {
    let chosen = elect_settlements(drafts, anchors);
    for (draft, chosen) in drafts.iter_mut().zip(chosen) {
        draft.chosen_candidate_index = chosen;
    }
}

pub(super) fn resolve_cluster_with_fixed(
    drafts: &mut [LocationResolutionDraft],
    fixed: &BTreeMap<String, i32>,
) {
    let chosen = elect_settlements_with_fixed(drafts, &[], fixed);
    for (draft, chosen) in drafts.iter_mut().zip(chosen) {
        draft.chosen_candidate_index = chosen;
    }
}

fn apply_choice(
    drafts: &[LocationResolutionDraft],
    group: &Group,
    candidate: &Candidate,
    chosen: &mut [Option<usize>],
) {
    for &index in &group.draft_indices {
        chosen[index] = drafts[index]
            .candidates
            .iter()
            .position(|other| other.settlement_id == candidate.settlement_id);
    }
}

fn eligible_groups(drafts: &[LocationResolutionDraft]) -> Vec<Group> {
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for (index, draft) in drafts.iter().enumerate() {
        let name = normalize_name(&draft.location);
        if name.is_empty() {
            continue;
        }
        let group = groups.entry(name).or_insert_with(|| Group {
            draft_indices: vec![],
            candidates: eligible_candidates(draft),
            fixed: false,
        });
        group.draft_indices.push(index);
    }
    groups.into_values().collect()
}

fn eligible_candidates(draft: &LocationResolutionDraft) -> Vec<Candidate> {
    let mut candidates = BTreeMap::new();
    for (&candidate_index, distance) in &draft.battle_line_distances {
        if !distance.distance_m.is_finite()
            || distance.distance_m < 0.0
            || distance.distance_m > settlement_max_distance_m(distance.is_west)
        {
            continue;
        }
        let Some(candidate) = draft.candidates.get(candidate_index) else {
            continue;
        };
        if !valid_coordinate(&candidate.coordinate) {
            continue;
        }
        candidates
            .entry(candidate.settlement_id)
            .or_insert(Candidate {
                settlement_id: candidate.settlement_id,
                coordinate: candidate.coordinate.clone(),
                battle_line_distance_m: distance.distance_m,
                anchor_distance_m: 0.0,
            });
    }
    candidates.into_values().collect()
}

fn apply_anchor_distances(groups: &mut [Group], anchors: &[SettlementAnchor]) {
    for group in groups {
        group.candidates.retain_mut(|candidate| {
            let closest = anchors
                .iter()
                .filter(|anchor| valid_coordinate(&anchor.coordinate))
                .map(|anchor| {
                    if anchor.settlement_id == candidate.settlement_id {
                        0.0
                    } else {
                        distance_between(
                            &candidate.coordinate,
                            &anchor.coordinate,
                        )
                    }
                })
                .min_by(f64::total_cmp);
            if let Some(distance) = closest {
                candidate.anchor_distance_m = distance;
            }
            closest.is_some()
        });
    }
}

fn compare_distance(left: f64, right: f64) -> Ordering {
    if (left - right).abs() <= BATTLE_LINE_SETTLEMENT_ELECTION_TIE_METERS {
        Ordering::Equal
    } else {
        left.total_cmp(&right)
    }
}

fn valid_coordinate(coordinate: &BattleLineCoordinate) -> bool {
    (-90.0..=90.0).contains(&coordinate.lat)
        && (-180.0..=180.0).contains(&coordinate.lon)
}

fn distance_between(
    left: &BattleLineCoordinate,
    right: &BattleLineCoordinate,
) -> f64 {
    coordinate_distance_m(left.lat, left.lon, right.lat, right.lon)
}

#[cfg(test)]
mod tests;
