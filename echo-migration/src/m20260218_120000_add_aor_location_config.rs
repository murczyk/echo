use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table aor_location_config (
                id bigserial primary key,
                aor_id bigint not null references area_of_responsibility(id) on delete cascade,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                unique(aor_id)
            );

            create index aor_location_config_aor_id_idx on aor_location_config (aor_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table if exists aor_location_config;
            "#,
        )
        .await?;
        Ok(())
    }
}
