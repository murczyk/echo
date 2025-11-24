use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
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
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
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
            ",
        )
            .await?;
        Ok(())
    }
}
