use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                with merged as (
                    select
                        min(id) as keep_id,
                        min(since_ts) as since_ts,
                        max(till_ts) as till_ts
                    from group_stats_recalculation_task
                    where completed_at is null
                      and started_at is null
                )
                update group_stats_recalculation_task as task
                set
                    since_ts = merged.since_ts,
                    till_ts = merged.till_ts
                from merged
                where task.id = merged.keep_id;

                delete from group_stats_recalculation_task
                where completed_at is null
                  and started_at is null
                  and id <> (
                      select min(id)
                      from group_stats_recalculation_task
                      where completed_at is null
                        and started_at is null
                  );

                create unique index group_stats_recalculation_task_pending_unique_idx
                    on group_stats_recalculation_task ((true))
                    where completed_at is null and started_at is null;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop index if exists group_stats_recalculation_task_pending_unique_idx;
                "#,
            )
            .await?;
        Ok(())
    }
}
