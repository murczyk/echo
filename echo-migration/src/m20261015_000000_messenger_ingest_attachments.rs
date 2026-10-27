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
-- Messenger metadata of ingested media, one row per signal_message_media.
-- external_id makes attach retries idempotent per message.
create table messenger_media_meta (
 id uuid primary key references signal_message_media(id) on delete cascade,
 sigint_chat_message_id bigint not null references sigint_chat_message(id) on delete cascade,
 external_id text not null,
 telegram_file_id int8,
 telegram_media_type text,
 external_created_at timestamp,
 created_at timestamp not null default (now() at time zone 'utc'),
 unique (sigint_chat_message_id, external_id)
);
-- The same Telegram file is shared by every message it was forwarded to.
create index messenger_media_meta_telegram_file_idx
 on messenger_media_meta (telegram_file_id)
 where telegram_file_id is not null;
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
drop table if exists messenger_media_meta;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
