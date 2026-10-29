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
drop trigger message_reply_lock on message_reply;
drop function message_reply_lock_statement();
drop function message_reply_lock_threads();

create function message_reply_component_keys(nodes jsonb) returns bigint[] language sql volatile set jit = off as $$
    with recursive related(kind, datasource, id) as (
        select kind, datasource, id from jsonb_to_recordset(nodes)
            as seed(kind text, datasource bigint, id bigint) where id is not null
        union
        select neighbor.* from related anchor cross join lateral (
            select endpoint.* from message_reply r cross join lateral (values
                ('message'::text, 0::bigint, r.original_signal_message_id),
                ('message', 0, r.reply_signal_message_id),
                ('message', 0, r.engaged_message_id),
                ('thread', 0, r.thread_id), ('relation', 0, r.id)
            ) endpoint(kind, datasource, id)
            where (anchor.kind = 'message' and (r.original_signal_message_id = anchor.id
                or r.reply_signal_message_id = anchor.id or r.engaged_message_id = anchor.id))
                or (anchor.kind = 'thread' and r.thread_id = anchor.id)
                or (anchor.kind = 'relation' and r.id = anchor.id)
            union all
            select endpoint.* from message_reply_source s cross join lateral (values
                ('message'::text, 0::bigint, s.signal_message_id),
                ('inbox', s.datasource_id, s.inbox_message_id),
                ('inbox', s.datasource_id, s.original_inbox_message_id),
                ('outbox', s.datasource_id, s.original_outbox_message_id),
                ('relation', 0, s.message_reply_id)
            ) endpoint(kind, datasource, id)
            where (anchor.kind = 'message' and s.signal_message_id = anchor.id)
                or (anchor.kind = 'relation' and s.message_reply_id = anchor.id)
                or (anchor.kind = 'inbox' and s.datasource_id = anchor.datasource
                    and (s.inbox_message_id = anchor.id or s.original_inbox_message_id = anchor.id))
                or (anchor.kind = 'outbox' and s.datasource_id = anchor.datasource
                    and s.original_outbox_message_id = anchor.id)
            union all
            select 'message', 0, sm.id from signal_message sm
                join datasource_group dg on dg.id = sm.datasource_group_id
            where anchor.kind = 'inbox' and sm.echo_inbox_message_id = anchor.id
                and dg.datasource_id = anchor.datasource
            union all
            select 'inbox', dg.datasource_id, sm.echo_inbox_message_id from signal_message sm
                join datasource_group dg on dg.id = sm.datasource_group_id
            where anchor.kind = 'message' and sm.id = anchor.id
            union all
            select endpoint.* from echo_inbox_message e cross join lateral (values
                ('inbox'::text, anchor.datasource, e.reply_to_inbox_message_id::bigint),
                ('outbox', anchor.datasource, e.reply_to_outbox_message_id::bigint)
            ) endpoint(kind, datasource, id)
            where anchor.kind = 'inbox' and e.id = anchor.id
        ) neighbor where neighbor.id is not null
    )
    select coalesce(array_agg(distinct hashtextextended(
        format('message-reply:%s:%s:%s', kind, datasource, id), 0)
        order by hashtextextended(format('message-reply:%s:%s:%s', kind, datasource, id), 0)), '{}')
    from related;
$$;

create function message_reply_lock_nodes(nodes jsonb) returns void language plpgsql as $$
declare
    keys bigint[];
    key bigint;
begin
    if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
        raise exception 'Message reply mutations require READ COMMITTED isolation'
            using errcode = '0A000';
    end if;
    loop
        keys := message_reply_component_keys(nodes);
        begin
            foreach key in array keys loop
                perform pg_advisory_xact_lock(key);
            end loop;
            if message_reply_component_keys(nodes) <@ keys then
                return;
            end if;
            -- Release locks from this attempt before discovering the changed component again.
            raise serialization_failure;
        exception when serialization_failure then
            null;
        end;
    end loop;
end;
$$;

create function message_reply_lock_row() returns trigger language plpgsql as $$
declare
    nodes jsonb := '[]';
    endpoint record;
begin
    for endpoint in select * from jsonb_to_recordset(
        case when TG_OP = 'INSERT' then jsonb_build_array(to_jsonb(NEW))
            when TG_OP = 'DELETE' then jsonb_build_array(to_jsonb(OLD))
            else jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) end
    ) as r(id bigint, original_signal_message_id bigint, reply_signal_message_id bigint,
        engaged_message_id bigint, thread_id bigint, datasource_id bigint, inbox_message_id bigint,
        original_inbox_message_id bigint, original_outbox_message_id bigint,
        signal_message_id bigint, message_reply_id bigint)
    loop
        if TG_TABLE_NAME = 'message_reply' then
            nodes := nodes || jsonb_build_array(
                jsonb_build_object('kind', 'message', 'datasource', 0, 'id', endpoint.original_signal_message_id),
                jsonb_build_object('kind', 'message', 'datasource', 0, 'id', endpoint.reply_signal_message_id),
                jsonb_build_object('kind', 'message', 'datasource', 0, 'id', endpoint.engaged_message_id),
                jsonb_build_object('kind', 'thread', 'datasource', 0, 'id', endpoint.thread_id),
                jsonb_build_object('kind', 'relation', 'datasource', 0, 'id', endpoint.id));
        elsif TG_TABLE_NAME = 'message_reply_source' then
            nodes := nodes || jsonb_build_array(
                jsonb_build_object('kind', 'message', 'datasource', 0, 'id', endpoint.signal_message_id),
                jsonb_build_object('kind', 'relation', 'datasource', 0, 'id', endpoint.message_reply_id),
                jsonb_build_object('kind', 'inbox', 'datasource', endpoint.datasource_id, 'id', endpoint.inbox_message_id),
                jsonb_build_object('kind', 'inbox', 'datasource', endpoint.datasource_id, 'id', endpoint.original_inbox_message_id),
                jsonb_build_object('kind', 'outbox', 'datasource', endpoint.datasource_id, 'id', endpoint.original_outbox_message_id));
        else
            nodes := nodes || jsonb_build_array(
                jsonb_build_object('kind', 'message', 'datasource', 0, 'id', endpoint.id));
        end if;
    end loop;
    perform message_reply_lock_nodes(nodes);
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
end;
$$;

create trigger message_reply_lock before insert or update or delete on message_reply
    for each row execute function message_reply_lock_row();
create trigger message_reply_source_lock before insert or update or delete on message_reply_source
    for each row execute function message_reply_lock_row();
create trigger message_reply_endpoint_before_lock before delete or update of deleted on signal_message
    for each row execute function message_reply_lock_row();
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
drop trigger message_reply_endpoint_before_lock on signal_message;
drop trigger message_reply_source_lock on message_reply_source;
drop trigger message_reply_lock on message_reply;
drop function message_reply_lock_row();
drop function message_reply_lock_nodes(jsonb);
drop function message_reply_component_keys(jsonb);

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
        "#).await.map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
