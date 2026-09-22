use crate::devices::analytics::types::DeviceAnalyticsSummaryRsp;
use crate::devices::files::types::SyncSummary;
use crate::devices::types::{
    deserialize_canonical_uuid, deserialize_canonical_uuid_vec,
    deserialize_optional_datetime,
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceSyncSessionsReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_datetime")]
    pub created_from: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_datetime")]
    pub created_to: Option<String>,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceSyncSessionsRsp {
    pub sessions: Vec<SyncSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GetDeviceSyncSessionReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub sync_id: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSyncSessionSummariesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid_vec")]
    pub sync_ids: Vec<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSyncSessionSummary {
    pub sync_id: String,
    pub analysis: DeviceAnalyticsSummaryRsp,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSyncSessionSummariesRsp {
    pub summaries: Vec<DeviceSyncSessionSummary>,
}
