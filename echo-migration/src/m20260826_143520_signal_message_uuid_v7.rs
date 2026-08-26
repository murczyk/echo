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
alter table signal_message
    add column id_uuid uuid;

alter table sigint_inbox_item
    add column id_uuid uuid;

alter table sigint_search
    add column id_uuid uuid;

alter table signal_message_group
    add column signal_message_uuid uuid;

alter table signal_message_media
    add column signal_message_uuid uuid;

alter table sigint_bookmark
    add column signal_message_uuid uuid;

alter table sigint_important
    add column signal_message_uuid uuid;

alter table sigint_comment
    add column signal_message_uuid uuid,
    add column migrated_signal_message_uuid uuid;

alter table intel_product
    add column intel_message_uuid uuid,
    add column source_message_uuid uuid;

alter table ai_callsign_worker_job
    add column sigint_inbox_item_uuid uuid;

alter table failed_inbox_unit
    add column inbox_item_uuid uuid;

alter table sigint_inbox_item_callsign
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_item_metadata
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_item_network
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_item_point_token
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_item_settlement
    add column item_uuid uuid;

alter table sigint_inbox_item_tag
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_item_unit
    add column item_uuid uuid;

alter table sigint_inbox_item_unit_tag_queue
    add column sigint_inbox_item_uuid uuid;

alter table sigint_inbox_tag_model_error
    add column sigint_inbox_item_uuid uuid;

alter table sigint_peleng
    add column source_inbox_item_uuid uuid;
                "#,
            )
            .await
            .map(|_| ())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table sigint_peleng
    drop column if exists source_inbox_item_uuid;

alter table sigint_inbox_tag_model_error
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_unit_tag_queue
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_unit
    drop column if exists item_uuid;

alter table sigint_inbox_item_tag
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_settlement
    drop column if exists item_uuid;

alter table sigint_inbox_item_point_token
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_network
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_metadata
    drop column if exists sigint_inbox_item_uuid;

alter table sigint_inbox_item_callsign
    drop column if exists sigint_inbox_item_uuid;

alter table failed_inbox_unit
    drop column if exists inbox_item_uuid;

alter table ai_callsign_worker_job
    drop column if exists sigint_inbox_item_uuid;

alter table intel_product
    drop column if exists source_message_uuid,
    drop column if exists intel_message_uuid;

alter table sigint_comment
    drop column if exists migrated_signal_message_uuid,
    drop column if exists signal_message_uuid;

alter table sigint_important
    drop column if exists signal_message_uuid;

alter table sigint_bookmark
    drop column if exists signal_message_uuid;

alter table signal_message_media
    drop column if exists signal_message_uuid;

alter table signal_message_group
    drop column if exists signal_message_uuid;

alter table sigint_search
    drop column if exists id_uuid;

alter table sigint_inbox_item
    drop column if exists id_uuid;

alter table signal_message
    drop column if exists id_uuid;
                "#,
            )
            .await
            .map(|_| ())
    }
}
