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
                alter table file_sync_session
                    rename column sync_id to id;
                alter table file_sync_batch
                    rename column sync_id to id;
                alter table file_sync_item
                    rename column sync_id to id;
                alter table file_metadata_revision
                    rename column file_id to id;
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
                alter table file_metadata_revision
                    rename column id to file_id;
                alter table file_sync_item
                    rename column id to sync_id;
                alter table file_sync_batch
                    rename column id to sync_id;
                alter table file_sync_session
                    rename column id to sync_id;
                "#,
            )
            .await?;
        Ok(())
    }
}
