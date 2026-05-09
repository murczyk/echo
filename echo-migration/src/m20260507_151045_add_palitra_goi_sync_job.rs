use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table palitra_goi_sync_job (
                id bigserial primary key,
                palitra_id bigint not null references palitra(id) on delete cascade,
                kind text not null,
                source_folder text not null default '',
                file_data bytea,
                created_at timestamptz not null default now(),
                last_attempt_at timestamptz,
                attempt_count int4 not null default 0,
                last_error text,
                unique (palitra_id, kind, source_folder)
            );

            create index idx_palitra_goi_sync_job_created_at
                on palitra_goi_sync_job (created_at);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table palitra_goi_sync_job;
            "#,
        )
        .await?;
        Ok(())
    }
}
