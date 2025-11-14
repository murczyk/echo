use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "create index concurrently \
             echo_inbox_message_account_seen_updated_created_idx \
             on echo_inbox_message (account_id, updated_at, created_at) \
             where seen = false;",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "drop index if exists echo_inbox_message_account_seen_updated_created_idx;",
        )
        .await?;
        Ok(())
    }
}
