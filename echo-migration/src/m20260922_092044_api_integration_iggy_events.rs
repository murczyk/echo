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
create table api_integration_iggy_destination (
    id bigserial primary key,
    api_integration_id bigint not null references api_integration(id) on delete cascade,
    api_user_login_id uuid not null references login(id),
    iggy_url text,
    iggy_login text,
    iggy_password text,
    iggy_inbox_topic text,
    active_from timestamp without time zone not null
);

create index api_integration_iggy_destination_current_idx
    on api_integration_iggy_destination (api_integration_id, id desc);

insert into api_integration_iggy_destination (
    api_integration_id, api_user_login_id, iggy_url, iggy_login,
    iggy_password, iggy_inbox_topic, active_from
)
select id, api_user_login_id, iggy_url, iggy_login,
    iggy_password, iggy_inbox_topic, created_at at time zone 'utc'
from api_integration
where has_iggy_connection;

create function capture_api_integration_iggy_destination()
returns trigger language plpgsql as $$
begin
    if not new.has_iggy_connection then
        return new;
    end if;
    if exists (
        select 1 from api_integration_iggy_destination destination
        where destination.api_integration_id = new.id
            and destination.api_user_login_id is distinct from new.api_user_login_id
            and destination.iggy_url is not distinct from new.iggy_url
            and destination.iggy_inbox_topic is not distinct from new.iggy_inbox_topic
    ) then
        raise exception 'Changing the API user requires a new Iggy destination';
    end if;
    if tg_op = 'UPDATE' then
        if old.has_iggy_connection is not distinct from new.has_iggy_connection
            and old.api_user_login_id is not distinct from new.api_user_login_id
            and old.iggy_url is not distinct from new.iggy_url
            and old.iggy_login is not distinct from new.iggy_login
            and old.iggy_password is not distinct from new.iggy_password
            and old.iggy_inbox_topic is not distinct from new.iggy_inbox_topic then
            return new;
        end if;
    end if;
    insert into api_integration_iggy_destination (
        api_integration_id, api_user_login_id, iggy_url, iggy_login,
        iggy_password, iggy_inbox_topic, active_from
    ) values (
        new.id, new.api_user_login_id, new.iggy_url, new.iggy_login,
        new.iggy_password, new.iggy_inbox_topic,
        clock_timestamp() at time zone 'utc'
    );
    perform scrub_api_integration_iggy_destination_credentials(new.id);
    return new;
end;
$$;

create trigger api_integration_capture_iggy_destination_insert
after insert on api_integration
for each row execute function capture_api_integration_iggy_destination();

create trigger api_integration_capture_iggy_destination_update
after update of has_iggy_connection, api_user_login_id, iggy_url, iggy_login,
    iggy_password, iggy_inbox_topic on api_integration
for each row execute function capture_api_integration_iggy_destination();

create table api_integration_iggy_event (
    id bigserial primary key,
    api_integration_id bigint not null references api_integration(id) on delete cascade,
    destination_id bigint not null references api_integration_iggy_destination(id)
        deferrable initially deferred,
    sigint_inbox_item_id bigint,
    payload jsonb not null,
    created_at timestamp without time zone not null default (clock_timestamp() at time zone 'utc')
);

create index api_integration_iggy_event_pending_idx
    on api_integration_iggy_event (api_integration_id, id);

create index api_integration_iggy_event_destination_idx
    on api_integration_iggy_event (destination_id);

create function scrub_api_integration_iggy_destination_credentials(integration_id bigint)
returns void language sql as $$
    update api_integration_iggy_destination destination
    set iggy_login = null, iggy_password = null
    where destination.api_integration_id = integration_id
        and destination.id <> (
            select max(id) from api_integration_iggy_destination
            where api_integration_id = integration_id
        )
        and (destination.iggy_login is not null
            or destination.iggy_password is not null)
        and not exists (
            select 1 from api_integration_iggy_event event
            where event.destination_id = destination.id
        )
        and (
            select integration.last_sync_at from api_integration integration
            where integration.id = destination.api_integration_id
        ) >= (
            select next.active_from from api_integration_iggy_destination next
            where next.api_integration_id = destination.api_integration_id
                and next.id > destination.id
            order by next.id limit 1
        );
$$;

create function queue_api_integration_iggy_event(item_id bigint, event_payload jsonb)
returns void language plpgsql as $$
begin
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, item_id, event_payload
    from api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection;
end;
$$;

create function api_integration_iggy_has_publisher()
returns boolean language plpgsql as $$
declare
    has_publisher boolean;
begin
    perform 1 from api_integration integration
    order by integration.id for share;
    select exists (
        select 1 from api_integration integration
        where integration.sync_enabled and integration.has_iggy_connection
    ) into has_publisher;
    return has_publisher;
end;
$$;

create function api_integration_iggy_network_frequency_ids(
    target_network_id bigint, item_freq text, item_datetime timestamp without time zone
) returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(frequency.id order by frequency.id), '[]'::jsonb)
    from sigint_network_freq frequency
    join sigint_network network on network.id = frequency.network_id
    where frequency.network_id = target_network_id
        and frequency.freq = item_freq
        and not frequency.deleted and not network.deleted
        and frequency.active_from <= item_datetime
        and (frequency.active_to is null or item_datetime <= frequency.active_to);
$$;

create function api_integration_iggy_network_callsign_ids(network_id bigint)
returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(callsign.id order by callsign.id), '[]'::jsonb)
    from sigint_network_callsign callsign
    where callsign.sigint_network_id = network_id and not callsign.deleted;
$$;

create function api_integration_iggy_network_sigint_callsign_ids(network_id bigint)
returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(distinct callsign.sigint_callsign_id order by callsign.sigint_callsign_id), '[]'::jsonb)
    from sigint_network_callsign callsign
    where callsign.sigint_network_id = network_id
        and not callsign.deleted and callsign.sigint_callsign_id is not null;
$$;

create function api_integration_iggy_callsign_key(input text)
returns text language sql immutable strict as $$
    select btrim(regexp_replace(translate(lower(input), U&'\002D\0020\2010\2011\2012\2013\2014\2015\0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000', repeat('-', 32)), '-+', '-', 'g'), '-');
$$;

create function api_integration_iggy_callsign_ids(item_callsign text)
returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(callsign.id order by callsign.id), '[]'::jsonb)
    from sigint_callsign callsign
    join sigint_unit unit on unit.id = callsign.unit_id
    where not callsign.deleted and not unit.deleted and unit.active
        and btrim(regexp_replace(translate(lower(callsign.callsign), U&'\002D\0020\2010\2011\2012\2013\2014\2015\0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000', repeat('-', 32)), '-+', '-', 'g'), '-')
            = api_integration_iggy_callsign_key(item_callsign);
$$;

create function queue_api_integration_iggy_network_callsign_refresh(callsign_keys text[])
returns void language plpgsql as $$
begin
    if cardinality(callsign_keys) = 0 then
        return;
    end if;
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, null,
        jsonb_build_object(
            'event_type', 'sigint_network_callsign_unlinked',
            'sigint_network_id', network_callsign.sigint_network_id,
            'sigint_network_callsign_id', network_callsign.id,
            'sigint_callsign_id', network_callsign.sigint_callsign_id,
            'callsign', network_callsign.sigint_callsign,
            'sigint_callsign_ids', api_integration_iggy_callsign_ids(
                network_callsign.sigint_callsign
            )
        )
    from sigint_network_callsign network_callsign
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where not network_callsign.deleted
        and api_integration_iggy_callsign_key(network_callsign.sigint_callsign)
            = any(callsign_keys)
        and integration.sync_enabled and integration.has_iggy_connection
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = network_callsign.sigint_network_id);
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, null,
        jsonb_build_object(
            'event_type', 'sigint_network_callsign_linked',
            'sigint_network_id', network_callsign.sigint_network_id,
            'sigint_network_callsign_id', network_callsign.id,
            'sigint_callsign_id', network_callsign.sigint_callsign_id,
            'callsign', network_callsign.sigint_callsign,
            'sigint_callsign_ids', api_integration_iggy_callsign_ids(
                network_callsign.sigint_callsign
            )
        )
    from sigint_network_callsign network_callsign
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where not network_callsign.deleted
        and api_integration_iggy_callsign_key(network_callsign.sigint_callsign)
            = any(callsign_keys)
        and integration.sync_enabled and integration.has_iggy_connection
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = network_callsign.sigint_network_id);
end;
$$;

create function queue_api_integration_iggy_network_frequency_change(
    item_id bigint, old_freq text, new_freq text,
    old_datetime timestamp without time zone,
    new_datetime timestamp without time zone
) returns void language plpgsql as $$
declare
    network_link record;
    old_frequency_ids jsonb;
    new_frequency_ids jsonb;
begin
    if not api_integration_iggy_has_publisher() then
        return;
    end if;
    for network_link in
        select sigint_network_id from sigint_inbox_item_network
        where sigint_inbox_item_id = item_id
    loop
        old_frequency_ids := api_integration_iggy_network_frequency_ids(
            network_link.sigint_network_id, old_freq, old_datetime
        );
        new_frequency_ids := api_integration_iggy_network_frequency_ids(
            network_link.sigint_network_id, new_freq, new_datetime
        );
        if old_frequency_ids is distinct from new_frequency_ids then
            perform queue_api_integration_iggy_event(
                item_id,
                jsonb_build_object(
                    'event_type', 'sigint_inbox_item_network_frequencies_changed',
                    'sigint_network_id', network_link.sigint_network_id,
                    'unlinked_sigint_network_freq_ids', old_frequency_ids,
                    'linked_sigint_network_freq_ids', new_frequency_ids
                )
            );
        end if;
    end loop;
end;
$$;

create function capture_api_integration_iggy_inbox_edit()
returns trigger language plpgsql as $$
declare
    item_id bigint;
    item_frequency text;
    fallback_datetime timestamp without time zone;
    item_datetime timestamp without time zone;
begin
    if not api_integration_iggy_has_publisher() then
        return new;
    end if;
    if tg_table_name = 'sigint_inbox_item' and tg_op = 'INSERT' then
        perform queue_api_integration_iggy_event(
            new.id,
            jsonb_build_object('event_type', 'sigint_inbox_item_created')
        );
        return new;
    end if;
    if tg_table_name = 'signal_message' then
        if old is not distinct from new then
            return new;
        end if;
        for item_id in
            select distinct product.source_message_id
            from intel_product product
            join sigint_inbox_item item
                on item.id = product.source_message_id
            where product.intel_message_id = new.id
                and product.relation_kind = 'comment'
        loop
            perform queue_api_integration_iggy_event(
                item_id,
                jsonb_build_object(
                    'event_type', 'sigint_inbox_item_updated'
                )
            );
        end loop;
        if exists (select 1 from sigint_inbox_item where id = new.id) then
            perform queue_api_integration_iggy_event(
                new.id,
                jsonb_build_object(
                    'event_type', case
                        when new.deleted then 'sigint_inbox_item_deleted'
                        when old.deleted then 'sigint_inbox_item_created'
                        else 'sigint_inbox_item_updated'
                    end
                )
            );
            if old.timestamp is distinct from new.timestamp
                or old.created_at is distinct from new.created_at then
                select item.freq, item.datetime into item_frequency, item_datetime
                from sigint_inbox_item item where item.id = new.id;
                if item_datetime is null then
                    perform queue_api_integration_iggy_network_frequency_change(
                        new.id, item_frequency, item_frequency,
                        coalesce(old.timestamp, old.created_at),
                        coalesce(new.timestamp, new.created_at)
                    );
                end if;
            end if;
        end if;
        return new;
    end if;

    if old is not distinct from new then
        return new;
    end if;
    item_id := new.id;
    perform queue_api_integration_iggy_event(
        item_id,
        jsonb_build_object('event_type', 'sigint_inbox_item_updated')
    );

    if old.freq is distinct from new.freq or old.datetime is distinct from new.datetime then
        select coalesce(message.timestamp, message.created_at)
        into fallback_datetime
        from signal_message message where message.id = item_id;
        perform queue_api_integration_iggy_network_frequency_change(
            item_id, old.freq, new.freq,
            coalesce(old.datetime, fallback_datetime),
            coalesce(new.datetime, fallback_datetime)
        );
    end if;
    return new;
end;
$$;

create trigger sigint_inbox_item_capture_iggy_edit
after insert or update on sigint_inbox_item
for each row execute function capture_api_integration_iggy_inbox_edit();

create trigger signal_message_capture_iggy_edit
after update on signal_message
for each row execute function capture_api_integration_iggy_inbox_edit();

create function capture_api_integration_iggy_related_edit()
returns trigger language plpgsql as $$
declare
    old_item_id bigint;
    new_item_id bigint;
    event_payload jsonb;
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE' and old is not distinct from new then
        return new;
    end if;
    if tg_op <> 'INSERT' then
        old_item_id := (to_jsonb(old) ->> tg_argv[0])::bigint;
    end if;
    if tg_op <> 'DELETE' then
        new_item_id := (to_jsonb(new) ->> tg_argv[0])::bigint;
    end if;
    if old_item_id is not null and (tg_op = 'DELETE' or old_item_id <> new_item_id)
        and exists (select 1 from sigint_inbox_item where id = old_item_id) then
        event_payload := jsonb_build_object('event_type', 'sigint_inbox_item_updated');
        if tg_table_name = 'signal_message_group' then
            event_payload := event_payload || jsonb_build_object(
                'previous_group_master_key', to_jsonb(old) ->> 'group_master_key'
            );
        end if;
        perform queue_api_integration_iggy_event(old_item_id, event_payload);
    end if;
    if new_item_id is not null and exists (
        select 1 from sigint_inbox_item where id = new_item_id
    ) then
        event_payload := jsonb_build_object('event_type', 'sigint_inbox_item_updated');
        if tg_table_name = 'signal_message_group' and tg_op = 'UPDATE'
            and old_item_id = new_item_id
            and (to_jsonb(old) ->> 'group_master_key') is distinct from
                (to_jsonb(new) ->> 'group_master_key') then
            event_payload := event_payload || jsonb_build_object(
                'previous_group_master_key', to_jsonb(old) ->> 'group_master_key'
            );
        end if;
        perform queue_api_integration_iggy_event(new_item_id, event_payload);
    end if;
    return coalesce(new, old);
end;
$$;

create trigger intel_product_capture_iggy_edit
after insert or update or delete on intel_product
for each row execute function capture_api_integration_iggy_related_edit('source_message_id');

create trigger sigint_comment_capture_iggy_edit
after insert or update or delete on sigint_comment
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

create trigger sigint_inbox_item_unit_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_unit
for each row execute function capture_api_integration_iggy_related_edit('item_id');

create function capture_api_integration_iggy_unit_visibility()
returns trigger language plpgsql as $$
begin
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select distinct integration.id, destination.id, affected.item_id,
        jsonb_build_object('event_type', 'sigint_inbox_item_updated')
    from (
        select link.item_id
        from sigint_inbox_item_unit link
        where link.unit_id = new.id
        union
        select inbox_callsign.sigint_inbox_item_id
        from sigint_callsign catalog_callsign
        join sigint_inbox_item_callsign inbox_callsign
            on api_integration_iggy_callsign_key(inbox_callsign.callsign)
                = api_integration_iggy_callsign_key(catalog_callsign.callsign)
        where catalog_callsign.unit_id = new.id
            and not catalog_callsign.deleted and not inbox_callsign.deleted
    ) affected
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection;
    perform queue_api_integration_iggy_network_callsign_refresh(array(
        select distinct api_integration_iggy_callsign_key(callsign)
        from sigint_callsign
        where unit_id = new.id and not deleted
    ));
    return new;
end;
$$;

create trigger sigint_unit_capture_iggy_visibility
after update of deleted, active on sigint_unit
for each row when (old.deleted is distinct from new.deleted
    or old.active is distinct from new.active)
execute function capture_api_integration_iggy_unit_visibility();

create trigger sigint_inbox_item_tag_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_tag
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger sigint_inbox_item_metadata_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_metadata
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger sigint_inbox_item_point_token_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_point_token
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger sigint_important_capture_iggy_edit
after insert or update or delete on sigint_important
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

create trigger signal_message_media_capture_iggy_edit
after insert or update or delete on signal_message_media
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

create function capture_api_integration_iggy_media_result()
returns trigger language plpgsql as $$
declare
    old_media_id uuid;
    new_media_id uuid;
    item_id bigint;
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE' and old is not distinct from new then
        return new;
    end if;
    if tg_op <> 'INSERT' then
        old_media_id := (to_jsonb(old) ->> tg_argv[0])::uuid;
    end if;
    if tg_op <> 'DELETE' then
        new_media_id := (to_jsonb(new) ->> tg_argv[0])::uuid;
    end if;
    for item_id in
        select distinct media.signal_message_id
        from signal_message_media media
        join sigint_inbox_item item on item.id = media.signal_message_id
        where media.id = old_media_id or media.id = new_media_id
    loop
        perform queue_api_integration_iggy_event(
            item_id,
            jsonb_build_object('event_type', 'sigint_inbox_item_updated')
        );
    end loop;
    return coalesce(new, old);
end;
$$;

create trigger echo_gpu_transcription_queue_capture_iggy_edit
after insert or update of source_id, state, transcribed_value or delete
on echo_gpu_transcription_queue
for each row execute function capture_api_integration_iggy_media_result('source_id');

create trigger ocr_job_capture_iggy_edit
after insert or update of media_id, state, quality_status, processed_pages, total_pages,
    last_error, attempts, submitted_at, completed_at, updated_at, ai_engine_id,
    ai_engine_name, model_name or delete on ocr_job
for each row execute function capture_api_integration_iggy_media_result('media_id');

create trigger media_summary_capture_iggy_edit
after insert or update of media_id, state, last_error, coordinates or delete
on media_summary
for each row execute function capture_api_integration_iggy_media_result('media_id');

create trigger signal_message_media_conversion_job_capture_iggy_edit
after insert or update of source_media_id, status or delete
on signal_message_media_conversion_job
for each row execute function capture_api_integration_iggy_media_result('source_media_id');

create trigger signal_message_group_capture_iggy_edit
after insert or update or delete on signal_message_group
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

create function queue_api_integration_iggy_group_visibility_change(
    target_group_master_keys text[], target_login_ids uuid[],
    target_zone_ids bigint[], target_organism_ids bigint[]
) returns void language plpgsql as $$
begin
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select distinct integration.id, destination.id, message_group.signal_message_id,
        jsonb_build_object(
            'event_type', 'sigint_inbox_item_visibility_changed'
        )
    from api_integration integration
    join login api_user on api_user.id = integration.api_user_login_id
    join signal_message_group message_group
        on message_group.group_master_key is not null
        and (target_group_master_keys is null
            or message_group.group_master_key = any(target_group_master_keys))
    join sigint_inbox_item item on item.id = message_group.signal_message_id
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection
        and (
            (target_login_ids is null and target_zone_ids is null
                and target_organism_ids is null)
            or api_user.id = any(coalesce(target_login_ids, '{}'::uuid[]))
            or api_user.sigint_zone_id = any(
                coalesce(target_zone_ids, '{}'::bigint[])
            )
            or api_user.organism_id = any(
                coalesce(target_organism_ids, '{}'::bigint[])
            )
        );
end;
$$;

create function capture_api_integration_iggy_aor_assignment()
returns trigger language plpgsql as $$
declare
    target_group_master_keys text[];
    target_organism_ids bigint[];
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_table_name = 'organism_aor' then
        target_organism_ids := case tg_op
            when 'INSERT' then array[new.organism_id]
            when 'DELETE' then array[old.organism_id]
            else array[old.organism_id, new.organism_id]
        end;
    else
        target_group_master_keys := case tg_op
            when 'INSERT' then array[new.master_key]
            when 'DELETE' then array[old.master_key]
            else array[old.master_key, new.master_key]
        end;
    end if;
    perform queue_api_integration_iggy_group_visibility_change(
        target_group_master_keys, null, null, target_organism_ids
    );
    return coalesce(new, old);
end;
$$;

create trigger organism_aor_capture_iggy_visibility
after insert or delete or update of organism_id, aor_id on organism_aor
for each row execute function capture_api_integration_iggy_aor_assignment();

create trigger signal_group_aor_capture_iggy_visibility
after insert or delete or update of master_key, aor_id on signal_group_aor
for each row execute function capture_api_integration_iggy_aor_assignment();

create function capture_api_integration_iggy_signal_group_visibility()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    perform queue_api_integration_iggy_group_visibility_change(
        array[old.master_key], null, null, null
    );
    return coalesce(new, old);
end;
$$;

create trigger signal_group_capture_iggy_visibility_update
after update of deleted, is_archived, is_secret on signal_group
for each row when (old.deleted is distinct from new.deleted
    or old.is_archived is distinct from new.is_archived
    or old.is_secret is distinct from new.is_secret)
execute function capture_api_integration_iggy_signal_group_visibility();

create trigger signal_group_capture_iggy_visibility_delete
before delete on signal_group
for each row execute function capture_api_integration_iggy_signal_group_visibility();

create function capture_api_integration_iggy_secret_group_user()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[old.master_key], array[old.login_id], null, null
        );
    end if;
    if tg_op <> 'DELETE' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[new.master_key], array[new.login_id], null, null
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger secret_group_user_capture_iggy_visibility
after insert or delete or update of master_key, login_id on secret_group_user
for each row execute function capture_api_integration_iggy_secret_group_user();

create function capture_api_integration_iggy_secret_group_organism()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[old.master_key], null, null, array[old.organism_id]
        );
    end if;
    if tg_op <> 'DELETE' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[new.master_key], null, null, array[new.organism_id]
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger secret_group_organism_capture_iggy_visibility
after insert or delete or update of master_key, organism_id on secret_group_organism
for each row execute function capture_api_integration_iggy_secret_group_organism();

create function capture_api_integration_iggy_zone_group()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[old.group_master_key], null, array[old.sigint_zone_id], null
        );
    end if;
    if tg_op <> 'DELETE' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[new.group_master_key], null, array[new.sigint_zone_id], null
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_zone_datasource_capture_iggy_visibility
after insert or delete or update of sigint_zone_id, datasource_id, group_master_key
on sigint_zone_datasource
for each row execute function capture_api_integration_iggy_zone_group();

create function capture_api_integration_iggy_login_groups()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return new;
    end if;
    perform queue_api_integration_iggy_group_visibility_change(
        null, array[new.id], null, null
    );
    return new;
end;
$$;

create trigger login_capture_iggy_group_visibility
after update of sigint_zone_id, organism_id on login
for each row when (old.sigint_zone_id is distinct from new.sigint_zone_id
    or old.organism_id is distinct from new.organism_id)
execute function capture_api_integration_iggy_login_groups();

create function capture_api_integration_iggy_organism_group()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[old.signal_group_master_key], null, null, null
        );
    end if;
    if tg_op <> 'DELETE' then
        perform queue_api_integration_iggy_group_visibility_change(
            array[new.signal_group_master_key], null, null, null
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger organism_group_capture_iggy_visibility
after insert or update or delete on organism_group
for each row execute function capture_api_integration_iggy_organism_group();

create function capture_api_integration_iggy_network_link()
returns trigger language plpgsql as $$
declare
    network_link record;
    item_frequency text;
    item_datetime timestamp without time zone;
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'INSERT' then
        network_link := new;
    else
        network_link := old;
    end if;
    select item.freq, coalesce(item.datetime, message.timestamp, message.created_at)
    into item_frequency, item_datetime
    from sigint_inbox_item item
    join signal_message message on message.id = item.id
    where item.id = network_link.sigint_inbox_item_id;
    perform queue_api_integration_iggy_event(
        network_link.sigint_inbox_item_id,
        jsonb_build_object(
            'event_type', case when tg_op = 'INSERT'
                then 'sigint_inbox_item_network_linked'
                else 'sigint_inbox_item_network_unlinked' end,
            'sigint_network_id', network_link.sigint_network_id,
            'sigint_network_freq_ids', api_integration_iggy_network_frequency_ids(
                network_link.sigint_network_id,
                item_frequency,
                item_datetime
            ),
            'sigint_network_callsign_ids', api_integration_iggy_network_callsign_ids(
                network_link.sigint_network_id
            ),
            'sigint_callsign_ids', api_integration_iggy_network_sigint_callsign_ids(
                network_link.sigint_network_id
            )
        )
    );
    return network_link;
end;
$$;

create trigger sigint_inbox_item_network_capture_iggy_link
after insert or delete on sigint_inbox_item_network
for each row execute function capture_api_integration_iggy_network_link();

create function capture_api_integration_iggy_inbox_callsign()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' and not old.deleted
        and (tg_op = 'DELETE' or new.deleted
            or old.callsign is distinct from new.callsign
            or old.sigint_inbox_item_id is distinct from new.sigint_inbox_item_id) then
        if not exists (
            select 1 from sigint_inbox_item_callsign other
            where other.sigint_inbox_item_id = old.sigint_inbox_item_id
                and api_integration_iggy_callsign_key(other.callsign)
                    = api_integration_iggy_callsign_key(old.callsign)
                and not other.deleted
                and other.id <> old.id
        ) then
            perform queue_api_integration_iggy_event(
                old.sigint_inbox_item_id,
                jsonb_build_object(
                    'event_type', 'sigint_inbox_item_callsign_unlinked',
                    'sigint_inbox_item_callsign_id', old.id,
                    'callsign', old.callsign,
                    'sigint_callsign_ids', api_integration_iggy_callsign_ids(old.callsign)
                )
            );
        end if;
    end if;
    if tg_op <> 'DELETE' and not new.deleted
        and (tg_op = 'INSERT' or old.deleted
            or old.callsign is distinct from new.callsign
            or old.sigint_inbox_item_id is distinct from new.sigint_inbox_item_id) then
        perform queue_api_integration_iggy_event(
            new.sigint_inbox_item_id,
            jsonb_build_object(
                'event_type', 'sigint_inbox_item_callsign_linked',
                'sigint_inbox_item_callsign_id', new.id,
                'callsign', new.callsign,
                'sigint_callsign_ids', api_integration_iggy_callsign_ids(new.callsign)
            )
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_inbox_item_callsign_capture_iggy_link
after insert or update or delete on sigint_inbox_item_callsign
for each row execute function capture_api_integration_iggy_inbox_callsign();

create function capture_api_integration_iggy_catalog_callsign()
returns trigger language plpgsql as $$
declare
    affected_callsign_keys text[] := array[]::text[];
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE'
        and old.callsign is not distinct from new.callsign
        and old.deleted is not distinct from new.deleted
        and old.unit_id is not distinct from new.unit_id then
        return new;
    end if;
    if tg_op <> 'INSERT' and not old.deleted then
        affected_callsign_keys := array_append(
            affected_callsign_keys,
            api_integration_iggy_callsign_key(old.callsign)
        );
    end if;
    if tg_op <> 'DELETE' and not new.deleted then
        affected_callsign_keys := array_append(
            affected_callsign_keys,
            api_integration_iggy_callsign_key(new.callsign)
        );
    end if;
    if cardinality(affected_callsign_keys) = 0 then
        return coalesce(new, old);
    end if;
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select distinct integration.id, destination.id,
        inbox_callsign.sigint_inbox_item_id,
        jsonb_build_object('event_type', 'sigint_inbox_item_updated')
    from sigint_inbox_item_callsign inbox_callsign
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where not inbox_callsign.deleted
        and api_integration_iggy_callsign_key(inbox_callsign.callsign)
            = any(affected_callsign_keys)
        and integration.sync_enabled and integration.has_iggy_connection;
    perform queue_api_integration_iggy_network_callsign_refresh(
        affected_callsign_keys
    );
    return coalesce(new, old);
end;
$$;

create trigger sigint_callsign_capture_iggy_edit
after insert or update or delete on sigint_callsign
for each row execute function capture_api_integration_iggy_catalog_callsign();

create function capture_api_integration_iggy_inbox_settlement()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' and old.settlement_id is not null
        and (tg_op = 'DELETE' or old.settlement_id is distinct from new.settlement_id
            or old.item_id is distinct from new.item_id) then
        if not exists (
            select 1 from sigint_inbox_item_settlement other
            where other.item_id = old.item_id
                and other.settlement_id = old.settlement_id
                and other.id <> old.id
        ) then
            perform queue_api_integration_iggy_event(
                old.item_id,
                jsonb_build_object(
                    'event_type', 'sigint_inbox_item_settlement_unlinked',
                    'settlement_id', old.settlement_id
                )
            );
        end if;
    end if;
    if tg_op <> 'DELETE' and new.settlement_id is not null
        and (tg_op = 'INSERT' or old.settlement_id is distinct from new.settlement_id
            or old.item_id is distinct from new.item_id) then
        perform queue_api_integration_iggy_event(
            new.item_id,
            jsonb_build_object(
                'event_type', 'sigint_inbox_item_settlement_linked',
                'settlement_id', new.settlement_id
            )
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_inbox_item_settlement_capture_iggy_link
after insert or update or delete on sigint_inbox_item_settlement
for each row execute function capture_api_integration_iggy_inbox_settlement();

create function capture_api_integration_iggy_network_callsign()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' and not old.deleted
        and (tg_op = 'DELETE' or new.deleted
            or old.sigint_network_id is distinct from new.sigint_network_id
            or old.sigint_callsign is distinct from new.sigint_callsign
            or old.sigint_callsign_id is distinct from new.sigint_callsign_id)
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = old.sigint_network_id) then
        perform queue_api_integration_iggy_event(
            null,
            jsonb_build_object(
                'event_type', 'sigint_network_callsign_unlinked',
                'sigint_network_id', old.sigint_network_id,
                'sigint_network_callsign_id', old.id,
                'sigint_callsign_id', old.sigint_callsign_id,
                'callsign', old.sigint_callsign,
                'sigint_callsign_ids', api_integration_iggy_callsign_ids(old.sigint_callsign)
            )
        );
    end if;
    if tg_op <> 'DELETE' and not new.deleted
        and (tg_op = 'INSERT' or old.deleted
            or old.sigint_network_id is distinct from new.sigint_network_id
            or old.sigint_callsign is distinct from new.sigint_callsign
            or old.sigint_callsign_id is distinct from new.sigint_callsign_id)
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = new.sigint_network_id) then
        perform queue_api_integration_iggy_event(
            null,
            jsonb_build_object(
                'event_type', 'sigint_network_callsign_linked',
                'sigint_network_id', new.sigint_network_id,
                'sigint_network_callsign_id', new.id,
                'sigint_callsign_id', new.sigint_callsign_id,
                'callsign', new.sigint_callsign,
                'sigint_callsign_ids', api_integration_iggy_callsign_ids(new.sigint_callsign)
            )
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_network_callsign_capture_iggy_link
after insert or update or delete on sigint_network_callsign
for each row execute function capture_api_integration_iggy_network_callsign();

create function capture_api_integration_iggy_network_frequency()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op <> 'INSERT' and not old.deleted
        and (tg_op = 'DELETE' or new.deleted
            or old.network_id is distinct from new.network_id
            or old.freq is distinct from new.freq
            or old.active_from is distinct from new.active_from
            or old.active_to is distinct from new.active_to)
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = old.network_id)
        and exists (select 1 from sigint_network
            where id = old.network_id and not deleted) then
        perform queue_api_integration_iggy_event(
            null,
            jsonb_build_object(
                'event_type', 'sigint_network_frequency_unlinked',
                'sigint_network_id', old.network_id,
                'sigint_network_freq_id', old.id,
                'freq', old.freq,
                'active_from', old.active_from,
                'active_to', old.active_to
            )
        );
    end if;
    if tg_op <> 'DELETE' and not new.deleted
        and (tg_op = 'INSERT' or old.deleted
            or old.network_id is distinct from new.network_id
            or old.freq is distinct from new.freq
            or old.active_from is distinct from new.active_from
            or old.active_to is distinct from new.active_to)
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = new.network_id)
        and exists (select 1 from sigint_network
            where id = new.network_id and not deleted) then
        perform queue_api_integration_iggy_event(
            null,
            jsonb_build_object(
                'event_type', 'sigint_network_frequency_linked',
                'sigint_network_id', new.network_id,
                'sigint_network_freq_id', new.id,
                'freq', new.freq,
                'active_from', new.active_from,
                'active_to', new.active_to
            )
        );
    end if;
    return coalesce(new, old);
end;
$$;

create function capture_api_integration_iggy_network_visibility()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return new;
    end if;
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, null,
        jsonb_build_object(
            'event_type', case when new.deleted
                then 'sigint_network_frequency_unlinked'
                else 'sigint_network_frequency_linked' end,
            'sigint_network_id', new.id,
            'sigint_network_freq_id', frequency.id,
            'freq', frequency.freq,
            'active_from', frequency.active_from,
            'active_to', frequency.active_to
        )
    from sigint_network_freq frequency
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where frequency.network_id = new.id and not frequency.deleted
        and integration.sync_enabled and integration.has_iggy_connection
        and exists (select 1 from sigint_inbox_item_network
            where sigint_network_id = new.id);
    return new;
end;
$$;

create trigger sigint_network_capture_iggy_visibility
after update of deleted on sigint_network
for each row when (old.deleted is distinct from new.deleted)
execute function capture_api_integration_iggy_network_visibility();

create trigger sigint_network_freq_capture_iggy_link
after insert or update or delete on sigint_network_freq
for each row execute function capture_api_integration_iggy_network_frequency();
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
drop trigger if exists sigint_network_freq_capture_iggy_link on sigint_network_freq;
drop trigger if exists sigint_network_capture_iggy_visibility on sigint_network;
drop trigger if exists sigint_network_callsign_capture_iggy_link on sigint_network_callsign;
drop trigger if exists sigint_inbox_item_settlement_capture_iggy_link on sigint_inbox_item_settlement;
drop trigger if exists sigint_callsign_capture_iggy_edit on sigint_callsign;
drop trigger if exists sigint_inbox_item_callsign_capture_iggy_link on sigint_inbox_item_callsign;
drop trigger if exists sigint_inbox_item_network_capture_iggy_link on sigint_inbox_item_network;
drop trigger if exists sigint_inbox_item_unit_capture_iggy_edit on sigint_inbox_item_unit;
drop trigger if exists sigint_unit_capture_iggy_visibility on sigint_unit;
drop trigger if exists api_integration_capture_iggy_destination_update on api_integration;
drop trigger if exists api_integration_capture_iggy_destination_insert on api_integration;
drop trigger if exists sigint_inbox_item_tag_capture_iggy_edit on sigint_inbox_item_tag;
drop trigger if exists sigint_inbox_item_metadata_capture_iggy_edit on sigint_inbox_item_metadata;
drop trigger if exists sigint_inbox_item_point_token_capture_iggy_edit on sigint_inbox_item_point_token;
drop trigger if exists signal_message_media_capture_iggy_edit on signal_message_media;
drop trigger if exists echo_gpu_transcription_queue_capture_iggy_edit on echo_gpu_transcription_queue;
drop trigger if exists ocr_job_capture_iggy_edit on ocr_job;
drop trigger if exists media_summary_capture_iggy_edit on media_summary;
drop trigger if exists signal_message_media_conversion_job_capture_iggy_edit on signal_message_media_conversion_job;
drop trigger if exists signal_message_group_capture_iggy_edit on signal_message_group;
drop trigger if exists signal_group_aor_capture_iggy_visibility on signal_group_aor;
drop trigger if exists organism_aor_capture_iggy_visibility on organism_aor;
drop trigger if exists organism_group_capture_iggy_visibility on organism_group;
drop trigger if exists login_capture_iggy_group_visibility on login;
drop trigger if exists sigint_zone_datasource_capture_iggy_visibility on sigint_zone_datasource;
drop trigger if exists secret_group_organism_capture_iggy_visibility on secret_group_organism;
drop trigger if exists secret_group_user_capture_iggy_visibility on secret_group_user;
drop trigger if exists signal_group_capture_iggy_visibility_delete on signal_group;
drop trigger if exists signal_group_capture_iggy_visibility_update on signal_group;
drop trigger if exists sigint_important_capture_iggy_edit on sigint_important;
drop trigger if exists sigint_comment_capture_iggy_edit on sigint_comment;
drop trigger if exists intel_product_capture_iggy_edit on intel_product;
drop trigger if exists signal_message_capture_iggy_edit on signal_message;
drop trigger if exists sigint_inbox_item_capture_iggy_edit on sigint_inbox_item;
drop function if exists capture_api_integration_iggy_network_frequency();
drop function if exists capture_api_integration_iggy_network_visibility();
drop function if exists capture_api_integration_iggy_network_callsign();
drop function if exists capture_api_integration_iggy_inbox_settlement();
drop function if exists capture_api_integration_iggy_catalog_callsign();
drop function if exists capture_api_integration_iggy_inbox_callsign();
drop function if exists capture_api_integration_iggy_network_link();
drop function if exists capture_api_integration_iggy_inbox_edit();
drop function if exists capture_api_integration_iggy_related_edit();
drop function if exists capture_api_integration_iggy_media_result();
drop function if exists capture_api_integration_iggy_unit_visibility();
drop function if exists capture_api_integration_iggy_aor_assignment();
drop function if exists capture_api_integration_iggy_organism_group();
drop function if exists capture_api_integration_iggy_login_groups();
drop function if exists capture_api_integration_iggy_zone_group();
drop function if exists capture_api_integration_iggy_secret_group_organism();
drop function if exists capture_api_integration_iggy_secret_group_user();
drop function if exists capture_api_integration_iggy_signal_group_visibility();
drop function if exists capture_api_integration_iggy_destination();
drop function if exists scrub_api_integration_iggy_destination_credentials(bigint);
drop function if exists queue_api_integration_iggy_network_frequency_change(bigint, text, text, timestamp without time zone, timestamp without time zone);
drop function if exists api_integration_iggy_network_callsign_ids(bigint);
drop function if exists api_integration_iggy_network_sigint_callsign_ids(bigint);
drop function if exists queue_api_integration_iggy_network_callsign_refresh(text[]);
drop function if exists api_integration_iggy_callsign_ids(text);
drop function if exists api_integration_iggy_callsign_key(text);
drop function if exists api_integration_iggy_network_frequency_ids(bigint, text, timestamp without time zone);
drop function if exists api_integration_iggy_has_publisher();
drop function if exists queue_api_integration_iggy_group_visibility_change(text[], uuid[], bigint[], bigint[]);
drop function if exists queue_api_integration_iggy_event(bigint, jsonb);
drop table if exists api_integration_iggy_event;
drop table if exists api_integration_iggy_destination;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
