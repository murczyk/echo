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
    add column enabled boolean default true not null;

create table ai_callsign_settings (
    id smallint primary key check (id = 1),
    prompt text not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_callsign_test_message (
    id uuid primary key,
    message text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_callsign_parse_result (
    ai_callsign_test_message_id uuid not null
        references ai_callsign_test_message(id) on delete cascade,
    ai_engine_id uuid not null references ai_engine(id) on delete cascade,
    callsigns jsonb not null default '[]'::jsonb,
    error text,
    response_text text not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    primary key (ai_callsign_test_message_id, ai_engine_id)
);

create index ai_callsign_parse_result_ai_engine_id_idx
    on ai_callsign_parse_result (ai_engine_id);
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
drop table if exists ai_callsign_parse_result;
drop table if exists ai_callsign_test_message;
drop table if exists ai_callsign_settings;
alter table ai_engine drop column if exists enabled;
                "#,
            )
            .await?;
        Ok(())
    }
}
