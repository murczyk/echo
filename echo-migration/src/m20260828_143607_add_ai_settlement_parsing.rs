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
create table ai_settlement_settings (
    id smallint primary key check (id = 1),
    prompt text not null,
    worker_enabled boolean default false not null,
    worker_ai_engine_id uuid references ai_engine(id) on delete set null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_settlement_test_message (
    id uuid primary key,
    message text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_settlement_parse_result (
    ai_settlement_test_message_id uuid not null
        references ai_settlement_test_message(id) on delete cascade,
    ai_engine_id uuid not null references ai_engine(id) on delete cascade,
    settlements jsonb not null default '[]'::jsonb,
    error text,
    response_text text not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    primary key (ai_settlement_test_message_id, ai_engine_id)
);

create index ai_settlement_parse_result_ai_engine_id_idx
    on ai_settlement_parse_result (ai_engine_id);

create table ai_settlement_worker_job (
    sigint_inbox_item_id bigint primary key
        references sigint_inbox_item(id) on delete cascade,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_settlement_worker_job_next_attempt_idx
    on ai_settlement_worker_job (next_attempt_at, created_at, sigint_inbox_item_id);
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
drop table if exists ai_settlement_worker_job;
drop table if exists ai_settlement_parse_result;
drop table if exists ai_settlement_test_message;
drop table if exists ai_settlement_settings;
                "#,
            )
            .await?;
        Ok(())
    }
}
