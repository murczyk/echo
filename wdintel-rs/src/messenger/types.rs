use crate::rer_importer::types::SignalGroupStats;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use std::fmt::Debug;
use crate::sigint::area_of_responsibility::types::AreaOfResponsibility;

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoAccountF1 {
    pub id: i64,
    pub status: String,
    pub created_at: i64,
    pub client_id: i32,
    pub display_name: String,
    pub system_service_name: String,
    pub description: Option<String>,
    pub messenger: String,
    pub phone_number: String,
    pub is_linked: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupEntryF1 {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub group_stats: SignalGroupStats,
    pub area_of_responsibility: Option<AreaOfResponsibility>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct QrCodeReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct QrCodeRsp {
    pub qr_code_base64: String,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct AccountsRsp {
    pub accounts: Vec<EchoAccountF1>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct IsAccountLinkedReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct IsAccountLinkedRsp {
    pub is_linked: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct AccountStatusReq {
    pub account_id: i64,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeleteAccountReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct LinkAccountReq {
    pub phone: String,
    pub messenger: String,
    pub display_name: String,
    pub system_service_name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct LinkAccountRsp {
    pub account: EchoAccountF1,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupUpdateReq {
    pub master_key: String,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
}
