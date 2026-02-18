use crate::location::SettlementsData;
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

pub struct SettlementsDataConfig {
    pub aor_id_to_settlements_data: HashMap<i64, Arc<SettlementsData>>,
    pub aor_id_to_config_name: HashMap<i64, String>,
    pub default_settlements_data: Arc<SettlementsData>,
    pub settlements_data_by_config: HashMap<String, Arc<SettlementsData>>,
    pub available_settlements_configs: Vec<String>,
}

impl Default for SettlementsDataConfig {
    fn default() -> Self {
        let default_settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            BTreeMap::new(),
        ));
        Self {
            aor_id_to_settlements_data: HashMap::new(),
            aor_id_to_config_name: HashMap::new(),
            default_settlements_data: default_settlements_data.clone(),
            settlements_data_by_config: HashMap::new(),
            available_settlements_configs: vec![],
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Debug, PartialEq, Serialize, Deserialize,
)]
pub struct AorLocationConfigItem {
    pub aor_id: i64,
    pub aor_name: String,
    pub selected_config: Option<String>,
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
    pub settlements_config: String,
}
