use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            create index if not exists sigint_peleng_source_inbox_item_id_deleted_idx
                on sigint_peleng (source_inbox_item_id, deleted);

            create index if not exists stats_group_freq_5min_dt_idx
                on stats_group_freq_5min (dt);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            drop index if exists stats_group_freq_5min_dt_idx;
            drop index if exists sigint_peleng_source_inbox_item_id_deleted_idx;
            "#,
        )
        .await?;

        Ok(())
    }
}
