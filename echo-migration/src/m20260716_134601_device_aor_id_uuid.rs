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
                alter table device_aor alter column id drop default;

                alter table device_aor
                    alter column id type uuid
                    using lpad(to_hex(id), 32, '0')::uuid;

                alter table device_aor
                    alter column id set default
                    lpad(to_hex(nextval('device_aor_id_seq'::regclass)), 32, '0')::uuid;
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
                alter table device_aor alter column id drop default;

                alter table device_aor
                    alter column id type bigint
                    using nextval('device_aor_id_seq'::regclass);

                alter table device_aor
                    alter column id set default nextval('device_aor_id_seq'::regclass);
                "#,
            )
            .await?;
        Ok(())
    }
}
