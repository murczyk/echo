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
-- Avatars of ingest accounts, chats, chat members and contacts, history
-- included. Exactly one owner column is set, enforced by the ingest code.
create table messenger_avatar (
 id uuid primary key,
 messenger_account_id uuid references messenger_account(id),
 messenger_chat_id uuid references messenger_chat(id),
 messenger_chat_member_id uuid references messenger_chat_member(id),
 messenger_contact_id uuid references messenger_contact(id),
 messenger_type text not null,
 external_id text not null,
 telegram_photo_id int8,
 content_type text not null,
 file_name text,
 file_ext text,
 size_bytes int8 not null,
 is_encrypted boolean not null,
 storage_key text not null,
 external_set_at timestamp,
 created_at timestamp not null default (now() at time zone 'utc')
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
 execute format('alter table messenger_avatar alter column id set default %s', id_generator);
end $$;
-- external_id is unique per owner; one partial index per owner kind. They
-- also serve the avatar lookups of one owner.
create unique index messenger_avatar_account_external_idx
 on messenger_avatar (messenger_account_id, external_id)
 where messenger_account_id is not null;
create unique index messenger_avatar_chat_external_idx
 on messenger_avatar (messenger_chat_id, external_id)
 where messenger_chat_id is not null;
create unique index messenger_avatar_chat_member_external_idx
 on messenger_avatar (messenger_chat_member_id, external_id)
 where messenger_chat_member_id is not null;
create unique index messenger_avatar_contact_external_idx
 on messenger_avatar (messenger_contact_id, external_id)
 where messenger_contact_id is not null;

-- Current avatar of each owner; null when unknown or removed.
alter table messenger_account add column avatar_id uuid references messenger_avatar(id);
alter table messenger_chat add column avatar_id uuid references messenger_avatar(id);
alter table messenger_chat_member add column avatar_id uuid references messenger_avatar(id);
alter table messenger_contact add column avatar_id uuid references messenger_avatar(id);
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
alter table messenger_contact drop column if exists avatar_id;
alter table messenger_chat_member drop column if exists avatar_id;
alter table messenger_chat drop column if exists avatar_id;
alter table messenger_account drop column if exists avatar_id;
drop table if exists messenger_avatar;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
