use super::*;

fn candidate(id: i32, lon: f64) -> SettlementRecord {
    SettlementRecord {
        id,
        name: "A".to_string(),
        district: None,
        region: None,
        lat: Some(0.0),
        lon: Some(lon),
    }
}

#[test]
fn settlement_fallback_requires_a_unique_network_matching_all_names_2133() {
    let candidates = [candidate(1, 0.0), candidate(2, 2.0)];
    let anchors =
        BTreeMap::from([(1, vec![(0.0, 0.01)]), (2, vec![(0.0, 4.0)])]);
    assert_eq!(unique_network(&[1, 2], &[&candidates], &anchors), Some(1));
    assert_eq!(unique_network(&[1, 2], &[&candidates, &[]], &anchors), None);
    assert_eq!(unique_network(&[1, 2], &[], &anchors), None);
    assert_eq!(unique_network(&[2, 3], &[&candidates], &anchors), None);
    let anchors =
        BTreeMap::from([(1, vec![(0.0, 0.01)]), (2, vec![(0.0, 2.01)])]);
    assert_eq!(unique_network(&[1, 2], &[&candidates], &anchors), None);
}

#[test]
fn fallback_observes_fifteen_kilometer_boundary_2133() {
    let anchors = BTreeMap::from([(1, vec![(0.0, 0.0)])]);
    for (meters, expected) in [(14_999.999, Some(1)), (15_000.001, None)] {
        let candidates = [candidate(
            1,
            (meters / crate::config::SETTLEMENT_EARTH_RADIUS_METERS)
                .to_degrees(),
        )];
        assert_eq!(unique_network(&[1, 2], &[&candidates], &anchors), expected);
    }
    assert_eq!(
        unique_network(&[1, 2], &[&[candidate(1, f64::NAN)]], &anchors),
        None
    );
}
