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
-- What each login has read in each chat: the span of the chat timeline
-- (sigint_chat_message.messenger_sent_at) it has seen, bounds included.
-- Messages outside the span are unread; a chat without a row is unread
-- entirely. The primary key also serves the per-chat join of the chat list.
create table if not exists messenger_chat_read_state (
 login_id uuid not null references login(id) on delete cascade,
 messenger_chat_id uuid not null references messenger_chat(id) on delete cascade,
 oldest_read_at timestamp,
 newest_read_at timestamp,
 updated_at timestamp not null default (now() at time zone 'utc'),
 primary key (login_id, messenger_chat_id),
 check (
   oldest_read_at is null
   or newest_read_at is null
   or oldest_read_at <= newest_read_at
 )
);
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
drop table if exists messenger_chat_read_state;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
