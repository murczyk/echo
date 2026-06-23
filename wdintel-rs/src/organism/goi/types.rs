use crate::organism::types::GoiIntegrationType;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListGoiAssociationsSortBy {
    GoiAssociationSourceAssociationIdDesc,
    GoiAssociationSourceAssociationIdAsc,
    GoiAssociationSourceCreatedAtDesc,
    GoiAssociationSourceCreatedAtAsc,
    GoiAssociationFrequencyAsc,
    GoiAssociationFrequencyDesc,
    GoiAssociationCoordinatesAsc,
    GoiAssociationCoordinatesDesc,
    GoiAssociationCategoryAsc,
    GoiAssociationCategoryDesc,
    GoiAssociationAuthorAsc,
    GoiAssociationAuthorDesc,
    GoiAssociationCreatedAtDesc,
    GoiAssociationCreatedAtAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListGoiKnowledgeSortBy {
    GoiKnowledgeSourceKnowledgeIdDesc,
    GoiKnowledgeSourceKnowledgeIdAsc,
    GoiKnowledgeSourceCreatedAtDesc,
    GoiKnowledgeSourceCreatedAtAsc,
    GoiKnowledgeNameAsc,
    GoiKnowledgeNameDesc,
    GoiKnowledgeKeyAsc,
    GoiKnowledgeKeyDesc,
    GoiKnowledgeTypeAsc,
    GoiKnowledgeTypeDesc,
    GoiKnowledgeAuthorAsc,
    GoiKnowledgeAuthorDesc,
    GoiKnowledgeFormationAsc,
    GoiKnowledgeFormationDesc,
    GoiKnowledgeNoteAsc,
    GoiKnowledgeNoteDesc,
    GoiKnowledgeSourceDateDesc,
    GoiKnowledgeSourceDateAsc,
    GoiKnowledgeCreatedAtDesc,
    GoiKnowledgeCreatedAtAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListGoiAssociationsReq {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    pub sort_by: Option<ListGoiAssociationsSortBy>,
    pub filter_text: Option<String>,
    pub filter_server: Option<String>,
    pub filter_frequency: Option<String>,
    pub filter_coordinates: Option<String>,
    pub filter_note: Option<String>,
    pub filter_category: Option<String>,
    pub filter_author: Option<String>,
    pub filter_deleted: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListGoiKnowledgeReq {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    pub sort_by: Option<ListGoiKnowledgeSortBy>,
    pub filter_text: Option<String>,
    pub filter_server: Option<String>,
    pub filter_name: Option<String>,
    pub filter_key: Option<String>,
    pub filter_knowledge_type: Option<String>,
    pub filter_note: Option<String>,
    pub filter_author: Option<String>,
    pub filter_formation: Option<String>,
    pub filter_deleted: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiAssociation {
    pub id: i64,
    pub integration_id: i64,
    pub server_label: String,
    pub owner_organism_name: String,
    pub source_association_id: i64,
    pub source_created_at_ms: i64,
    pub created_at_ms: i64,
    pub deleted: bool,
    pub association_type: Option<String>,
    pub frequency: Option<String>,
    pub coordinates: Option<String>,
    pub note: Option<String>,
    pub category: Option<String>,
    pub call_signs: Vec<String>,
    pub formation: Option<String>,
    pub association_count: Option<i32>,
    pub sidc: Option<String>,
    pub author: Option<String>,
    pub source_date_raw: Option<String>,
    pub source_date_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiKnowledge {
    pub id: i64,
    pub integration_id: i64,
    pub server_label: String,
    pub owner_organism_name: String,
    pub source_knowledge_id: i64,
    pub source_created_at_ms: i64,
    pub created_at_ms: i64,
    pub deleted: bool,
    pub name: Option<String>,
    pub key: Option<String>,
    pub knowledge_type: Option<String>,
    pub author: Option<String>,
    pub note: Option<String>,
    pub source_date_raw: Option<String>,
    pub source_date_ms: Option<i64>,
    pub formation: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListGoiAssociationsRsp {
    pub items: Vec<GoiAssociation>,
    pub has_more: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListGoiKnowledgeRsp {
    pub items: Vec<GoiKnowledge>,
    pub has_more: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiUserIntegration {
    pub id: i64,
    pub owner_organism_id: i64,
    pub owner_organism_name: String,
    pub integration_type: String,
    pub server_label: String,
    pub goi_url: Option<String>,
    pub swapp_url: Option<String>,
    pub has_data_access: bool,
    pub can_restart: bool,
    pub restart_unavailable_reason: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiReportTabOrderItem {
    pub aor_id: i64,
    pub aor_name: String,
    pub order_for_report: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiReportTabOrderListReq {
    pub integration_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiReportTabOrderListRsp {
    pub items: Vec<GoiReportTabOrderItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GoiReportTabOrderUpdateReq {
    pub integration_id: Option<i64>,
    pub items: Vec<GoiReportTabOrderItem>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct GoiAdminIntegration {
    pub id: i64,
    pub owner_organism_id: i64,
    pub owner_organism_name: String,
    pub created_at_ms: i64,
    pub integration_type: GoiIntegrationType,
    pub server_label: String,
    pub ssh_host: Option<String>,
    pub ssh_user: Option<String>,
    pub ssh_port: i32,
    pub path: String,
    pub api_host: Option<String>,
    pub api_port: i32,
    pub api_login: Option<String>,
    pub api_password: Option<String>,
    pub access_organism_ids: Vec<i64>,
    pub access_logins: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ListGoiAdminIntegrationsRsp {
    pub items: Vec<GoiAdminIntegration>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct GetGoiAdminIntegrationReq {
    pub id: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct UpsertGoiAdminIntegrationReq {
    pub id: Option<i64>,
    pub owner_organism_id: i64,
    pub integration_type: GoiIntegrationType,
    pub ssh_host: Option<String>,
    pub ssh_user: Option<String>,
    pub ssh_port: i32,
    pub path: String,
    pub api_host: Option<String>,
    pub api_port: i32,
    pub api_login: Option<String>,
    pub api_password: Option<String>,
    pub access_organism_ids: Vec<i64>,
    pub access_logins: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DeleteGoiAdminIntegrationReq {
    pub id: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SetupGoiIntegrationWorkerReq {
    pub id: i64,
    pub ssh_host: String,
    pub ssh_user: String,
    pub ssh_port: i32,
    pub path: String,
    pub api_host: Option<String>,
    pub api_port: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct RestartGoiIntegrationServiceReq {
    pub integration_id: i64,
    pub service: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct UnlinkGoiIntegrationWhatsappReq {
    pub integration_id: i64,
    pub service: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DownloadGoiIntegrationPalettesReq {
    pub integration_id: i64,
}
