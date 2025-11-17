use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table stats_group_5min rename stats_start_ts to start_ts;
            create index if not exists stats_group_5min_group_master_key_start_ts_idx on stats_group_5min (group_master_key, start_ts);
            create index if not exists stats_group_day_group_master_key_stats_dt_idx on stats_group_day (group_master_key, stats_dt);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_start_ts_idx;
            drop index stats_group_day_group_master_key_stats_dt_idx;
            alter table stats_group_5min rename start_ts to stats_start_ts;
            ",
        )
        .await?;
        Ok(())
    }
}
