use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                create index file_sync_session_history_idx
                    on file_sync_session (device_id, created_at desc, id desc);
                create index file_revision_session_journal_idx
                    on file_revision (sync_id, created_at desc, id desc);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop index file_revision_session_journal_idx; drop index file_sync_session_history_idx;")
            .await?;
        Ok(())
    }
}
