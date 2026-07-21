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
                create index if not exists sigint_network_unit_network_unit_idx
                    on sigint_network_unit (network_id, unit_id);
                create index if not exists sigint_unit_name_idx
                    on sigint_unit (name);
                create index if not exists sigint_inbox_item_tag_item_tag_confident_idx
                    on sigint_inbox_item_tag (sigint_inbox_item_id, tag_id)
                    where confidence >= 0.7;

                alter table sigint_inbox_item set (
                    autovacuum_analyze_scale_factor = 0.01,
                    autovacuum_analyze_threshold = 10000
                );
                alter table sigint_inbox_item_tag set (
                    autovacuum_analyze_scale_factor = 0.01,
                    autovacuum_analyze_threshold = 10000
                );
                alter table signal_message set (
                    autovacuum_analyze_scale_factor = 0.01,
                    autovacuum_analyze_threshold = 10000
                );
                alter table signal_message_group set (
                    autovacuum_analyze_scale_factor = 0.01,
                    autovacuum_analyze_threshold = 10000
                );
                alter table sigint_inbox_item_network set (
                    autovacuum_analyze_scale_factor = 0.01,
                    autovacuum_analyze_threshold = 1000
                );
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
                alter table sigint_inbox_item reset (
                    autovacuum_analyze_scale_factor,
                    autovacuum_analyze_threshold
                );
                alter table sigint_inbox_item_tag reset (
                    autovacuum_analyze_scale_factor,
                    autovacuum_analyze_threshold
                );
                alter table signal_message reset (
                    autovacuum_analyze_scale_factor,
                    autovacuum_analyze_threshold
                );
                alter table signal_message_group reset (
                    autovacuum_analyze_scale_factor,
                    autovacuum_analyze_threshold
                );
                alter table sigint_inbox_item_network reset (
                    autovacuum_analyze_scale_factor,
                    autovacuum_analyze_threshold
                );

                drop index if exists sigint_inbox_item_tag_item_tag_confident_idx;
                drop index if exists sigint_unit_name_idx;
                drop index if exists sigint_network_unit_network_unit_idx;
                "#,
            )
            .await?;
        Ok(())
    }
}
