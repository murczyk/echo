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
            .map(|(index, &(_, _, distance_m))| {
                (
                    index,
                    BattleLineCandidateDistance {
                        candidate_index: index,
                        distance_m,
                        is_west: false,
                    },
                )
            })
            .collect(),
        chosen_candidate_index: None,
        invalid_aor_ids: vec![],
    }
}

fn chosen(mut drafts: Vec<LocationResolutionDraft>) -> Vec<Option<i32>> {
    resolve_cluster(&mut drafts, &[]);
    drafts
        .into_iter()
        .map(location_result_from_draft)
        .map(|result| result.chosen_settlement_id)
        .collect()
}

#[test]
fn finds_complete_cluster_instead_of_greedy_pair_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0), (2, 1.0, 2.0)]),
            draft("B", &[(3, 0.0, 1.0), (4, 1.01, 2.0)]),
            draft("C", &[(5, 1.02, 1.0), (6, 2.0, 1.0), (7, 3.0, 1.0)]),
            draft("D", &[(8, 1.03, 1.0), (9, 4.0, 1.0), (10, 5.0, 1.0)]),
        ]),
        vec![Some(2), Some(4), Some(5), Some(8)]
    );
}

#[test]
fn ranks_by_all_pairwise_distances_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0), (2, 0.1, 2.0)]),
            draft("B", &[(3, 0.0, 1.0), (4, 0.12, 2.0)]),
            draft("C", &[(5, 0.12, 1.0), (6, 0.3, 1.0), (7, 0.4, 1.0)]),
        ]),
        vec![Some(2), Some(4), Some(5)]
    );
}

#[test]
fn fixed_inbox_votes_cannot_be_replaced_or_dropped_for_another_cluster_2133() {
    let fixed = BTreeMap::from([("A".to_string(), 1)]);
    let mut drafts = vec![
        draft("A", &[(1, 0.0, 1.0), (2, 2.0, 1.0)]),
        draft("B", &[(3, 2.01, 1.0)]),
        draft("C", &[(4, 2.02, 1.0)]),
    ];
    resolve_cluster_with_fixed(&mut drafts, &fixed);
    assert!(drafts
        .iter()
        .all(|draft| draft.chosen_candidate_index.is_none()));
    assert_eq!(
        elect_settlements_with_fixed(
            &[
                draft("A", &[(1, 0.0, 1.0)]),
                draft("B", &[(2, 0.1, 1.0)]),
                draft("OUTLIER", &[(3, 4.0, 1.0)]),
                draft("MISSING", &[]),
            ],
            &[],
            &fixed,
        ),
        vec![Some(0), Some(0), None, None]
    );
    assert_eq!(
        elect_settlements_with_fixed(
            &[draft("A", &[]), draft("B", &[(2, 0.1, 1.0)])],
            &[],
            &fixed,
        ),
        vec![None; 2]
    );
}

#[test]
fn selects_strict_majority_and_leaves_outliers_unresolved_2133() {
    assert_eq!(
        chosen(vec![
            draft("OUTLIER", &[(1, 4.0, 1.0)]),
            draft("A", &[(2, 1.0, 1.0)]),
            draft("B", &[(3, 1.01, 1.0)]),
            draft("C", &[(4, 1.02, 1.0)]),
        ]),
        vec![None, Some(2), Some(3), Some(4)]
    );
}

#[test]
fn missing_and_ineligible_names_do_not_block_resolved_locations_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.1, 2.0)]),
            draft("MISSING", &[]),
            draft("DISTANT", &[(3, 0.0, 150_001.0)]),
        ]),
        vec![Some(1), Some(2), None, None]
    );
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.1, 2.0)]),
            draft("MISSING", &[]),
        ]),
        vec![Some(1), Some(2), None]
    );
    for candidates in [vec![(1, 0.0, 1.0)], vec![(1, 0.0, 1.0), (2, 0.1, 2.0)]]
    {
        let expected = (candidates.len() == 1).then_some(1);
        assert_eq!(
            chosen(vec![
                draft("A", &candidates),
                draft("MISSING", &[]),
                draft("DISTANT", &[(3, 0.0, 150_001.0)]),
            ]),
            vec![expected, None, None]
        );
    }
}

#[test]
fn candidate_less_names_do_not_count_toward_search_limit_2133() {
    let mut drafts = vec![draft("A", &[(1, 0.0, 1.0)])];
    for index in 0..BATTLE_LINE_SETTLEMENT_ELECTION_MAX_NAMES {
        drafts.push(draft(&format!("MISSING {index}"), &[]));
        drafts.push(draft(&format!("DISTANT {index}"), &[(2, 0.0, 150_001.0)]));
    }
    let mut expected = vec![None; drafts.len()];
    expected[0] = Some(0);
    assert_eq!(elect_settlements(&drafts, &[]), expected);
    let anchors = [SettlementAnchor {
        settlement_id: 1,
        coordinate: BattleLineCoordinate { lat: 0.0, lon: 0.0 },
    }];
    assert_eq!(elect_settlements(&drafts, &anchors), expected);
    let fixed = BTreeMap::from([("A".to_string(), 1)]);
    assert_eq!(elect_settlements_with_fixed(&drafts, &[], &fixed), expected);
    drafts[0] = draft("A", &[]);
    drafts.push(draft("B", &[(2, 0.0, 1.0)]));
    assert_eq!(
        elect_settlements_with_fixed(&drafts, &[], &fixed),
        vec![None; drafts.len()]
    );
}

#[test]
fn rejects_tied_clusters_and_tied_majorities_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0), (2, 1.0, 1.0)]),
            draft("B", &[(3, 0.01, 1.0), (4, 1.01, 1.0)]),
        ]),
        vec![None; 2]
    );
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.2, 1.0)]),
            draft("C", &[(3, 0.4, 1.0)]),
        ]),
        vec![None; 3]
    );
}

#[test]
fn singleton_requires_one_eligible_canonical_settlement_2133() {
    assert_eq!(
        chosen(vec![draft("A", &[(1, 0.0, 1.0), (2, 1.0, 2.0)])]),
        vec![None]
    );
    assert_eq!(
        chosen(vec![draft("A", &[(1, 0.0, 1.0), (1, 0.0, 1.0)])]),
        vec![Some(1)]
    );
    assert_eq!(
        chosen(vec![draft("A", &[(1, 0.0, 1.0), (2, 1.0, 150_001.0)])]),
        vec![Some(1)]
    );
    assert_eq!(chosen(vec![draft("A", &[])]), vec![None]);
    assert!(chosen(vec![]).is_empty());
}

#[test]
fn duplicated_names_do_not_create_a_majority_but_aliases_can_share_ids_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft(" a ", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 4.0, 1.0)]),
        ]),
        vec![None; 3]
    );
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("ALIAS", &[(1, 0.0, 1.0)])
        ]),
        vec![Some(1); 2]
    );
}

#[test]
fn anchors_choose_nearest_and_reject_equal_distances_2133() {
    let drafts = vec![draft("A", &[(1, 0.0, 1.0), (2, 2.0, 2.0)])];
    let anchor = |id, lon| SettlementAnchor {
        settlement_id: id,
        coordinate: BattleLineCoordinate { lat: 0.0, lon },
    };
    assert_eq!(elect_settlements(&drafts, &[anchor(3, 1.9)]), vec![Some(1)]);
    assert_eq!(elect_settlements(&drafts, &[anchor(3, 1.0)]), vec![None]);
    assert_eq!(
        elect_settlements(&drafts, &[anchor(1, 0.0), anchor(2, 2.0)]),
        vec![None]
    );
    assert_eq!(
        elect_settlements(&drafts, &[anchor(3, f64::NAN)]),
        vec![None]
    );
}

#[test]
fn invalid_coordinates_and_distances_are_not_elected_2133() {
    for value in [f64::NAN, f64::INFINITY, -1.0, 150_001.0] {
        assert_eq!(chosen(vec![draft("A", &[(1, 0.0, value)])]), vec![None]);
    }
    for lon in [f64::NAN, f64::INFINITY, 181.0] {
        assert_eq!(chosen(vec![draft("A", &[(1, lon, 1.0)])]), vec![None]);
    }
    let mut west = draft("A", &[(1, 0.0, 75_001.0)]);
    west.battle_line_distances.get_mut(&0).unwrap().is_west = true;
    assert_eq!(chosen(vec![west]), vec![None]);
}

#[test]
fn excludes_thirty_kilometers_and_accepts_just_below_2133() {
    let first = Candidate {
        settlement_id: 1,
        coordinate: BattleLineCoordinate { lat: 0.0, lon: 0.0 },
        battle_line_distance_m: 1.0,
        anchor_distance_m: 0.0,
    };
    let combination = Combination::default().extend(0, &first, false).unwrap();
    for (distance, valid) in [(29_999.999, true), (30_000.001, false)] {
        let second = Candidate {
            settlement_id: 2,
            coordinate: BattleLineCoordinate {
                lat: 0.0,
                lon: (distance / crate::config::SETTLEMENT_EARTH_RADIUS_METERS)
                    .to_degrees(),
            },
            ..first.clone()
        };
        assert_eq!(combination.extend(1, &second, false).is_some(), valid);
    }
}

#[test]
fn searches_previously_pruned_options_and_preserves_ambiguity_2133() {
    let first = (1..=6)
        .map(|id| (id, f64::from(id), 1.0))
        .collect::<Vec<_>>();
    let second = (11..=17)
        .map(|id| (id, f64::from(id - 10), 1.0))
        .collect::<Vec<_>>();
    let third = (21..=28)
        .map(|id| (id, f64::from(id - 15), 1.0))
        .collect::<Vec<_>>();
    assert_eq!(
        chosen(vec![
            draft("A", &first),
            draft("B", &second),
            draft("C", &third)
        ]),
        vec![Some(6), Some(16), Some(21)]
    );
    assert_eq!(
        chosen(vec![draft("A", &first), draft("B", &second)]),
        vec![None; 2]
    );
}

#[test]
fn bounded_search_fails_closed_2133() {
    let mut drafts = (0..=BATTLE_LINE_SETTLEMENT_ELECTION_MAX_NAMES)
        .map(|index| draft(&format!("{index}"), &[(1, 0.0, 1.0)]))
        .collect::<Vec<_>>();
    assert_eq!(elect_settlements(&drafts, &[]), vec![None; drafts.len()]);
    drafts.pop();
    assert_eq!(elect_settlements(&drafts, &[]), vec![Some(0); drafts.len()]);
    let mut expected = vec![Some(0); drafts.len()];
    drafts.push(draft("MISSING", &[]));
    expected.push(None);
    assert_eq!(elect_settlements(&drafts, &[]), expected);
    let drafts = (0..18)
        .map(|index| {
            draft(
                &format!("{index}"),
                &[(index * 2, 0.0, 1.0), (index * 2 + 1, 0.0, 1.0)],
            )
        })
        .collect::<Vec<_>>();
    let mut election = Election {
        visited: BATTLE_LINE_SETTLEMENT_ELECTION_MAX_STATES,
        ..Default::default()
    };
    election.search(&eligible_groups(&drafts), 0, &Combination::default());
    assert!(election.exhausted);
    assert_eq!(elect_settlements(&drafts, &[]), vec![None; drafts.len()]);
}

#[test]
fn anchored_ambiguity_leaves_the_entire_set_unresolved_2133() {
    let drafts = vec![
        draft("A", &[(1, 0.0, 1.0), (2, 2.0, 2.0)]),
        draft("B", &[(3, 1.0, 1.0)]),
    ];
    let anchors = [SettlementAnchor {
        settlement_id: 3,
        coordinate: BattleLineCoordinate { lat: 0.0, lon: 1.0 },
    }];
    assert_eq!(elect_settlements(&drafts, &anchors), vec![None; 2]);
}

#[test]
fn chained_millimeter_ties_do_not_depend_on_candidate_ids_2133() {
    let longitude = |meters: f64| {
        (meters / crate::config::SETTLEMENT_EARTH_RADIUS_METERS).to_degrees()
    };
    for distances in [[1.0012, 1.0008, 1.0], [1.0, 1.0008, 1.0012]] {
        let candidates = distances
            .into_iter()
            .enumerate()
            .map(|(index, meters)| (index as i32 + 1, longitude(meters), 1.0))
            .collect::<Vec<_>>();
        let drafts = vec![draft("A", &candidates)];
        let anchor = SettlementAnchor {
            settlement_id: 4,
            coordinate: BattleLineCoordinate { lat: 0.0, lon: 0.0 },
        };
        assert_eq!(elect_settlements(&drafts, &[anchor]), vec![None]);
        assert_eq!(
            chosen(vec![draft("A", &candidates), draft("B", &[(4, 0.0, 1.0)])]),
            vec![None; 2]
        );
        let candidates = distances
            .into_iter()
            .enumerate()
            .map(|(index, meters)| (index as i32 + 1, 0.0, meters))
            .collect::<Vec<_>>();
        assert_eq!(
            chosen(vec![draft("A", &candidates), draft("B", &[(4, 0.0, 1.0)])]),
            vec![None; 2]
        );
    }
}

#[test]
fn more_votes_beat_a_smaller_tighter_cluster_2133() {
    assert_eq!(
        chosen(vec![
            draft("A", &[(1, 0.0, 1.0)]),
            draft("B", &[(2, 0.1, 1.0)]),
            draft("C", &[(3, 0.2, 1.0)]),
            draft("D", &[(4, 4.0, 1.0)]),
            draft("E", &[(5, 4.0, 1.0)]),
        ]),
        vec![Some(1), Some(2), Some(3), None, None]
    );
}

#[test]
fn election_is_independent_of_input_order_2133() {
    let mut drafts = vec![
        draft("B", &[(4, 5.0, 2.0), (2, 0.1, 1.0)]),
        draft("A", &[(3, 3.0, 2.0), (1, 0.0, 1.0)]),
        draft("C", &[(5, 0.2, 1.0)]),
    ];
    assert_eq!(chosen(drafts.clone()), vec![Some(2), Some(1), Some(5)]);
    drafts.reverse();
    assert_eq!(chosen(drafts), vec![Some(5), Some(1), Some(2)]);
}

#[test]
fn anchored_sets_use_proximity_and_spatial_context_without_id_tiebreaks_2133() {
    let drafts = vec![
        draft("A", &[(1, 0.0, 1.0), (2, 2.0, 1.0)]),
        draft("B", &[(3, 0.1, 1.0)]),
    ];
    let anchor = SettlementAnchor {
        settlement_id: 4,
        coordinate: BattleLineCoordinate { lat: 0.0, lon: 1.0 },
    };
    assert_eq!(
        elect_settlements(&drafts, &[anchor]),
        vec![Some(0), Some(0)]
    );
}
