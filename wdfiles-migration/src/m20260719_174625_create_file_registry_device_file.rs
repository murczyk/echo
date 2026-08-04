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
                create table public.device_file (
                    id uuid primary key,
                    device_id uuid not null,
                    name text not null,
                    path text not null,
                    mime_type text,
                    extension text,
                    file_metadata_created_at timestamp without time zone,
                    file_metadata_modified_at timestamp without time zone,
                    created_at timestamp without time zone not null,
                    updated_at timestamp without time zone not null,
                    constraint device_file_name_not_empty_check
                        check (btrim(name) <> ''),
                    constraint device_file_path_not_empty_check
                        check (btrim(path) <> ''),
                    constraint device_file_mime_type_not_empty_check
                        check (mime_type is null or btrim(mime_type) <> ''),
                    constraint device_file_extension_not_empty_check
                        check (extension is null or btrim(extension) <> '')
                );

                create index device_file_device_id_updated_at_id_idx
                    on public.device_file(device_id, updated_at desc, id);
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
                drop table public.device_file;
                "#,
            )
            .await?;
        Ok(())
    }
}
