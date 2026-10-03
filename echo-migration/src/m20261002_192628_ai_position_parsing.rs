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
    id bigserial primary key,
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
    id bigserial primary key,
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
    id bigserial primary key,
    mention_id bigint not null
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
    id bigserial primary key,
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

-- Every removed mention (reparse, edit, deletion, a cascade from a removed
-- attachment or inbox item) queues the knowledge it may have fed. A fresh
-- created_at keeps a running recompute from consuming the job.
create function ai_position_mention_queue_knowledge()
returns trigger language plpgsql as $$
begin
    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select scope.kind, scope.key, old.name_key
    from (
        select 'group' as kind, old.group_master_key as key
        where old.group_master_key is not null
        union all
        select 'aor', aor_id::text from unnest(old.aor_ids) aor_id
    ) scope
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';
    return old;
end;
$$;

create trigger ai_position_mention_queue_knowledge
after delete on ai_position_mention
for each row execute function ai_position_mention_queue_knowledge();

-- Mentions point into the text by offset: a changed body drops them, and a
-- deleted message also drops its documents' mentions, on every write path.
create function ai_position_signal_message_invalidate()
returns trigger language plpgsql as $$
begin
    delete from ai_position_mention where sigint_inbox_item_id = new.id;
    if new.deleted then
        delete from ai_position_mention mention
        using signal_message_media media
        where media.signal_message_id = new.id and mention.media_id = media.id;
    end if;
    return new;
end;
$$;

create trigger ai_position_signal_message_invalidate
after update of body, deleted on signal_message
for each row
when (old.body is distinct from new.body or (new.deleted and not old.deleted))
execute function ai_position_signal_message_invalidate();

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
create function ai_position_rescope_message(message_id bigint)
returns void language plpgsql as $$
declare
    current_group text;
    current_aors bigint[];
begin
    select smg.group_master_key into current_group
    from signal_message_group smg
    where smg.signal_message_id = message_id and smg.group_master_key is not null
    order by smg.id
    limit 1;
    select coalesce(array_agg(sga.aor_id order by sga.aor_id), '{}') into current_aors
    from signal_group_aor sga
    join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
    where sga.master_key = current_group;

    insert into ai_position_knowledge_job (scope_kind, scope_key, name_key)
    select distinct scope.kind, scope.key, mention.name_key
    from ai_position_mention mention
    left join signal_message_media media on media.id = mention.media_id
    cross join lateral (
        select 'group' as kind, mention.group_master_key as key
        where mention.group_master_key is not null
        union all
        select 'aor', aor_id::text from unnest(mention.aor_ids) aor_id
        union all
        select 'group', current_group where current_group is not null
        union all
        select 'aor', aor_id::text from unnest(current_aors) aor_id
    ) scope
    where coalesce(mention.sigint_inbox_item_id, media.signal_message_id) = message_id
      and mention.group_master_key is distinct from current_group
    on conflict (scope_kind, scope_key, name_key) do update
        set attempts = 0,
            last_error = null,
            next_attempt_at = now() at time zone 'utc',
            created_at = now() at time zone 'utc';

    update ai_position_mention mention
    set group_master_key = current_group, aor_ids = current_aors
    where mention.group_master_key is distinct from current_group
      and (mention.sigint_inbox_item_id = message_id
           or mention.media_id in (
               select media.id from signal_message_media media
               where media.signal_message_id = message_id
           ));
end;
$$;

create function ai_position_signal_message_group_changed()
returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' or new.signal_message_id is distinct from old.signal_message_id then
        perform ai_position_rescope_message(old.signal_message_id);
    end if;
    if tg_op = 'UPDATE' then
        perform ai_position_rescope_message(new.signal_message_id);
    end if;
    return null;
end;
$$;

-- New links get higher ids, so an insert never changes the first group.
create trigger ai_position_signal_message_group_changed
after update or delete on signal_message_group
for each row execute function ai_position_signal_message_group_changed();
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
drop trigger if exists ai_position_signal_message_group_changed on signal_message_group;
drop function if exists ai_position_signal_message_group_changed();
drop function if exists ai_position_rescope_message(bigint);
drop trigger if exists ai_position_media_summary_deleted on media_summary;
drop function if exists ai_position_media_summary_deleted();
drop trigger if exists ai_position_media_summary_invalidate on media_summary;
drop function if exists ai_position_media_summary_invalidate();
drop trigger if exists ai_position_signal_message_invalidate on signal_message;
drop function if exists ai_position_signal_message_invalidate();
drop table if exists ai_position_knowledge_job;
drop table if exists ai_position_knowledge;
drop table if exists ai_position_coordinate;
drop table if exists ai_position_mention;
drop function if exists ai_position_mention_queue_knowledge();
drop table if exists ai_position_worker_job;
drop table if exists ai_position_settings;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
