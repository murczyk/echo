use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(r#"
create table file_preview (
    generation uuid primary key,
    device_id uuid not null,
    file_id uuid not null,
    revision bigint not null check (revision > 0),
    source_file_id uuid,
    source_revision bigint,
    kind text not null check (kind = 'geodata_kmz'),
    converter_version integer not null check (converter_version > 0),
    is_current boolean not null,
    state text not null check (state in ('queued', 'running', 'retry_wait', 'ready', 'failed', 'retired')),
    run_id uuid not null,
    attempt integer not null check (attempt between 1 and 3),
    source_object_key text not null,
    source_sha256 bytea not null check (octet_length(source_sha256) = 32),
    source_size_bytes bigint not null check (source_size_bytes >= 0),
    source_is_encrypted boolean not null,
    source_name text not null,
    source_extension text,
    lease uuid,
    lease_until timestamptz,
    heartbeat_at timestamptz,
    not_before timestamptz not null,
    attempt_deadline timestamptz,
    output_object_key text not null unique,
    result_size_bytes bigint check (result_size_bytes >= 0),
    result_sha256 bytea check (octet_length(result_sha256) = 32),
    result_encrypted boolean,
    error_code text,
    retryable boolean not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    expires_at timestamptz,
    cleanup_after timestamptz,
    object_deleted_at timestamptz,
    tombstone_until timestamptz,
    foreign key (source_file_id, source_revision) references file_content(file_id, revision) on delete set null,
    check ((source_file_id is null and source_revision is null) or
           (source_file_id is not null and source_revision is not null and source_file_id = file_id and source_revision = revision)),
    check ((state = 'running' and lease is not null and lease_until is not null and heartbeat_at is not null and attempt_deadline is not null) or
           (state <> 'running' and lease is null and lease_until is null and heartbeat_at is null)),
    check ((result_size_bytes is null and result_sha256 is null and result_encrypted is null) or
           (result_size_bytes is not null and result_sha256 is not null and result_encrypted is not null)),
    check (state <> 'ready' or (result_size_bytes is not null and result_sha256 is not null and result_encrypted is not null and expires_at is not null)),
    check (state <> 'retired' or not is_current)
);
create unique index file_preview_current_idx on file_preview(file_id, revision, kind) where is_current and source_file_id is not null;
create index file_preview_runnable_idx on file_preview(not_before, created_at, generation) where is_current and source_file_id is not null and state in ('queued', 'retry_wait');
create index file_preview_lease_idx on file_preview(lease_until, generation) where is_current and state = 'running';
create index file_preview_expiry_idx on file_preview(expires_at, generation) where is_current and state = 'ready';
create index file_preview_cleanup_idx on file_preview(cleanup_after, generation) where cleanup_after is not null;
create index file_preview_pending_device_idx on file_preview(device_id) where is_current and source_file_id is not null and state in ('queued', 'running', 'retry_wait');
create index file_preview_source_idx on file_preview(source_file_id, source_revision) where source_file_id is not null;
create function file_preview_guard() returns trigger language plpgsql as $$
begin
    if row(new.generation, new.device_id, new.file_id, new.revision, new.kind, new.converter_version, new.run_id, new.attempt, new.source_object_key, new.source_sha256, new.source_size_bytes, new.source_is_encrypted, new.source_name, new.source_extension, new.output_object_key, new.created_at)
        is distinct from row(old.generation, old.device_id, old.file_id, old.revision, old.kind, old.converter_version, old.run_id, old.attempt, old.source_object_key, old.source_sha256, old.source_size_bytes, old.source_is_encrypted, old.source_name, old.source_extension, old.output_object_key, old.created_at) then
        raise exception 'preview source identity is immutable';
    end if;
    if old.source_file_id is null and new.source_file_id is not null then
        raise exception 'preview source cannot be reattached';
    end if;
    if new.source_file_id is null and old.source_file_id is not null then
        new.cleanup_after := greatest(now(), coalesce(new.attempt_deadline, now()) + interval '1 hour');
    end if;
    return new;
end $$;
create trigger file_preview_guard before update on file_preview for each row execute function file_preview_guard();
"#)
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
do $$ begin
    if exists (select 1 from file_preview where object_deleted_at is null or tombstone_until > now()) then
        raise exception 'Complete preview object cleanup and tombstone retention before dropping file_preview';
    end if;
end $$;
drop table file_preview;
drop function file_preview_guard();
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
