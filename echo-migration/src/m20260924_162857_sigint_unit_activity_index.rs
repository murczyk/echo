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
        for sql in [
            "create index concurrently if not exists sigint_inbox_item_unit_unit_created_at_item_idx on sigint_inbox_item_unit (unit_id, created_at desc, item_id);",
            "create index concurrently if not exists sigint_unit_inactive_id_idx on sigint_unit (id) where active = false and deleted = false;",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!("{}: {error}", h!()))
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            "drop index concurrently if exists sigint_unit_inactive_id_idx;",
            "drop index concurrently if exists sigint_inbox_item_unit_unit_created_at_item_idx;",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!("{}: {error}", h!()))
                })?;
        }
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
