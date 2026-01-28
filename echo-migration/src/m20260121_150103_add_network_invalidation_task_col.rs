use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            ALTER TABLE network_invalidation_task ADD COLUMN sigint_network_id bigint REFERENCES sigint_network(id) ON DELETE set null;
            ALTER TABLE network_invalidation_task ADD COLUMN started_at timestamp without time zone;
            ALTER TABLE network_invalidation_task DROP COLUMN IF EXISTS sigint_inbox_item_id;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            ALTER TABLE network_invalidation_task ADD COLUMN sigint_inbox_item_id bigint REFERENCES sigint_inbox_item(id) ON DELETE set null;
            ALTER TABLE network_invalidation_task DROP COLUMN IF EXISTS sigint_network_id;
            ALTER TABLE network_invalidation_task DROP COLUMN IF EXISTS started_at;
            ",
        )
            .await?;
        Ok(())
    }
}
