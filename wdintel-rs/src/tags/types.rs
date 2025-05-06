use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Tag {
    pub label: String,
    pub extra: Option<bool>,
    pub ord: Option<f64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageTagsAddReq {
    pub message_id: i64,
    pub tag_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageTagsRmReq {
    pub message_id: i64,
    pub tag_id: i64,
}
