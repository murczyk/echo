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
        manager.get_connection().execute_unprepared(r#"
alter table message_reply
    add column engaged_message_id bigint references signal_message(id) on delete set null,
    add column thread_id bigint;
create index message_reply_source_outbox_idx on message_reply_source (datasource_id, original_outbox_message_id)
    where original_outbox_message_id is not null;
create index message_reply_engaged_idx on message_reply (engaged_message_id);
create index message_reply_thread_idx on message_reply (thread_id, created_at, id);

with duplicates as (
    select id, first_value(id) over (partition by reply_signal_message_id order by created_at, id) as retained
    from message_reply where reply_signal_message_id is not null
)
update message_reply_source s set message_reply_id = d.retained
    from duplicates d where s.message_reply_id = d.id and d.id <> d.retained;
with duplicates as (
    select id, row_number() over (partition by reply_signal_message_id order by created_at, id) as position
    from message_reply where reply_signal_message_id is not null
)
delete from message_reply where id in (select id from duplicates where position > 1);
create unique index message_reply_single_reply_idx on message_reply (reply_signal_message_id);

update message_reply set engaged_message_id = original_signal_message_id,
    thread_id = coalesce(original_signal_message_id, -id);

create function message_reply_lock_threads() returns void language sql as $$
    select pg_advisory_xact_lock(hashtextextended('message-reply-threads', 0));
$$;
create function message_reply_lock_statement() returns trigger language plpgsql as $$
begin
    perform message_reply_lock_threads();
    return null;
end;
$$;
create trigger message_reply_lock before insert or update or delete on message_reply
    for each statement execute function message_reply_lock_statement();

create function message_reply_resolve_head() returns trigger language plpgsql as $$
declare
    parent message_reply%rowtype;
begin
    if NEW.engaged_message_id is not null and NEW.engaged_message_id is distinct from NEW.reply_signal_message_id then
        select * into parent from message_reply
            where reply_signal_message_id = NEW.engaged_message_id and id <> NEW.id
            order by created_at, id limit 1;
        if found then
            NEW.original_signal_message_id := nullif(parent.original_signal_message_id, NEW.reply_signal_message_id);
            NEW.original_deleted := parent.original_deleted;
            NEW.thread_id := parent.thread_id;
        else
            NEW.original_signal_message_id := NEW.engaged_message_id;
            NEW.original_deleted := NEW.original_deleted or
                coalesce((select deleted from signal_message where id = NEW.engaged_message_id), false);
            NEW.thread_id := NEW.engaged_message_id;
        end if;
    elsif NEW.engaged_message_id = NEW.reply_signal_message_id then
        NEW.original_signal_message_id := null;
        NEW.engaged_message_id := null;
    end if;
    NEW.thread_id := coalesce(NEW.thread_id, NEW.original_signal_message_id, -NEW.id);
    NEW.deleted := NEW.original_deleted or NEW.reply_deleted;
    return NEW;
end;
$$;
create trigger message_reply_resolve_head before insert or update of engaged_message_id on message_reply
    for each row execute function message_reply_resolve_head();

create function message_reply_rethread_children() returns trigger language plpgsql as $$
declare
    endpoint bigint;
    head bigint;
    thread bigint;
    head_deleted boolean;
    previous_thread bigint;
begin
    if pg_trigger_depth() > 1 then
        return null;
    end if;
    if TG_OP = 'DELETE' then
        endpoint := OLD.reply_signal_message_id;
        head := endpoint;
        thread := endpoint;
        previous_thread := OLD.thread_id;
        select deleted into head_deleted from signal_message where id = endpoint;
    else
        endpoint := NEW.reply_signal_message_id;
        head := NEW.original_signal_message_id;
        thread := NEW.thread_id;
        head_deleted := NEW.original_deleted;
        previous_thread := case when TG_OP = 'UPDATE' then OLD.thread_id else NEW.thread_id end;
    end if;
    with recursive descendants as (
        select id, reply_signal_message_id from message_reply where engaged_message_id = endpoint
        union
        select child.id, child.reply_signal_message_id from message_reply child
            join descendants parent on child.engaged_message_id = parent.reply_signal_message_id
    )
    update message_reply child set original_signal_message_id = nullif(head, child.reply_signal_message_id),
        thread_id = thread, original_deleted = head_deleted, deleted = head_deleted or child.reply_deleted
    where child.id in (select id from descendants)
        and (child.original_signal_message_id, child.thread_id, child.original_deleted)
            is distinct from (nullif(head, child.reply_signal_message_id), thread, head_deleted);
    insert into message_reply_change
        select reply_signal_message_id from message_reply
        where thread_id = previous_thread and reply_signal_message_id is not null
        order by created_at, id limit 1 on conflict do nothing;
    return null;
end;
$$;
create trigger message_reply_rethread_children after insert or update or delete on message_reply
    for each row execute function message_reply_rethread_children();

update message_reply set engaged_message_id = engaged_message_id;
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger message_reply_rethread_children on message_reply;
drop function message_reply_rethread_children();
drop trigger message_reply_resolve_head on message_reply;
drop function message_reply_resolve_head();
drop trigger message_reply_lock on message_reply;
drop function message_reply_lock_statement();
drop function message_reply_lock_threads();
drop index message_reply_source_outbox_idx;
drop index message_reply_single_reply_idx;
drop index message_reply_thread_idx;
drop index message_reply_engaged_idx;
alter table message_reply drop column thread_id, drop column engaged_message_id;
        "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
