use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            create table stats_group_network_day (
                id bigserial primary key,
                dt date not null,
                network_id bigint not null references sigint_network(id) on delete cascade,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
            );

            create table stats_group_network_freq_day (
                id bigserial primary key,
                dt date not null,
                network_id bigint not null references sigint_network(id) on delete cascade,
                frequency text not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
            );

            create table stats_group_network_callsign_day (
                id bigserial primary key,
                dt date not null,
                network_id bigint not null references sigint_network(id) on delete cascade,
                callsign text not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
            );

            create index if not exists stats_group_network_day_dt_idx on stats_group_network_day (dt);
            create index if not exists stats_group_network_freq_day_dt_idx on stats_group_network_freq_day (dt);
            create index if not exists stats_group_network_callsign_day_dt_idx on stats_group_network_callsign_day (dt);

            create index if not exists stats_group_network_day_dt_batch_network_idx on stats_group_network_day (dt, signal_group_batch_id, network_id);
            create index if not exists stats_group_network_freq_day_dt_batch_network_freq_idx on stats_group_network_freq_day (dt, signal_group_batch_id, network_id, frequency);
            create index if not exists stats_group_network_callsign_day_dt_batch_network_callsign_idx on stats_group_network_callsign_day (dt, signal_group_batch_id, network_id, callsign);
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index if exists stats_group_network_callsign_day_dt_batch_network_callsign_idx;
            drop index if exists stats_group_network_freq_day_dt_batch_network_freq_idx;
            drop index if exists stats_group_network_day_dt_batch_network_idx;

            drop index if exists stats_group_network_callsign_day_dt_idx;
            drop index if exists stats_group_network_freq_day_dt_idx;
            drop index if exists stats_group_network_day_dt_idx;

            drop table if exists stats_group_network_callsign_day;
            drop table if exists stats_group_network_freq_day;
            drop table if exists stats_group_network_day;
            ",
        )
        .await?;
        Ok(())
    }
}
