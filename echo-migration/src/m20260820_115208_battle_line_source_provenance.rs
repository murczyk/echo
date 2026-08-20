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
alter table battle_line_version
    add column source_kind text default 'admin_upload' not null,
    add column source_identifier text,
    add column source_sha256 text,
    add constraint battle_line_version_source_check check (
        (source_kind = 'admin_upload' and source_identifier is null)
        or
        (source_kind = 'delta_kml' and source_identifier is not null)
    ),
    add constraint battle_line_version_source_sha256_check check (
        source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'
    );

create unique index battle_line_version_source_uq
    on battle_line_version (source_kind, source_identifier, source_sha256)
    where source_identifier is not null and source_sha256 is not null;
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
drop index if exists battle_line_version_source_uq;
alter table battle_line_version
    drop constraint if exists battle_line_version_source_sha256_check,
    drop constraint if exists battle_line_version_source_check,
    drop column if exists source_sha256,
    drop column if exists source_identifier,
    drop column if exists source_kind;
                "#,
            )
            .await?;
        Ok(())
    }
}
