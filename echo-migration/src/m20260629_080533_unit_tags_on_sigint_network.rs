use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table sigint_network
                    add column if not exists unit_tags jsonb not null default '[]'::jsonb;

                do $$
                begin
                    if not exists (
                        select 1
                        from pg_constraint
                        where conname = 'sigint_network_unit_tags_array_check'
                    ) then
                        alter table sigint_network
                            add constraint sigint_network_unit_tags_array_check
                            check (jsonb_typeof(unit_tags) = 'array');
                    end if;
                end
                $$;

                with tag_rows as (
                    select
                        sn.id as network_id,
                        btrim(existing_tag.tag) as tag
                    from sigint_network sn
                    cross join lateral jsonb_array_elements_text(sn.unit_tags) existing_tag(tag)
                    where btrim(existing_tag.tag) <> ''

                    union all

                    select
                        um.sigint_network_id as network_id,
                        btrim(machine_tag.tag) as tag
                    from unit_machine um
                    cross join lateral jsonb_array_elements_text(um.machine_tags) machine_tag(tag)
                    where um.deleted = false
                        and btrim(machine_tag.tag) <> ''

                    union all

                    select
                        um.sigint_network_id as network_id,
                        btrim(um.machine_id) as tag
                    from unit_machine um
                    where um.deleted = false
                        and um.machine_id is not null
                        and btrim(um.machine_id) <> ''
                ),
                deduped_tags as (
                    select distinct on (network_id, lower(tag))
                        network_id,
                        tag
                    from tag_rows
                    order by network_id, lower(tag), tag
                ),
                merged_tags as (
                    select
                        network_id,
                        jsonb_agg(tag order by lower(tag), tag) as unit_tags
                    from deduped_tags
                    group by network_id
                )
                update sigint_network sn
                    set unit_tags = merged_tags.unit_tags
                    from merged_tags
                    where sn.id = merged_tags.network_id;

                create index if not exists sigint_network_unit_tags_gin_idx
                    on sigint_network using gin(unit_tags jsonb_path_ops);

                create table if not exists sigint_inbox_item_unit_tag_queue (
                    id bigserial primary key,
                    sigint_inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint sigint_inbox_item_unit_tag_queue_item_unique
                        unique (sigint_inbox_item_id)
                );

                create index if not exists sigint_inbox_item_unit_tag_queue_pickup_idx
                    on sigint_inbox_item_unit_tag_queue(created_at, id);

                insert into sigint_inbox_item_unit_tag_queue (
                    sigint_inbox_item_id,
                    created_at
                )
                select
                    sigint_inbox_item_id,
                    min(created_at)
                from sigint_inbox_item_unit_machine_queue
                group by sigint_inbox_item_id
                on conflict (sigint_inbox_item_id) do nothing;

                insert into sigint_inbox_item_network (
                    sigint_inbox_item_id,
                    sigint_network_id
                )
                select distinct
                    link.sigint_inbox_item_id,
                    um.sigint_network_id
                from sigint_inbox_item_unit_machine link
                join unit_machine um on um.id = link.unit_machine_id
                where not exists (
                    select 1
                    from sigint_inbox_item_network existing
                    where existing.sigint_inbox_item_id = link.sigint_inbox_item_id
                        and existing.sigint_network_id = um.sigint_network_id
                );

                drop table if exists sigint_inbox_item_unit_machine_queue;
                drop table if exists sigint_inbox_item_unit_machine;
                drop table if exists unit_machine;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists unit_machine (
                    id bigserial primary key,
                    sigint_network_id bigint not null references sigint_network(id),
                    machine_id text null,
                    machine_tags jsonb not null default '[]'::jsonb,
                    deleted boolean not null default false,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                    updated_by text null references login(login),
                    constraint unit_machine_machine_tags_array_check
                        check (jsonb_typeof(machine_tags) = 'array')
                );

                create index if not exists unit_machine_sigint_network_id_idx
                    on unit_machine(sigint_network_id);

                create index if not exists unit_machine_machine_id_not_null_idx
                    on unit_machine(machine_id)
                    where machine_id is not null;

                create unique index if not exists unit_machine_machine_id_active_lower_uniq
                    on unit_machine(lower(machine_id))
                    where machine_id is not null and deleted = false;

                create index if not exists unit_machine_machine_tags_gin_idx
                    on unit_machine using gin(machine_tags jsonb_path_ops);

                create index if not exists unit_machine_deleted_idx
                    on unit_machine(deleted);

                insert into unit_machine (sigint_network_id, machine_tags)
                select id, unit_tags
                from sigint_network
                where unit_tags <> '[]'::jsonb
                on conflict do nothing;

                create table if not exists sigint_inbox_item_unit_machine (
                    id bigserial primary key,
                    sigint_inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
                    unit_machine_id bigint not null references unit_machine(id) on delete cascade,
                    match_source text not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint sigint_inbox_item_unit_machine_source_check
                        check (match_source in ('machine_id', 'machine_tag')),
                    constraint sigint_inbox_item_unit_machine_unique
                        unique (sigint_inbox_item_id, unit_machine_id)
                );

                create index if not exists sigint_inbox_item_unit_machine_item_idx
                    on sigint_inbox_item_unit_machine(sigint_inbox_item_id);

                create index if not exists sigint_inbox_item_unit_machine_machine_idx
                    on sigint_inbox_item_unit_machine(unit_machine_id);

                create index if not exists sigint_inbox_item_unit_machine_source_idx
                    on sigint_inbox_item_unit_machine(match_source);

                create table if not exists sigint_inbox_item_unit_machine_queue (
                    id bigserial primary key,
                    sigint_inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint sigint_inbox_item_unit_machine_queue_item_unique
                        unique (sigint_inbox_item_id)
                );

                create index if not exists sigint_inbox_item_unit_machine_queue_pickup_idx
                    on sigint_inbox_item_unit_machine_queue(created_at, id);

                insert into sigint_inbox_item_unit_machine_queue (
                    sigint_inbox_item_id,
                    created_at
                )
                select
                    sigint_inbox_item_id,
                    min(created_at)
                from sigint_inbox_item_unit_tag_queue
                group by sigint_inbox_item_id
                on conflict (sigint_inbox_item_id) do nothing;

                drop table if exists sigint_inbox_item_unit_tag_queue;
                drop index if exists sigint_network_unit_tags_gin_idx;
                alter table sigint_network
                    drop constraint if exists sigint_network_unit_tags_array_check;
                alter table sigint_network
                    drop column if exists unit_tags;
            "#,
        )
        .await?;
        Ok(())
    }
}
