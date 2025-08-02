use crate::entities::{
    datasource, sigint_inbox_item, signal_group, signal_message,
    signal_profile, whatsapp_group,
};
use crate::types::{Deserialize, Serialize};
use chrono::NaiveDateTime;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DataSourceFile {
    pub source_server: String,
    pub created_at: NaiveDateTime,
    pub groups_count: i64,
    pub profiles_count: i64,
    pub inbox_items_count: i64,
    pub datasource: DatasourceDetails,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DatasourceDetails {
    pub datasource: datasource::Model,
    pub profiles: Vec<signal_profile::Model>,
    pub signal_groups: Vec<signal_group::Model>,
    pub whatsapp_groups: Vec<whatsapp_group::Model>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Message {
    pub message: signal_message::Model,
    pub inbox_item: sigint_inbox_item::Model,
}
