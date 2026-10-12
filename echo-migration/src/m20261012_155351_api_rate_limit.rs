use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table system_settings
    add column api_rate_limit_replenish_interval_ms integer
        check (api_rate_limit_replenish_interval_ms > 0),
    add column api_rate_limit_burst_size integer
        check (api_rate_limit_burst_size > 0),
    add constraint system_settings_api_rate_limit_capacity_check
        check (api_rate_limit_replenish_interval_ms::bigint
            * api_rate_limit_burst_size <= 9223372036854);

update system_settings
set api_rate_limit_replenish_interval_ms = 500,
    api_rate_limit_burst_size = 5
where deleted = false;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table system_settings
    drop constraint if exists system_settings_api_rate_limit_capacity_check,
    drop column if exists api_rate_limit_replenish_interval_ms,
    drop column if exists api_rate_limit_burst_size;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
