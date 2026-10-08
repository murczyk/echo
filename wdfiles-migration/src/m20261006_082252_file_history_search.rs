use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("create index concurrently file_revision_name_trgm_idx on file_revision using gin(name gin_trgm_ops)")
            .await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index concurrently if exists file_revision_name_trgm_idx",
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }
    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
