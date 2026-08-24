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
alter table sigint_unit
    add column updated_at timestamp without time zone not null
        default (now() at time zone 'utc');

create index sigint_unit_active_updated_idx
    on sigint_unit (updated_at, id)
    where active = true and deleted = false;

create table sigint_unit_change (
    id bigserial primary key,
    sigint_unit_id bigint not null references sigint_unit(id) on delete cascade,
    author_login_id uuid not null references login(id),
    kind text not null check (kind in ('unit', 'orbit_links')),
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    transaction_id bigint not null,
    old_value jsonb,
    new_value jsonb,
    unique (transaction_id, sigint_unit_id, kind)
);

create index sigint_unit_change_unit_created_idx
    on sigint_unit_change (sigint_unit_id, created_at desc, id desc);

create function sigint_unit_change_author_id()
returns uuid
language sql
stable
as $$
    select coalesce(
        nullif(current_setting('echo.sigint_unit_change_author_id', true), '')::uuid,
        (
            select id
            from login
            where login = 'system'
            limit 1
        )
    );
$$;

create function record_sigint_unit_change()
returns trigger
language plpgsql
as $$
declare
    old_json jsonb;
    new_json jsonb;
    target_sigint_unit_id bigint;
begin
    if tg_op = 'INSERT' then
        target_sigint_unit_id := new.id;
        old_json := null;
        new_json := to_jsonb(new) - 'search_tsv' - 'updated_at';
    elsif tg_op = 'DELETE' then
        target_sigint_unit_id := old.id;
        old_json := to_jsonb(old) - 'search_tsv' - 'updated_at';
        new_json := null;
    else
        target_sigint_unit_id := new.id;
        old_json := to_jsonb(old) - 'search_tsv' - 'updated_at';
        new_json := to_jsonb(new) - 'search_tsv' - 'updated_at';
    end if;

    if old_json is not distinct from new_json then
        if tg_op = 'DELETE' then
            return old;
        end if;
        return new;
    end if;

    insert into sigint_unit_change (
        sigint_unit_id,
        author_login_id,
        kind,
        transaction_id,
        old_value,
        new_value
    )
    values (
        target_sigint_unit_id,
        sigint_unit_change_author_id(),
        'unit',
        txid_current(),
        old_json,
        new_json
    )
    on conflict (transaction_id, sigint_unit_id, kind) do update
    set new_value = excluded.new_value;

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create trigger sigint_unit_record_change
after insert or update on sigint_unit
for each row execute function record_sigint_unit_change();

create function sigint_unit_orbit_links_snapshot(target_sigint_unit_id bigint)
returns jsonb
language sql
volatile
as $$
    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', link.orbit_unit_id::text,
                'name', coalesce(
                    orbit_unit.unit_name,
                    orbit_unit.unit_name_short,
                    orbit_unit.generative_unit_name_full,
                    link.orbit_unit_id::text
                )
            )
            order by link.orbit_unit_id
        ),
        '[]'::jsonb
    )
    from orbit_unit_sigint_unit link
    join orbit_unit on orbit_unit.unit_id = link.orbit_unit_id
    where link.sigint_unit_id = target_sigint_unit_id
      and link.is_suppressed = false
      and orbit_unit.deleted = false;
$$;

create function capture_sigint_unit_orbit_links_before()
returns trigger
language plpgsql
as $$
declare
    target_sigint_unit_id bigint;
    target_sigint_unit_ids bigint[];
begin
    if tg_op = 'INSERT' then
        target_sigint_unit_ids := array[new.sigint_unit_id];
    elsif tg_op = 'DELETE' then
        target_sigint_unit_ids := array[old.sigint_unit_id];
    else
        target_sigint_unit_ids := array[old.sigint_unit_id, new.sigint_unit_id];
    end if;

    for target_sigint_unit_id in
        select distinct id
        from unnest(target_sigint_unit_ids) as ids(id)
        where id is not null
          and exists (
              select 1
              from sigint_unit
              where sigint_unit.id = ids.id
          )
    loop
        insert into sigint_unit_change (
            sigint_unit_id,
            author_login_id,
            kind,
            transaction_id,
            old_value,
            new_value
        )
        values (
            target_sigint_unit_id,
            sigint_unit_change_author_id(),
            'orbit_links',
            txid_current(),
            sigint_unit_orbit_links_snapshot(target_sigint_unit_id),
            sigint_unit_orbit_links_snapshot(target_sigint_unit_id)
        )
        on conflict (transaction_id, sigint_unit_id, kind) do nothing;
    end loop;

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create function capture_sigint_unit_orbit_links_after()
returns trigger
language plpgsql
as $$
declare
    target_sigint_unit_id bigint;
    target_sigint_unit_ids bigint[];
begin
    if tg_op = 'INSERT' then
        target_sigint_unit_ids := array[new.sigint_unit_id];
    elsif tg_op = 'DELETE' then
        target_sigint_unit_ids := array[old.sigint_unit_id];
    else
        target_sigint_unit_ids := array[old.sigint_unit_id, new.sigint_unit_id];
    end if;

    for target_sigint_unit_id in
        select distinct id
        from unnest(target_sigint_unit_ids) as ids(id)
        where id is not null
    loop
        update sigint_unit_change
        set new_value = sigint_unit_orbit_links_snapshot(target_sigint_unit_id)
        where transaction_id = txid_current()
          and sigint_unit_id = target_sigint_unit_id
          and kind = 'orbit_links';

        delete from sigint_unit_change
        where transaction_id = txid_current()
          and sigint_unit_id = target_sigint_unit_id
          and kind = 'orbit_links'
          and old_value is not distinct from new_value;
    end loop;

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create trigger orbit_unit_sigint_unit_capture_change_before
before insert or update or delete on orbit_unit_sigint_unit
for each row execute function capture_sigint_unit_orbit_links_before();

create trigger orbit_unit_sigint_unit_capture_change_after
after insert or update or delete on orbit_unit_sigint_unit
for each row execute function capture_sigint_unit_orbit_links_after();
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
drop trigger if exists orbit_unit_sigint_unit_capture_change_after
    on orbit_unit_sigint_unit;
drop trigger if exists orbit_unit_sigint_unit_capture_change_before
    on orbit_unit_sigint_unit;
drop trigger if exists sigint_unit_record_change on sigint_unit;
drop function if exists capture_sigint_unit_orbit_links_after();
drop function if exists capture_sigint_unit_orbit_links_before();
drop function if exists sigint_unit_orbit_links_snapshot(bigint);
drop function if exists record_sigint_unit_change();
drop function if exists sigint_unit_change_author_id();
drop table if exists sigint_unit_change;
drop index if exists sigint_unit_active_updated_idx;
alter table sigint_unit drop column if exists updated_at;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
