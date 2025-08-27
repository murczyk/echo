use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network_callsign add column unit_developing boolean not null default false;
             alter table sigint_network_callsign add column unit_id int8 references sigint_unit(id);",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network_callsign drop column unit_developing;
             alter table sigint_network_callsign drop column unit_id;",
        )
        .await?;

        Ok(())
    }
}
