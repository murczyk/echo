use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists goi_knowledge (
                    id bigserial primary key,
                    organism_id bigint not null references organism(id) on delete cascade,
                    source_knowledge_id bigint not null,
                    source_created_at timestamptz not null,
                    row jsonb not null,
                    created_at timestamptz not null default now(),
                    deleted bool not null default false,
                    name text,
                    key text,
                    knowledge_type text,
                    author text,
                    note text,
                    source_date_raw text,
                    source_date timestamptz,
                    formation text,
                    unique (organism_id, source_knowledge_id)
                );

                create index if not exists idx_goi_knowledge_organism_id
                    on goi_knowledge (organism_id);

                create index if not exists idx_goi_knowledge_organism_source_id
                    on goi_knowledge (organism_id, source_knowledge_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_goi_knowledge_organism_source_id;
                drop index if exists idx_goi_knowledge_organism_id;
                drop table if exists goi_knowledge;
            "#,
        )
        .await?;
        Ok(())
    }
}
