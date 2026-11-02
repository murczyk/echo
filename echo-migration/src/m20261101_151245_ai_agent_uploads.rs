use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table ai_agent_engine_runtime_profile
 add column vision_input_enabled boolean;
create table ai_agent_upload (
 id uuid primary key default gen_random_uuid(),
 human_login_id uuid not null references login(id) on delete restrict,
 conversation_id uuid references ai_agent_conversation(id) on delete cascade,
 request_id uuid references ai_agent_request(id) on delete set null,
 file_name text not null check (length(file_name) between 1 and 255),
 extension text not null,
 content_type text not null,
 size_bytes bigint not null check (size_bytes > 0),
 sha256 text not null,
 storage_key text not null,
 preview_key text,
 state text not null default 'uploaded'
   check (state in ('uploaded','extracting','ready','failed')),
 extractor_job_id text,
 chunk_count integer not null default 0,
 text_chars bigint not null default 0,
 warnings jsonb not null default '[]',
 last_error text,
 attempts integer not null default 0,
 lease uuid,
 lease_until timestamp,
 next_attempt_at timestamp not null default (now() at time zone 'utc'),
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc'),
 check (request_id is null or conversation_id is not null)
);
create index ai_agent_upload_conversation_idx on ai_agent_upload(conversation_id, created_at, id)
 where conversation_id is not null;
create index ai_agent_upload_request_idx on ai_agent_upload(request_id) where request_id is not null;
create index ai_agent_upload_draft_idx on ai_agent_upload(human_login_id, created_at) where request_id is null;
create index ai_agent_upload_due_idx on ai_agent_upload(next_attempt_at, created_at, id)
 where state in ('uploaded','extracting');
create table ai_agent_upload_chunk (
 id uuid primary key default gen_random_uuid(),
 upload_id uuid not null references ai_agent_upload(id) on delete cascade,
 ordinal integer not null,
 member text not null,
 locator text not null,
 text text not null,
 markdown text not null,
 search_tsv tsvector generated always as
   (to_tsvector('russian', member || ' ' || text)) stored,
 unique(upload_id, ordinal)
);
create index ai_agent_upload_chunk_search_idx on ai_agent_upload_chunk using gin(search_tsv);
create index ai_agent_upload_chunk_text_idx on ai_agent_upload_chunk using gin(text gin_trgm_ops);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table ai_agent_upload_chunk;
drop table ai_agent_upload;
alter table ai_agent_engine_runtime_profile drop column vision_input_enabled;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
