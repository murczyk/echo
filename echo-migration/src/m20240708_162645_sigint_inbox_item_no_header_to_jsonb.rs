use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item DROP COLUMN body_noheader",
            )
            .await?;
        let _ = db
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item ADD COLUMN body_noheader JSONB",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item DROP COLUMN body_noheader",
            )
            .await?;
        let _ = db
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item ADD COLUMN body_noheader TEXT",
            )
            .await?;

        Ok(())
    }
}
