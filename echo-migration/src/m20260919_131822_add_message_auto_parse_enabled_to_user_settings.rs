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
                add column if not exists message_auto_parse_enabled boolean;

            update user_settings
            set message_auto_parse_enabled = coalesce(message_auto_parse_enabled, false)
            where message_auto_parse_enabled is null;

            alter table if exists user_settings
                alter column message_auto_parse_enabled set default false,
                alter column message_auto_parse_enabled set not null;
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
                drop column if exists message_auto_parse_enabled;
            "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
