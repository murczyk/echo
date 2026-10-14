use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
alter table file_preview add column archive_members text
    check (archive_members ~ '^(0|[1-9][0-9]{0,2})(,(0|[1-9][0-9]{0,2})){0,7}$');
drop index file_preview_current_idx;
create unique index file_preview_current_idx on file_preview(file_id, revision, kind, coalesce(archive_members, '')) where is_current and source_file_id is not null;
create function file_preview_archive_guard() returns trigger language plpgsql as $$
begin
    if new.archive_members is distinct from old.archive_members then
        raise exception 'preview archive identity is immutable';
    end if;
    return new;
end $$;
create trigger file_preview_archive_guard before update on file_preview for each row execute function file_preview_archive_guard();
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
do $$ begin
    if exists (select 1 from file_preview where archive_members is not null) then
        raise exception 'Complete archive preview cleanup and tombstone retention before removing archive identity';
    end if;
end $$;
drop trigger file_preview_archive_guard on file_preview;
drop function file_preview_archive_guard();
drop index file_preview_current_idx;
alter table file_preview drop column archive_members;
create unique index file_preview_current_idx on file_preview(file_id, revision, kind) where is_current and source_file_id is not null;
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
