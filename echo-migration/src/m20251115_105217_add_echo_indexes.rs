use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "create index if not exists echo_attachment_message_id_idx \
             on echo_attachment (message_id);",
        )
        .await?;
        db.execute_unprepared(
            "create index if not exists echo_inbox_message_duplicate_of_idx \
             on echo_inbox_message (duplicate_of);",
        )
        .await?;
        db.execute_unprepared(
            "create index if not exists echo_message_reaction_queue_inbox_message_id_idx \
             on echo_message_reaction_queue (inbox_message_id);",
        )
        .await?;
        db.execute_unprepared(
            "create index if not exists echo_inbox_message_reply_to_inbox_message_id_idx \
             on echo_inbox_message (reply_to_inbox_message_id);",
        )
        .await?;
        db.execute_unprepared(
            "create index if not exists echo_outbox_message_instance_reply_to_inbox_message_id_idx \
             on echo_outbox_message_instance (reply_to_inbox_message_id);",
        )
        .await?;
        db.execute_unprepared(
            "create index if not exists echo_inbox_message_changed_message_id_idx \
             on echo_inbox_message_changed (message_id);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "drop index if exists echo_inbox_message_changed_message_id_idx;",
        )
        .await?;
        db.execute_unprepared(
            "drop index if exists echo_outbox_message_instance_reply_to_inbox_message_id_idx;",
        )
        .await?;
        db.execute_unprepared(
            "drop index if exists echo_inbox_message_reply_to_inbox_message_id_idx;",
        )
        .await?;
        db.execute_unprepared(
            "drop index if exists echo_message_reaction_queue_inbox_message_id_idx;",
        )
        .await?;
        db.execute_unprepared(
            "drop index if exists echo_inbox_message_duplicate_of_idx;",
        )
        .await?;
        db.execute_unprepared(
            "drop index if exists echo_attachment_message_id_idx;",
        )
        .await?;
        Ok(())
    }
}
