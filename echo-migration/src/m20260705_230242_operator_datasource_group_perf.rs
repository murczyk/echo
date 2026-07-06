use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            create index if not exists datasource_group_datasource_id_id_idx
                on datasource_group (datasource_id, id);

            create index if not exists signal_message_datasource_group_id_created_at_id_idx
                on signal_message (datasource_group_id, created_at, id);

            create index if not exists stats_group_5min_dt_idx
                on stats_group_5min (dt);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            drop index if exists stats_group_5min_dt_idx;
            drop index if exists signal_message_datasource_group_id_created_at_id_idx;
            drop index if exists datasource_group_datasource_id_id_idx;
            "#,
        )
        .await?;

        Ok(())
    }
}
