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
create table api_integration_iggy_group_refresh (
    id bigserial primary key,
    api_integration_id bigint not null references api_integration(id) on delete cascade,
    destination_id bigint not null references api_integration_iggy_destination(id)
        deferrable initially deferred,
    group_master_key text,
    after_message_id bigint not null default 0,
    through_message_id bigint not null,
    through_membership_id bigint not null,
    next_attempt_at timestamp without time zone not null
        default (clock_timestamp() at time zone 'utc'),
    attempts integer not null default 0,
    last_error text,
    created_at timestamp without time zone not null
        default (clock_timestamp() at time zone 'utc')
);

create index api_integration_iggy_group_refresh_ready_idx
    on api_integration_iggy_group_refresh (next_attempt_at, id);
create index api_integration_iggy_group_refresh_integration_idx
    on api_integration_iggy_group_refresh (api_integration_id, id);
create index api_integration_iggy_group_refresh_destination_idx
    on api_integration_iggy_group_refresh (destination_id);

create or replace function queue_api_integration_iggy_group_visibility_change(
    target_group_master_keys text[], target_login_ids uuid[],
    target_zone_ids bigint[], target_organism_ids bigint[]
) returns void language plpgsql as $$
declare
    last_message_id bigint;
    last_membership_id bigint;
begin
    perform 1 from api_integration integration
    order by integration.id for share;
    select coalesce(max(id), 0) into last_message_id from signal_message;
    select coalesce(max(id), 0) into last_membership_id
    from signal_message_group;
    insert into api_integration_iggy_group_refresh (
        api_integration_id, destination_id, group_master_key,
        through_message_id, through_membership_id
    )
    select integration.id, destination.id, target_group.master_key,
        last_message_id, last_membership_id
    from api_integration integration
    join login api_user on api_user.id = integration.api_user_login_id
    cross join unnest(
        coalesce(target_group_master_keys, array[null::text])
    ) as target_group(master_key)
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

create function queue_api_integration_iggy_deleted_group_visibility_change(
    target_group_master_key text
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
    join signal_message_group message_group
        on message_group.group_master_key = target_group_master_key
    join sigint_inbox_item item on item.id = message_group.signal_message_id
    left join lateral (
        select id from api_integration_iggy_destination
        where api_integration_id = integration.id
        order by id desc limit 1
    ) destination on true
    where integration.sync_enabled and integration.has_iggy_connection;
end;
$$;

create function capture_api_integration_iggy_group_refresh_removal()
returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE'
        and old.signal_message_id = new.signal_message_id
        and old.group_master_key is not distinct from new.group_master_key then
        return new;
    end if;
    insert into api_integration_iggy_event (
        api_integration_id, destination_id, sigint_inbox_item_id, payload
    )
    select distinct job.api_integration_id, job.destination_id, item.id,
        jsonb_build_object(
            'event_type', 'sigint_inbox_item_visibility_changed'
        )
    from api_integration_iggy_group_refresh job
    join sigint_inbox_item item on item.id = old.signal_message_id
    where (job.group_master_key = old.group_master_key
            or (job.group_master_key is null
                and old.group_master_key is not null))
        and job.after_message_id < old.signal_message_id
        and old.id <= job.through_membership_id;
    return coalesce(new, old);
end;
$$;

create trigger signal_message_group_capture_iggy_group_refresh
after update of signal_message_id, group_master_key or delete on signal_message_group
for each row execute function capture_api_integration_iggy_group_refresh_removal();

create or replace function capture_api_integration_iggy_signal_group_visibility()
returns trigger language plpgsql as $$
begin
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
        perform queue_api_integration_iggy_deleted_group_visibility_change(
            old.master_key
        );
    else
        perform queue_api_integration_iggy_group_visibility_change(
            array[old.master_key], null, null, null
        );
    end if;
    return coalesce(new, old);
end;
$$;

create or replace function scrub_api_integration_iggy_destination_credentials(integration_id bigint)
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
        and not exists (
            select 1 from api_integration_iggy_unit_refresh job
            where job.destination_id = destination.id
        )
        and not exists (
            select 1 from api_integration_iggy_group_refresh job
            where job.destination_id = destination.id
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
do $$
begin
    if exists (select 1 from api_integration_iggy_group_refresh) then
        raise exception 'Drain the group refresh queue before rolling back';
    end if;
end;
$$;

drop trigger signal_message_group_capture_iggy_group_refresh on signal_message_group;
drop function capture_api_integration_iggy_group_refresh_removal();

create or replace function scrub_api_integration_iggy_destination_credentials(integration_id bigint)
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
        and not exists (
            select 1 from api_integration_iggy_unit_refresh job
            where job.destination_id = destination.id
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

create or replace function capture_api_integration_iggy_signal_group_visibility()
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

drop function queue_api_integration_iggy_deleted_group_visibility_change(text);

create or replace function queue_api_integration_iggy_group_visibility_change(
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

drop table api_integration_iggy_group_refresh;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
