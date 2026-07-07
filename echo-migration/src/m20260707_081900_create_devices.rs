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
                create table device (
                    id uuid primary key,
                    name text not null,
                    created_by text not null references login(login),
                    aor_id bigint references area_of_responsibility(id) on delete set null,
                    unit_id bigint references sigint_unit(id) on delete set null,
                    custom_fields jsonb not null default '[]'::jsonb,
                    external_url text,
                    deleted boolean not null default false,
                    deleted_at timestamp without time zone,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint device_name_not_empty_check
                        check (btrim(name) <> ''),
                    constraint device_custom_fields_array_check
                        check (jsonb_typeof(custom_fields) = 'array'),
                    constraint device_external_url_not_empty_check
                        check (external_url is null or btrim(external_url) <> ''),
                    constraint device_deleted_deleted_at_check
                        check (deleted = (deleted_at is not null))
                );

                create unique index device_lower_trimmed_name_unique_idx
                    on device(lower(btrim(name)));

                create index device_deleted_updated_at_id_idx
                    on device(deleted, updated_at desc, id);

                create index device_aor_id_idx
                    on device(aor_id);

                create index device_unit_id_idx
                    on device(unit_id);

                create index device_created_by_idx
                    on device(created_by);

                create table device_file (
                    id uuid primary key,
                    device_id uuid not null references device(id) on delete cascade,
                    original_name text,
                    original_absolute_path text,
                    original_created_at timestamp without time zone,
                    original_modified_at timestamp without time zone,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                    deleted boolean not null default false,
                    deleted_at timestamp without time zone,
                    constraint device_file_original_name_not_empty_check
                        check (original_name is null or btrim(original_name) <> ''),
                    constraint device_file_original_absolute_path_not_empty_check
                        check (original_absolute_path is null or btrim(original_absolute_path) <> ''),
                    constraint device_file_name_or_path_check
                        check (original_name is not null or original_absolute_path is not null),
                    constraint device_file_deleted_deleted_at_check
                        check (deleted = (deleted_at is not null))
                );

                create index device_file_device_id_deleted_updated_at_id_idx
                    on device_file(device_id, deleted, updated_at desc, id);
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
                drop table if exists device_file;
                drop table if exists device;
                "#,
            )
            .await?;
        Ok(())
    }
}
