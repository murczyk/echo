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
                alter table file_entry
                    add column content_path text;
                alter table file_entry
                    add constraint file_entry_directory_content_path_null_check
                    check (kind = 'file' or content_path is null);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                alter table file_entry
                    drop constraint file_entry_directory_content_path_null_check;
                alter table file_entry
                    drop column content_path;
                "#,
            )
            .await?;
        Ok(())
    }
}
