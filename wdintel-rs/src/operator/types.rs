use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OperatorInboxItem {
    pub message: crate::rer_importer::types::InboxMessage,
    pub group: Group,
    pub profile: Profile,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OperatorInboxMessage {
    pub message: String,
    pub timestamp: i64,
    pub group: Group,
    pub profile: Profile,
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
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Profile {
    pub id: String,
    pub name: String,
}
