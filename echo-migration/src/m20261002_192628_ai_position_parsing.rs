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
create table ai_position_settings (
    id smallint primary key check (id = 1),
    prompt text not null,
    worker_enabled boolean default false not null,
    worker_ai_engine_id uuid references ai_engine(id) on delete set null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

create table ai_position_worker_job (
    id uuid primary key,
    sigint_inbox_item_id bigint
        references sigint_inbox_item(id) on delete cascade,
    media_id uuid references signal_message_media(id) on delete cascade,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    check ((sigint_inbox_item_id is null) <> (media_id is null))
);

create unique index ai_position_worker_job_item_idx
    on ai_position_worker_job (sigint_inbox_item_id)
    where sigint_inbox_item_id is not null;

create unique index ai_position_worker_job_media_idx
    on ai_position_worker_job (media_id)
    where media_id is not null;

create index ai_position_worker_job_next_attempt_idx
    on ai_position_worker_job (next_attempt_at, created_at, id);

create table ai_position_mention (
    id uuid primary key,
    sigint_inbox_item_id bigint
        references sigint_inbox_item(id) on delete cascade,
    media_id uuid references signal_message_media(id) on delete cascade,
    name text not null,
    name_key text not null,
    begin_char integer not null,
    end_char integer not null,
    message_at timestamp without time zone not null,
    group_master_key text,
    group_is_secret boolean default false not null,
    aor_ids bigint[] default '{}' not null,
    ai_engine_id uuid references ai_engine(id) on delete set null,
    model_name text not null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    check ((sigint_inbox_item_id is null) <> (media_id is null)),
    check (begin_char >= 0 and end_char > begin_char)
);

create index ai_position_mention_item_idx
    on ai_position_mention (sigint_inbox_item_id)
    where sigint_inbox_item_id is not null;

create index ai_position_mention_media_idx
    on ai_position_mention (media_id)
    where media_id is not null;

create index ai_position_mention_name_key_idx
    on ai_position_mention (name_key, message_at desc);

create index ai_position_mention_message_at_idx
    on ai_position_mention (message_at desc, id desc);

create table ai_position_coordinate (
    id uuid primary key,
    mention_id uuid not null
        references ai_position_mention(id) on delete cascade,
    coordinate_text text not null,
    coordinate_system text not null
        check (coordinate_system in ('mgrs', 'sk42', 'usk2000', 'wgs84')),
    mgrs text not null,
    lat double precision not null,
    lng double precision not null,
    certainty text not null check (certainty in ('high', 'medium', 'low')),
    evidence text not null,
    coord_begin_char integer,
    coord_end_char integer,
    message_at timestamp without time zone not null,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_position_coordinate_mention_idx
    on ai_position_coordinate (mention_id);

create index ai_position_mention_group_idx
    on ai_position_mention (group_master_key, name_key);

create index ai_position_mention_aor_idx
    on ai_position_mention using gin (aor_ids);

-- Where a position is, per scope: an area of responsibility (facts from its
-- non-private groups) or a single group (private groups never leave it).
create table ai_position_knowledge (
    id uuid primary key,
    scope_kind text not null check (scope_kind in ('aor', 'group')),
    scope_key text not null,
    name_key text not null,
    name text not null,
    mgrs text not null,
    lat double precision not null,
    lng double precision not null,
    certainty text not null check (certainty in ('high', 'medium', 'low')),
    fact_count integer not null,
    conflicting boolean not null,
    first_fact_at timestamp without time zone not null,
    last_fact_at timestamp without time zone not null,
    source_group_keys text[] not null,
    updated_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    unique (scope_kind, scope_key, name_key)
);

create index ai_position_knowledge_last_fact_idx
    on ai_position_knowledge (last_fact_at desc, id desc);

create index ai_position_knowledge_name_key_idx
    on ai_position_knowledge (name_key);

create table ai_position_knowledge_job (
    scope_kind text not null check (scope_kind in ('aor', 'group')),
    scope_key text not null,
    name_key text not null,
    attempts integer default 0 not null,
    next_attempt_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    last_error text,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    primary key (scope_kind, scope_key, name_key)
);

create index ai_position_knowledge_job_next_attempt_idx
    on ai_position_knowledge_job (next_attempt_at, created_at);

-- Resumable linking of a known position into the scope's earlier messages:
-- one event-time range and pass, advanced batch by batch.
create table ai_position_link_job (
    id uuid primary key,
    scope_kind text not null check (scope_kind in ('aor', 'group')),
    scope_key text not null,
    name_key text not null,
    range_from timestamp without time zone not null,
    range_to timestamp without time zone not null,
    pass smallint not null check (pass in (0, 1)),
    cursor_at timestamp without time zone,
    cursor_id bigint not null default 0,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null
);

create index ai_position_link_job_created_idx
    on ai_position_link_job (created_at, id);

do $$
declare
    id_generator text;
    position_table text;
begin
    if to_regprocedure('uuidv7()') is not null then
        id_generator := 'uuidv7()';
    elsif to_regprocedure('uuid_generate_v7()') is not null then
        id_generator := 'uuid_generate_v7()';
    else
        raise exception 'UUIDv7 generator is unavailable: use PostgreSQL 18+ or enable the pg_uuidv7 extension';
    end if;
    foreach position_table in array array['ai_position_worker_job', 'ai_position_mention', 'ai_position_coordinate', 'ai_position_knowledge', 'ai_position_link_job'] loop
        execute format('alter table %I alter column id set default %s', position_table, id_generator);
    end loop;
end
$$;

-- Queues recomputes for a position's facts from a group: its group scope,
-- the recorded AORs, and every knowledge row built from the group (its AORs
-- may have changed since). A fresh created_at keeps a running recompute
-- from consuming the job.
create function ai_position_enqueue_knowledge(
    position_name_key text,
    position_group text,
    position_aors bigint[]
)
returns void language sql as $$
    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct scope.kind, scope.key, position_name_key
    from (
        select 'group' as kind, position_group as key
        where position_group is not null
        union all
        select 'aor', aor_id::text from unnest(position_aors) aor_id
        union all
        select knowledge.scope_kind, knowledge.scope_key
        from ai_position_knowledge knowledge
        where knowledge.name_key = position_name_key
          and position_group = any(knowledge.source_group_keys)
    ) scope
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';
$$;

-- Every removed mention (reparse, edit, a cascade from a removed attachment
-- or inbox item) queues the knowledge it may have fed.
create function ai_position_mention_queue_knowledge()
returns trigger language plpgsql as $$
begin
    perform ai_position_enqueue_knowledge(old.name_key, old.group_master_key, old.aor_ids);
    return old;
end;
$$;

create trigger ai_position_mention_queue_knowledge
after delete on ai_position_mention
for each row execute function ai_position_mention_queue_knowledge();

-- Keeps a message's mentions in step with its time and visibility: copies
-- the event time onto mentions and facts, and queues their knowledge (facts
-- of deleted messages are left out by every read, so a message restored
-- after restaging keeps its facts).
create function ai_position_refresh_message(target_message_id bigint)
returns void language plpgsql as $$
declare
    media_ids uuid[];
    item_at timestamp;
    media_at timestamp;
begin
    select coalesce(array_agg(media.id), '{}') into media_ids
    from signal_message_media media
    where media.signal_message_id = target_message_id;
    if not exists (
        select 1 from ai_position_mention where sigint_inbox_item_id = target_message_id
    ) and not exists (
        select 1 from ai_position_mention where media_id = any(media_ids)
    ) then
        return;
    end if;
    select coalesce(item.datetime, message.timestamp, message.created_at),
           coalesce(message.timestamp, message.created_at)
    into item_at, media_at
    from signal_message message
    left join sigint_inbox_item item on item.id = message.id
    where message.id = target_message_id;

    update ai_position_mention set message_at = item_at
    where sigint_inbox_item_id = target_message_id and message_at is distinct from item_at;
    update ai_position_mention set message_at = media_at
    where media_id = any(media_ids) and message_at is distinct from media_at;
    update ai_position_coordinate coordinate set message_at = mention.message_at
    from ai_position_mention mention
    where coordinate.mention_id = mention.id
      and mention.sigint_inbox_item_id = target_message_id
      and coordinate.message_at is distinct from mention.message_at;
    update ai_position_coordinate coordinate set message_at = mention.message_at
    from ai_position_mention mention
    where coordinate.mention_id = mention.id
      and mention.media_id = any(media_ids)
      and coordinate.message_at is distinct from mention.message_at;

    perform ai_position_enqueue_knowledge(fed.name_key, fed.group_master_key, fed.aor_ids)
    from (
        select distinct name_key, group_master_key, aor_ids from ai_position_mention
        where sigint_inbox_item_id = target_message_id
        union
        select distinct name_key, group_master_key, aor_ids from ai_position_mention
        where media_id = any(media_ids)
    ) fed;
end;
$$;

-- Body mentions point into the text by offset: a changed body drops them.
-- A changed send time or deletion flag refreshes the message's facts.
create function ai_position_signal_message_changed()
returns trigger language plpgsql as $$
begin
    if old.body is distinct from new.body then
        delete from ai_position_mention where sigint_inbox_item_id = new.id;
    end if;
    perform ai_position_refresh_message(new.id);
    return null;
end;
$$;

create trigger ai_position_signal_message_changed
after update of body, deleted, timestamp on signal_message
for each row
when (old.body is distinct from new.body
      or old.deleted is distinct from new.deleted
      or old.timestamp is distinct from new.timestamp)
execute function ai_position_signal_message_changed();

-- A corrected event time (date/time edited in Analysis) moves the facts.
create function ai_position_inbox_item_time_changed()
returns trigger language plpgsql as $$
begin
    perform ai_position_refresh_message(new.id);
    return null;
end;
$$;

create trigger ai_position_inbox_item_time_changed
after update of datetime on sigint_inbox_item
for each row
when (old.datetime is distinct from new.datetime)
execute function ai_position_inbox_item_time_changed();

-- A document's mentions point into its summary: a cleared (reprocessed) or
-- replaced summary drops them.
create function ai_position_media_summary_invalidate()
returns trigger language plpgsql as $$
begin
    delete from ai_position_mention where media_id = new.media_id;
    return new;
end;
$$;

create trigger ai_position_media_summary_invalidate
after update of summary on media_summary
for each row
when (old.summary is distinct from new.summary)
execute function ai_position_media_summary_invalidate();

-- OCR reprocessing deletes the summary row and keeps the attachment.
create function ai_position_media_summary_deleted()
returns trigger language plpgsql as $$
begin
    delete from ai_position_mention where media_id = old.media_id;
    return old;
end;
$$;

create trigger ai_position_media_summary_deleted
after delete on media_summary
for each row execute function ai_position_media_summary_deleted();

-- Mentions record the message's group (its first group link). When links
-- change (e.g. a group merge), move the mentions to the current group and
-- queue the knowledge of both the old and the new scopes: access checks and
-- knowledge must never follow a group the message left.
create function ai_position_rescope_message(target_message_id bigint)
returns void language plpgsql as $$
declare
    media_ids uuid[];
    current_group text;
    current_aors bigint[];
begin
    -- Indexed early exit: most messages have no mentions.
    select coalesce(array_agg(media.id), '{}') into media_ids
    from signal_message_media media
    where media.signal_message_id = target_message_id;
    if not exists (
        select 1 from ai_position_mention where sigint_inbox_item_id = target_message_id
    ) and not exists (
        select 1 from ai_position_mention where media_id = any(media_ids)
    ) then
        return;
    end if;

    select smg.group_master_key into current_group
    from signal_message_group smg
    where smg.signal_message_id = target_message_id and smg.group_master_key is not null
    order by smg.id
    limit 1;
    select coalesce(array_agg(sga.aor_id order by sga.aor_id), '{}') into current_aors
    from signal_group_aor sga
    join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
    where sga.master_key = current_group;

    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct scope.kind, scope.key, mention.name_key
    from (
        select name_key, group_master_key, aor_ids from ai_position_mention
        where sigint_inbox_item_id = target_message_id
        union all
        select name_key, group_master_key, aor_ids from ai_position_mention
        where media_id = any(media_ids)
    ) mention
    cross join lateral (
        select 'group' as kind, mention.group_master_key as key
        where mention.group_master_key is not null
        union all
        select 'aor', aor_id::text from unnest(mention.aor_ids) aor_id
        union all
        -- The old group's AORs now, which may differ from the snapshot.
        select 'aor', sga.aor_id::text
        from signal_group_aor sga
        where sga.master_key = mention.group_master_key
        union all
        select 'group', current_group where current_group is not null
        union all
        select 'aor', aor_id::text from unnest(current_aors) aor_id
    ) scope
    where mention.group_master_key is distinct from current_group
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';

    -- Knowledge the old group fed stays readable under that group's access
    -- until recomputed: drop it now and queue every dropped scope to rebuild.
    with dropped as (
    delete from ai_position_knowledge knowledge
    using (
        select name_key, group_master_key from ai_position_mention
        where sigint_inbox_item_id = target_message_id
          and group_master_key is distinct from current_group
        union
        select name_key, group_master_key from ai_position_mention
        where media_id = any(media_ids)
          and group_master_key is distinct from current_group
    ) moved
    where knowledge.name_key = moved.name_key
      and moved.group_master_key = any(knowledge.source_group_keys)
    returning knowledge.scope_kind, knowledge.scope_key, knowledge.name_key
    )
    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct scope_kind, scope_key, name_key from dropped
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';

    update ai_position_mention
    set group_master_key = current_group, aor_ids = current_aors
    where sigint_inbox_item_id = target_message_id
      and group_master_key is distinct from current_group;
    update ai_position_mention
    set group_master_key = current_group, aor_ids = current_aors
    where media_id = any(media_ids)
      and group_master_key is distinct from current_group;
end;
$$;

create function ai_position_signal_message_group_changed()
returns trigger language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        perform ai_position_rescope_message(new.signal_message_id);
        return null;
    end if;
    perform ai_position_rescope_message(old.signal_message_id);
    if tg_op = 'UPDATE' then
        if new.signal_message_id is distinct from old.signal_message_id then
            perform ai_position_rescope_message(new.signal_message_id);
        end if;
    end if;
    return null;
end;
$$;

-- Links that can change a message's first group: a new link (e.g. after
-- its links were replaced), a changed group or message, a removed link.
create trigger ai_position_signal_message_group_inserted
after insert on signal_message_group
for each row
when (new.group_master_key is not null)
execute function ai_position_signal_message_group_changed();

create trigger ai_position_signal_message_group_changed
after update on signal_message_group
for each row
when (old.group_master_key is distinct from new.group_master_key
      or old.signal_message_id is distinct from new.signal_message_id)
execute function ai_position_signal_message_group_changed();

create trigger ai_position_signal_message_group_deleted
after delete on signal_message_group
for each row execute function ai_position_signal_message_group_changed();

-- An attachment moved to another message (duplicate promotion) takes the
-- new message's group and time; both scopes are recomputed.
create function ai_position_media_moved()
returns trigger language plpgsql as $$
begin
    perform ai_position_rescope_message(new.signal_message_id);
    perform ai_position_refresh_message(new.signal_message_id);
    return null;
end;
$$;

create trigger ai_position_media_moved
after update of signal_message_id on signal_message_media
for each row
when (old.signal_message_id is distinct from new.signal_message_id)
execute function ai_position_media_moved();

-- A group newly part of AORs: link the positions those AORs already know
-- into its messages over their current windows (recomputing an unchanged
-- window queues no linking).
create function ai_position_link_group_into_aors(aor_ids bigint[])
returns void language sql as $$
    insert into ai_position_link_job
        (scope_kind, scope_key, name_key, range_from, range_to, pass)
    select 'aor', knowledge.scope_key, knowledge.name_key,
        knowledge.first_fact_at - interval '30 days',
        knowledge.last_fact_at + interval '30 days', 0
    from ai_position_knowledge knowledge
    where knowledge.scope_kind = 'aor'
      and knowledge.scope_key = any(array(select unnest(aor_ids)::text));
$$;

-- A group made private or public on any path (zone settings, importer):
-- recompute everything its facts feed.
create function ai_position_group_privacy_changed()
returns trigger language plpgsql as $$
begin
    if not new.is_secret then
        perform ai_position_link_group_into_aors(array(
            select sga.aor_id from signal_group_aor sga where sga.master_key = new.master_key
        ));
    end if;
    perform ai_position_enqueue_knowledge(fed.name_key, new.master_key, fed.aor_ids)
    from (
        select distinct name_key, aor_ids
        from ai_position_mention
        where group_master_key = new.master_key
    ) fed;
    perform ai_position_enqueue_knowledge(fed.name_key, new.master_key, array(
        select sga.aor_id from signal_group_aor sga where sga.master_key = new.master_key
    ))
    from (
        select distinct name_key
        from ai_position_mention
        where group_master_key = new.master_key
    ) fed;
    return null;
end;
$$;

create trigger ai_position_group_privacy_changed
after update of is_secret on signal_group
for each row
when (old.is_secret is distinct from new.is_secret)
execute function ai_position_group_privacy_changed();

-- A group's AOR links changed (reassignment deletes and reinserts them):
-- recompute its positions in the old and new AOR.
create function ai_position_group_aor_changed()
returns trigger language plpgsql as $$
begin
    if tg_op <> 'DELETE' and not exists (
        select 1 from signal_group sg where sg.master_key = new.master_key and sg.is_secret
    ) then
        perform ai_position_link_group_into_aors(array[new.aor_id]);
    end if;
    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct 'aor', changed.aor_id::text, fed.name_key
    from (
        select new.master_key as master_key, new.aor_id as aor_id where tg_op <> 'DELETE'
        union all
        select old.master_key, old.aor_id where tg_op <> 'INSERT'
    ) changed
    join lateral (
        select distinct mention.name_key
        from ai_position_mention mention
        where mention.group_master_key = changed.master_key
    ) fed on true
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';
    return null;
end;
$$;

create trigger ai_position_group_aor_changed
after insert or update or delete on signal_group_aor
for each row execute function ai_position_group_aor_changed();

-- An AOR deleted or restored: recompute what it knows or could know.
create function ai_position_aor_deleted_changed()
returns trigger language plpgsql as $$
begin
    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct 'aor', new.id::text, fed.name_key
    from (
        select knowledge.name_key
        from ai_position_knowledge knowledge
        where knowledge.scope_kind = 'aor' and knowledge.scope_key = new.id::text
        union
        select mention.name_key
        from signal_group_aor sga
        join ai_position_mention mention on mention.group_master_key = sga.master_key
        where sga.aor_id = new.id
    ) fed
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';
    return null;
end;
$$;

create trigger ai_position_aor_deleted_changed
after update of deleted on area_of_responsibility
for each row
when (old.deleted is distinct from new.deleted)
execute function ai_position_aor_deleted_changed();

-- Keyset pages of linking seek by event time; minute-precision times tie
-- often, so the id must be part of the index.
create index sigint_inbox_item_datetime_id_idx
    on sigint_inbox_item (datetime, id);
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
drop index if exists sigint_inbox_item_datetime_id_idx;
drop trigger if exists ai_position_aor_deleted_changed on area_of_responsibility;
drop function if exists ai_position_aor_deleted_changed();
drop trigger if exists ai_position_group_aor_changed on signal_group_aor;
drop function if exists ai_position_group_aor_changed();
drop trigger if exists ai_position_group_privacy_changed on signal_group;
drop function if exists ai_position_group_privacy_changed();
drop function if exists ai_position_link_group_into_aors(bigint[]);
drop trigger if exists ai_position_media_moved on signal_message_media;
drop function if exists ai_position_media_moved();
drop trigger if exists ai_position_signal_message_group_inserted on signal_message_group;
drop trigger if exists ai_position_signal_message_group_changed on signal_message_group;
drop trigger if exists ai_position_signal_message_group_deleted on signal_message_group;
drop function if exists ai_position_signal_message_group_changed();
drop function if exists ai_position_rescope_message(bigint);
drop trigger if exists ai_position_media_summary_deleted on media_summary;
drop function if exists ai_position_media_summary_deleted();
drop trigger if exists ai_position_media_summary_invalidate on media_summary;
drop function if exists ai_position_media_summary_invalidate();
drop trigger if exists ai_position_inbox_item_time_changed on sigint_inbox_item;
drop function if exists ai_position_inbox_item_time_changed();
drop trigger if exists ai_position_signal_message_changed on signal_message;
drop function if exists ai_position_signal_message_changed();
drop function if exists ai_position_refresh_message(bigint);
drop table if exists ai_position_link_job;
drop table if exists ai_position_knowledge_job;
drop table if exists ai_position_knowledge;
drop table if exists ai_position_coordinate;
drop table if exists ai_position_mention;
drop function if exists ai_position_mention_queue_knowledge();
drop function if exists ai_position_enqueue_knowledge(text, text, bigint[]);
drop table if exists ai_position_worker_job;
drop table if exists ai_position_settings;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
