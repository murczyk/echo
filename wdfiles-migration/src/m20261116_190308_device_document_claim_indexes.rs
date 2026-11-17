use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            r#"create index concurrently file_document_job_claim_order_idx
                on file_document_job(kind, created_at desc, id)
                where state in ('queued','retry_wait','running')"#,
            r#"create index concurrently file_document_job_poll_order_idx
                on file_document_job(kind, created_at desc, id)
                where state in ('queued','retry_wait','running')
                  and jsonb_typeof(payload->'extractorJobId')='string'"#,
            r#"create index concurrently file_document_job_poll_due_idx
                on file_document_job(kind, next_attempt_at)
                include (id, state, lease_until)
                where state in ('queued','retry_wait','running')
                  and jsonb_typeof(payload->'extractorJobId')='string'"#,
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!(
                        "at {}:{}: {error}",
                        file!(),
                        line!()
                    ))
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            "drop index concurrently if exists file_document_job_poll_due_idx",
            "drop index concurrently if exists file_document_job_poll_order_idx",
            "drop index concurrently if exists file_document_job_claim_order_idx",
        ] {
            manager.get_connection().execute_unprepared(sql).await
                .map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        }
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
