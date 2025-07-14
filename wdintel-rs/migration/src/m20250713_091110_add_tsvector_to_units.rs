use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "ALTER TABLE sigint_unit ADD COLUMN search_tsv tsvector;",
        )
        .await?;

        db.execute_unprepared(
            "CREATE INDEX sigint_unit_tsv_idx ON sigint_unit USING GIN(search_tsv);",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared("DROP INDEX IF EXISTS sigint_unit_tsv_idx;")
            .await?;

        db.execute_unprepared(
            "ALTER TABLE sigint_unit DROP COLUMN search_tsv;",
        )
        .await?;

        Ok(())
    }
}
