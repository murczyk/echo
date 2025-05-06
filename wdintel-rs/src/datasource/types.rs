use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Datasource {
    pub kind: String,
    pub display_name: String,
    pub signal_phone: Option<String>,
    pub enabled: Option<bool>,
}
