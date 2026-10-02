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
create table ai_agent_map (
    id uuid primary key,
    conversation_id uuid not null references ai_agent_conversation(id) on delete cascade,
    human_login_id uuid not null references login(id) on delete cascade,
    source_request_id uuid not null references ai_agent_request(id) on delete cascade,
    source_map_id uuid not null,
    head_revision integer not null check (head_revision > 0),
    created_at timestamp without time zone not null,
    updated_at timestamp without time zone not null,
    unique (human_login_id, source_request_id, source_map_id)
);

create table ai_agent_map_revision (
    map_id uuid not null references ai_agent_map(id) on delete cascade,
    revision integer not null check (revision > 0),
    parent_revision integer,
    document jsonb not null,
    origin text not null check (origin in ('artifact', 'agent', 'user')),
    request_id uuid references ai_agent_request(id) on delete set null,
    summary text not null,
    idempotency_key text,
    result jsonb,
    created_at timestamp without time zone not null,
    primary key (map_id, revision),
    unique (map_id, idempotency_key),
    foreign key (map_id, parent_revision)
        references ai_agent_map_revision (map_id, revision)
);

create table ai_agent_request_map_target (
    request_id uuid primary key references ai_agent_request(id) on delete cascade,
    target jsonb not null,
    created_at timestamp without time zone not null
);
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
drop table if exists ai_agent_request_map_target;
drop table if exists ai_agent_map_revision;
drop table if exists ai_agent_map;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
