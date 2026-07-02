use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table palitra
                add column if not exists conversion_status text not null default 'ready',
                add column if not exists source_format text,
                add column if not exists conversion_receipt text,
                add column if not exists conversion_error text,
                add column if not exists conversion_attempt_count int4 not null default 0,
                add column if not exists conversion_last_attempt_at timestamptz,
                add column if not exists missing_in_goi bool not null default false,
                add column if not exists imported_from_goi bool not null default false;

            create index if not exists idx_palitra_conversion_status
                on palitra (conversion_status)
                where deleted = false;

            create index if not exists idx_palitra_missing_in_goi
                on palitra (missing_in_goi)
                where deleted = false and missing_in_goi = true;

            alter table goi_integration
                add column if not exists disable_goi_to_echo_palitra_sync bool not null default true,
                add column if not exists maintainer_login text references login(login) on delete set null;

            create index if not exists idx_goi_integration_maintainer_login
                on goi_integration (maintainer_login);

            create table if not exists palitra_conversion_job (
                id bigserial primary key,
                palitra_id bigint not null references palitra(id) on delete cascade,
                source_file_name text not null,
                source_format text not null,
                content_type text,
                file_data bytea,
                status text not null default 'pending',
                conversion_receipt text,
                created_at timestamptz not null default now(),
                last_attempt_at timestamptz,
                attempt_count int4 not null default 0,
                last_error text,
                unique (palitra_id)
            );

            create index if not exists idx_palitra_conversion_job_status_created_at
                on palitra_conversion_job (status, created_at);

            create table if not exists goi_palitra_sync (
                id bigserial primary key,
                goi_integration_id bigint not null references goi_integration(id) on delete cascade,
                palitra_id bigint references palitra(id) on delete set null,
                remote_relative_path text not null,
                direction text not null,
                remote_status text not null default 'unknown',
                file_size bigint,
                file_sha256 text,
                last_seen_at timestamptz,
                last_sync_at timestamptz,
                last_error text,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now(),
                unique (goi_integration_id, remote_relative_path)
            );

            create index if not exists idx_goi_palitra_sync_palitra_id
                on goi_palitra_sync (palitra_id);

            create index if not exists idx_goi_palitra_sync_integration_status
                on goi_palitra_sync (goi_integration_id, remote_status);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists idx_goi_palitra_sync_integration_status;
            drop index if exists idx_goi_palitra_sync_palitra_id;
            drop table if exists goi_palitra_sync;

            drop index if exists idx_palitra_conversion_job_status_created_at;
            drop table if exists palitra_conversion_job;

            drop index if exists idx_goi_integration_maintainer_login;
            alter table goi_integration
                drop column if exists maintainer_login,
                drop column if exists disable_goi_to_echo_palitra_sync;

            drop index if exists idx_palitra_missing_in_goi;
            drop index if exists idx_palitra_conversion_status;
            alter table palitra
                drop column if exists imported_from_goi,
                drop column if exists missing_in_goi,
                drop column if exists conversion_last_attempt_at,
                drop column if exists conversion_attempt_count,
                drop column if exists conversion_error,
                drop column if exists conversion_receipt,
                drop column if exists source_format,
                drop column if exists conversion_status;
            "#,
        )
        .await?;
        Ok(())
    }
}
