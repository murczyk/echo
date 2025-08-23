use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "update sigint_callsign set callsign = trim(callsign);
             update sigint_network_callsign set sigint_callsign = trim(sigint_callsign);",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "update sigint_callsign set callsign = callsign;
             update sigint_network_callsign set sigint_callsign = sigint_callsign;",
        )
        .await?;

        Ok(())
    }
}
