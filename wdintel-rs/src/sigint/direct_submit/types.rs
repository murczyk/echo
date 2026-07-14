use crate::rer_importer::types::{
    SubmitCoordinates, SubmitDmrMetadata, SubmitNetwork,
};
use crate::types::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DirectSubmitPayload {
    #[serde(default)]
    pub full_body: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub freq: Option<String>,
    #[serde(default)]
    pub coords: Vec<SubmitCoordinates>,
    #[serde(default)]
    #[serde(rename = "from")]
    pub from_callsign: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub post: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub locations: Vec<String>,
    #[serde(default)]
    pub network: Option<SubmitNetwork>,
    #[serde(default)]
    pub dmr: Vec<SubmitDmrMetadata>,
    pub signal_group_master_key: String,
    #[serde(default)]
    pub device_name_id: Option<i64>,
    #[serde(default)]
    pub upload_urls: Option<Vec<String>>,
    #[serde(default)]
    pub deleted_media_ids: Option<Vec<uuid::Uuid>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DirectSubmitRsp {
    pub signal_message_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<crate::rer_importer::types::InboxMessage>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DirectSubmitParsePayload {
    pub full_body: String,
    #[serde(default)]
    pub signal_group_master_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DirectSubmitParseRsp {
    pub text: String,
    pub freq: Option<String>,
    pub coords: Vec<SubmitCoordinates>,
    pub to: Vec<String>,
    pub timestamp: Option<String>,
    pub comment: Option<String>,
    pub post: Option<String>,
    pub unit: Option<String>,
    pub locations: Vec<String>,
}
