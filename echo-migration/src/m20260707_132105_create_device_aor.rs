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
                create table device_aor (
                    id bigserial primary key,
                    device_id uuid not null references device(id) on delete cascade,
                    aor_id bigint not null references area_of_responsibility(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    constraint device_aor_device_aor_unique unique (device_id, aor_id)
                );

                create index device_aor_device_id_idx
                    on device_aor(device_id);

                create index device_aor_aor_id_device_id_idx
                    on device_aor(aor_id, device_id);

                insert into device_aor (device_id, aor_id)
                    select id, aor_id
                    from device
                    where aor_id is not null
                    on conflict (device_id, aor_id) do nothing;
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
                drop table if exists device_aor;
                "#,
            )
            .await?;
        Ok(())
    }
}
