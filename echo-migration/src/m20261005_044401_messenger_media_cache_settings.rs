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
    add column messenger_media_cache_enabled boolean,
    add column messenger_media_cache_retention_hours bigint,
    add column messenger_media_cache_max_size_gib bigint,
    add column messenger_media_cache_min_free_gib bigint;

update system_settings
set messenger_media_cache_enabled = false,
    messenger_media_cache_retention_hours = 24,
    messenger_media_cache_max_size_gib = 32,
    messenger_media_cache_min_free_gib = 10
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
    drop column if exists messenger_media_cache_enabled,
    drop column if exists messenger_media_cache_retention_hours,
    drop column if exists messenger_media_cache_max_size_gib,
    drop column if exists messenger_media_cache_min_free_gib;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
