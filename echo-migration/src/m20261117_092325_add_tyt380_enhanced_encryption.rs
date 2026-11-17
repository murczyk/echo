use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // `encryption.id` has no sequence, and sigint import already allocates
        // MAX(id) + 1 for imported names, so take the next free id here too.
        db.execute_unprepared(
            "INSERT INTO encryption (id, name, enabled, created_at)
             SELECT (SELECT COALESCE(MAX(id), 0) + 1 FROM encryption),
                    'TYT380Enhanced', true, now()
             WHERE NOT EXISTS (
                 SELECT 1 FROM encryption WHERE name = 'TYT380Enhanced'
             );",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "DELETE FROM encryption WHERE name = 'TYT380Enhanced';",
        )
        .await?;
        Ok(())
    }
}
