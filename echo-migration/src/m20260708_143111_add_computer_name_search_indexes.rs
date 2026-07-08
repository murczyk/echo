use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create extension if not exists pg_trgm;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                alter table computer_name
                    add column if not exists search_tsv tsvector
                    generated always as (to_tsvector('simple', coalesce(name, ''))) stored;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                create index if not exists computer_name_search_tsv_idx
                    on computer_name using gin(search_tsv);
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                create index if not exists computer_name_name_trgm_idx
                    on computer_name using gin (lower(name) gin_trgm_ops);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists computer_name_name_trgm_idx;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                drop index if exists computer_name_search_tsv_idx;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                alter table computer_name
                    drop column if exists search_tsv;
            "#,
        )
        .await?;

        Ok(())
    }
}
