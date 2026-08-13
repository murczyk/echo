use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table if exists user_settings
                add column if not exists duty_collapse_media_previews boolean;

            update user_settings
            set duty_collapse_media_previews = coalesce(duty_collapse_media_previews, true)
            where duty_collapse_media_previews is null;

            alter table if exists user_settings
                alter column duty_collapse_media_previews set default true,
                alter column duty_collapse_media_previews set not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table if exists user_settings
                drop column if exists duty_collapse_media_previews;
            "#,
        )
        .await?;
        Ok(())
    }
}
