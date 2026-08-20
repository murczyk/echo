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
create table ai_intel_report_attempt (
    id uuid primary key,
    login_id uuid not null references login(id) on delete restrict,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    source_message_id bigint not null,
    outcome text not null check (outcome in ('disabled', 'success', 'failed')),
    suggestions jsonb default '[]'::jsonb not null,
    raw_response text,
    error text,
    duration_ms bigint not null check (duration_ms >= 0),
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_intel_report_attempt_created_at_idx
    on ai_intel_report_attempt (created_at desc, id desc);

create index ai_intel_report_attempt_source_idx
    on ai_intel_report_attempt (source_message_id, created_at desc);
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
drop table if exists ai_intel_report_attempt;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
