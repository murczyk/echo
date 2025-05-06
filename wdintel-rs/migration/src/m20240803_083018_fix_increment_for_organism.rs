use sea_orm::{DbBackend, Statement};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        let result = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT COALESCE(MAX(id), 0) as max_id FROM organism"
                    .to_owned(),
            ))
            .await?;

        let increment: i64 = result
            .and_then(|row| row.try_get("", "max_id").ok())
            .unwrap_or(0)
            + 1;

        // Restart the sequence with max_id + 1
        db.execute_unprepared(&format!(
            "ALTER SEQUENCE organism_id_seq RESTART WITH {increment}",
        ))
        .await?;

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
