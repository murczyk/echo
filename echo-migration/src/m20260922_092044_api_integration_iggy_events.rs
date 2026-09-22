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
create table api_integration_iggy_event (
    id bigserial primary key,
    api_integration_id bigint not null references api_integration(id) on delete cascade,
    sigint_inbox_item_id bigint,
    payload jsonb not null,
    created_at timestamp without time zone not null default (clock_timestamp() at time zone 'utc')
);

create index api_integration_iggy_event_pending_idx
    on api_integration_iggy_event (api_integration_id, id);

create function queue_api_integration_iggy_event(item_id bigint, event_payload jsonb)
returns void language sql as $$
    insert into api_integration_iggy_event (api_integration_id, sigint_inbox_item_id, payload)
    select integration.id, item_id, event_payload
    from api_integration integration
    where integration.sync_enabled and integration.has_iggy_connection;
$$;

create function api_integration_iggy_has_publisher()
returns boolean language sql stable as $$
    select exists (
        select 1 from api_integration integration
        where integration.sync_enabled and integration.has_iggy_connection
    );
$$;

create function api_integration_iggy_network_frequency_ids(
    network_id bigint, item_freq text, item_datetime timestamp without time zone
) returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(frequency.id order by frequency.id), '[]'::jsonb)
    from sigint_network_freq frequency
    where frequency.network_id = network_id
        and frequency.freq = item_freq
        and not frequency.deleted
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
    if tg_table_name = 'signal_message' then
        if old is not distinct from new then
            return new;
        end if;
        if exists (select 1 from sigint_inbox_item where id = new.id) then
            perform queue_api_integration_iggy_event(
                new.id,
                jsonb_build_object(
                    'event_type', case when new.deleted
                        then 'sigint_inbox_item_deleted'
                        else 'sigint_inbox_item_updated' end
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
after update on sigint_inbox_item
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

create trigger sigint_inbox_item_unit_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_unit
for each row execute function capture_api_integration_iggy_related_edit('item_id');

create trigger sigint_inbox_item_tag_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_tag
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger sigint_inbox_item_metadata_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_metadata
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger sigint_inbox_item_point_token_capture_iggy_edit
after insert or update or delete on sigint_inbox_item_point_token
for each row execute function capture_api_integration_iggy_related_edit('sigint_inbox_item_id');

create trigger signal_message_media_capture_iggy_edit
after insert or update or delete on signal_message_media
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

create trigger signal_message_group_capture_iggy_edit
after insert or update or delete on signal_message_group
for each row execute function capture_api_integration_iggy_related_edit('signal_message_id');

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
            where sigint_network_id = old.network_id) then
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
            where sigint_network_id = new.network_id) then
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
drop trigger if exists sigint_network_callsign_capture_iggy_link on sigint_network_callsign;
drop trigger if exists sigint_inbox_item_settlement_capture_iggy_link on sigint_inbox_item_settlement;
drop trigger if exists sigint_inbox_item_callsign_capture_iggy_link on sigint_inbox_item_callsign;
drop trigger if exists sigint_inbox_item_network_capture_iggy_link on sigint_inbox_item_network;
drop trigger if exists sigint_inbox_item_unit_capture_iggy_edit on sigint_inbox_item_unit;
drop trigger if exists sigint_inbox_item_tag_capture_iggy_edit on sigint_inbox_item_tag;
drop trigger if exists sigint_inbox_item_metadata_capture_iggy_edit on sigint_inbox_item_metadata;
drop trigger if exists sigint_inbox_item_point_token_capture_iggy_edit on sigint_inbox_item_point_token;
drop trigger if exists signal_message_media_capture_iggy_edit on signal_message_media;
drop trigger if exists signal_message_group_capture_iggy_edit on signal_message_group;
drop trigger if exists signal_message_capture_iggy_edit on signal_message;
drop trigger if exists sigint_inbox_item_capture_iggy_edit on sigint_inbox_item;
drop function if exists capture_api_integration_iggy_network_frequency();
drop function if exists capture_api_integration_iggy_network_callsign();
drop function if exists capture_api_integration_iggy_inbox_settlement();
drop function if exists capture_api_integration_iggy_inbox_callsign();
drop function if exists capture_api_integration_iggy_network_link();
drop function if exists capture_api_integration_iggy_inbox_edit();
drop function if exists capture_api_integration_iggy_related_edit();
drop function if exists queue_api_integration_iggy_network_frequency_change(bigint, text, text, timestamp without time zone, timestamp without time zone);
drop function if exists api_integration_iggy_network_callsign_ids(bigint);
drop function if exists api_integration_iggy_network_sigint_callsign_ids(bigint);
drop function if exists api_integration_iggy_callsign_ids(text);
drop function if exists api_integration_iggy_callsign_key(text);
drop function if exists api_integration_iggy_network_frequency_ids(bigint, text, timestamp without time zone);
drop function if exists api_integration_iggy_has_publisher();
drop function if exists queue_api_integration_iggy_event(bigint, jsonb);
drop table if exists api_integration_iggy_event;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
