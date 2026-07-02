use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_palitra_sync
                add column if not exists echo_file_size bigint,
                add column if not exists echo_file_sha256 text,
                add column if not exists echo_updated_at timestamptz,
                add column if not exists goi_file_size bigint,
                add column if not exists goi_file_sha256 text,
                add column if not exists goi_updated_at timestamptz;

            update goi_palitra_sync
            set
                echo_file_size = coalesce(echo_file_size, file_size),
                echo_file_sha256 = coalesce(echo_file_sha256, file_sha256),
                echo_updated_at = coalesce(echo_updated_at, last_sync_at, updated_at, created_at),
                goi_file_size = coalesce(goi_file_size, file_size),
                goi_file_sha256 = coalesce(goi_file_sha256, file_sha256),
                goi_updated_at = coalesce(goi_updated_at, last_sync_at, updated_at, created_at)
            where file_size is not null
               or file_sha256 is not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_palitra_sync
                drop column if exists goi_updated_at,
                drop column if exists goi_file_sha256,
                drop column if exists goi_file_size,
                drop column if exists echo_updated_at,
                drop column if exists echo_file_sha256,
                drop column if exists echo_file_size;
            "#,
        )
        .await?;
        Ok(())
    }
}
