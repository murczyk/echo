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
create table message_reply (
    id bigserial primary key,
    original_signal_message_id bigint references signal_message(id) on delete set null,
    reply_signal_message_id bigint references signal_message(id) on delete set null,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    deleted boolean not null default false,
    original_deleted boolean not null default false,
    reply_deleted boolean not null default false,
    check (original_signal_message_id <> reply_signal_message_id),
    unique (original_signal_message_id, reply_signal_message_id)
);
create index message_reply_original_idx on message_reply (original_signal_message_id, created_at, id);
create index message_reply_reply_idx on message_reply (reply_signal_message_id, created_at, id);

create table message_reply_source (
    datasource_id bigint not null,
    inbox_message_id bigint not null,
    original_inbox_message_id bigint,
    original_outbox_message_id bigint,
    signal_message_id bigint references signal_message(id) on delete set null,
    message_reply_id bigint references message_reply(id) on delete set null,
    deleted boolean not null default false,
    primary key (datasource_id, inbox_message_id)
);
create index message_reply_source_original_idx on message_reply_source (original_inbox_message_id)
    where original_inbox_message_id is not null;
create index message_reply_source_message_idx on message_reply_source (signal_message_id);
create index message_reply_source_relation_idx on message_reply_source (message_reply_id);

create table message_reply_change (
    signal_message_id bigint primary key
);

create function message_reply_changed() returns trigger language plpgsql as $$
begin
    if TG_OP <> 'INSERT' then
        insert into message_reply_change
            select distinct message_id from unnest(array[OLD.original_signal_message_id, OLD.reply_signal_message_id]) message_id
            where message_id is not null on conflict do nothing;
    end if;
    if TG_OP <> 'DELETE' then
        insert into message_reply_change
            select distinct message_id from unnest(array[NEW.original_signal_message_id, NEW.reply_signal_message_id]) message_id
            where message_id is not null on conflict do nothing;
    end if;
    return null;
end;
$$;
create trigger message_reply_changed after insert or update or delete on message_reply
    for each row execute function message_reply_changed();

create function message_reply_endpoint_changed() returns trigger language plpgsql as $$
begin
    if TG_OP = 'DELETE' then
        update message_reply_source set deleted = true where signal_message_id = OLD.id;
        update message_reply set deleted = true,
            original_deleted = original_deleted or original_signal_message_id is not distinct from OLD.id,
            reply_deleted = reply_deleted or reply_signal_message_id is not distinct from OLD.id
            where original_signal_message_id = OLD.id or reply_signal_message_id = OLD.id;
        return OLD;
    end if;
    if NEW.deleted is distinct from OLD.deleted then
        update message_reply r set
            original_deleted = case when r.original_signal_message_id = NEW.id then NEW.deleted else r.original_deleted end,
            reply_deleted = case when r.reply_signal_message_id = NEW.id then NEW.deleted else r.reply_deleted end,
            deleted = case when r.original_signal_message_id = NEW.id then NEW.deleted else r.original_deleted end
                or case when r.reply_signal_message_id = NEW.id then NEW.deleted else r.reply_deleted end
            where r.original_signal_message_id = NEW.id or r.reply_signal_message_id = NEW.id;
    end if;
    insert into message_reply_change
        select distinct message_id from message_reply r,
            lateral unnest(array[r.original_signal_message_id, r.reply_signal_message_id]) message_id
        where (r.original_signal_message_id = NEW.id or r.reply_signal_message_id = NEW.id)
            and message_id is not null on conflict do nothing;
    return NEW;
end;
$$;
create trigger message_reply_endpoint_deleted before delete on signal_message
    for each row execute function message_reply_endpoint_changed();
create trigger message_reply_endpoint_updated after update of body, timestamp, deleted, datasource_group_id on signal_message
    for each row when (OLD.body is distinct from NEW.body or OLD.timestamp is distinct from NEW.timestamp
        or OLD.deleted is distinct from NEW.deleted or OLD.datasource_group_id is distinct from NEW.datasource_group_id)
    execute function message_reply_endpoint_changed();
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger message_reply_endpoint_updated on signal_message;
drop trigger message_reply_endpoint_deleted on signal_message;
drop function message_reply_endpoint_changed();
drop table message_reply_source;
drop table message_reply;
drop function message_reply_changed();
drop table message_reply_change;
        "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
