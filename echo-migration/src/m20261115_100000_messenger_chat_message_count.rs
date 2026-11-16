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
        // One script, so one implicit transaction: creating the trigger locks
        // sigint_chat_message against inserts and deletes until the backfill
        // commits, and no message is counted twice or missed.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
-- The chat's stored messages, so the chat list does not count them.
alter table messenger_chat
 add column if not exists message_count bigint not null default 0;

-- Messages are never updated, and their chat is fixed at insert, so inserts
-- and deletes are the only changes to count. Deletes come from the cascade
-- from sigint_inbox_item.
create or replace function sigint_chat_message_count()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'INSERT' then
        update messenger_chat
        set message_count = message_count + 1
        where id = new.messenger_chat_id;
    else
        update messenger_chat
        set message_count = message_count - 1
        where id = old.messenger_chat_id;
    end if;
    return null;
end;
$$;

drop trigger if exists sigint_chat_message_count on sigint_chat_message;
create trigger sigint_chat_message_count
after insert or delete on sigint_chat_message
for each row
execute function sigint_chat_message_count();

update messenger_chat as chat
set message_count = counted.n
from (
    select messenger_chat_id, count(*) as n
    from sigint_chat_message
    group by messenger_chat_id
) as counted
where chat.id = counted.messenger_chat_id;
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
drop trigger if exists sigint_chat_message_count on sigint_chat_message;
drop function if exists sigint_chat_message_count();
alter table messenger_chat drop column if exists message_count;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
