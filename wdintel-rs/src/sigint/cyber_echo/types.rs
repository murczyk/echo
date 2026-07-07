use crate::types::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessagePayload {
    pub body: String,
    pub timestamp_ms: Option<i64>,
    pub signal_group_master_key: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessageRsp {
    pub signal_message_id: i64,
    pub message_uid: Option<String>,
    pub inbox_item_id: i64,
    pub media_ids: Vec<Uuid>,
}
