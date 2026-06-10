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
                    alter table api_integration
                        add column sync_enabled boolean not null default false,
                        add column last_sync_at timestamp without time zone,
                        add column is_working boolean not null default false;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    alter table api_integration
                        drop column is_working,
                        drop column last_sync_at,
                        drop column sync_enabled;
                "#,
            )
            .await?;
        Ok(())
    }
}
