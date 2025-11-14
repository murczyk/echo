use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "create index concurrently if not exists \
             echo_inbox_message_account_internal_id_idx \
             on echo_inbox_message (account_id, internal_id);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "drop index concurrently if exists \
             echo_inbox_message_account_internal_id_idx;",
        )
        .await?;
        Ok(())
    }
}
