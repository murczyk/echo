use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE organism_group (
                organism_id bigint REFERENCES organism(id) ON DELETE CASCADE,
                signal_group_master_key text REFERENCES signal_group(master_key) ON DELETE CASCADE,
                PRIMARY KEY (organism_id, signal_group_master_key)
            );",
        )
        .await?;

        db.execute_unprepared("ALTER TABLE organism ADD COLUMN \"group_auto_link\" BOOLEAN DEFAULT FALSE;").await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE organism_group;").await?;
        db.execute_unprepared(
            "ALTER TABLE organism DROP COLUMN \"group_auto_link\";",
        )
        .await?;

        Ok(())
    }
}
