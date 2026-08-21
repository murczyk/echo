use crate::rer_importer::types::InboxMessage;
use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineCoordinate {
    pub lat: f64,
    pub lon: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineFeature {
    pub kind: String,
    pub coordinates: Vec<BattleLineCoordinate>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineVersionSummary {
    pub id: i64,
    pub source_file_name: String,
    pub uploader_login: String,
    pub uploaded_at_ts: i64,
    pub retired_at_ts: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineAorGeometry {
    pub aor_id: i64,
    pub aor_name: String,
    pub features: Vec<BattleLineFeature>,
    pub snapped_start: BattleLineCoordinate,
    pub snapped_end: BattleLineCoordinate,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineState {
    pub active_version: Option<BattleLineVersionSummary>,
    pub active_features: Vec<BattleLineFeature>,
    pub aor_geometries: Vec<BattleLineAorGeometry>,
    pub previous_versions: Vec<BattleLineVersionSummary>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineTestReq {
    pub inbox_item_id: Option<String>,
    pub message_uid: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineSettlementCandidate {
    pub settlement_id: i32,
    pub name: String,
    pub district: String,
    pub region: String,
    pub coordinate: BattleLineCoordinate,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineLocationResult {
    pub location: String,
    pub candidates: Vec<BattleLineSettlementCandidate>,
    pub chosen_settlement_id: Option<i32>,
    pub distance_m: Option<f64>,
    pub invalid_aor_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineTestRsp {
    pub inbox_item_id: i64,
    pub message: InboxMessage,
    pub group_master_keys: Vec<String>,
    pub aor_ids: Vec<i64>,
    pub locations: Vec<BattleLineLocationResult>,
    pub battle_line: BattleLineState,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineAdminPageReq {
    pub page: u64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineUnlinkedInboxRsp {
    pub items: Vec<(i64, InboxMessage)>,
    pub total: u64,
    pub page_size: u64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineUnresolvedLocation {
    pub settlement_text: String,
    pub item_count: u64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BattleLineUnresolvedLocationsRsp {
    pub items: Vec<BattleLineUnresolvedLocation>,
    pub total: u64,
    pub page_size: u64,
}
