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
create table media_summary_settings (
    id smallint primary key check (id = 1),
    enabled boolean default false not null,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    check (not enabled or ai_engine_id is not null)
);

insert into media_summary_settings (id) values (1);

create table media_summary (
    media_id uuid primary key references signal_message_media(id) on delete cascade,
    source_kind text not null check (length(source_kind) between 1 and 64),
    source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
    source_text text,
    source_char_count integer not null check (source_char_count > 0),
    state text default 'queued' not null
        check (state in ('queued', 'running', 'retry_wait', 'completed', 'failed')),
    ai_engine_id uuid references ai_engine(id) on delete set null,
    ai_engine_name text not null,
    model_name text not null,
    attempts integer default 0 not null check (attempts >= 0),
    lease_expires_at timestamp without time zone,
    next_attempt_at timestamp without time zone default (now() at time zone 'utc') not null,
    last_error text,
    summary text,
    who text,
    where_text text,
    what_happened text,
    what_next text,
    purpose text,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    check (state in ('completed', 'failed') or (source_text is not null and ai_engine_id is not null)),
    check (state <> 'completed' or (summary is not null and source_text is null)),
    check (state <> 'failed' or source_text is null)
);

create index media_summary_due_idx
    on media_summary (next_attempt_at, created_at, media_id)
    where state in ('queued', 'retry_wait');

create index media_summary_lease_idx
    on media_summary (lease_expires_at, media_id)
    where state = 'running';

create index media_summary_nonterminal_engine_idx
    on media_summary (ai_engine_id)
    where state in ('queued', 'running', 'retry_wait');
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
drop table if exists media_summary;
drop table if exists media_summary_settings;
                "#,
            )
            .await?;
        Ok(())
    }
}
