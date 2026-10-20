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
alter table ai_intel_report_settings
    add column fallback_ai_engine_id uuid references ai_engine(id) on delete set null,
    add column primary_timeout_secs integer check (primary_timeout_secs between 1 and 180),
    add column fallback_timeout_secs integer check (fallback_timeout_secs between 1 and 180),
    add column total_timeout_secs integer check (total_timeout_secs between 1 and 180),
    add constraint ai_intel_report_distinct_engines check (
        fallback_ai_engine_id is null or fallback_ai_engine_id <> quick_ai_engine_id
    );

create table ai_intel_report_engine_budget (
    ai_engine_id uuid primary key references ai_engine(id) on delete cascade,
    max_tokens integer not null check (max_tokens between 1 and 32768)
);
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
drop table ai_intel_report_engine_budget;

alter table ai_intel_report_settings
    drop constraint ai_intel_report_distinct_engines,
    drop column total_timeout_secs,
    drop column fallback_timeout_secs,
    drop column primary_timeout_secs,
    drop column fallback_ai_engine_id;
"#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
