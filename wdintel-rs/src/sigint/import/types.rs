use crate::entities::*;
use crate::types::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Debug;

#[derive(Serialize, Deserialize, Clone)]
pub struct EtalonData {
    pub area_of_responsibility: Vec<area_of_responsibility::Model>,
    pub sigint_signal: Vec<sigint_signal::Model>,
    pub sigint_signal_changelog: Vec<sigint_signal_changelog::Model>,
    pub sigint_unit: Vec<sigint_unit::Model>,
    pub sigint_network: Vec<sigint_network::Model>,
    pub sigint_network_aor: Vec<sigint_network_aor::Model>,
    pub sigint_network_changelog: Vec<sigint_network_changelog::Model>,
    pub sigint_network_description: Vec<sigint_network_description::Model>,
    pub sigint_network_freq: Vec<sigint_network_freq::Model>,
    pub sigint_network_freq_changelog:
        Vec<sigint_network_freq_changelog::Model>,
    pub sigint_network_unit: Vec<sigint_network_unit::Model>,
    pub sigint_network_unit_changelog:
        Vec<sigint_network_unit_changelog::Model>,
    pub sigint_callsign: Vec<sigint_callsign::Model>,
    pub sigint_callsign_changelog: Vec<sigint_callsign_changelog::Model>,
    pub encryption: Vec<encryption::Model>,
    pub source: Vec<source::Model>,
    pub sigint_post: Vec<sigint_post::Model>,
    pub sigint_zone_aor: Vec<sigint_zone_aor::Model>,
    pub sigint_network_post: Vec<sigint_network_post::Model>,
    pub sigint_network_callsign: Vec<sigint_network_callsign::Model>,
    pub sigint_network_callsign_changelog:
        Vec<sigint_network_callsign_changelog::Model>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImportResult<ID: Id> {
    pub ids_map: BTreeMap<ID, ID>,
    pub num_created: usize,
    pub num_updated: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EtalonImportResult {
    pub area_of_responsibility: ImportResult<i64>,
    pub sigint_signal: ImportResult<i64>,
    pub sigint_signal_changelog: ImportResult<i64>,
    pub sigint_unit: ImportResult<i64>,
    pub sigint_network: ImportResult<i64>,
    pub sigint_network_changelog: ImportResult<i64>,
    pub sigint_network_description: ImportResult<i64>,
    pub sigint_network_freq: ImportResult<i64>,
    pub sigint_network_freq_changelog: ImportResult<i64>,
    pub sigint_network_unit: ImportResult<i64>,
    pub sigint_network_unit_changelog: ImportResult<i64>,
    pub sigint_callsign: ImportResult<i64>,
    pub sigint_callsign_changelog: ImportResult<i64>,
    pub encryption: ImportResult<i32>,
    pub source: ImportResult<i64>,
    pub sigint_post: ImportResult<i64>,
    pub sigint_network_post: ImportResult<i64>,
    pub sigint_network_callsign: ImportResult<i64>,
    pub sigint_network_callsign_changelog: ImportResult<i64>,
    pub sigint_network_aor: ImportResult<i64>,
    pub sigint_zone_aor: ImportResult<i64>,
}

pub trait Id: Sized + Ord + Copy + Debug {}
impl Id for i32 {}
impl Id for i64 {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_etalon_units_default_extended_hierarchy_fields() {
        let unit = sigint_unit::Model {
            id: 1,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            regiment: String::new(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: "20 ЗВА".to_string(),
            active: true,
            deleted: false,
            created_at: Default::default(),
            created_by_login_id: uuid::Uuid::nil(),
            name: "20 ЗВА".to_string(),
            comment: String::new(),
            battalion: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            army_region: "ЗС РФ".to_string(),
            military_district: "Західний ВО".to_string(),
        };
        let etalon = EtalonData {
            area_of_responsibility: vec![],
            sigint_signal: vec![],
            sigint_signal_changelog: vec![],
            sigint_unit: vec![unit],
            sigint_network: vec![],
            sigint_network_aor: vec![],
            sigint_network_changelog: vec![],
            sigint_network_description: vec![],
            sigint_network_freq: vec![],
            sigint_network_freq_changelog: vec![],
            sigint_network_unit: vec![],
            sigint_network_unit_changelog: vec![],
            sigint_callsign: vec![],
            sigint_callsign_changelog: vec![],
            encryption: vec![],
            source: vec![],
            sigint_post: vec![],
            sigint_zone_aor: vec![],
            sigint_network_post: vec![],
            sigint_network_callsign: vec![],
            sigint_network_callsign_changelog: vec![],
        };
        let mut value = serde_json::to_value(etalon).unwrap();
        let unit = value["sigint_unit"][0].as_object_mut().unwrap();
        unit.remove("army_region");
        unit.remove("military_district");

        let imported: EtalonData = serde_json::from_value(value).unwrap();

        assert_eq!(imported.sigint_unit[0].army_region, "");
        assert_eq!(imported.sigint_unit[0].military_district, "");
    }
}
