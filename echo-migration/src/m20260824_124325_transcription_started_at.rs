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
alter table echo_gpu_transcription_queue
    add column started_transcription_at timestamp without time zone;

create function set_echo_gpu_transcription_started_at()
returns trigger
language plpgsql
as $$
begin
    if new.state = 'processing' and old.state <> 'processing' then
        new.started_transcription_at = coalesce(
            new.started_transcription_at,
            new.updated_at
        );
    elsif old.state in ('completed', 'terminal')
        and new.state in ('queued', 'retrying') then
        new.started_transcription_at = null;
    end if;
    return new;
end;
$$;

create trigger echo_gpu_transcription_started_at
before update of state on echo_gpu_transcription_queue
for each row
execute function set_echo_gpu_transcription_started_at();

create index echo_gpu_transcription_queue_created_at_idx
    on echo_gpu_transcription_queue (created_at desc, id desc);
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
drop trigger if exists echo_gpu_transcription_started_at
    on echo_gpu_transcription_queue;
drop function if exists set_echo_gpu_transcription_started_at();
drop index if exists echo_gpu_transcription_queue_created_at_idx;
alter table echo_gpu_transcription_queue
    drop column if exists started_transcription_at;
                "#,
            )
            .await?;
        Ok(())
    }
}
