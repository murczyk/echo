use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists signal_message_media_conversion_job (
                id bigserial primary key,
                signal_message_id bigint not null references signal_message(id) on delete cascade,
                source_media_id uuid not null references signal_message_media(id) on delete cascade,
                source_file_md5 text not null,
                source_file_name text not null,
                source_content_type text,
                status text not null default 'pending',
                conversion_receipt text,
                converted_storage_key text,
                converted_file_name text,
                converted_size_bytes bigint,
                created_at timestamptz not null default now(),
                last_attempt_at timestamptz,
                attempt_count int4 not null default 0,
                last_error text,
                constraint signal_message_media_conversion_job_source_file_md5_check
                    check (source_file_md5 ~ '^[0-9a-f]{32}$'),
                unique (source_media_id)
            );

            create index if not exists idx_signal_message_media_conversion_job_status_created_at
                on signal_message_media_conversion_job (status, created_at);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists idx_signal_message_media_conversion_job_status_created_at;
            drop table if exists signal_message_media_conversion_job;
            "#,
        )
        .await?;
        Ok(())
    }
}
