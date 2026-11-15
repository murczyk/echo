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
        // NULL means never chosen: startup keeps the sandbox off and warns.
        // media_sandbox_error is set when the startup self-check fails and
        // turns the sandbox off.
        // Touch only the active settings row to publish the column via CDC.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table system_settings
    add column media_sandbox_enabled boolean,
    add column media_sandbox_error text;

update system_settings
set media_sandbox_enabled = null,
    media_sandbox_error = null
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
    drop column if exists media_sandbox_error,
    drop column if exists media_sandbox_enabled;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
