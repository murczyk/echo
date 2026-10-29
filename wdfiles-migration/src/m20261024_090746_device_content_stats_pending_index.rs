use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "create index concurrently file_content_upload_stats_pending_idx on file_content_upload (device_id, stats_epoch) where status = 'completed'",
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index concurrently if exists file_content_upload_stats_pending_idx",
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
