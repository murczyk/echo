use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_start_ts_idx;
            drop index stats_group_day_group_master_key_stats_dt_idx;
            drop index stats_group_freq_5min_group_master_key_start_ts_freq_idx;
            drop index stats_group_freq_day_group_master_key_stats_dt_freq_idx;

            alter table stats_group_5min rename start_ts to dt;
            alter table stats_group_freq_5min rename start_ts to dt;
            alter table stats_group_day rename stats_dt to dt;
            alter table stats_group_freq_day rename stats_dt to dt;

            create index if not exists stats_group_5min_group_master_key_dt_idx on stats_group_5min (group_master_key, dt);
            create index if not exists stats_group_day_group_master_key_dt_idx on stats_group_day (group_master_key, dt);
            create index if not exists stats_group_freq_5min_group_master_key_dt_freq_idx on stats_group_freq_5min (group_master_key, dt, frequency);
            create index if not exists stats_group_freq_day_group_master_key_dt_freq_idx on stats_group_freq_day (group_master_key, dt, frequency);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_dt_idx;
            drop index stats_group_day_group_master_key_dt_idx;
            drop index stats_group_freq_5min_group_master_key_dt_freq_idx;
            drop index stats_group_freq_day_group_master_key_dt_freq_idx;

            alter table stats_group_5min rename dt to start_ts;
            alter table stats_group_freq_5min rename dt to start_ts;
            alter table stats_group_day rename dt to stats_dt;
            alter table stats_group_freq_day rename dt to stats_dt;

            create index if not exists stats_group_5min_group_master_key_start_ts_idx on stats_group_5min (group_master_key, start_ts);
            create index if not exists stats_group_day_group_master_key_stats_dt_idx on stats_group_day (group_master_key, stats_dt);
            create index if not exists stats_group_freq_5min_group_master_key_start_ts_freq_idx on stats_group_freq_5min (group_master_key, start_ts, frequency);
            create index if not exists stats_group_freq_day_group_master_key_stats_dt_freq_idx on stats_group_freq_day (group_master_key, stats_dt, frequency);
            ",
        )
            .await?;
        Ok(())
    }
}
