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
alter table signal_message_queue
    add column attempt_count integer default 0 not null,
    add column next_attempt_at timestamp without time zone default (now() at time zone 'utc') not null,
    add column last_error text,
    add constraint signal_message_queue_attempt_count_check
        check (attempt_count >= 0);

create index signal_message_queue_due_idx
    on signal_message_queue (next_attempt_at, created_at, id);
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
drop index if exists signal_message_queue_due_idx;
alter table signal_message_queue
    drop constraint if exists signal_message_queue_attempt_count_check,
    drop column if exists last_error,
    drop column if exists next_attempt_at,
    drop column if exists attempt_count;
                "#,
            )
            .await?;
        Ok(())
    }
}
