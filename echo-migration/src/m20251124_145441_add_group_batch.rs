use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_dt_aor_id_idx;
            drop index stats_group_day_group_master_key_dt_aor_id_idx;
            drop index stats_group_5min_group_master_key_dt_post_id_idx;
            drop index stats_group_day_group_master_key_dt_post_id_idx;
            drop index stats_group_5min_group_master_key_dt_sender_idx;
            drop index stats_group_day_group_master_key_dt_sender_idx;
            drop index stats_group_5min_group_master_key_dt_callsign_idx;
            drop index stats_group_day_group_master_key_dt_callsign_idx;
            drop index stats_group_5min_group_master_key_dt_location_idx;
            drop index stats_group_day_group_master_key_dt_location_idx;
            drop index stats_group_5min_group_master_key_dt_unit_idx;
            drop index stats_group_day_group_master_key_dt_unit_idx;
            drop index stats_group_5min_group_master_key_dt_tag_id_idx;
            drop index stats_group_day_group_master_key_dt_tag_id_idx;

            create table signal_group_batch (
                id bigserial primary key,
                group_master_keys text not null unique,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            delete from stats_group_5min;
            delete from stats_group_day;
            delete from stats_group_aor_id_day;
            delete from stats_group_aor_id_5min;
            delete from stats_group_post_id_day;
            delete from stats_group_post_id_5min;
            delete from stats_group_sender_day;
            delete from stats_group_sender_5min;
            delete from stats_group_callsign_day;
            delete from stats_group_callsign_5min;
            delete from stats_group_location_day;
            delete from stats_group_location_5min;
            delete from stats_group_unit_day;
            delete from stats_group_unit_5min;
            delete from stats_group_tag_day;
            delete from stats_group_tag_5min;
            delete from stats_group_freq_5min;
            delete from stats_group_freq_day;

            alter table stats_group_5min drop column group_master_key;
            alter table stats_group_day drop column group_master_key;
            alter table stats_group_aor_id_day drop column group_master_key;
            alter table stats_group_aor_id_5min drop column group_master_key;
            alter table stats_group_post_id_day drop column group_master_key;
            alter table stats_group_post_id_5min drop column group_master_key;
            alter table stats_group_sender_day drop column group_master_key;
            alter table stats_group_sender_5min drop column group_master_key;
            alter table stats_group_callsign_day drop column group_master_key;
            alter table stats_group_callsign_5min drop column group_master_key;
            alter table stats_group_location_day drop column group_master_key;
            alter table stats_group_location_5min drop column group_master_key;
            alter table stats_group_unit_day drop column group_master_key;
            alter table stats_group_unit_5min drop column group_master_key;
            alter table stats_group_tag_day drop column group_master_key;
            alter table stats_group_tag_5min drop column group_master_key;
            alter table stats_group_freq_5min drop column group_master_key;
            alter table stats_group_freq_day drop column group_master_key;

            alter table stats_group_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_aor_id_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_aor_id_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_post_id_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_post_id_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_sender_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_sender_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_callsign_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_callsign_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_location_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_location_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_unit_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_unit_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_tag_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_tag_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_freq_5min add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;
            alter table stats_group_freq_day add column signal_group_batch_id bigint not null REFERENCES signal_group_batch(id) ON DELETE CASCADE;

            create index if not exists stats_group_5min_dt_signal_group_batch_id_aor_id_idx on stats_group_aor_id_5min (dt, signal_group_batch_id, aor_id);
            create index if not exists stats_group_day_dt_signal_group_batch_id_aor_id_idx on stats_group_aor_id_day (dt, signal_group_batch_id, aor_id);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_post_id_idx on stats_group_post_id_5min (dt, signal_group_batch_id, post_id);
            create index if not exists stats_group_day_dt_signal_group_batch_id_post_id_idx on stats_group_post_id_day (dt, signal_group_batch_id, post_id);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_sender_idx on stats_group_sender_5min (dt, signal_group_batch_id, sender);
            create index if not exists stats_group_day_dt_signal_group_batch_id_sender_idx on stats_group_sender_day (dt, signal_group_batch_id, sender);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_callsign_idx on stats_group_callsign_5min (dt, signal_group_batch_id, callsign);
            create index if not exists stats_group_day_dt_signal_group_batch_id_callsign_idx on stats_group_callsign_day (dt, signal_group_batch_id, callsign);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_location_idx on stats_group_location_5min (dt, signal_group_batch_id, location);
            create index if not exists stats_group_day_dt_signal_group_batch_id_location_idx on stats_group_location_day (dt, signal_group_batch_id, location);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_unit_idx on stats_group_unit_5min (dt, signal_group_batch_id, unit);
            create index if not exists stats_group_day_dt_signal_group_batch_id_unit_idx on stats_group_unit_day (dt, signal_group_batch_id, unit);
            create index if not exists stats_group_5min_dt_signal_group_batch_id_tag_id_idx on stats_group_tag_5min (dt, signal_group_batch_id, tag_id);
            create index if not exists stats_group_day_dt_signal_group_batch_id_tag_id_idx on stats_group_tag_day (dt, signal_group_batch_id, tag_id);


            create index if not exists stats_group_aor_id_5min_dt_idx on stats_group_aor_id_5min (dt);
            create index if not exists stats_group_aor_id_day_dt_idx on stats_group_aor_id_day (dt);
            create index if not exists stats_group_post_id_5min_dt_idx on stats_group_post_id_5min (dt);
            create index if not exists stats_group_post_id_day_dt_idx on stats_group_post_id_day (dt);
            create index if not exists stats_group_sender_5min_dt_idx on stats_group_sender_5min (dt);
            create index if not exists stats_group_sender_day_dt_idx on stats_group_sender_day (dt);
            create index if not exists stats_group_callsign_5min_dt_idx on stats_group_callsign_5min (dt);
            create index if not exists stats_group_callsign_day_dt_idx on stats_group_callsign_day (dt);
            create index if not exists stats_group_location_5min_dt_idx on stats_group_location_5min (dt);
            create index if not exists stats_group_location_day_dt_idx on stats_group_location_day (dt);
            create index if not exists stats_group_unit_5min_dt_idx on stats_group_unit_5min (dt);
            create index if not exists stats_group_unit_day_dt_idx on stats_group_unit_day (dt);
            create index if not exists stats_group_tag_5min_dt_idx on stats_group_tag_5min (dt);
            create index if not exists stats_group_tag_day_dt_idx on stats_group_tag_day (dt);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_aor_id_5min_dt_idx;
            drop index stats_group_aor_id_day_dt_idx;
            drop index stats_group_post_id_5min_dt_idx;
            drop index stats_group_post_id_day_dt_idx;
            drop index stats_group_sender_5min_dt_idx;
            drop index stats_group_sender_day_dt_idx;
            drop index stats_group_callsign_5min_dt_idx;
            drop index stats_group_callsign_day_dt_idx;
            drop index stats_group_location_5min_dt_idx;
            drop index stats_group_location_day_dt_idx;
            drop index stats_group_unit_5min_dt_idx;
            drop index stats_group_unit_day_dt_idx;
            drop index stats_group_tag_5min_dt_idx;
            drop index stats_group_tag_day_dt_idx;

            drop index stats_group_5min_dt_signal_group_batch_id_aor_id_idx;
            drop index stats_group_day_dt_signal_group_batch_id_aor_id_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_post_id_idx;
            drop index stats_group_day_dt_signal_group_batch_id_post_id_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_sender_idx;
            drop index stats_group_day_dt_signal_group_batch_id_sender_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_callsign_idx;
            drop index stats_group_day_dt_signal_group_batch_id_callsign_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_location_idx;
            drop index stats_group_day_dt_signal_group_batch_id_location_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_unit_idx;
            drop index stats_group_day_dt_signal_group_batch_id_unit_idx;
            drop index stats_group_5min_dt_signal_group_batch_id_tag_id_idx;
            drop index stats_group_day_dt_signal_group_batch_id_tag_id_idx;

            delete from stats_group_5min;
            delete from stats_group_day;
            delete from stats_group_aor_id_day;
            delete from stats_group_aor_id_5min;
            delete from stats_group_post_id_day;
            delete from stats_group_post_id_5min;
            delete from stats_group_sender_day;
            delete from stats_group_sender_5min;
            delete from stats_group_callsign_day;
            delete from stats_group_callsign_5min;
            delete from stats_group_location_day;
            delete from stats_group_location_5min;
            delete from stats_group_unit_day;
            delete from stats_group_unit_5min;
            delete from stats_group_tag_day;
            delete from stats_group_tag_5min;
            delete from stats_group_freq_5min;
            delete from stats_group_freq_day;

            alter table stats_group_5min drop column signal_group_batch_id;
            alter table stats_group_day drop column signal_group_batch_id;
            alter table stats_group_aor_id_day drop column signal_group_batch_id;
            alter table stats_group_aor_id_5min drop column signal_group_batch_id;
            alter table stats_group_post_id_day drop column signal_group_batch_id;
            alter table stats_group_post_id_5min drop column signal_group_batch_id;
            alter table stats_group_sender_day drop column signal_group_batch_id;
            alter table stats_group_sender_5min drop column signal_group_batch_id;
            alter table stats_group_callsign_day drop column signal_group_batch_id;
            alter table stats_group_callsign_5min drop column signal_group_batch_id;
            alter table stats_group_location_day drop column signal_group_batch_id;
            alter table stats_group_location_5min drop column signal_group_batch_id;
            alter table stats_group_unit_day drop column signal_group_batch_id;
            alter table stats_group_unit_5min drop column signal_group_batch_id;
            alter table stats_group_tag_day drop column signal_group_batch_id;
            alter table stats_group_tag_5min drop column signal_group_batch_id;
            alter table stats_group_freq_5min drop column signal_group_batch_id;
            alter table stats_group_freq_day drop column signal_group_batch_id;

            alter table stats_group_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_aor_id_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_aor_id_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_post_id_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_post_id_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_sender_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_sender_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_callsign_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_callsign_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_location_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_location_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_unit_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_unit_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_tag_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_tag_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_freq_5min add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;
            alter table stats_group_freq_day add column group_master_key text not null REFERENCES signal_group(master_key) ON DELETE CASCADE;

            drop table signal_group_batch;

            create index if not exists stats_group_5min_group_master_key_dt_aor_id_idx on stats_group_aor_id_5min (group_master_key, dt, aor_id);
            create index if not exists stats_group_day_group_master_key_dt_aor_id_idx on stats_group_aor_id_day (group_master_key, dt, aor_id);
            create index if not exists stats_group_5min_group_master_key_dt_post_id_idx on stats_group_post_id_5min (group_master_key, dt, post_id);
            create index if not exists stats_group_day_group_master_key_dt_post_id_idx on stats_group_post_id_day (group_master_key, dt, post_id);
            create index if not exists stats_group_5min_group_master_key_dt_sender_idx on stats_group_sender_5min (group_master_key, dt, sender);
            create index if not exists stats_group_day_group_master_key_dt_sender_idx on stats_group_sender_day (group_master_key, dt, sender);
            create index if not exists stats_group_5min_group_master_key_dt_callsign_idx on stats_group_callsign_5min (group_master_key, dt, callsign);
            create index if not exists stats_group_day_group_master_key_dt_callsign_idx on stats_group_callsign_day (group_master_key, dt, callsign);
            create index if not exists stats_group_5min_group_master_key_dt_location_idx on stats_group_location_5min (group_master_key, dt, location);
            create index if not exists stats_group_day_group_master_key_dt_location_idx on stats_group_location_day (group_master_key, dt, location);
            create index if not exists stats_group_5min_group_master_key_dt_unit_idx on stats_group_unit_5min (group_master_key, dt, unit);
            create index if not exists stats_group_day_group_master_key_dt_unit_idx on stats_group_unit_day (group_master_key, dt, unit);
            create index if not exists stats_group_5min_group_master_key_dt_tag_id_idx on stats_group_tag_5min (group_master_key, dt, tag_id);
            create index if not exists stats_group_day_group_master_key_dt_tag_id_idx on stats_group_tag_day (group_master_key, dt, tag_id);

            ",
        )
            .await?;
        Ok(())
    }
}
