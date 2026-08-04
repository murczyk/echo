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
                drop table public.device_file;
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
                create table public.device_file (
                    id uuid primary key,
                    device_id uuid not null references public.device(id) on delete cascade,
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
                    on public.device_file(device_id, deleted, updated_at desc, id);
                "#,
            )
            .await?;
        Ok(())
    }
}
