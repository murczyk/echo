use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Source {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
}

// #[derive(
//     Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
// )]
// pub struct ListSourcesReq {
// }

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListSourcesRsp {
    pub sources: Vec<Source>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSourceReq {
    pub name: String,
}
