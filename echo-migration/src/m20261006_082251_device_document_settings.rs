use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table device_document_settings (
    id smallint primary key check(id=1),
    enabled boolean not null default false,
    summaries_enabled boolean not null default true,
    positions_enabled boolean not null default false,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    position_engine_id uuid references ai_engine(id) on delete set null
);
insert into device_document_settings(id) values(1);
alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in (
 'request_start','progress','assistant_delta','assistant_snapshot','tool_start','tool_update','tool_end','source','message_citations','file_citations','map_artifact','completion','cancellation','error'
));
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("drop table device_document_settings;
delete from ai_agent_request_event where event_type='file_citations';
alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in ('request_start','progress','assistant_delta','assistant_snapshot','tool_start','tool_update','tool_end','source','message_citations','map_artifact','completion','cancellation','error'));")
            .await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
