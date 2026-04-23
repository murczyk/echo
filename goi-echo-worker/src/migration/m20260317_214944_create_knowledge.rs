use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    create table if not exists knowledge (
                        id bigserial primary key,
                        row jsonb not null,
                        created_at timestamptz not null default now(),
                        updated_at timestamptz not null default now(),
                        deleted bool not null default false,
                        dedupe_key text not null
                    );

                    create unique index if not exists idx_knowledge_dedupe_key
                        on knowledge (dedupe_key);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    drop index if exists idx_knowledge_dedupe_key;
                    drop table if exists knowledge;
                "#,
            )
            .await?;
        Ok(())
    }
}
