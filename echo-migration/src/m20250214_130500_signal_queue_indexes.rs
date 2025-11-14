use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index concurrently if not exists signal_message_queue_datasource_created_idx
                on signal_message_queue (datasource_id, created_at);

            create index concurrently if not exists signal_message_queue_attachment_message_idx
                on signal_message_queue_attachment (message_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index concurrently if exists signal_message_queue_attachment_message_idx;
            drop index concurrently if exists signal_message_queue_datasource_created_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
