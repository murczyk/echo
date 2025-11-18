use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            " create table stats_group_freq_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                stats_dt DATE not null,
                frequency text not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_freq_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                start_ts timestamp without time zone not null,
                frequency text not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_freq_5min_group_master_key_start_ts_freq_idx on stats_group_freq_5min (group_master_key, start_ts, frequency);
            create index if not exists stats_group_freq_day_group_master_key_stats_dt_freq_idx on stats_group_freq_day (group_master_key, stats_dt, frequency);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_freq_5min_group_master_key_start_ts_freq_idx;
            drop index stats_group_freq_day_group_master_key_stats_dt_freq_idx;
            drop table stats_group_freq_day;
            drop table stats_group_freq_5min;
            ",
        )
        .await?;
        Ok(())
    }
}
