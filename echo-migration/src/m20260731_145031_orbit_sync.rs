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
create table orbit_sync (
    id bigserial primary key,
    synced_at timestamp without time zone not null,
    archive_md5 text not null,
    constraint orbit_sync_archive_md5_length_ck
        check (length(archive_md5) = 32)
);

create index orbit_sync_synced_at_idx
    on orbit_sync (synced_at desc, id desc);

alter table orbit_unit
    add column is_snapshot_root boolean not null default false;
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
alter table orbit_unit drop column is_snapshot_root;
drop table orbit_sync;
"#,
            )
            .await?;
        Ok(())
    }
}
