use crate::sea_orm::{DbBackend, Statement};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let result = db
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "SELECT count(*) as cnt from login where login = 'merge_networks_api'"
                    .to_owned(),
            ))
            .await?;

        let login_count: i64 = result
            .and_then(|row| row.try_get("", "cnt").ok())
            .unwrap_or(0);
        if login_count < 1 {
            db.execute_unprepared(
                "INSERT INTO login (login, roles) values ('merge_networks_api', '[]');",
            )
                .await?;
        }
        db.execute_unprepared(
            r#"
                update login
                set deleted = false,
                    last_active_at = now(),
                    roles = '["NoAutoLogout"]',
                    deactivation_reason = null
                where login = 'merge_networks_api';
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
