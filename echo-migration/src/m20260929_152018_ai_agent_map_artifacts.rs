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
alter table ai_agent_request_event
    add column map_summary jsonb;

create index ai_agent_request_event_map_artifact_idx
    on ai_agent_request_event (request_id, sequence)
    where event_type = 'map_artifact';

do $$
declare
    existing_name text;
begin
    select con.conname
      into existing_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'ai_agent_request_event'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%event_type%'
    limit 1;
    if existing_name is not null then
        execute format(
            'alter table ai_agent_request_event drop constraint %I;',
            existing_name
        );
    end if;
end $$;

alter table ai_agent_request_event
    add constraint ai_agent_request_event_event_type_check
    check (event_type in (
        'request_start',
        'progress',
        'assistant_delta',
        'assistant_snapshot',
        'tool_start',
        'tool_update',
        'tool_end',
        'source',
        'message_citations',
        'map_artifact',
        'completion',
        'cancellation',
        'error'
    ));
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
delete from ai_agent_request_event
where event_type = 'map_artifact';

drop index if exists ai_agent_request_event_map_artifact_idx;

alter table ai_agent_request_event
    drop column map_summary;

alter table ai_agent_request_event
    drop constraint if exists ai_agent_request_event_event_type_check;

alter table ai_agent_request_event
    add constraint ai_agent_request_event_event_type_check
    check (event_type in (
        'request_start',
        'progress',
        'assistant_delta',
        'assistant_snapshot',
        'tool_start',
        'tool_update',
        'tool_end',
        'source',
        'message_citations',
        'completion',
        'cancellation',
        'error'
    ));
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
