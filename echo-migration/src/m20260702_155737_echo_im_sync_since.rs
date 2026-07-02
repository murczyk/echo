use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table system_settings
                    add column if not exists echo_im_sync_since timestamp without time zone not null default (now() at time zone 'utc');

                create index if not exists signal_message_external_id_idx
                    on signal_message (external_id)
                    where external_id is not null;

                create index if not exists signal_message_queue_internal_id_idx
                    on signal_message_queue (internal_id);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists signal_message_queue_internal_id_idx;
                drop index if exists signal_message_external_id_idx;

                alter table system_settings
                    drop column if exists echo_im_sync_since;
            "#,
        )
        .await?;
        Ok(())
    }
}
