use anyhow::Result;
use sea_orm::DatabaseConnection;
use sea_orm_migration::prelude::*;

trait MigrationContext<T> {
    fn c(self, context: &'static str) -> std::result::Result<T, DbErr>;
}

impl<T> MigrationContext<T> for std::result::Result<T, DbErr> {
    fn c(self, context: &'static str) -> std::result::Result<T, DbErr> {
        self.map_err(|error| DbErr::Migration(format!("{context}: {error}")))
    }
}

mod m20260315_200000_create_association;
mod m20260317_214944_create_knowledge;
mod m20260701_120000_create_sync_lock;
mod m20260730_120000_drop_knowledge_deleted;
mod m20260812_115619_add_association_dedupe_key_version;

pub struct Migrator;

impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260315_200000_create_association::Migration),
            Box::new(m20260317_214944_create_knowledge::Migration),
            Box::new(m20260701_120000_create_sync_lock::Migration),
            Box::new(m20260730_120000_drop_knowledge_deleted::Migration),
            Box::new(
                m20260812_115619_add_association_dedupe_key_version::Migration,
            ),
        ]
    }
}

pub async fn run_migration(db: &DatabaseConnection) -> Result<()> {
    Migrator::up(db, None).await?;
    Ok(())
}
