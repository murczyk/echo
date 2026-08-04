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
                drop index if exists device_lower_trimmed_name_unique_idx;

                alter table device
                    add column hostname text,
                    add column ssh_port integer,
                    add constraint device_hostname_not_empty_check
                        check (hostname is null or btrim(hostname) <> ''),
                    add constraint device_ssh_port_range_check
                        check (ssh_port is null or ssh_port between 1 and 65535);
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
                alter table device
                    drop constraint if exists device_ssh_port_range_check,
                    drop constraint if exists device_hostname_not_empty_check,
                    drop column if exists ssh_port,
                    drop column if exists hostname;

                create unique index device_lower_trimmed_name_unique_idx
                    on device(lower(btrim(name)));
                "#,
            )
            .await?;
        Ok(())
    }
}
