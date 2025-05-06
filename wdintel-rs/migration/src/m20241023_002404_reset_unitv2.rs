use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "update sigint_inbox_item set parsed_unit_v2 = false where parsed_unit_v2 = true;",
        )
            .await?;
        db.execute_unprepared(
            "update sigint_inbox_item set unit_v2 = null where unit_v2 is not null;",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let _db = manager.get_connection();
        Ok(())
    }
}
