use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_inbox_item add column coords_location text;",
        )
        .await?;
        db.execute_unprepared(
            "update sigint_inbox_item set has_coords_location_v2 = false where datetime > '2024-10-30';"
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_inbox_item drop column coords_location;",
        )
        .await?;
        Ok(())
    }
}
