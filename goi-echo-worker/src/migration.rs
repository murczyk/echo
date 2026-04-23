use anyhow::Result;
use sea_orm::DatabaseConnection;
use sea_orm_migration::prelude::*;

mod m20260315_200000_create_association;
mod m20260317_214944_create_knowledge;

pub struct Migrator;

impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260315_200000_create_association::Migration),
            Box::new(m20260317_214944_create_knowledge::Migration),
        ]
    }
}

pub async fn run_migration(db: &DatabaseConnection) -> Result<()> {
    Migrator::up(db, None).await?;
    Ok(())
}
