use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                update echo_missing_message
                set
                    status = 'duplicate',
                    is_resolved = true,
                    resolved_at = coalesce(resolved_at, now() at time zone 'utc'),
                    error = null
                where status = 'error'
                    and error = 'skipped during recovery: duplicate';
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                update echo_missing_message
                set
                    status = 'error',
                    is_resolved = false,
                    resolved_at = null,
                    error = 'skipped during recovery: duplicate'
                where status = 'duplicate'
                    and error is null;
            "#,
        )
        .await?;
        Ok(())
    }
}
