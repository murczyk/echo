use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                alter table system_settings
                    add column if not exists support_non_rer_interceptions boolean not null default false;

                update system_settings
                    set support_non_rer_interceptions = false
                    where support_non_rer_interceptions is null;

                alter table signal_group
                    add column if not exists is_rer boolean not null default true;

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
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop table if exists sigint_inbox_item_unit_machine_queue;
                drop table if exists sigint_inbox_item_unit_machine;
                drop table if exists unit_machine;
                alter table signal_group drop column if exists is_rer;
                alter table system_settings drop column if exists support_non_rer_interceptions;
                "#,
            )
            .await?;
        Ok(())
    }
}
