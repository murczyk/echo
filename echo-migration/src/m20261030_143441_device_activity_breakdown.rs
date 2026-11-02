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
alter table device_settings
    add column activity_split_files_audio boolean;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table device_settings drop column activity_split_files_audio;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }
}
