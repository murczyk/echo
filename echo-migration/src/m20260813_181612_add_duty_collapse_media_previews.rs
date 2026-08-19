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
            alter table if exists user_settings
                add column if not exists duty_collapse_media_previews boolean;

            update user_settings
            set duty_collapse_media_previews = coalesce(duty_collapse_media_previews, false)
            where duty_collapse_media_previews is null;

            alter table if exists user_settings
                alter column duty_collapse_media_previews set default false,
                alter column duty_collapse_media_previews set not null;
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
            alter table if exists user_settings
                drop column if exists duty_collapse_media_previews;
            "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
