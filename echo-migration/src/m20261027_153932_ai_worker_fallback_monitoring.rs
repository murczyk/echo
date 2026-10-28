use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
alter table ai_callsign_settings add column worker_fallback_ai_engine_id uuid references ai_engine(id) on delete set null;
alter table ai_settlement_settings add column worker_fallback_ai_engine_id uuid references ai_engine(id) on delete set null;
alter table ai_position_settings add column worker_fallback_ai_engine_id uuid references ai_engine(id) on delete set null;

create table ai_worker_progress (
    worker text primary key check (worker in ('callsign', 'settlement', 'position')),
    last_completed_at timestamp,
    latest_processed_entry_created_at timestamp,
    last_error_at timestamp,
    last_error text
);

create index ai_callsign_worker_job_created_at_idx on ai_callsign_worker_job(created_at);
create index ai_settlement_worker_job_created_at_idx on ai_settlement_worker_job(created_at);
create index ai_position_worker_job_created_at_idx on ai_position_worker_job(created_at);
"#).await.map_err(|error| DbErr::Migration(format!("at {} line {}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index ai_position_worker_job_created_at_idx;
drop index ai_settlement_worker_job_created_at_idx;
drop index ai_callsign_worker_job_created_at_idx;
drop table ai_worker_progress;
alter table ai_position_settings drop column worker_fallback_ai_engine_id;
alter table ai_settlement_settings drop column worker_fallback_ai_engine_id;
alter table ai_callsign_settings drop column worker_fallback_ai_engine_id;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!(
                    "at {} line {}: {error}",
                    file!(),
                    line!()
                ))
            })?;
        Ok(())
    }
}
