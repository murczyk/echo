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
                create table analytics_tag (
                    id uuid primary key,
                    name text not null,
                    rule_expression jsonb,
                    archived_at timestamptz,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now(),
                    constraint analytics_tag_name_not_empty_check
                        check (btrim(name) <> ''),
                    constraint analytics_tag_rule_expression_object_check
                        check (
                            rule_expression is null
                            or jsonb_typeof(rule_expression) = 'object'
                        )
                );

                create unique index analytics_tag_lower_trimmed_name_unique_idx
                    on analytics_tag(lower(btrim(name)));

                create table analytics_tag_test_file (
                    id uuid primary key,
                    tag_id uuid not null references analytics_tag(id) on delete cascade,
                    position integer not null,
                    name text not null,
                    absolute_path text not null,
                    extension text,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now(),
                    constraint analytics_tag_test_file_position_check
                        check (position >= 0),
                    constraint analytics_tag_test_file_tag_id_position_unique
                        unique (tag_id, position)
                );

                create table device_file_tag (
                    id uuid primary key,
                    file_entry_id uuid not null,
                    device_id uuid not null,
                    file_entry_created_at timestamptz not null,
                    tag_id uuid not null references analytics_tag(id) on delete cascade,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now(),
                    constraint device_file_tag_file_entry_id_tag_id_unique
                        unique (file_entry_id, tag_id),
                    constraint device_file_tag_file_entry_fk
                        foreign key (device_id, file_entry_id)
                        references file_entry(device_id, id)
                        on delete cascade
                );

                create index device_file_tag_device_tag_created_file_idx
                    on device_file_tag(
                        device_id,
                        tag_id,
                        file_entry_created_at desc,
                        file_entry_id desc
                    );

                create index device_file_tag_file_entry_id_idx
                    on device_file_tag(file_entry_id);
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
                drop table if exists device_file_tag;
                drop table if exists analytics_tag_test_file;
                drop table if exists analytics_tag;
                "#,
            )
            .await?;
        Ok(())
    }
}
