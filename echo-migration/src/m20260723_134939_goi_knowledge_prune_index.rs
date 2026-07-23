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
                    create index if not exists idx_goi_knowledge_deleted_prune
                        on goi_knowledge (integration_id, deleted_at, id)
                        where deleted = true;
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
                    drop index if exists idx_goi_knowledge_deleted_prune;
                "#,
            )
            .await?;
        Ok(())
    }
}
