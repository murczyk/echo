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
        // Null means "never set": the application imports the legacy
        // config.toml values into the active row at startup. The update
        // keeps it null; it only gives PeerDB the row change it needs to
        // publish the new columns to analytics.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table system_settings
    add column signoz_metrics_enabled boolean,
    add column signoz_metrics_endpoint text;

update system_settings
set signoz_metrics_enabled = null
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
    drop column if exists signoz_metrics_enabled,
    drop column if exists signoz_metrics_endpoint;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
