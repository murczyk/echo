use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `sigint_peleng` is PeerDB-replicated. New peleng inserts made by the
        // application provide the post-DDL row changes needed for schema
        // propagation; the new column has no PostgreSQL default or historical
        // value that would require a ClickHouse backfill.
        manager
            .get_connection()
            .execute_unprepared(
                "alter table sigint_peleng add column pelengation_object text;",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "alter table sigint_peleng drop column pelengation_object;",
            )
            .await?;
        Ok(())
    }
}
