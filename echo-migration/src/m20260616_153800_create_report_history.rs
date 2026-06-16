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
                    create table report_history (
                        id bigserial primary key,
                        report_kind text not null,
                        requested_by text not null references login(login),
                        request jsonb not null,
                        created_at timestamp without time zone default (now() at time zone 'utc') not null,
                        status text not null default 'planned',
                        retry_count integer not null default 0,
                        planned_for_ts timestamp without time zone,
                        started_at timestamp without time zone,
                        completed_at timestamp without time zone,
                        s3_id text,
                        bgtask_id bigint references bgtask(id),
                        file_name text,
                        content_type text,
                        last_error text,
                        log jsonb not null default '[]'::jsonb,
                        legacy_log_id bigint unique,
                        legacy_report_path text,
                        constraint report_history_status_check
                            check (status in ('planned', 'in_progress', 'failed', 'done')),
                        constraint report_history_retry_count_check
                            check (retry_count >= 0 and retry_count <= 3),
                        constraint report_history_log_array_check
                            check (jsonb_typeof(log) = 'array')
                    );

                    create index idx_report_history_requested_by_created_at
                        on report_history (requested_by, created_at desc);

                    create index idx_report_history_queue_pickup
                        on report_history (report_kind, planned_for_ts, created_at, id)
                        where status = 'planned';

                    create index idx_report_history_in_progress
                        on report_history (id)
                        where status = 'in_progress';

                    create index idx_report_history_bgtask_id
                        on report_history (bgtask_id)
                        where bgtask_id is not null;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table report_history;")
            .await?;
        Ok(())
    }
}
