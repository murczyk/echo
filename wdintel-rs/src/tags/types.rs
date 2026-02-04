use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Tag {
    pub label: String,
    pub extra: Option<bool>,
    pub ord: Option<f64>,
    pub keywords: Option<Vec<TagKeyword>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagAdmin {
    pub tag_id: i64,
    pub label: String,
    pub extra: Option<bool>,
    pub ord: Option<f64>,
    pub enabled: bool,
    pub keywords: Vec<TagKeyword>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagUpsertReq {
    pub label: String,
    pub extra: Option<bool>,
    pub ord: Option<f64>,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagKeyword {
    pub tag_keyword_id: i64,
    pub is_regex: bool,
    pub keyword: String,
    pub keyword_forms: Vec<String>,
    pub keyword_negative_forms: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagKeywordAddReq {
    pub is_regex: bool,
    pub keyword: String,
    pub keyword_forms: Option<Vec<String>>,
    pub keyword_negative_forms: Option<Vec<String>>,
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

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageTagModelErrorReq {
    pub message_id: i64,
    pub tag_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagModelError {
    pub id: i64,
    pub sigint_inbox_item_id: i64,
    pub model: String,
    pub model_login: Option<String>,
    pub confidence: f64,
    pub removed_by_login: String,
    pub removed_at: i64,
    pub body: String,
    pub timestamp: Option<i64>,
    pub coords: Option<String>,
    pub freq: Option<String>,
    pub post_id: Option<String>,
    pub datetime: Option<i64>,
    pub location_v2: Option<String>,
    pub post_name: Option<String>,
}

#[derive(FromQueryResult)]
pub struct TagModelErrorQueryDesc {
    pub id: i64,
    pub sigint_inbox_item_id: i64,
    pub model: String,
    pub model_login: Option<String>,
    pub confidence: f64,
    pub removed_by_login: String,
    pub removed_at: DateTimeWithTimeZone,
    pub body: String,
    pub timestamp: Option<chrono::NaiveDateTime>,
    pub coords: Option<String>,
    pub freq: Option<String>,
    pub post_id: Option<String>,
    pub datetime: Option<chrono::NaiveDateTime>,
    pub location_v2: Option<String>,
    pub post_name: Option<String>,
}
