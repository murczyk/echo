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
create table ocr_settings (
    id smallint primary key check (id = 1),
    worker_enabled boolean default false not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

insert into ocr_settings (id) values (1);

create table ocr_job (
    media_id uuid primary key references signal_message_media(id) on delete cascade,
    state text default 'queued' not null
        check (state in ('queued', 'submitted', 'retry_wait', 'completed', 'failed')),
    extractor_job_id uuid,
    attempts integer default 0 not null check (attempts >= 0),
    next_attempt_at timestamp without time zone default (now() at time zone 'utc') not null,
    last_error text,
    quality_status text
        check (quality_status is null or quality_status in ('accepted', 'degraded', 'failed')),
    processed_pages integer default 0 not null check (processed_pages >= 0),
    total_pages integer default 0 not null check (total_pages >= 0),
    html_s3_key text,
    html_size_bytes bigint check (html_size_bytes is null or html_size_bytes >= 0),
    discovered_at timestamp without time zone default (now() at time zone 'utc') not null,
    submitted_at timestamp without time zone,
    completed_at timestamp without time zone,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create unique index ocr_job_extractor_job_id_idx
    on ocr_job (extractor_job_id)
    where extractor_job_id is not null;

create index ocr_job_due_idx
    on ocr_job (next_attempt_at, discovered_at, media_id)
    where state in ('queued', 'retry_wait');

create index ocr_job_latest_idx
    on ocr_job (updated_at desc, media_id);
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
drop table if exists ocr_job;
drop table if exists ocr_settings;
                "#,
            )
            .await?;
        Ok(())
    }
}
