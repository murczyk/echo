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
create table sigint_network_settlement (
    id bigserial primary key,
    created_at timestamp without time zone
        default (now() at time zone 'utc') not null,
    network_id bigint not null references sigint_network(id) on delete cascade,
    settlement_text text not null,
    settlement_id integer references settlement(id) on delete set null,
    is_undefined boolean,
    unique (network_id, settlement_text),
    check (is_undefined is not true or settlement_id is null)
);

create index sigint_network_settlement_pending_idx
    on sigint_network_settlement (id)
    where settlement_id is null and is_undefined is null;

create index sigint_network_settlement_settlement_network_idx
    on sigint_network_settlement (settlement_id, network_id)
    where settlement_id is not null;

create function sigint_network_settlement_requeue_deleted()
returns trigger language plpgsql as $$
begin
    new.is_undefined = null;
    return new;
end;
$$;

create trigger sigint_network_settlement_requeue_deleted
before update of settlement_id on sigint_network_settlement
for each row
when (old.settlement_id is not null and new.settlement_id is null
      and new.is_undefined is false)
execute function sigint_network_settlement_requeue_deleted();

create function reconcile_sigint_network_settlements()
returns trigger language plpgsql as $$
declare
    desired text[];
    existing text[];
begin
    if new.deleted then
        delete from sigint_network_settlement where network_id = new.id;
        return new;
    end if;
    select coalesce(array_agg(distinct name order by name), '{}'::text[])
    into desired
    from (
        select upper(translate(btrim(value), chr(39) || 'ʼ`', '’’’')) as name
        from unnest(string_to_array(new.location, '|')) as value
        where btrim(value) <> ''
    ) names;
    select coalesce(array_agg(settlement_text order by settlement_text), '{}'::text[])
    into existing from sigint_network_settlement where network_id = new.id;
    if desired = existing then
        return new;
    end if;
    delete from sigint_network_settlement
    where network_id = new.id and not (settlement_text = any(desired));
    update sigint_network_settlement set settlement_id = null, is_undefined = null
    where network_id = new.id;
    insert into sigint_network_settlement (network_id, settlement_text)
    select new.id, unnest(desired)
    on conflict (network_id, settlement_text) do nothing;
    return new;
end;
$$;

create trigger reconcile_sigint_network_settlements
after insert or update of location, deleted on sigint_network
for each row execute function reconcile_sigint_network_settlements();

insert into sigint_network_settlement (network_id, settlement_text)
select distinct network.id, upper(translate(btrim(value), chr(39) || 'ʼ`', '’’’'))
from sigint_network network
cross join lateral unnest(string_to_array(network.location, '|')) as value
where not network.deleted
    and network.active_to is null
    and (network.active_from is null or network.active_from <= now() at time zone 'utc')
    and btrim(value) <> '';
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
drop trigger reconcile_sigint_network_settlements on sigint_network;
drop function reconcile_sigint_network_settlements();
drop table sigint_network_settlement;
drop function sigint_network_settlement_requeue_deleted();
        "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
