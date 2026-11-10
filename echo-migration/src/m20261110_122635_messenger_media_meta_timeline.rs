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
-- Copies of the message's account, chat and send time, so attachments can
-- be paged by chat or account without reading every message. Messages are
-- insert-only and chats never change account, so the copies never change.
alter table messenger_media_meta
    add column if not exists messenger_account_id uuid
        references messenger_account (id),
    add column if not exists messenger_chat_id uuid
        references messenger_chat (id),
    add column if not exists messenger_sent_at timestamp;

update messenger_media_meta mm
set messenger_account_id = c.messenger_account_id,
    messenger_chat_id = m.messenger_chat_id,
    messenger_sent_at = m.messenger_sent_at
from sigint_chat_message m
join messenger_chat c on c.id = m.messenger_chat_id
where m.id = mm.sigint_chat_message_id
  and (mm.messenger_account_id is null
       or mm.messenger_chat_id is null
       or mm.messenger_sent_at is null);

alter table messenger_media_meta
    alter column messenger_account_id set not null,
    alter column messenger_chat_id set not null,
    alter column messenger_sent_at set not null;

-- Attachment timelines: gallery pages per chat and per account.
create index if not exists messenger_media_meta_chat_timeline_idx
    on messenger_media_meta (messenger_chat_id, messenger_sent_at desc,
                             sigint_chat_message_id desc, id desc);
create index if not exists messenger_media_meta_account_timeline_idx
    on messenger_media_meta (messenger_account_id, messenger_sent_at desc,
                             sigint_chat_message_id desc, id desc);
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
drop index if exists messenger_media_meta_account_timeline_idx;
drop index if exists messenger_media_meta_chat_timeline_idx;
alter table messenger_media_meta
    drop column if exists messenger_sent_at,
    drop column if exists messenger_chat_id,
    drop column if exists messenger_account_id;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
