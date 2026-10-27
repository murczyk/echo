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
-- Chat members as seen by the account, profile included, like the
-- collector's chat_members rows. Message senders reference them; the
-- account itself is a member of its chats.
create table messenger_chat_member (
 id uuid primary key,
 messenger_chat_id uuid not null references messenger_chat(id),
 messenger_type text not null,
 external_id text not null,
 telegram_user_id int8,
 username text,
 first_name text,
 last_name text,
 phone text,
 is_bot boolean,
 role text,
 joined_date timestamp,
 deleted boolean not null default false,
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc'),
 unique (messenger_chat_id, external_id)
);
do $$
declare
 id_generator text;
begin
 if to_regprocedure('uuidv7()') is not null then
   id_generator := 'uuidv7()';
 elsif to_regprocedure('uuid_generate_v7()') is not null then
   id_generator := 'uuid_generate_v7()';
 else
   raise exception 'UUIDv7 generator is unavailable: use PostgreSQL 18+ or enable the pg_uuidv7 extension';
 end if;
 execute format('alter table messenger_chat_member alter column id set default %s', id_generator);
end $$;
create unique index messenger_chat_member_chat_telegram_user_idx
 on messenger_chat_member (messenger_chat_id, telegram_user_id)
 where telegram_user_id is not null and not deleted;

create table sigint_chat_message (
 id bigint primary key references sigint_inbox_item(id) on delete cascade,
 messenger_chat_id uuid not null references messenger_chat(id),
 messenger_external_id text not null,
 messenger_sent_at timestamp not null,
 telegram_message_id int8,
 messenger_sender_id uuid references messenger_chat_member(id),
 messenger_is_outgoing boolean,
 messenger_has_media boolean,
 unique (messenger_chat_id, messenger_external_id)
);
-- Chat timeline: browsing pages one chat by send time.
create index sigint_chat_message_chat_timeline_idx
 on sigint_chat_message (messenger_chat_id, messenger_sent_at desc, id desc);
create unique index sigint_chat_message_telegram_message_idx
 on sigint_chat_message (messenger_chat_id, telegram_message_id)
 where telegram_message_id is not null;
create index sigint_chat_message_messenger_sender_idx
 on sigint_chat_message (messenger_sender_id)
 where messenger_sender_id is not null;
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
drop table if exists sigint_chat_message;
drop table if exists messenger_chat_member;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
