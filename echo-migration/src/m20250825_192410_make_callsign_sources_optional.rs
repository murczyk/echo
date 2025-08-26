use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"ALTER TABLE sigint_callsign ALTER COLUMN source_id DROP NOT NULL;"#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            UPDATE sigint_callsign sc
                SET source_id = s.id
                FROM source s
                WHERE sc.source_id IS NULL
                AND s.name = 'ВЗАЄМОДІЯ';

            ALTER TABLE sigint_callsign ALTER COLUMN source_id SET NOT NULL;"#,
        )
        .await?;

        Ok(())
    }
}
