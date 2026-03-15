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
