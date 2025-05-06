use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network add column updated_by text references login(login)",
        ).await?;
        db.execute_unprepared(
            "alter table sigint_network add column updated_at timestamp without time zone default (now() at time zone 'utc') not null",
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network drop column updated_by;",
        )
        .await?;
        db.execute_unprepared(
            "alter table sigint_network drop column updated_at;",
        )
        .await?;
        Ok(())
    }
}
