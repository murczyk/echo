use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            create table if not exists group_stats_recalculation_task (
                id bigserial primary key,
                group_master_key text not null references signal_group(master_key) on delete cascade,
                since_ts timestamp without time zone not null,
                till_ts timestamp without time zone not null,
                started_at timestamp without time zone,
                completed_at timestamp without time zone,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                reason text not null
            );

            create index if not exists group_stats_recalculation_task_pending_idx
                on group_stats_recalculation_task (completed_at, started_at, created_at, id);

            create index if not exists group_stats_recalculation_task_group_pending_idx
                on group_stats_recalculation_task (group_master_key, completed_at);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            drop index if exists group_stats_recalculation_task_group_pending_idx;
            drop index if exists group_stats_recalculation_task_pending_idx;
            drop table if exists group_stats_recalculation_task;
            "#,
        )
        .await?;

        Ok(())
    }
}
