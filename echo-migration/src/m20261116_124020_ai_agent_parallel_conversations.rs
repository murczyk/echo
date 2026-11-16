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
-- A user may run requests in several conversations at once; each
-- conversation still runs one request at a time, in order (#4232).
create unique index if not exists ai_agent_request_one_running_per_conversation_idx
    on ai_agent_request (conversation_id)
    where state = 'running';

create index if not exists ai_agent_request_running_user_idx
    on ai_agent_request (human_login_id)
    where state = 'running';

drop index if exists ai_agent_request_one_running_per_user_idx;
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
-- Fails while a user has more than one running request; drain the queue first.
create unique index if not exists ai_agent_request_one_running_per_user_idx
    on ai_agent_request (human_login_id)
    where state = 'running';

drop index if exists ai_agent_request_running_user_idx;
drop index if exists ai_agent_request_one_running_per_conversation_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
