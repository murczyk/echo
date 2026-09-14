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
            "create index concurrently if not exists sigint_callsign_unit_id_id_idx on sigint_callsign (unit_id, id);",
            "create index concurrently if not exists sigint_signal_unit_id_id_idx on sigint_signal (unit, id);",
            "create index concurrently if not exists sigint_network_unit_unit_id_id_idx on sigint_network_unit (unit_id, id);",
            "create index concurrently if not exists sigint_network_callsign_unit_id_id_idx on sigint_network_callsign (unit_id, id);",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            "drop index concurrently if exists sigint_network_callsign_unit_id_id_idx;",
            "drop index concurrently if exists sigint_network_unit_unit_id_id_idx;",
            "drop index concurrently if exists sigint_signal_unit_id_id_idx;",
            "drop index concurrently if exists sigint_callsign_unit_id_id_idx;",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        }
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
