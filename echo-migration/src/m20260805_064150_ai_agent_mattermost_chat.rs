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
alter table ai_agent_settings
    add column mattermost_chat_enabled boolean default false not null;

create table ai_agent_chat_mattermost_notification (
    request_id uuid primary key references ai_agent_request(id) on delete cascade,
    state text not null check (state in ('pending', 'sent', 'failed', 'discarded')),
    attempt_count integer default 0 not null,
    next_attempt_at timestamp without time zone default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create index ai_agent_chat_mattermost_notification_pending_idx
    on ai_agent_chat_mattermost_notification (next_attempt_at, request_id)
    where state in ('pending', 'failed');
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
drop table if exists ai_agent_chat_mattermost_notification;
alter table ai_agent_settings
    drop column if exists mattermost_chat_enabled;
                "#,
            )
            .await?;
        Ok(())
    }
}
