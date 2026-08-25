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
            do $$ begin
                create type user_settings_message_text_preview_lines as enum ('twenty', 'forty', 'off');
            exception when duplicate_object then null;
            end $$;

            alter table if exists user_settings
                add column if not exists message_text_preview_lines user_settings_message_text_preview_lines;

            update user_settings
            set message_text_preview_lines = 'twenty'
            where message_text_preview_lines is null;

            alter table if exists user_settings
                alter column message_text_preview_lines set default 'twenty',
                alter column message_text_preview_lines set not null;
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
                drop column if exists message_text_preview_lines;
            drop type if exists user_settings_message_text_preview_lines;
            "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
