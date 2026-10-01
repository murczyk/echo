use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalMediaKmzConversionStatusRsp {
    pub status: String,
    pub error: Option<String>,
    pub converted_file_name: Option<String>,
}
