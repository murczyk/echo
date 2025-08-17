use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE sigint_network ADD COLUMN active_from timestamp DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL; 
             ALTER TABLE sigint_network ADD COLUMN active_to timestamp;"
        )
        .await?;

        db.execute_unprepared(
            "UPDATE sigint_network SET active_from = created_at;
             UPDATE sigint_network SET active_to = updated_at where deleted = true;"
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE sigint_network DROP COLUMN active_from;
             ALTER TABLE sigint_network DROP COLUMN active_to;",
        )
        .await?;
        Ok(())
    }
}
