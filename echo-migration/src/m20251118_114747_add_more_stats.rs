use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            delete from stats_group_5min;
            delete from stats_group_day;

            create table stats_group_aor_id_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_aor_id_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                aor_id bigint NOT NULL REFERENCES area_of_responsibility(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_aor_id_idx on stats_group_aor_id_5min (group_master_key, dt, aor_id);
            create index if not exists stats_group_day_group_master_key_dt_aor_id_idx on stats_group_aor_id_day (group_master_key, dt, aor_id);

            -------------------------------------

            create table stats_group_post_id_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                post_id bigint NOT NULL REFERENCES sigint_post(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_post_id_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                post_id bigint NOT NULL REFERENCES sigint_post(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_post_id_idx on stats_group_post_id_5min (group_master_key, dt, post_id);
            create index if not exists stats_group_day_group_master_key_dt_post_id_idx on stats_group_post_id_day (group_master_key, dt, post_id);

            -------------------------------------

            create table stats_group_sender_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                sender text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_sender_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                sender text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_sender_idx on stats_group_sender_5min (group_master_key, dt, sender);
            create index if not exists stats_group_day_group_master_key_dt_sender_idx on stats_group_sender_day (group_master_key, dt, sender);

            -------------------------------------

            create table stats_group_callsign_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                callsign text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_callsign_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                callsign text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_callsign_idx on stats_group_callsign_5min (group_master_key, dt, callsign);
            create index if not exists stats_group_day_group_master_key_dt_callsign_idx on stats_group_callsign_day (group_master_key, dt, callsign);

            -------------------------------------

            create table stats_group_location_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                location text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_location_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                location text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_location_idx on stats_group_location_5min (group_master_key, dt, location);
            create index if not exists stats_group_day_group_master_key_dt_location_idx on stats_group_location_day (group_master_key, dt, location);

            -------------------------------------

            create table stats_group_unit_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                unit text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_unit_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                unit text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_unit_idx on stats_group_unit_5min (group_master_key, dt, unit);
            create index if not exists stats_group_day_group_master_key_dt_unit_idx on stats_group_unit_day (group_master_key, dt, unit);

            -------------------------------------

            create table stats_group_tag_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                tag text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_tag_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                tag text NOT NULL,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_tag_idx on stats_group_tag_5min (group_master_key, dt, tag);
            create index if not exists stats_group_day_group_master_key_dt_tag_idx on stats_group_tag_day (group_master_key, dt, tag);

            -------------------------------------

            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_dt_aor_id_idx;
            drop index stats_group_day_group_master_key_dt_aor_id_idx;
            drop table stats_group_aor_id_day;
            drop table stats_group_aor_id_5min;

            drop index stats_group_5min_group_master_key_dt_post_id_idx;
            drop index stats_group_day_group_master_key_dt_post_id_idx;
            drop table stats_group_post_id_day;
            drop table stats_group_post_id_5min;

            drop index stats_group_5min_group_master_key_dt_sender_idx;
            drop index stats_group_day_group_master_key_dt_sender_idx;
            drop table stats_group_sender_day;
            drop table stats_group_sender_5min;

            drop index stats_group_5min_group_master_key_dt_callsign_idx;
            drop index stats_group_day_group_master_key_dt_callsign_idx;
            drop table stats_group_callsign_day;
            drop table stats_group_callsign_5min;

            drop index stats_group_5min_group_master_key_dt_location_idx;
            drop index stats_group_day_group_master_key_dt_location_idx;
            drop table stats_group_location_day;
            drop table stats_group_location_5min;

            drop index stats_group_5min_group_master_key_dt_unit_idx;
            drop index stats_group_day_group_master_key_dt_unit_idx;
            drop table stats_group_unit_day;
            drop table stats_group_unit_5min;

            drop index stats_group_5min_group_master_key_dt_tag_idx;
            drop index stats_group_day_group_master_key_dt_tag_idx;
            drop table stats_group_tag_day;
            drop table stats_group_tag_5min;
            ",
        )
        .await?;
        Ok(())
    }
}
