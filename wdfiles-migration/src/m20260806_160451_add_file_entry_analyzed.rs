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
                alter table file_entry
                    add column analyzed boolean not null default false;

                create index file_entry_pending_analysis_idx
                    on file_entry(created_at, id)
                    where kind = 'file' and analyzed = false;
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
                drop index file_entry_pending_analysis_idx;
                alter table file_entry drop column analyzed;
                "#,
            )
            .await?;
        Ok(())
    }
}
