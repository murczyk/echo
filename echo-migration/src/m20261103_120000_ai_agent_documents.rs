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
create table ai_agent_document (
    id uuid primary key,
    conversation_id uuid not null references ai_agent_conversation(id) on delete cascade,
    human_login_id uuid not null references login(id) on delete cascade,
    source_request_id uuid not null references ai_agent_request(id) on delete cascade,
    source_upload_id uuid references ai_agent_upload(id) on delete set null,
    title text not null check (length(title) between 1 and 200),
    file_name text not null check (length(file_name) between 1 and 255),
    head_revision integer not null check (head_revision > 0),
    created_at timestamp without time zone not null,
    updated_at timestamp without time zone not null
);

create index ai_agent_document_conversation_idx
    on ai_agent_document (conversation_id, created_at);

create table ai_agent_document_revision (
    document_id uuid not null references ai_agent_document(id) on delete cascade,
    revision integer not null check (revision > 0),
    parent_revision integer,
    storage_key text not null,
    size_bytes bigint not null check (size_bytes > 0),
    sha256 text not null,
    origin text not null check (origin in ('agent', 'user')),
    request_id uuid references ai_agent_request(id) on delete set null,
    summary text,
    idempotency_key text,
    result jsonb,
    created_at timestamp without time zone not null,
    primary key (document_id, revision),
    unique (document_id, idempotency_key),
    foreign key (document_id, parent_revision)
        references ai_agent_document_revision (document_id, revision)
);

create index ai_agent_document_revision_request_idx
    on ai_agent_document_revision (request_id)
    where request_id is not null;

create table ai_agent_request_document_target (
    request_id uuid primary key references ai_agent_request(id) on delete cascade,
    target jsonb not null,
    created_at timestamp without time zone not null
);

create index ai_agent_request_event_document_artifact_idx
    on ai_agent_request_event (request_id, sequence)
    where event_type = 'document_artifact';

alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in (
 'request_start','progress','assistant_delta','assistant_snapshot','completion_metadata','tool_start','tool_update','tool_end','source','message_citations','file_citations','map_artifact','document_artifact','completion','cancellation','error'
));
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
delete from ai_agent_request_event where event_type='document_artifact';
alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in (
 'request_start','progress','assistant_delta','assistant_snapshot','completion_metadata','tool_start','tool_update','tool_end','source','message_citations','file_citations','map_artifact','completion','cancellation','error'
));
drop index if exists ai_agent_request_event_document_artifact_idx;
drop table if exists ai_agent_request_document_target;
drop table if exists ai_agent_document_revision;
drop table if exists ai_agent_document;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
