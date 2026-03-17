use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table goi_knowledge
                    add column if not exists deleted_at timestamptz;

                update goi_knowledge
                set deleted_at = now()
                where deleted = true
                    and deleted_at is null;

                create index if not exists idx_goi_knowledge_organism_deleted_deleted_at
                    on goi_knowledge (organism_id, deleted, deleted_at);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_goi_knowledge_organism_deleted_deleted_at;

                alter table goi_knowledge
                    drop column if exists deleted_at;
            "#,
        )
        .await?;
        Ok(())
    }
}
