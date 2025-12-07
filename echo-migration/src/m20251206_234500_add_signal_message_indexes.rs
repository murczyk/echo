use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists signal_message_queue_created_at_idx
                on signal_message_queue (created_at);

            create index if not exists signal_message_dg_ts_idx
                on signal_message (datasource_group_id, timestamp);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists signal_message_queue_created_at_idx;
            drop index if exists signal_message_dg_ts_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
