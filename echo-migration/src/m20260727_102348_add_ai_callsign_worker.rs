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
alter table ai_callsign_settings
    add column worker_enabled boolean default false not null,
    add column worker_ai_engine_id uuid
        references ai_engine(id) on delete set null;

create table ai_callsign_worker_job (
    sigint_inbox_item_id bigint primary key
        references sigint_inbox_item(id) on delete cascade,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_callsign_worker_job_next_attempt_idx
    on ai_callsign_worker_job (next_attempt_at, created_at, sigint_inbox_item_id);
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
drop table if exists ai_callsign_worker_job;
alter table ai_callsign_settings
    drop column if exists worker_ai_engine_id,
    drop column if exists worker_enabled;
                "#,
            )
            .await?;
        Ok(())
    }
}
