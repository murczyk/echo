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
alter table ai_engine
    add column callsign_enabled boolean default true not null,
    add column ocr_enabled boolean default false not null,
    add column ocr_request_profile text default 'openai_vision' not null
        check (ocr_request_profile in ('openai_vision', 'ocr_gemma'));

alter table ocr_settings
    add column main_ai_engine_id uuid references ai_engine(id) on delete restrict;

create table ocr_settings_ai_engine (
    ocr_settings_id smallint not null references ocr_settings(id) on delete cascade,
    ai_engine_id uuid not null references ai_engine(id) on delete restrict,
    primary key (ocr_settings_id, ai_engine_id)
);

alter table ocr_job
    add column ai_engine_id uuid references ai_engine(id) on delete set null,
    add column ai_engine_name text,
    add column model_name text,
    add column ocr_request_profile text
        check (ocr_request_profile is null or ocr_request_profile in ('openai_vision', 'ocr_gemma'));

create index ocr_job_nonterminal_engine_idx
    on ocr_job (ai_engine_id)
    where state in ('queued', 'submitted', 'retry_wait');
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
drop index if exists ocr_job_nonterminal_engine_idx;
alter table ocr_job
    drop column if exists ocr_request_profile,
    drop column if exists model_name,
    drop column if exists ai_engine_name,
    drop column if exists ai_engine_id;
drop table if exists ocr_settings_ai_engine;
alter table ocr_settings drop column if exists main_ai_engine_id;
alter table ai_engine
    drop column if exists ocr_request_profile,
    drop column if exists ocr_enabled,
    drop column if exists callsign_enabled;
                "#,
            )
            .await?;
        Ok(())
    }
}
