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
