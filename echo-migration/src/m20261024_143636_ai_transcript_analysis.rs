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
alter table signal_group
    add column ai_transcript_analysis_enabled boolean,
    add column ai_transcript_analysis_enabled_at timestamp without time zone;

-- Publish the new nullable columns without firing visibility or color triggers.
update signal_group set ai_transcript_analysis_enabled = ai_transcript_analysis_enabled
where master_key = (select master_key from signal_group order by master_key limit 1);

create table ai_transcript_analysis_settings (
    id smallint primary key check (id = 1),
    prompt text not null default '',
    worker_enabled boolean not null default false,
    worker_ai_engine_id uuid references ai_engine(id) on delete set null,
    revision uuid not null default gen_random_uuid()
);
insert into ai_transcript_analysis_settings(id) values(1);
create table ai_transcript_analysis_test_message (
    id uuid primary key,
    message text not null,
    version uuid not null default gen_random_uuid(),
    created_at timestamp not null default (now() at time zone 'utc')
);
create table ai_transcript_analysis_test_result (
    test_message_id uuid not null references ai_transcript_analysis_test_message(id) on delete cascade,
    ai_engine_id uuid not null references ai_engine(id) on delete cascade,
    prompt text not null,
    important boolean,
    response_text text not null,
    error text,
    updated_at timestamp not null default (now() at time zone 'utc'),
    primary key (test_message_id, ai_engine_id)
);
create table ai_transcript_analysis_job (
    message_id bigint primary key references signal_message(id) on delete cascade,
    state text not null default 'waiting' check (state in ('waiting','running','retry','completed','skipped','failed')),
    next_attempt_at timestamp not null default (now() at time zone 'utc'),
    attempts integer not null default 0,
    lease uuid,
    lease_until timestamp,
    manual_suppressed boolean not null default false,
    important boolean,
    important_id bigint references sigint_important(id) on delete set null,
    transcript text,
    prompt text,
    ai_engine_id uuid,
    response_text text,
    last_error text,
    completed_at timestamp
);
create index ai_transcript_analysis_job_due_idx on ai_transcript_analysis_job(next_attempt_at, message_id)
    where state in ('waiting','retry','running') and not manual_suppressed;
create unique index ai_transcript_analysis_job_important_idx on ai_transcript_analysis_job(important_id)
    where important_id is not null;
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
drop table ai_transcript_analysis_job;
drop table ai_transcript_analysis_test_result;
drop table ai_transcript_analysis_test_message;
drop table ai_transcript_analysis_settings;
alter table signal_group
    drop column ai_transcript_analysis_enabled_at,
    drop column ai_transcript_analysis_enabled;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
