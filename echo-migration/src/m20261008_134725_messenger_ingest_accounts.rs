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
-- Messenger ingest API (#3699): one datasource per API login, one datasource_group
-- per messenger account. 'telegram' for now; null for every other kind.
alter table datasource_group add column messenger_type text;

-- The only trigger on this table watches group_master_key. One indexed row
-- change publishes the nullable column through CDC without a backfill.
update datasource_group
set messenger_type = null
where id = (select id from datasource_group order by id limit 1);

create table messenger_account (
 id uuid primary key,
 datasource_id int8 not null references datasource(id),
 datasource_group_id int8 not null unique references datasource_group(id),
 messenger_type text not null,
 external_id text not null,
 display_name text not null,
 telegram_user_id int8,
 phone text,
 username text,
 first_name text,
 last_name text,
 status text,
 status_error text,
 status_changed_at timestamp,
 is_active boolean,
 is_paused boolean,
 notes text,
 external_created_at timestamp,
 external_last_sync_at timestamp,
 deleted boolean not null default false,
 created_at timestamp not null default (now() at time zone 'utc'),
 updated_at timestamp not null default (now() at time zone 'utc'),
 unique (datasource_id, external_id)
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
 execute format('alter table messenger_account alter column id set default %s', id_generator);
end $$;
create unique index messenger_account_datasource_telegram_user_idx
 on messenger_account (datasource_id, telegram_user_id)
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
drop index if exists messenger_account_datasource_telegram_user_idx;
drop table if exists messenger_account;
alter table datasource_group drop column if exists messenger_type;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
