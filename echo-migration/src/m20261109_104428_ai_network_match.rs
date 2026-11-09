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
alter table system_settings
    add column ai_network_match_enabled boolean;

update system_settings
set ai_network_match_enabled = false
where deleted = false;

alter table sigint_network
    add column ai_instructions text;

create table ai_network_match_worker_job (
    sigint_inbox_item_id bigint primary key
        references sigint_inbox_item(id) on delete cascade,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_network_match_worker_job_next_attempt_idx
    on ai_network_match_worker_job (next_attempt_at, created_at, sigint_inbox_item_id);

create index ai_network_match_worker_job_created_at_idx
    on ai_network_match_worker_job (created_at);

create table ai_network_match_result (
    sigint_inbox_item_id bigint primary key
        references sigint_inbox_item(id) on delete cascade,
    candidate_network_ids bigint[] not null,
    input_md5 text not null,
    certainties jsonb not null,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

alter table ai_worker_progress
    drop constraint ai_worker_progress_worker_check;

alter table ai_worker_progress
    add constraint ai_worker_progress_worker_check
    check (worker in ('callsign', 'settlement', 'position', 'network_match'));
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
delete from ai_worker_progress
where worker = 'network_match';

alter table ai_worker_progress
    drop constraint ai_worker_progress_worker_check;

alter table ai_worker_progress
    add constraint ai_worker_progress_worker_check
    check (worker in ('callsign', 'settlement', 'position'));

drop table if exists ai_network_match_result;

drop table if exists ai_network_match_worker_job;

alter table sigint_network
    drop column if exists ai_instructions;

alter table system_settings
    drop column if exists ai_network_match_enabled;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
