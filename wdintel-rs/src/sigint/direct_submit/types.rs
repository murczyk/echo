use crate::rer_importer::types::{
    SubmitCoordinates, SubmitDmrMetadata, SubmitNetwork,
};
use crate::types::{Deserialize, Serialize};
use serde::Deserializer;

fn deserialize_optional_update<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

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
    #[serde(default, deserialize_with = "deserialize_optional_update")]
    pub device_name_id: Option<Option<i64>>,
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
    pub unit_v2: Option<String>,
    pub locations: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(device_name_id: serde_json::Value) -> serde_json::Value {
        let mut payload = json!({
            "signal_group_master_key": "group",
        });
        payload["device_name_id"] = device_name_id;
        payload
    }

    #[test]
    fn device_name_id_distinguishes_missing_clear_and_value() {
        let missing: DirectSubmitPayload = serde_json::from_value(json!({
            "signal_group_master_key": "group",
        }))
        .unwrap();
        let clear: DirectSubmitPayload =
            serde_json::from_value(payload(json!(null))).unwrap();
        let value: DirectSubmitPayload =
            serde_json::from_value(payload(json!(42))).unwrap();

        assert_eq!(missing.device_name_id, None);
        assert_eq!(clear.device_name_id, Some(None));
        assert_eq!(value.device_name_id, Some(Some(42)));
    }
}
