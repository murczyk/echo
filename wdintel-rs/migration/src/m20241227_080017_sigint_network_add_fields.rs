use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network add column radio_station text;",
        )
        .await?;

        db.execute_unprepared(
            "alter table sigint_network add column confirmation text;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "alter table sigint_network drop column confirmation;",
        )
        .await?;

        db.execute_unprepared(
            "alter table sigint_network drop column radio_station;",
        )
        .await?;

        Ok(())
    }
}
