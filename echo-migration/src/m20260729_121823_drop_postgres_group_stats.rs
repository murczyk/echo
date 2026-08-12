use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                drop table if exists stats_group_network_callsign_day;
                drop table if exists stats_group_network_freq_day;
                drop table if exists stats_group_network_day;
                drop table if exists stats_group_tag_day;
                drop table if exists stats_group_tag_5min;
                drop table if exists stats_group_unit_day;
                drop table if exists stats_group_unit_5min;
                drop table if exists stats_group_location_day;
                drop table if exists stats_group_location_5min;
                drop table if exists stats_group_callsign_day;
                drop table if exists stats_group_callsign_5min;
                drop table if exists stats_group_sender_day;
                drop table if exists stats_group_sender_5min;
                drop table if exists stats_group_post_id_day;
                drop table if exists stats_group_post_id_5min;
                drop table if exists stats_group_aor_id_day;
                drop table if exists stats_group_aor_id_5min;
                drop table if exists stats_group_freq_day;
                drop table if exists stats_group_freq_5min;
                drop table if exists stats_group_day;
                drop table if exists stats_group_5min;
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                create table stats_group_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_day (
                    id bigserial primary key,
                    dt date not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_freq_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    frequency text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_freq_day (
                    id bigserial primary key,
                    dt date not null,
                    frequency text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_aor_id_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    aor_id bigint not null references area_of_responsibility(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_aor_id_day (
                    id bigserial primary key,
                    dt date not null,
                    aor_id bigint not null references area_of_responsibility(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_post_id_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    post_id bigint not null references sigint_post(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_post_id_day (
                    id bigserial primary key,
                    dt date not null,
                    post_id bigint not null references sigint_post(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_sender_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    sender text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_sender_day (
                    id bigserial primary key,
                    dt date not null,
                    sender text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_callsign_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    callsign text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_callsign_day (
                    id bigserial primary key,
                    dt date not null,
                    callsign text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_location_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    location text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_location_day (
                    id bigserial primary key,
                    dt date not null,
                    location text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_unit_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    unit text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_unit_day (
                    id bigserial primary key,
                    dt date not null,
                    unit text not null,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_tag_5min (
                    id bigserial primary key,
                    dt timestamp without time zone not null,
                    tag_id bigint not null references tag(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
                create table stats_group_tag_day (
                    id bigserial primary key,
                    dt date not null,
                    tag_id bigint not null references tag(id) on delete cascade,
                    quantity integer not null default 0,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    signal_group_batch_id bigint not null references signal_group_batch(id) on delete cascade
                );
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

                create index stats_group_5min_dt_batch_idx on stats_group_5min (dt, signal_group_batch_id);
                create index stats_group_day_dt_batch_idx on stats_group_day (dt, signal_group_batch_id);
                create index stats_group_freq_5min_dt_batch_value_idx on stats_group_freq_5min (dt, signal_group_batch_id, frequency);
                create index stats_group_freq_day_dt_batch_value_idx on stats_group_freq_day (dt, signal_group_batch_id, frequency);
                create index stats_group_aor_id_5min_dt_batch_value_idx on stats_group_aor_id_5min (dt, signal_group_batch_id, aor_id);
                create index stats_group_aor_id_day_dt_batch_value_idx on stats_group_aor_id_day (dt, signal_group_batch_id, aor_id);
                create index stats_group_post_id_5min_dt_batch_value_idx on stats_group_post_id_5min (dt, signal_group_batch_id, post_id);
                create index stats_group_post_id_day_dt_batch_value_idx on stats_group_post_id_day (dt, signal_group_batch_id, post_id);
                create index stats_group_sender_5min_dt_batch_value_idx on stats_group_sender_5min (dt, signal_group_batch_id, sender);
                create index stats_group_sender_day_dt_batch_value_idx on stats_group_sender_day (dt, signal_group_batch_id, sender);
                create index stats_group_callsign_5min_dt_batch_value_idx on stats_group_callsign_5min (dt, signal_group_batch_id, callsign);
                create index stats_group_callsign_day_dt_batch_value_idx on stats_group_callsign_day (dt, signal_group_batch_id, callsign);
                create index stats_group_location_5min_dt_batch_value_idx on stats_group_location_5min (dt, signal_group_batch_id, location);
                create index stats_group_location_day_dt_batch_value_idx on stats_group_location_day (dt, signal_group_batch_id, location);
                create index stats_group_unit_5min_dt_batch_value_idx on stats_group_unit_5min (dt, signal_group_batch_id, unit);
                create index stats_group_unit_day_dt_batch_value_idx on stats_group_unit_day (dt, signal_group_batch_id, unit);
                create index stats_group_tag_5min_dt_batch_value_idx on stats_group_tag_5min (dt, signal_group_batch_id, tag_id);
                create index stats_group_tag_day_dt_batch_value_idx on stats_group_tag_day (dt, signal_group_batch_id, tag_id);
                create index stats_group_network_day_dt_batch_value_idx on stats_group_network_day (dt, signal_group_batch_id, network_id);
                create index stats_group_network_freq_day_dt_batch_value_idx on stats_group_network_freq_day (dt, signal_group_batch_id, network_id, frequency);
                create index stats_group_network_callsign_day_dt_batch_value_idx on stats_group_network_callsign_day (dt, signal_group_batch_id, network_id, callsign);
                ",
            )
            .await?;
        Ok(())
    }
}
