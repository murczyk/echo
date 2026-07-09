use crate::rer_importer::types::{SubmitCoordinates, SubmitNetwork};
use crate::types::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessagePayload {
    #[serde(default)]
    pub message_uid: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub freq: Option<String>,
    #[serde(default)]
    pub coords: Vec<SubmitCoordinates>,
    #[serde(default)]
    pub from_callsign: Option<String>,
    #[serde(default, alias = "to_callsing", alias = "to_callsign")]
    pub to_callsigns: Vec<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub full_body: Option<String>,
    #[serde(default)]
    pub post: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub locations: Vec<String>,
    #[serde(default)]
    pub network: Option<SubmitNetwork>,
    pub signal_group_master_key: String,
    pub device_name_id: i64,
    #[serde(default)]
    pub upload_urls: Option<Vec<String>>,
    #[serde(default)]
    pub delete_media_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessageRsp {
    pub signal_message_id: i64,
    pub message_uid: Option<String>,
    pub inbox_item_id: i64,
    pub media_ids: Vec<Uuid>,
}
