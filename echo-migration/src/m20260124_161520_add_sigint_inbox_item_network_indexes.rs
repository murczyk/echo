use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists sigint_inbox_item_network_created_at_desc_idx
                on sigint_inbox_item_network (created_at desc);

            create index if not exists sigint_inbox_item_network_inbox_item_id_idx
                on sigint_inbox_item_network (sigint_inbox_item_id);

            create index if not exists sigint_inbox_item_network_network_id_idx
                on sigint_inbox_item_network (sigint_network_id);

            create index if not exists network_invalidation_task_pending_idx
                on network_invalidation_task (is_for_old_worker, completed_at, till_ts);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists network_invalidation_task_pending_idx;
            drop index if exists sigint_inbox_item_network_network_id_idx;
            drop index if exists sigint_inbox_item_network_inbox_item_id_idx;
            drop index if exists sigint_inbox_item_network_created_at_desc_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
