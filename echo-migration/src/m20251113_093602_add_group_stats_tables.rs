use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            " create table stats_group_day (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                stats_dt DATE not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

             create table stats_group_5min (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                stats_start_ts timestamp without time zone not null,
                quantity integer not null default 0,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop table stats_group_day;
            drop table stats_group_5min;
            ",
        )
        .await?;
        Ok(())
    }
}
