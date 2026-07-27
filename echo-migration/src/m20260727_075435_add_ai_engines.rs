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
create table ai_engine (
    id uuid primary key,
    name text not null unique,
    url text not null,
    token text,
    model_name text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_chat (
    id uuid primary key,
    ai_engine_id uuid not null references ai_engine(id) on delete cascade,
    created_by_login_id uuid not null references login(id),
    title text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_chat_ai_engine_updated_at_idx
    on ai_chat (ai_engine_id, updated_at desc);

create table ai_chat_message (
    id uuid primary key,
    ai_chat_id uuid not null references ai_chat(id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_chat_message_ai_chat_created_at_idx
    on ai_chat_message (ai_chat_id, created_at, id);
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
drop table if exists ai_chat_message;
drop table if exists ai_chat;
drop table if exists ai_engine;
                "#,
            )
            .await?;
        Ok(())
    }
}
