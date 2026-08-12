use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                create index report_history_duplicate_lookup_idx
                    on report_history (
                        requested_by_login_id,
                        report_kind,
                        created_at,
                        id
                    )
                    where status in ('planned', 'in_progress', 'failed');
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index if exists report_history_duplicate_lookup_idx;",
            )
            .await?;
        Ok(())
    }
}
