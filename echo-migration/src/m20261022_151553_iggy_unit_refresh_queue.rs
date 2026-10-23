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
create table api_integration_iggy_unit_refresh (
    id bigserial primary key,
    api_integration_id bigint not null references api_integration(id) on delete cascade,
    destination_id bigint not null references api_integration_iggy_destination(id)
        deferrable initially deferred,
    sigint_unit_id bigint not null,
    stage smallint not null default 0 check (stage between 0 and 2),
    catalog_cursor bigint not null default 0,
    after_id bigint not null default 0,
    after_network_id bigint not null default 0,
    next_attempt_at timestamp without time zone not null
        default (clock_timestamp() at time zone 'utc'),
    attempts integer not null default 0,
    last_error text,
    created_at timestamp without time zone not null
        default (clock_timestamp() at time zone 'utc')
);

create index api_integration_iggy_unit_refresh_ready_idx
    on api_integration_iggy_unit_refresh (next_attempt_at, id);
create index api_integration_iggy_unit_refresh_integration_idx
    on api_integration_iggy_unit_refresh (api_integration_id, id);
create index api_integration_iggy_unit_refresh_destination_idx
    on api_integration_iggy_unit_refresh (destination_id);

drop trigger sigint_unit_capture_iggy_visibility on sigint_unit;
drop function capture_api_integration_iggy_unit_visibility();

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
    if exists (select 1 from api_integration_iggy_unit_refresh) then
        raise exception 'Drain the unit refresh queue before rolling back';
    end if;
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

drop table api_integration_iggy_unit_refresh;

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
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
