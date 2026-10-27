use crate::config::{
    SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS,
    SETTLEMENT_EARTH_RADIUS_METERS,
};
use crate::location::SettlementsDataConfig;

pub(super) struct SettlementScope {
    coordinates: Vec<(f64, f64)>,
}

impl SettlementScope {
    pub(super) fn new(
        config: &SettlementsDataConfig,
        aor_ids: Option<&[i64]>,
    ) -> Self {
        let mut coordinates =
            crate::location::select_settlements_sources(config, aor_ids)
                .into_iter()
                .flat_map(|source| source.4.values().flatten())
                .filter_map(|settlement| settlement.coords)
                .filter(|&(lat, lon)| valid_coordinate(lat, lon))
                .collect::<Vec<_>>();
        coordinates.sort_unstable_by(|left, right| {
            left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1))
        });
        coordinates.dedup();
        Self { coordinates }
    }

    pub(super) fn contains(&self, lat: f64, lon: f64) -> bool {
        if !valid_coordinate(lat, lon) {
            return false;
        }
        let latitude_delta = (SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS
            / SETTLEMENT_EARTH_RADIUS_METERS)
            .to_degrees();
        let start = self
            .coordinates
            .partition_point(|&(latitude, _)| latitude < lat - latitude_delta);
        self.coordinates[start..]
            .iter()
            .take_while(|&&(latitude, _)| latitude <= lat + latitude_delta)
            .any(|&(latitude, longitude)| {
                coordinate_distance_m(lat, lon, latitude, longitude)
                    <= SETTLEMENT_CANONICAL_MATCH_MAX_DISTANCE_METERS
            })
    }
}

fn valid_coordinate(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

pub(crate) fn coordinate_distance_m(
    lat: f64,
    lon: f64,
    latitude: f64,
    longitude: f64,
) -> f64 {
    let latitude_delta = (latitude - lat).to_radians();
    let longitude_delta = (longitude - lon).to_radians();
    let haversine = (latitude_delta / 2.0).sin().powi(2)
        + lat.to_radians().cos()
            * latitude.to_radians().cos()
            * (longitude_delta / 2.0).sin().powi(2);
    SETTLEMENT_EARTH_RADIUS_METERS * 2.0 * haversine.sqrt().min(1.0).asin()
}
