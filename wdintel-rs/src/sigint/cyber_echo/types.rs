use crate::types::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessagePayload {
    pub body: String,
    pub signal_group_master_key: String,
    pub computer_name_id: i64,
    pub upload_urls: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct CreateCyberEchoSignalMessageRsp {
    pub signal_message_id: i64,
    pub message_uid: Option<String>,
    pub inbox_item_id: i64,
    pub media_ids: Vec<Uuid>,
}
