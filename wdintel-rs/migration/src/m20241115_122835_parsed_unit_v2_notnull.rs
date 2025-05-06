use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                update sigint_inbox_item set parsed_unit_v2 = false where parsed_unit_v2 is null;
                alter table sigint_inbox_item alter column parsed_unit_v2 set not null;
                ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r"
                alter table sigint_inbox_item alter column parsed_unit_v2 drop not null;
                "
        ).await?;
        Ok(())
    }
}
