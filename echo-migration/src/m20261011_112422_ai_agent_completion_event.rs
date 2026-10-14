use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in (
 'request_start','progress','assistant_delta','assistant_snapshot','completion_metadata','tool_start','tool_update','tool_end','source','message_citations','file_citations','map_artifact','completion','cancellation','error'
));
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
delete from ai_agent_request_event where event_type='completion_metadata';
alter table ai_agent_request_event drop constraint ai_agent_request_event_event_type_check;
alter table ai_agent_request_event add constraint ai_agent_request_event_event_type_check check(event_type in (
 'request_start','progress','assistant_delta','assistant_snapshot','tool_start','tool_update','tool_end','source','message_citations','file_citations','map_artifact','completion','cancellation','error'
));
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
