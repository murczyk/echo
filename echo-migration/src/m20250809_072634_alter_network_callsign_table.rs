use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            ALTER TABLE sigint_network_callsign 
            ADD COLUMN position TEXT,
            ADD COLUMN comment TEXT,
            ADD COLUMN sigint_callsign_id BIGINT REFERENCES sigint_callsign(id) ON DELETE SET NULL,
            ADD COLUMN source_id BIGINT REFERENCES source(id) ON DELETE SET NULL,
            DROP COLUMN is_reported;

            CREATE INDEX idx_sigint_network_callsign_callsign_id ON sigint_network_callsign (sigint_callsign_id);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            ALTER TABLE sigint_network_callsign 
            ADD COLUMN is_reported bool NOT NULL DEFAULT false,          
            DROP COLUMN sigint_callsign_id,
            DROP COLUMN position,              
            DROP COLUMN source_id,      
            DROP COLUMN comment;   

            DROP INDEX IF EXISTS idx_sigint_network_callsign_callsign_id;
            ",
        )
        .await?;
        Ok(())
    }
}
