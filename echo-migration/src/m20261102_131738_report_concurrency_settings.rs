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
alter table system_settings
    add column report_global_concurrency integer
        check (report_global_concurrency > 0),
    add column report_kind_concurrency integer
        check (report_kind_concurrency > 0),
    add column report_etalonka_concurrency integer
        check (report_etalonka_concurrency > 0);

update system_settings
set report_global_concurrency = 4,
    report_kind_concurrency = 1,
    report_etalonka_concurrency = 2
where deleted = false;
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
alter table system_settings
    drop column if exists report_global_concurrency,
    drop column if exists report_kind_concurrency,
    drop column if exists report_etalonka_concurrency;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
