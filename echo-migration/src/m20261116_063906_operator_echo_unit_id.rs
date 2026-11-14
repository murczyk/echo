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
-- SIGINT unit the sender chose (set by the Echo Operator API). Unit resolution
-- prefers it to the unit name parsed from the body. No foreign key: units are
-- soft-deleted and merged, and resolution skips a deleted one.
alter table signal_message add column if not exists echo_unit_id bigint;

-- Column-scoped UPDATE triggers don't watch echo_unit_id, and the Iggy edit
-- trigger skips rows where old is not distinct from new. One indexed row
-- change publishes the nullable column through CDC without a backfill.
update signal_message
set echo_unit_id = null
where id = (select id from signal_message order by id limit 1);
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
alter table signal_message drop column if exists echo_unit_id;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
