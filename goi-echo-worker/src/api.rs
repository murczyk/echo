use crate::knowledge::KnowledgeRow;
use crate::row::AssociationRow;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListAssociationsReq {
    pub since_id_nonincl: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssociationApiItem {
    pub id: i64,
    pub row: AssociationRow,
    pub created_at: DateTime<Utc>,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnowledgeApiItem {
    pub id: i64,
    pub row: KnowledgeRow,
    pub created_at: DateTime<Utc>,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportSignedFrequenciesRsp {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiPaletteFileReq {
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiPaletteFilesRsp {
    pub relative_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiPaletteFileMoveReq {
    pub source_relative_path: String,
    pub target_relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoiService {
    Swapp,
    SwappAlt,
    Goi,
    EchoSwapp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiServiceReq {
    pub service: GoiService,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiSyncLockReq {
    pub lock_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoiSyncLockAcquireRsp {
    pub lock_id: Option<String>,
}
