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

-- The proxies the last full start configured, e.g. `echo_gateway` or
-- `direct_http:host:port`: a request joins a running container only if they
-- match its engine, since they cannot change under running conversations.
alter table ai_agent_container
    add column if not exists configured_proxies text;
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
alter table ai_agent_container
    drop column if exists configured_proxies;

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
