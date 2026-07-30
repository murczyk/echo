use anyhow::Result;
use sea_orm::DatabaseConnection;
use sea_orm_migration::prelude::*;

mod m20260315_200000_create_association;
mod m20260317_214944_create_knowledge;
mod m20260701_120000_create_sync_lock;
mod m20260730_120000_drop_knowledge_deleted;

pub struct Migrator;

impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260315_200000_create_association::Migration),
            Box::new(m20260317_214944_create_knowledge::Migration),
            Box::new(m20260701_120000_create_sync_lock::Migration),
            Box::new(m20260730_120000_drop_knowledge_deleted::Migration),
        ]
    }
}

pub async fn run_migration(db: &DatabaseConnection) -> Result<()> {
    Migrator::up(db, None).await?;
    Ok(())
}
