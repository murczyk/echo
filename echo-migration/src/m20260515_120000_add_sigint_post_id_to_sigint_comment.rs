use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // On production databases `sigint_comment` already existed before this
        // migration. The later `m20260702_145245_create_sigint_comment`
        // migration exists only to make fresh/test databases match that state.
        db.execute_unprepared(
            "alter table sigint_comment add column if not exists sigint_post_id bigint references sigint_post(id);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_comment drop column if exists sigint_post_id;",
        )
        .await?;
        Ok(())
    }
}
