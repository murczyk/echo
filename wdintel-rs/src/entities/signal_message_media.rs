//! `SeaORM` Entity for encrypted messenger media stored on S3.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize,
)]
#[sea_orm(table_name = "signal_message_media")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: Uuid,
    pub signal_message_id: i64,
    #[sea_orm(column_type = "Text")]
    pub content_type: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub file_ext: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub file_name: Option<String>,
    pub size_bytes: i64,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::signal_message::Entity",
        from = "Column::SignalMessageId",
        to = "super::signal_message::Column::Id",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    SignalMessage,
}

impl Related<super::signal_message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::SignalMessage.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
