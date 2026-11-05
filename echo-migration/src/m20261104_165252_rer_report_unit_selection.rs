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
alter table sigint_unit_rer_report_metadata add column report_name text;
update sigint_unit_rer_report_metadata metadata
set report_name = coalesce(nullif(btrim(metadata.labels ->> 0), ''), nullif(btrim(unit.name), '')),
    labels = case when jsonb_array_length(metadata.labels) > 0
        then jsonb_build_array(metadata.labels ->> 0) else '[]'::jsonb end
from sigint_unit unit where unit.id = metadata.sigint_unit_id;
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
alter table sigint_unit_rer_report_metadata drop column report_name;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
