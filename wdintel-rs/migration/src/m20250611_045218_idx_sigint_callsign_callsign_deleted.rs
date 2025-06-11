use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE INDEX idx_sigint_callsign_callsign_deleted ON sigint_callsign (LOWER(callsign), deleted);",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "DROP INDEX IF EXISTS idx_sigint_callsign_callsign_deleted;",
        )
        .await?;
        Ok(())
    }
}
