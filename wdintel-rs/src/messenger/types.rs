use elm_rs::Elm;
use serde::{Deserialize, Serialize};
use std::fmt::Debug;

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct EchoAccountF1 {
    pub id: i64,
    pub status: String,
    pub created_at: i64,
    pub client_id: i32,
    pub name: String,
    pub messenger: String,
    pub phone_number: String,
    pub is_linked: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct QrCodeReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct QrCodeRsp {
    pub qr_code_base64: String,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct AccountsRsp {
    pub accounts: Vec<EchoAccountF1>,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct IsAccountLinkedReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct IsAccountLinkedRsp {
    pub is_linked: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct AccountStatusReq {
    pub account_id: i64,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct DeleteAccountReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct LinkAccountReq {
    pub phone: String,
    pub messenger: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize, Elm)]
pub struct LinkAccountRsp {
    pub account: EchoAccountF1,
}
