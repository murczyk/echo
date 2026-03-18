use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table organism
                    add column if not exists goi_api_host text,
                    add column if not exists goi_api_port int4 not null default 8088,
                    add column if not exists goi_api_login text,
                    add column if not exists goi_api_password text;

                create table if not exists goi_association (
                    id bigserial primary key,
                    organism_id bigint not null references organism(id) on delete cascade,
                    source_association_id bigint not null,
                    source_created_at timestamptz not null,
                    row jsonb not null,
                    created_at timestamptz not null default now(),
                    deleted bool not null default false,
                    association_type text,
                    frequency text,
                    coordinates text,
                    note text,
                    category text,
                    call_signs jsonb not null default '[]'::jsonb,
                    formation text,
                    association_count int4,
                    sidc text,
                    author text,
                    source_date_raw text,
                    source_date timestamptz,
                    source_created_at_ms bigint,
                    palettes jsonb,
                    unique (organism_id, source_association_id)
                );

                create index if not exists idx_goi_association_organism_id
                    on goi_association (organism_id);

                create index if not exists idx_goi_association_organism_source_id
                    on goi_association (organism_id, source_association_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_goi_association_organism_source_id;
                drop index if exists idx_goi_association_organism_id;
                drop table if exists goi_association;

                alter table organism
                    drop column if exists goi_api_password,
                    drop column if exists goi_api_login,
                    drop column if exists goi_api_port,
                    drop column if exists goi_api_host;
            "#,
        )
        .await?;
        Ok(())
    }
}
