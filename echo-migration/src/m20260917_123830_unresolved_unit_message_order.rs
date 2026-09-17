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
        for sql in [
            r#"
alter table sigint_inbox_item_failed_unit_label
    add column if not exists signal_message_created_at timestamp without time zone;
            "#,
            r#"
create or replace function set_failed_unit_link_message_created_at()
returns trigger
language plpgsql
as $$
begin
    new.signal_message_created_at := (
        select signal_message.created_at
        from signal_message
        where signal_message.id = new.inbox_item_id
    );
    return new;
end;
$$;

drop trigger if exists failed_unit_link_set_message_created_at
    on sigint_inbox_item_failed_unit_label;
create trigger failed_unit_link_set_message_created_at
before insert or update of inbox_item_id
on sigint_inbox_item_failed_unit_label
for each row
execute function set_failed_unit_link_message_created_at();

create or replace function update_failed_unit_link_message_created_at()
returns trigger
language plpgsql
as $$
begin
    update sigint_inbox_item_failed_unit_label
    set signal_message_created_at = new.created_at
    where inbox_item_id = new.id
      and signal_message_created_at is distinct from new.created_at;
    return null;
end;
$$;

drop trigger if exists signal_message_update_failed_unit_link_created_at
    on signal_message;
create trigger signal_message_update_failed_unit_link_created_at
after update of created_at
on signal_message
for each row
when (old.created_at is distinct from new.created_at)
execute function update_failed_unit_link_message_created_at();
            "#,
            r#"
update sigint_inbox_item_failed_unit_label as link
set signal_message_created_at = message.created_at
from signal_message as message
where message.id = link.inbox_item_id
  and link.signal_message_created_at is distinct from message.created_at;
            "#,
            r#"
create index concurrently if not exists sigint_inbox_item_failed_unit_label_active_message_idx
    on sigint_inbox_item_failed_unit_label (
        failed_unit_label_id,
        signal_message_created_at desc,
        inbox_item_id desc
    )
    where deleted = false and signal_message_created_at is not null;
            "#,
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!("{}: {error}", h!()))
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index concurrently if exists sigint_inbox_item_failed_unit_label_active_message_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger if exists signal_message_update_failed_unit_link_created_at
    on signal_message;
drop function if exists update_failed_unit_link_message_created_at();
drop trigger if exists failed_unit_link_set_message_created_at
    on sigint_inbox_item_failed_unit_label;
drop function if exists set_failed_unit_link_message_created_at();
alter table sigint_inbox_item_failed_unit_label
    drop column if exists signal_message_created_at;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
