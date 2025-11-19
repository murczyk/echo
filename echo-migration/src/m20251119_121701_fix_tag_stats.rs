use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_dt_tag_idx;
            drop index stats_group_day_group_master_key_dt_tag_idx;
            drop table stats_group_tag_day;
            drop table stats_group_tag_5min;

            create table stats_group_tag_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt DATE not null,
                tag_id bigint NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_tag_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                dt timestamp without time zone not null,
                tag_id bigint NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index if not exists stats_group_5min_group_master_key_dt_tag_id_idx on stats_group_tag_5min (group_master_key, dt, tag_id);
            create index if not exists stats_group_day_group_master_key_dt_tag_id_idx on stats_group_tag_day (group_master_key, dt, tag_id);
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop index stats_group_5min_group_master_key_dt_tag_id_idx;
            drop index stats_group_day_group_master_key_dt_tag_id_idx;
            drop table stats_group_tag_day;
            drop table stats_group_tag_5min;


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
            ",
        )
            .await?;
        Ok(())
    }
}
