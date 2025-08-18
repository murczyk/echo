use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            ALTER TABLE sigint_network_callsign ADD COLUMN radio_freq TEXT;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Remove the default AOR record
        db.execute_unprepared(
            r#"
            ALTER TABLE sigint_network_callsign DROP COLUMN radio_freq;
            "#,
        )
        .await?;

        Ok(())
    }
}
