use serde::{Deserialize, Serialize};
use std::fmt::Debug;

#[derive(Debug, Serialize, Deserialize)]
pub struct ListLinksReq {
    pub bot_id: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListLinksRsp {
    pub links: Vec<LinkF1>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnlinkReq {
    pub link_id: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnlinkRsp {
    pub ok: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LinkReq {
    pub bot_id: i32,
    pub organism_id: i32,
    pub group_id: i32,
    pub user_id: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LinkRsp {
    pub link_id: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QrCodeReq {
    pub messenger: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QrCodeRsp {
    pub qr_code_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GroupF1 {
    pub id: i32,
    pub name: String,
    pub messenger: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListGroupsReq {
    pub bot_id: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListGroupsRsp {
    pub groups: Vec<GroupF1>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BotF1 {
    pub id: i32,
    pub status: String,
    pub messenger: String,
    pub phone: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BotF2 {
    pub id: i32,
    pub status: String,
    pub messenger: String,
    pub phone: String,
    pub name: String,
    pub display_name: String,
    pub client_port: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BotOrganismF1 {
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LinkF1 {
    pub id: i32,
    pub group_id: i32,
    pub organism_id: i32,
    pub user_id: i32,
    pub organism_name: String,
    pub group_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListBotOrganismsReq {}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListBotOrganismsRsp {
    pub organisms: Vec<BotOrganismF1>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListBotsReq {}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListBotsRsp {
    pub bots: Vec<BotF2>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BotByPhoneNumberReq {
    pub phone_number: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BotByPhoneNumberRsp {
    pub bot: Option<BotF1>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IsBotLinkedReq {
    pub bot_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IsBotLinkedRsp {
    pub is_linked: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteBotReq {
    pub bot_id: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteBotRsp {}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateBotReq {
    pub phone: String,
    pub messenger: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateBotRsp {
    pub result: BotF1,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateBotReq {
    pub bot_id: i32,
    pub is_active: Option<bool>,
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateBotRsp {
    pub bot_f1: BotF1,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckBotExistsReq {
    pub phone: String,
    pub messenger: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckBotExistsRsp {
    pub exists: bool,
}
