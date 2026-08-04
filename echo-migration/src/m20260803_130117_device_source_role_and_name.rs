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
                update device
                set name = source_label;

                alter table device
                    drop constraint device_source_label_not_empty_check,
                    drop column source_label;
                alter table device
                    drop constraint device_name_not_empty_check;
                alter table device
                    alter column name drop not null;
                alter table device
                    add constraint device_name_not_empty_check
                    check (name is null or btrim(name) <> '');

                update login
                set roles = (roles - 'DeviceAnalyst')
                    || case
                        when roles @> '["DeviceSource"]'::jsonb then '[]'::jsonb
                        else '["DeviceSource"]'::jsonb
                    end
                where roles @> '["DeviceAnalyst"]'::jsonb;

                update organism
                set roles = (roles - 'DeviceAnalyst')
                    || case
                        when roles @> '["DeviceSource"]'::jsonb then '[]'::jsonb
                        else '["DeviceSource"]'::jsonb
                    end
                where roles @> '["DeviceAnalyst"]'::jsonb;
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
                    drop constraint device_name_not_empty_check;
                alter table device
                    add constraint device_name_not_empty_check
                    check (btrim(name) <> '');
                alter table device
                    add column source_label text;

                update device
                set source_label = coalesce(name, id::text);

                alter table device
                    alter column source_label set not null;
                alter table device
                    add constraint device_source_label_not_empty_check
                    check (btrim(source_label) <> '');
                "#,
            )
            .await?;
        Ok(())
    }
}
