use crate::types::*;

use crate::entities::sea_orm_active_enums as db_enums;
use crate::organism::types::MyOrganism;
use crate::sigint::aor::types::AreaOfResponsibility;
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "lowercase")]
pub enum InterseptionKind {
    #[serde(rename = "rer")]
    InterseptionRer,
    #[serde(rename = "other")]
    InterseptionOther,
}

impl From<db_enums::InterseptionKind> for InterseptionKind {
    fn from(interseption_kind: db_enums::InterseptionKind) -> Self {
        match interseption_kind {
            db_enums::InterseptionKind::Rer => Self::InterseptionRer,
            db_enums::InterseptionKind::Other => Self::InterseptionOther,
        }
    }
}

impl From<InterseptionKind> for db_enums::InterseptionKind {
    fn from(interseption_kind: InterseptionKind) -> Self {
        match interseption_kind {
            InterseptionKind::InterseptionRer => Self::Rer,
            InterseptionKind::InterseptionOther => Self::Other,
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SigintZone {
    pub name: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupsReq {
    pub zone_id: i64,
    pub datasource_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroup {
    pub sigint_zone_datasource_id: i64,
    pub group_master_key: String,
    pub is_group_secret: bool,
    pub interseption_kind: InterseptionKind,
    pub disable_network_assignment: bool,
    pub allowed_users: Vec<String>,
    pub allowed_organism_ids: Vec<i64>,
    pub admin_logins: Vec<String>,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupListRsp {
    pub zone_datasource_groups: Vec<ZoneDatasourceGroup>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupUpdateReq {
    pub id: i64,
    pub is_secret: bool,
    pub interseption_kind: Option<InterseptionKind>,
    pub disable_network_assignment: Option<bool>,
    pub user_logins: Vec<String>,
    pub organism_ids: Vec<i64>,
    pub admin_logins: Vec<String>,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    /// Deprecated
    pub area_of_responsibility_id: Option<i64>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupAddReq {
    pub zone_id: i64,
    pub datasource_id: i64,
    pub is_secret: bool,
    pub interseption_kind: Option<InterseptionKind>,
    pub master_key: String,
    pub user_logins: Vec<String>,
    pub organism_ids: Vec<i64>,
    pub admin_logins: Vec<String>,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupAddRsp {
    pub zone_id: i64,
    pub datasource_id: i64,
    pub group_master_key: String,
    pub group_name: Option<String>,
    pub zone_datasource_group: ZoneDatasourceGroup,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupLogin {
    pub login: String,
    pub delta_login: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyAdminSignalGroup {
    pub master_key: String,
    pub name: String,
    pub datasource_name: Option<String>,
    pub datasource_kind: Option<String>,
    pub is_group_secret: bool,
    pub disable_network_assignment: bool,
    pub allowed_users: Vec<SignalGroupLogin>,
    pub allowed_organism_ids: Vec<i64>,
    pub admin_logins: Vec<SignalGroupLogin>,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyAdminSignalGroupUpdateReq {
    pub master_key: String,
    pub is_secret: bool,
    pub disable_network_assignment: bool,
    pub user_logins: Vec<String>,
    pub organism_ids: Vec<i64>,
    pub admin_logins: Vec<String>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyAdminSignalGroupEditReferenceReq {
    pub master_key: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyAdminSignalGroupEditReferenceRsp {
    pub logins: Vec<String>,
    pub organisms: Vec<MyOrganism>,
    pub areas_of_responsibility: Vec<AreaOfResponsibility>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyAdminSignalGroupsRsp {
    pub groups: Vec<MyAdminSignalGroup>,
}
