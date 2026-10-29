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
                alter table file_content_upload
                    add column stats_epoch bigint not null default 0;

                create table device_content_stat (
                    device_id uuid not null,
                    epoch bigint not null default 1,
                    content_count bigint not null default 0,
                    content_bytes bigint not null default 0,
                    first_content_at timestamp with time zone,
                    last_content_at timestamp with time zone,
                    backfill_started_at timestamp with time zone,
                    backfilled_at timestamp with time zone,
                    updated_at timestamp with time zone not null,
                    constraint device_content_stat_pkey
                        primary key (device_id),
                    constraint device_content_stat_epoch_check
                        check (epoch >= 1),
                    constraint device_content_stat_count_check
                        check (content_count >= 0 and content_bytes >= 0),
                    constraint device_content_stat_content_at_check
                        check (
                            (content_count = 0) = (last_content_at is null)
                            and (first_content_at is null) = (last_content_at is null)
                            and (first_content_at is null or first_content_at <= last_content_at)
                        )
                );

                create table device_content_stat_extension (
                    device_id uuid not null,
                    extension text not null,
                    content_count bigint not null,
                    content_bytes bigint not null,
                    last_content_at timestamp with time zone not null,
                    constraint device_content_stat_extension_pkey
                        primary key (device_id, extension),
                    constraint device_content_stat_extension_device_fk
                        foreign key (device_id)
                        references device_content_stat (device_id)
                        on delete cascade,
                    constraint device_content_stat_extension_count_check
                        check (content_count > 0 and content_bytes >= 0)
                );

                create table device_content_stat_day (
                    device_id uuid not null,
                    day date not null,
                    extension text not null,
                    content_count bigint not null,
                    content_bytes bigint not null,
                    constraint device_content_stat_day_pkey
                        primary key (device_id, day, extension),
                    constraint device_content_stat_day_device_fk
                        foreign key (device_id)
                        references device_content_stat (device_id)
                        on delete cascade,
                    constraint device_content_stat_day_count_check
                        check (content_count > 0 and content_bytes >= 0)
                );

                create table device_tree_stat (
                    device_id uuid not null,
                    directory_count bigint not null default 0,
                    file_count bigint not null default 0,
                    rebuilt_at timestamp with time zone,
                    updated_at timestamp with time zone not null,
                    constraint device_tree_stat_pkey
                        primary key (device_id),
                    constraint device_tree_stat_count_check
                        check (directory_count >= 0 and file_count >= 0)
                );
                "#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop table device_tree_stat;
                drop table device_content_stat_day;
                drop table device_content_stat_extension;
                drop table device_content_stat;

                alter table file_content_upload
                    drop column stats_epoch;
                "#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }
}
