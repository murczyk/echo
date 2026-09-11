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
create index concurrently signal_message_babak_candidate_stream_idx
    on signal_message (datasource_group_id, created_at, id)
    where deleted = false;
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
drop index concurrently if exists signal_message_babak_candidate_stream_idx;
                "#,
            )
            .await?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
