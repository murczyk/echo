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
-- Contacts of an account, profile included, like the collector's contacts
-- rows. Kept apart from chat members: the same person may be both.
create table messenger_contact (
 id uuid primary key,
 messenger_account_id uuid not null references messenger_account(id),
 messenger_type text not null,
 external_id text not null,
 telegram_user_id int8,
 username text,
 first_name text,
 last_name text,
 phone text,
 is_mutual boolean,
 is_close_friend boolean,
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
 execute format('alter table messenger_contact alter column id set default %s', id_generator);
end $$;
create unique index messenger_contact_account_telegram_user_idx
 on messenger_contact (messenger_account_id, telegram_user_id)
 where telegram_user_id is not null and not deleted;
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
drop table if exists messenger_contact;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
