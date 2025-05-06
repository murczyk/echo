use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared("ALTER TABLE sigint_inbox_item ADD post TEXT")
            .await?;
        let _ = db
            .execute_unprepared(
                "CREATE INDEX idx_sigint_inbox_item_post ON sigint_inbox_item (post)",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared("DROP INDEX idx_sigint_inbox_item_post")
            .await?;
        let _ = db
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item DROP COLUMN post",
            )
            .await;
        Ok(())
    }
}
