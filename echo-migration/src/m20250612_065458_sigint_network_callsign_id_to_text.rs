use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // alter table sigint_network_callsign, create sigint_callsign text field and drop the sigint_callsign_id field
        db.execute_unprepared(
            "
            ALTER TABLE sigint_network_callsign 
            ADD COLUMN sigint_callsign TEXT NOT NULL DEFAULT '',
            DROP COLUMN sigint_callsign_id;
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // revert the changes made in the up method
        db.execute_unprepared(
            "
            ALTER TABLE sigint_network_callsign 
            DROP COLUMN sigint_callsign,
            ADD COLUMN sigint_callsign_id INTEGER NOT NULL DEFAULT 0;
",
        )
        .await?;
        Ok(())
    }
}
