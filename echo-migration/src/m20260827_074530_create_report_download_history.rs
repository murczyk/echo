use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table report_download_history (
    id bigserial primary key,
    report_history_id bigint not null references report_history(id) on delete cascade,
    requested_by_login_id uuid not null references login(id) on delete restrict,
    requested_at timestamp without time zone default (now() at time zone 'utc') not null,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    duration_ms bigint check (duration_ms >= 0),
    successful boolean,
    constraint report_download_history_completion_check check (
        (completed_at is null and duration_ms is null and successful is null)
        or (completed_at is not null and duration_ms is not null and successful is not null)
    )
);

create index report_download_history_report_requested_idx
    on report_download_history (report_history_id, requested_at desc, id desc);

create index report_download_history_pending_idx
    on report_download_history (report_history_id, requested_by_login_id, requested_at desc, id desc)
    where completed_at is null;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists report_download_history;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
