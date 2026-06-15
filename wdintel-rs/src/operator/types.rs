use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OperatorInboxMessage {
    pub instance_id: String,
    pub message: String,
    pub group: Group,
    pub profile: Profile,
    pub metadata: Metadata,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Metadata {
    pub dmr_sender_id: Option<String>,
    pub dmr_call_group_id: Option<String>,
    pub dmr_color_code: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SubmitMessageRsp {
    pub message_uid: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub source_signal_group_id: Option<String>,
    pub source_whatsapp_group_jid: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Profile {
    pub id: String,
    pub name: String,
}
