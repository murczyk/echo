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
                "create index concurrently if not exists \
                    signal_message_group_null_group_datasource_idx \
                    on signal_message_group (datasource_group_id, signal_message_id) \
                    where group_master_key is null;",
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"create function queue_api_integration_iggy_aor_changes(changed_item_ids bigint[])
returns void language plpgsql as $$
begin
    if changed_item_ids is null or cardinality(changed_item_ids) = 0 then
        return;
    end if;
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, changed_item.id,
        jsonb_build_object(
            'event_type', 'sigint_inbox_item_aors_changed'
        )
    from (
        select distinct unnest(changed_item_ids) as id
    ) changed_item
    join sigint_inbox_item item on item.id = changed_item.id
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection;
end;
$$;

create function queue_api_integration_iggy_bulk_aor_changes(
    target_group_master_keys text[],
    target_network_ids bigint[],
    target_datasource_group_ids bigint[]
) returns void language plpgsql as $$
begin
    if coalesce(cardinality(target_group_master_keys), 0)
        + coalesce(cardinality(target_network_ids), 0)
        + coalesce(cardinality(target_datasource_group_ids), 0) = 0 then
        return;
    end if;
    perform 1 from api_integration integration
    order by integration.id for share;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select integration.id, destination.id, changed_item.id,
        jsonb_build_object(
            'event_type', 'sigint_inbox_item_aors_changed'
        )
    from (
        select distinct candidate.id
        from (
            select message_group.signal_message_id as id, true as group_scoped
            from signal_message_group message_group
            where target_group_master_keys is not null
                and message_group.group_master_key
                    = any(target_group_master_keys)

            union all

            select message_group.signal_message_id as id,
                true as group_scoped
            from datasource_group
            join signal_message_group message_group
                on message_group.datasource_group_id = datasource_group.id
            where target_group_master_keys is not null
                and datasource_group.group_master_key
                    = any(target_group_master_keys)
                and message_group.group_master_key is null

            union all

            select message.id, true as group_scoped
            from datasource_group
            join signal_message message
                on message.datasource_group_id = datasource_group.id
            where target_group_master_keys is not null
                and datasource_group.group_master_key
                    = any(target_group_master_keys)
                and not exists (
                    select 1 from signal_message_group message_group
                    where message_group.signal_message_id = message.id
                )

            union all

            select inbox_network.sigint_inbox_item_id as id,
                false as group_scoped
            from sigint_inbox_item_network inbox_network
            where target_network_ids is not null
                and inbox_network.sigint_network_id = any(target_network_ids)

            union all

            select message_group.signal_message_id as id,
                true as group_scoped
            from signal_message_group message_group
            where target_datasource_group_ids is not null
                and message_group.datasource_group_id
                    = any(target_datasource_group_ids)
                and message_group.group_master_key is null

            union all

            select message.id, true as group_scoped
            from signal_message message
            where target_datasource_group_ids is not null
                and message.datasource_group_id
                    = any(target_datasource_group_ids)
                and not exists (
                    select 1 from signal_message_group message_group
                    where message_group.signal_message_id = message.id
                )
        ) candidate
        where not candidate.group_scoped
            or not exists (
                select 1 from sigint_inbox_item_network inbox_network
                where inbox_network.sigint_inbox_item_id = candidate.id
            )
    ) changed_item
    join sigint_inbox_item item on item.id = changed_item.id
    cross join api_integration integration
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection;
end;
$$;

create function capture_api_integration_iggy_message_group_aors()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE'
        and old.signal_message_id is not distinct from new.signal_message_id then
        if (old.group_master_key is distinct from new.group_master_key
                or old.datasource_group_id is distinct from new.datasource_group_id)
            and not exists (
                select 1 from sigint_inbox_item_network
                where sigint_inbox_item_id = new.signal_message_id
            ) then
            perform queue_api_integration_iggy_aor_changes(
                array[new.signal_message_id]
            );
        end if;
        return new;
    end if;
    if tg_op <> 'INSERT'
        and (tg_op = 'DELETE'
            or old.signal_message_id is distinct from new.signal_message_id)
        and not exists (
            select 1 from sigint_inbox_item_network
            where sigint_inbox_item_id = old.signal_message_id
        ) then
        perform queue_api_integration_iggy_aor_changes(
            array[old.signal_message_id]
        );
    end if;
    if tg_op <> 'DELETE'
        and (tg_op = 'INSERT'
            or old.signal_message_id is distinct from new.signal_message_id)
        and not exists (
            select 1 from sigint_inbox_item_network
            where sigint_inbox_item_id = new.signal_message_id
        ) then
        perform queue_api_integration_iggy_aor_changes(
            array[new.signal_message_id]
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger signal_message_group_capture_iggy_edit_then_aors
after insert or update of signal_message_id, group_master_key, datasource_group_id
    or delete on signal_message_group
for each row execute function capture_api_integration_iggy_message_group_aors();

create function capture_api_integration_iggy_inbox_network_aors()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE'
        and old.sigint_inbox_item_id is not distinct from new.sigint_inbox_item_id then
        if old.sigint_network_id is distinct from new.sigint_network_id then
            perform queue_api_integration_iggy_aor_changes(
                array[new.sigint_inbox_item_id]
            );
        end if;
        return new;
    end if;
    if tg_op <> 'INSERT'
        and (tg_op = 'DELETE'
            or old.sigint_inbox_item_id is distinct from new.sigint_inbox_item_id) then
        perform queue_api_integration_iggy_aor_changes(
            array[old.sigint_inbox_item_id]
        );
    end if;
    if tg_op <> 'DELETE'
        and (tg_op = 'INSERT'
            or old.sigint_inbox_item_id is distinct from new.sigint_inbox_item_id) then
        perform queue_api_integration_iggy_aor_changes(
            array[new.sigint_inbox_item_id]
        );
    end if;
    return coalesce(new, old);
end;
$$;

create trigger sigint_inbox_item_network_capture_iggy_link_then_aors
after insert or update of sigint_inbox_item_id, sigint_network_id
    or delete on sigint_inbox_item_network
for each row execute function capture_api_integration_iggy_inbox_network_aors();

create function capture_api_integration_iggy_group_aors()
returns trigger language plpgsql as $$
declare
    target_group_master_keys text[];
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    target_group_master_keys := case tg_op
        when 'INSERT' then array[new.master_key]
        when 'DELETE' then array[old.master_key]
        else array[old.master_key, new.master_key]
    end;
    if tg_op = 'UPDATE'
        and old.master_key is not distinct from new.master_key
        and old.aor_id is not distinct from new.aor_id then
        return new;
    end if;
    perform queue_api_integration_iggy_bulk_aor_changes(
        target_group_master_keys, null, null
    );
    return coalesce(new, old);
end;
$$;

create trigger signal_group_aor_capture_iggy_visibility_then_aors
after insert or update of master_key, aor_id or delete on signal_group_aor
for each row execute function capture_api_integration_iggy_group_aors();

create function capture_api_integration_iggy_network_aors()
returns trigger language plpgsql as $$
declare
    target_network_ids bigint[];
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    target_network_ids := case tg_op
        when 'INSERT' then array[new.network_id]
        when 'DELETE' then array[old.network_id]
        else array[old.network_id, new.network_id]
    end;
    if tg_op = 'UPDATE'
        and old.network_id is not distinct from new.network_id
        and old.aor_id is not distinct from new.aor_id then
        return new;
    end if;
    perform queue_api_integration_iggy_bulk_aor_changes(
        null, target_network_ids, null
    );
    return coalesce(new, old);
end;
$$;

create trigger sigint_network_aor_capture_iggy_aors
after insert or update of network_id, aor_id or delete on sigint_network_aor
for each row execute function capture_api_integration_iggy_network_aors();

create function capture_api_integration_iggy_aor_state()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return new;
    end if;
    perform queue_api_integration_iggy_bulk_aor_changes(
        array(
            select distinct master_key from signal_group_aor
            where aor_id = new.id
        ),
        array(
            select distinct network_id from sigint_network_aor
            where aor_id = new.id
        ),
        null
    );
    return new;
end;
$$;

create trigger area_of_responsibility_capture_iggy_aors
after update of deleted on area_of_responsibility
for each row when (old.deleted is distinct from new.deleted)
execute function capture_api_integration_iggy_aor_state();

create function capture_api_integration_iggy_legacy_message_aors()
returns trigger language plpgsql as $$
begin
    if old.datasource_group_id is not distinct from new.datasource_group_id
        or not api_integration_iggy_has_publisher()
        or not exists (select 1 from sigint_inbox_item where id = new.id)
        or exists (
            select 1 from sigint_inbox_item_network
            where sigint_inbox_item_id = new.id
        )
        or exists (
            select 1 from signal_message_group
            where signal_message_id = new.id
        ) then
        return new;
    end if;
    perform queue_api_integration_iggy_aor_changes(array[new.id]);
    return new;
end;
$$;

create trigger signal_message_capture_iggy_legacy_aors
after update of datasource_group_id on signal_message
for each row execute function capture_api_integration_iggy_legacy_message_aors();

create function capture_api_integration_iggy_datasource_group_aors()
returns trigger language plpgsql as $$
begin
    if old.group_master_key is not distinct from new.group_master_key
        or not api_integration_iggy_has_publisher() then
        return new;
    end if;
    perform queue_api_integration_iggy_bulk_aor_changes(
        null, null, array[new.id]
    );
    return new;
end;
$$;

create trigger datasource_group_capture_iggy_aors
after update of group_master_key on datasource_group
for each row execute function capture_api_integration_iggy_datasource_group_aors();
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
drop trigger if exists area_of_responsibility_capture_iggy_aors
    on area_of_responsibility;
drop trigger if exists sigint_network_aor_capture_iggy_aors on sigint_network_aor;
drop trigger if exists signal_group_aor_capture_iggy_visibility_then_aors
    on signal_group_aor;
drop trigger if exists sigint_inbox_item_network_capture_iggy_link_then_aors
    on sigint_inbox_item_network;
drop trigger if exists signal_message_group_capture_iggy_edit_then_aors
    on signal_message_group;
drop trigger if exists signal_message_capture_iggy_legacy_aors on signal_message;
drop trigger if exists datasource_group_capture_iggy_aors on datasource_group;
drop function if exists capture_api_integration_iggy_datasource_group_aors();
drop function if exists capture_api_integration_iggy_legacy_message_aors();
drop function if exists capture_api_integration_iggy_aor_state();
drop function if exists capture_api_integration_iggy_network_aors();
drop function if exists capture_api_integration_iggy_group_aors();
drop function if exists capture_api_integration_iggy_inbox_network_aors();
drop function if exists capture_api_integration_iggy_message_group_aors();
drop function if exists queue_api_integration_iggy_bulk_aor_changes(
    text[], bigint[], bigint[]
);
drop function if exists queue_api_integration_iggy_aor_changes(bigint[]);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        manager
            .get_connection()
            .execute_unprepared(
                "drop index concurrently if exists \
                    signal_message_group_null_group_datasource_idx;",
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
