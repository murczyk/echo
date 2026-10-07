use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!(
                "m20261006_082251_device_documents_up.sql"
            ))
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
drop trigger file_document_content_published on file_content;
drop function file_document_content_published();
drop table file_document_revision_generation, file_document_position, file_document_chunk, file_document_job;
alter table file_document drop constraint file_document_published_generation_fkey;
drop table file_document_generation, file_document, file_document_backfill;
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
