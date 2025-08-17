use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "INSERT INTO tag (label, extra, ord, title, enabled) values ('палітра', false, (SELECT COALESCE(MAX(ord), 0.0) + 1.0 FROM tag), 'Палітра', true);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DELETE FROM tag where label = 'палітра';")
            .await?;
        Ok(())
    }
}
