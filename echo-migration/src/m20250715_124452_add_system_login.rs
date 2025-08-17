use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"INSERT INTO login
            (login,roles, sigint_zone_id)
            SELECT 'system','["Admin", "NoAutoLogout"]'::jsonb, 1
            WHERE NOT EXISTS (SELECT 1 FROM login where login = 'system');"#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let _db = manager.get_connection();
        Ok(())
    }
}
