//! `SeaORM` Entity

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize,
)]
#[sea_orm(table_name = "goi_integration_access_organism")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub goi_integration_id: i64,
    pub organism_id: i64,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::goi_integration::Entity",
        from = "Column::GoiIntegrationId",
        to = "super::goi_integration::Column::Id",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    GoiIntegration,
    #[sea_orm(
        belongs_to = "super::organism::Entity",
        from = "Column::OrganismId",
        to = "super::organism::Column::Id",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    Organism,
}

impl Related<super::goi_integration::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::GoiIntegration.def()
    }
}

impl Related<super::organism::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Organism.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
