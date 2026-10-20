use super::{settlement_max_distance_m, LocationResolutionDraft};
use crate::battle_line::types::BattleLineCoordinate;
use crate::config::{
    BATTLE_LINE_SETTLEMENT_CLUSTER_BEAM_WIDTH,
    BATTLE_LINE_SETTLEMENT_CLUSTER_DISTANCE_BATCH_SIZE,
    BATTLE_LINE_SETTLEMENT_CLUSTER_MAX_DISTANCE_METERS,
};
use crate::h;
use crate::settlement::normalize_name;
use crate::types::ShortContext;
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub(super) struct SettlementAnchor {
    pub settlement_id: i32,
    pub coordinate: BattleLineCoordinate,
}

#[derive(Clone)]
struct Candidate {
    group_index: usize,
    candidate_index: Option<usize>,
    settlement_id: i32,
    coordinate: BattleLineCoordinate,
    battle_line_distance_m: f64,
}

#[derive(Clone, Default)]
struct Combination {
    choices: BTreeMap<usize, Candidate>,
    distance_m: f64,
    battle_line_distance_m: f64,
}

impl Combination {
    fn rank(&self, other: &Self) -> Ordering {
        self.distance_m
            .total_cmp(&other.distance_m)
            .then_with(|| {
                self.battle_line_distance_m
                    .total_cmp(&other.battle_line_distance_m)
            })
            .then_with(|| {
                self.choices
                    .values()
                    .map(|choice| choice.settlement_id)
                    .cmp(
                        other
                            .choices
                            .values()
                            .map(|choice| choice.settlement_id),
                    )
            })
    }

    fn extend(
        &self,
        candidate: &Candidate,
        distances: &BTreeMap<(i32, i32), f64>,
    ) -> Option<Self> {
        let mut distance_m = self.distance_m;
        for choice in self.choices.values() {
            let distance = distances
                .get(&(choice.settlement_id, candidate.settlement_id))?;
            if !distance.is_finite()
                || *distance
                    >= BATTLE_LINE_SETTLEMENT_CLUSTER_MAX_DISTANCE_METERS
            {
                return None;
            }
            distance_m += distance;
        }
        let mut extended = self.clone();
        extended
            .choices
            .insert(candidate.group_index, candidate.clone());
        extended.distance_m = distance_m;
        extended.battle_line_distance_m += candidate.battle_line_distance_m;
        Some(extended)
    }
}

pub(super) async fn resolve_cluster<C: ConnectionTrait>(
    dbx: &C,
    drafts: &mut [LocationResolutionDraft],
    anchors: &[SettlementAnchor],
) -> anyhow::Result<()> {
    let mut groups = eligible_groups(drafts);
    if groups.is_empty() || groups.len() + anchors.len() < 2 {
        return Ok(());
    }
    groups.sort_by_key(|group| {
        let index = group[0].group_index;
        (group.len(), normalize_name(&drafts[index].location), index)
    });
    let mut beam = vec![Combination::default()];
    for (index, anchor) in anchors.iter().enumerate() {
        let candidate = anchor_candidate(anchor, drafts.len() + index);
        beam = extend_beam(dbx, &beam, &[candidate]).await.c(h!())?;
    }
    for (index, group) in groups.iter().enumerate() {
        if index == 0 && anchors.is_empty() {
            beam = group
                .iter()
                .map(|candidate| {
                    let mut combination = Combination::default();
                    combination
                        .choices
                        .insert(candidate.group_index, candidate.clone());
                    combination.battle_line_distance_m =
                        candidate.battle_line_distance_m;
                    combination
                })
                .collect();
        } else {
            beam = extend_beam(dbx, &beam, group).await.c(h!())?;
        }
        if beam.is_empty() {
            break;
        }
    }
    for draft in drafts.iter_mut() {
        draft.chosen_candidate_index = None;
    }
    if let Some(best) = beam.first() {
        for choice in best.choices.values() {
            if let Some(draft) = drafts.get_mut(choice.group_index) {
                draft.chosen_candidate_index = choice.candidate_index;
            }
        }
    }
    Ok(())
}

fn eligible_groups(drafts: &[LocationResolutionDraft]) -> Vec<Vec<Candidate>> {
    drafts
        .iter()
        .enumerate()
        .filter_map(|(group_index, draft)| {
            let mut candidates = BTreeMap::new();
            for (candidate_index, distance) in &draft.battle_line_distances {
                if !distance.distance_m.is_finite()
                    || distance.distance_m
                        > settlement_max_distance_m(distance.is_west)
                {
                    continue;
                }
                let candidate = &draft.candidates[*candidate_index];
                candidates.entry(candidate.settlement_id).or_insert(
                    Candidate {
                        group_index,
                        candidate_index: Some(*candidate_index),
                        settlement_id: candidate.settlement_id,
                        coordinate: candidate.coordinate.clone(),
                        battle_line_distance_m: distance.distance_m,
                    },
                );
            }
            (!candidates.is_empty()).then(|| candidates.into_values().collect())
        })
        .collect()
}

fn anchor_candidate(
    anchor: &SettlementAnchor,
    group_index: usize,
) -> Candidate {
    Candidate {
        group_index,
        candidate_index: None,
        settlement_id: anchor.settlement_id,
        coordinate: anchor.coordinate.clone(),
        battle_line_distance_m: 0.0,
    }
}

async fn extend_beam<C: ConnectionTrait>(
    dbx: &C,
    beam: &[Combination],
    candidates: &[Candidate],
) -> anyhow::Result<Vec<Combination>> {
    if beam.is_empty() {
        return Ok(vec![]);
    }
    let selected = beam
        .iter()
        .flat_map(|combination| combination.choices.values())
        .map(|candidate| (candidate.settlement_id, candidate))
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect::<Vec<_>>();
    let batch_size = (BATTLE_LINE_SETTLEMENT_CLUSTER_DISTANCE_BATCH_SIZE
        / selected.len().max(1))
    .max(1);
    let mut shortlist = Vec::new();
    for candidates in candidates.chunks(batch_size) {
        let distances =
            load_distances(dbx, &selected, candidates).await.c(h!())?;
        for combination in beam {
            for candidate in candidates {
                if let Some(extended) =
                    combination.extend(candidate, &distances)
                {
                    shortlist.push(extended);
                    shortlist.sort_by(Combination::rank);
                    shortlist
                        .truncate(BATTLE_LINE_SETTLEMENT_CLUSTER_BEAM_WIDTH);
                }
            }
        }
    }
    Ok(shortlist)
}

#[derive(FromQueryResult)]
struct PairDistance {
    left_id: i32,
    right_id: i32,
    distance_m: f64,
}

async fn load_distances<C: ConnectionTrait>(
    dbx: &C,
    selected: &[&Candidate],
    candidates: &[Candidate],
) -> anyhow::Result<BTreeMap<(i32, i32), f64>> {
    let mut distances = BTreeMap::new();
    for selected in
        selected.chunks(BATTLE_LINE_SETTLEMENT_CLUSTER_DISTANCE_BATCH_SIZE)
    {
        let rows = PairDistance::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select l.id as left_id, r.id as right_id,
    ST_Distance(
        ST_SetSRID(ST_MakePoint(l.lon, l.lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography
    ) as distance_m
from unnest($1::integer[], $2::double precision[], $3::double precision[]) as l(id, lat, lon)
cross join unnest($4::integer[], $5::double precision[], $6::double precision[]) as r(id, lat, lon)
            "#,
            [
                selected.iter().map(|candidate| candidate.settlement_id).collect::<Vec<_>>().into(),
                selected.iter().map(|candidate| candidate.coordinate.lat).collect::<Vec<_>>().into(),
                selected.iter().map(|candidate| candidate.coordinate.lon).collect::<Vec<_>>().into(),
                candidates.iter().map(|candidate| candidate.settlement_id).collect::<Vec<_>>().into(),
                candidates.iter().map(|candidate| candidate.coordinate.lat).collect::<Vec<_>>().into(),
                candidates.iter().map(|candidate| candidate.coordinate.lon).collect::<Vec<_>>().into(),
            ],
        )).all(dbx).await.c(h!())?;
        for row in rows {
            distances.insert((row.left_id, row.right_id), row.distance_m);
        }
    }
    Ok(distances)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battle_line::types::BattleLineSettlementCandidate;
    use crate::battle_line::{
        location_result_from_draft, BattleLineCandidateDistance,
    };

    fn draft(
        name: &str,
        candidates: &[(i32, f64, f64)],
    ) -> LocationResolutionDraft {
        LocationResolutionDraft {
            location: name.to_string(),
            candidates: candidates
                .iter()
                .map(|&(settlement_id, lon, _)| BattleLineSettlementCandidate {
                    settlement_id,
                    name: name.to_string(),
                    district: String::new(),
                    region: String::new(),
                    coordinate: BattleLineCoordinate { lat: 0.0, lon },
                })
                .collect(),
            battle_line_distances: candidates
                .iter()
                .enumerate()
                .map(|(candidate_index, &(_, _, distance_m))| {
                    (
                        candidate_index,
                        BattleLineCandidateDistance {
                            candidate_index,
                            distance_m,
                            is_west: false,
                        },
                    )
                })
                .collect(),
            chosen_candidate_index: (!candidates.is_empty()).then_some(0),
            invalid_aor_ids: vec![],
        }
    }

    fn chosen(drafts: Vec<LocationResolutionDraft>) -> Vec<Option<i32>> {
        drafts
            .into_iter()
            .map(location_result_from_draft)
            .map(|result| result.chosen_settlement_id)
            .collect()
    }

    #[tokio::test]
    async fn retains_alternative_pairs_for_later_names_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![
            draft("A", &[(1, 0.0, 1.0), (2, 1.0, 2.0)]),
            draft("B", &[(3, 0.0, 1.0), (4, 1.01, 2.0)]),
            draft("C", &[(5, 1.02, 1.0), (6, 2.0, 1.0), (7, 3.0, 1.0)]),
            draft("D", &[(8, 1.03, 1.0), (9, 4.0, 1.0), (10, 5.0, 1.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(2), Some(4), Some(5), Some(8)]);
    }

    #[tokio::test]
    async fn ranks_complete_clusters_by_all_pairwise_distances_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![
            draft("A", &[(1, 0.0, 1.0), (2, 0.1, 2.0)]),
            draft("B", &[(3, 0.0, 1.0), (4, 0.12, 2.0)]),
            draft("C", &[(5, 0.12, 1.0), (6, 0.3, 1.0), (7, 0.4, 1.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(2), Some(4), Some(5)]);
    }

    #[tokio::test]
    async fn rejects_chains_and_does_not_persist_a_partial_cluster_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.3, 1.0)]),
            draft("C", &[(3, 0.6, 1.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![None, None, None]);
    }

    #[tokio::test]
    async fn excludes_ineligible_names_without_blocking_good_candidates_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.0, 150_001.0), (3, 0.1, 2.0)]),
            draft("MISSING", &[]),
            draft("DISTANT", &[(4, 0.0, 150_001.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(1), Some(3), None, None]);
    }

    #[tokio::test]
    async fn honors_resolved_context_and_allows_shared_canonical_ids_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![draft("A", &[(1, 0.0, 1.0), (2, 1.0, 2.0)])];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(drafts[0].chosen_candidate_index, Some(0));
        let anchor = SettlementAnchor {
            settlement_id: 2,
            coordinate: BattleLineCoordinate { lat: 0.0, lon: 1.0 },
        };
        resolve_cluster(&dbx, &mut drafts, &[anchor]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(2)]);

        let mut drafts = vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("ALIAS", &[(1, 0.0, 1.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(1), Some(1)]);
    }

    #[tokio::test]
    async fn breaks_ties_by_battle_line_distance_then_canonical_ids_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let mut drafts = vec![
            draft("A", &[(1, 0.0, 3.0), (3, 0.0, 2.0), (2, 0.0, 2.0)]),
            draft("B", &[(5, 0.0, 1.0), (4, 0.0, 1.0)]),
        ];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(2), Some(4)]);
    }

    #[tokio::test]
    async fn considers_every_first_pair_before_pruning_to_five_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let candidates = (1..=6)
            .map(|id| (id, f64::from(id), 1.0))
            .collect::<Vec<_>>();
        let others = (7..=13)
            .map(|id| (id, f64::from(id) - 1.0, 1.0))
            .collect::<Vec<_>>();
        let mut drafts = vec![draft("A", &candidates), draft("B", &others)];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![Some(6), Some(7)]);
    }

    #[tokio::test]
    async fn does_not_restore_pruned_pairs_when_a_later_group_fails_2133() {
        let dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let first = (1..=6)
            .map(|id| (id, f64::from(id), 1.0))
            .collect::<Vec<_>>();
        let second = (11..=17)
            .map(|id| (id, f64::from(id - 10), 1.0))
            .collect::<Vec<_>>();
        let third = (21..=28)
            .map(|id| (id, f64::from(id - 15), 1.0))
            .collect::<Vec<_>>();
        let mut drafts =
            vec![draft("A", &first), draft("B", &second), draft("C", &third)];
        resolve_cluster(&dbx, &mut drafts, &[]).await.unwrap();
        assert_eq!(chosen(drafts), vec![None, None, None]);
    }

    #[test]
    fn excludes_exactly_fifty_kilometers_2133() {
        let first = Candidate {
            group_index: 0,
            candidate_index: Some(0),
            settlement_id: 1,
            coordinate: BattleLineCoordinate { lat: 0.0, lon: 0.0 },
            battle_line_distance_m: 1.0,
        };
        let second = Candidate {
            group_index: 1,
            settlement_id: 2,
            ..first.clone()
        };
        let combination = Combination::default()
            .extend(&first, &BTreeMap::new())
            .unwrap();
        for (distance, valid) in
            [(49_999.999, true), (50_000.0, false), (50_000.001, false)]
        {
            let distances = BTreeMap::from([((1, 2), distance)]);
            assert_eq!(
                combination.extend(&second, &distances).is_some(),
                valid
            );
        }
    }
}
