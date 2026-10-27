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
create table messenger_chat (
 id uuid primary key,
 messenger_account_id uuid not null references messenger_account(id),
 messenger_type text not null,
 external_id text not null,
 telegram_chat_id int8,
 chat_type text,
 title text,
 username text,
 members_count int4,
 account_member_status text,
 last_message_date timestamp,
 deleted boolean not null default false,
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc'),
 unique (messenger_account_id, external_id)
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
 execute format('alter table messenger_chat alter column id set default %s', id_generator);
end $$;
create unique index messenger_chat_account_telegram_chat_idx
 on messenger_chat (messenger_account_id, telegram_chat_id)
 where telegram_chat_id is not null and not deleted;
-- Chat list of an account, most recent first.
create index messenger_chat_account_recent_idx
 on messenger_chat (messenger_account_id, last_message_date desc nulls last)
 where not deleted;
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
drop index if exists messenger_chat_account_recent_idx;
drop index if exists messenger_chat_account_telegram_chat_idx;
drop table if exists messenger_chat;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
