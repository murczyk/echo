use crate::location::SettlementsData;
use crate::rer_importer::types::GeoCoordinates;
use crate::types::Mode;
use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    Eq,
    PartialEq,
    Ord,
    PartialOrd,
    Clone,
    Default,
)]
pub enum Language {
    #[default]
    Ua,
    UaTranslit,
    Ru,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FindSettlementReq {
    pub query: String,
    pub region: Option<String>,
    pub related_coordinates: Option<(f64, f64)>,
    pub aor_id: Option<i64>,
    #[serde(default)]
    pub signal_group_master_key: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Default,
    Debug,
    PartialEq,
    Serialize,
    Deserialize,
)]
pub struct SettlementDetails {
    pub id: Option<i32>,
    pub name: String,
    pub region: String,
    pub language: Language,
    pub coords: Option<(f64, f64)>,
}

#[derive(Serialize, Deserialize)]
pub struct SettlementFileRow {
    pub id: Option<i32>,
    pub name: String,
    pub coords: Option<(f64, f64)>,
    pub language_details: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MapCoordinatesReq {
    pub coords: Vec<GeoCoordinates>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CoordinateWithLocality {
    pub coords: GeoCoordinates,
    pub locality: Option<LocalityDetails>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LocalityDetails {
    pub settlement_name: String,
    pub direction: String,
    pub distance_m: f64,
    pub is_rf: bool,
}

#[derive(Clone)]
pub struct SettlementsDataConfig {
    pub aor_id_to_settlements_data: HashMap<i64, Arc<SettlementsData>>,
    pub aor_id_to_config_names: HashMap<i64, Vec<String>>,
    pub default_settlements_data: Arc<SettlementsData>,
    pub default_settlements_files: Vec<String>,
    pub settlements_data_by_config: HashMap<String, Arc<SettlementsData>>,
    pub available_settlements_configs: Vec<String>,
    pub mode: Mode,
}

impl Default for SettlementsDataConfig {
    fn default() -> Self {
        let default_settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        ));
        Self {
            aor_id_to_settlements_data: HashMap::new(),
            aor_id_to_config_names: HashMap::new(),
            default_settlements_data: default_settlements_data.clone(),
            default_settlements_files: vec![],
            settlements_data_by_config: HashMap::new(),
            available_settlements_configs: vec![],
            mode: Mode::Test,
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Debug, PartialEq, Serialize, Deserialize,
)]
pub struct AorLocationConfigItem {
    pub aor_id: i64,
    pub aor_name: String,
    pub selected_configs: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Debug, PartialEq, Serialize, Deserialize,
)]
pub struct ListAorLocationConfigRsp {
    pub available_configs: Vec<String>,
    pub items: Vec<AorLocationConfigItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Debug, PartialEq, Serialize, Deserialize,
)]
pub struct SaveAorLocationConfigReq {
    pub aor_id: i64,
    pub settlements_configs: Vec<String>,
}
