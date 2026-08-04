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
                drop index if exists device_aor_id_idx;
                alter table device drop column if exists aor_id;
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
                    add column if not exists aor_id bigint
                        references area_of_responsibility(id) on delete set null;

                comment on column device.aor_id is
                    'Rollback-only mirror of the first device_aor row; additional smugi are not represented in this scalar column.';

                update device
                set aor_id = device_aor_first.aor_id
                from (
                    select distinct on (device_id) device_id, aor_id
                    from device_aor
                    order by device_id, id
                ) as device_aor_first
                where device.id = device_aor_first.device_id;

                create index if not exists device_aor_id_idx
                    on device(aor_id);
                "#,
            )
            .await?;
        Ok(())
    }
}
