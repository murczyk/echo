//! Per-account operative-feed UI preferences.

use super::sea_orm_active_enums::UserSettingsTagsLayout;
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize,
)]
#[sea_orm(table_name = "user_settings")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    #[sea_orm(unique)]
    pub login: String,
    pub tags_layout: UserSettingsTagsLayout,
    pub disable_auto_scroll: bool,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::login::Entity",
        from = "Column::Login",
        to = "super::login::Column::Login",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Login,
}

impl Related<super::login::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Login.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
