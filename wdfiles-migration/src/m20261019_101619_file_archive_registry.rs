use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"alter table file_entry
    add column is_archive boolean,
    add column archive_file_id uuid,
    add column archive_relative_path text collate "C",
    add constraint file_entry_archive_parent_fk foreign key (device_id,archive_file_id) references file_entry(device_id,id) on delete restrict,
    add constraint file_entry_archive_identity_key unique (archive_file_id,archive_relative_path,kind),
    add constraint file_entry_archive_path_check check (
        (archive_file_id is null and archive_relative_path is null) or
        (archive_file_id is not null and archive_relative_path is not null and archive_relative_path<>'' and octet_length(archive_relative_path)<=1024)),
    drop constraint file_entry_row_shape_check,
    drop constraint file_entry_sync_projection_check;
alter table file_entry
    add constraint file_entry_row_shape_check check (
        (kind='directory' and absolute_path is null) or
        (kind='file' and parent_id is not null and ((archive_file_id is null and absolute_path is not null) or (archive_file_id is not null and absolute_path is null)))),
    add constraint file_entry_sync_projection_check check (
        (archive_file_id is null and kind='directory' and revision is null and sync_id is null and analysis_input_revision is null and current_analysis_run_id is null and source_file_state is null and source_file_state_settled_at is null and source_file_state_settled_by is null) or
        (archive_file_id is null and kind='file' and revision is not null and sync_id is not null and analysis_input_revision is not null and
            ((source_file_state is null and source_file_state_settled_at is null and source_file_state_settled_by is null) or
             (source_file_state is not null and source_file_state_settled_at is not null and (source_file_state_settled_by is null or btrim(source_file_state_settled_by)<>'')))) or
        (archive_file_id is not null and parent_id is not null and revision is not null and sync_id is not null and absolute_path is null and analysis_input_revision is null and current_analysis_run_id is null and source_file_state is null and source_file_state_settled_at is null and source_file_state_settled_by is null));
create index file_entry_archive_parent_idx on file_entry(archive_file_id,parent_id,kind,name,id) where archive_file_id is not null;
alter table file_revision
    add column is_archive boolean,
    add column origin_archive_id uuid,
    add column archive_member_index bigint check (archive_member_index>=0),
    alter column absolute_path drop not null,
    alter column source_sequence drop not null,
    alter column analysis_input_revision drop not null;

alter table file_content add constraint file_content_archive_source_key unique(file_id,revision,object_key,source_size_bytes,source_sha256,is_encrypted);

create table file_archive (
    id uuid primary key,
    device_id uuid not null,
    source_file_id uuid not null,
    source_revision bigint not null,
    source_object_key text not null,
    source_sha256 bytea not null check (octet_length(source_sha256)=32),
    source_size_bytes bigint not null check (source_size_bytes>=0),
    source_is_encrypted boolean not null,
    root_id uuid not null references file_archive(id) on delete restrict,
    parent_id uuid references file_archive(id) on delete restrict,
    depth bigint not null check (depth>0),
    policy jsonb not null,
    state text not null default 'queued' check (state in ('queued','running','retry_wait','ready','failed')),
    attempts bigint not null default 0 check (attempts>=0),
    run_id uuid,
    heartbeat_at timestamptz,
    first_started_at timestamptz,
    deadline timestamptz,
    not_before timestamptz not null default clock_timestamp(),
    next_cleanup_at timestamptz not null default clock_timestamp(),
    error_code text,
    exhausted_limit text,
    declared_nodes bigint check (declared_nodes>=0),
    budgeted_attempt bigint not null default 0,
    expanded_bytes bigint not null default 0 check (expanded_bytes>=0),
    node_count bigint not null default 0 check (node_count>=0),
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    unique(device_id,source_file_id,source_revision),
    foreign key(source_file_id,source_revision,source_object_key,source_size_bytes,source_sha256,source_is_encrypted) references file_content(file_id,revision,object_key,source_size_bytes,source_sha256,is_encrypted) on delete restrict,
    foreign key(device_id,source_file_id,source_revision) references file_revision(device_id,id,revision) on delete restrict,
    check ((parent_id is null and root_id=id and depth=1) or (parent_id is not null and root_id<>id and depth>1)),
    check (state<>'running' or (attempts>0 and run_id is not null and heartbeat_at is not null and deadline is not null)),
    check (state<>'failed' or error_code is not null)
);
create index file_archive_queue_idx on file_archive(not_before,id) where state in ('queued','retry_wait');
create index file_archive_heartbeat_idx on file_archive(heartbeat_at,id) where state='running';
create index file_archive_root_idx on file_archive(root_id,id);
alter table file_revision
    add constraint file_revision_archive_fk foreign key (origin_archive_id) references file_archive(id) on delete restrict,
    add constraint file_revision_origin_shape_check check (
        (origin_archive_id is null and absolute_path is not null and source_sequence is not null and analysis_input_revision is not null and archive_member_index is null) or
        (origin_archive_id is not null and absolute_path is null and source_sequence is null and analysis_input_revision is null and source_file_state is null and source_file_state_settled_at is null and source_file_state_settled_by is null));
create unique index file_revision_archive_member_idx on file_revision(origin_archive_id,archive_member_index) where archive_member_index is not null;
create index file_revision_archive_snapshot_idx on file_revision(origin_archive_id,id);
alter table file_content
    alter column upload_id drop not null,
    add column origin_archive_id uuid references file_archive(id) on delete restrict,
    add constraint file_content_one_origin_check check ((upload_id is null)<>(origin_archive_id is null));

create function file_archive_guard() returns trigger language plpgsql as $$
declare source file_revision; parent file_archive;
begin
    select * into strict source from file_revision where id=new.source_file_id and revision=new.source_revision and device_id=new.device_id;
    if source.origin_archive_id is distinct from new.parent_id then raise exception 'archive source origin mismatch'; end if;
    if new.parent_id is not null then
        select * into strict parent from file_archive where id=new.parent_id and state='ready';
        if row(new.root_id,new.depth,new.device_id,new.policy) is distinct from row(parent.root_id,parent.depth+1,parent.device_id,parent.policy) then
            raise exception 'nested archive context mismatch';
        end if;
    end if;
    if tg_op='UPDATE' then
        if row(new.id,new.device_id,new.source_file_id,new.source_revision,new.source_object_key,new.source_sha256,new.source_size_bytes,new.source_is_encrypted,new.root_id,new.parent_id,new.depth,new.policy,new.created_at)
            is distinct from row(old.id,old.device_id,old.source_file_id,old.source_revision,old.source_object_key,old.source_sha256,old.source_size_bytes,old.source_is_encrypted,old.root_id,old.parent_id,old.depth,old.policy,old.created_at) then raise exception 'archive identity is immutable'; end if;
        if old.state in ('ready','failed') and
            row(new.state,new.attempts,new.run_id,new.error_code,new.exhausted_limit,new.declared_nodes) is distinct from row(old.state,old.attempts,old.run_id,old.error_code,old.exhausted_limit,old.declared_nodes) then raise exception 'archive result is immutable'; end if;
        if new.attempts<old.attempts or new.expanded_bytes<old.expanded_bytes or new.node_count<old.node_count or
            (old.deadline is not null and new.deadline is distinct from old.deadline) then raise exception 'archive budgets/deadline cannot reset'; end if;
        if new.state='running' and (old.state<>'running' or new.run_id is distinct from old.run_id) and
            (new.attempts<>old.attempts+1 or new.run_id is not distinct from old.run_id) then raise exception 'claim needs new run and attempt'; end if;
    end if;
    return new;
end $$;
create trigger file_archive_guard before insert or update on file_archive for each row execute function file_archive_guard();

create function file_entry_archive_guard() returns trigger language plpgsql as $$
begin
    if tg_op='UPDATE' and row(new.archive_file_id,new.archive_relative_path) is distinct from row(old.archive_file_id,old.archive_relative_path) then
        raise exception 'archive member identity is immutable';
    end if;
    if new.archive_file_id is null then return new; end if;
    if tg_op='UPDATE' and (new.revision<old.revision or row(new.parent_id,new.name,new.hierarchy_path) is distinct from row(old.parent_id,old.name,old.hierarchy_path)) then
        raise exception 'derived identity/current revision cannot regress';
    end if;
    if not exists(select 1 from file_archive a where a.source_file_id=new.archive_file_id and a.source_revision=new.revision and a.device_id=new.device_id and a.state='running') then
        raise exception 'derived entry requires a running archive snapshot';
    end if;
    return new;
end $$;
create trigger file_entry_archive_guard before insert or update on file_entry for each row execute function file_entry_archive_guard();

create or replace function file_entry_validate_hierarchy() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare parent file_entry;
begin
    if new.parent_id is null then
        if new.hierarchy_path<>file_entry_uuid_label(new.id) then raise exception 'invalid root hierarchy'; end if;
        return new;
    end if;
    select * into strict parent from file_entry where id=new.parent_id and device_id=new.device_id;
    if parent.kind<>'directory' and (new.archive_file_id is null or new.archive_file_id<>parent.id) then raise exception 'parent must be directory or containing ZIP'; end if;
    if new.archive_file_id is null and parent.archive_file_id is not null then raise exception 'source entry cannot have derived parent'; end if;
    if new.archive_file_id is not null and parent.id<>new.archive_file_id and parent.archive_file_id is distinct from new.archive_file_id then raise exception 'archive parent mismatch'; end if;
    if new.hierarchy_path<>parent.hierarchy_path||file_entry_uuid_label(new.id) then raise exception 'invalid child hierarchy'; end if;
    return new;
end $$;

create function file_revision_archive_guard() returns trigger language plpgsql as $$
declare entry file_entry; source file_revision; job file_archive;
begin
    select * into strict entry from file_entry where id=new.id and device_id=new.device_id;
    if (entry.archive_file_id is null)<>(new.origin_archive_id is null) then raise exception 'revision origin mismatch'; end if;
    if new.origin_archive_id is null then return new; end if;
    select * into strict job from file_archive where id=new.origin_archive_id and state='running';
    select * into strict source from file_revision where id=job.source_file_id and revision=job.source_revision;
    if row(entry.archive_file_id,new.revision,new.device_id,new.sync_id,new.name) is distinct from row(job.source_file_id,job.source_revision,job.device_id,source.sync_id,entry.name) then raise exception 'member revision context mismatch'; end if;
    return new;
end $$;
create trigger file_revision_archive_guard before insert on file_revision for each row execute function file_revision_archive_guard();

create function file_content_archive_guard() returns trigger language plpgsql as $$
declare origin uuid;
begin
    select origin_archive_id into strict origin from file_revision where id=new.file_id and revision=new.revision;
    if origin is distinct from new.origin_archive_id then raise exception 'content revision origin mismatch'; end if;
    if origin is not null and (not exists(select 1 from file_archive where id=origin and state='running') or not exists(select 1 from file_entry where id=new.file_id and kind='file')) then
        raise exception 'archive content requires running publication and file entry';
    end if;
    return new;
end $$;
create trigger file_content_archive_guard before insert on file_content for each row execute function file_content_archive_guard();

CREATE OR REPLACE FUNCTION public.file_document_content_published()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare source_device uuid; next_generation uuid;
begin
    select device_id into source_device from file_revision where id=new.file_id and revision=new.revision and origin_archive_id is null;
    if not found then return new; end if;
    next_generation := uuid_generate_v7();
    insert into file_document(file_id,revision,device_id,generation)
        values(new.file_id,new.revision,source_device,next_generation) on conflict do nothing;
    insert into file_document_job(id,file_id,revision,generation,kind)
        select uuid_generate_v7(),file_id,revision,generation,'extract'
        from file_document where file_id=new.file_id and revision=new.revision on conflict do nothing;
    return new;
end $function$;

create function file_archive_ready_guard() returns trigger language plpgsql as $$
begin
    if new.state='ready' and (new.declared_nodes is null or
        new.declared_nodes<>(select count(*) from file_revision where origin_archive_id=new.id) or
        exists(select 1 from file_revision r join file_entry e on e.id=r.id left join file_content c on c.file_id=r.id and c.revision=r.revision where r.origin_archive_id=new.id and e.kind='file' and c.file_id is null)) then
        raise exception 'archive snapshot must publish all entries/content atomically';
    end if;
    return new;
end $$;
create constraint trigger file_archive_ready_guard after insert or update on file_archive deferrable initially deferred for each row execute function file_archive_ready_guard();
"#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"do $$ begin
    if exists(select 1 from file_archive) then raise exception 'rollback requires empty archive registry'; end if;
end $$;
CREATE OR REPLACE FUNCTION public.file_document_content_published()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare source_device uuid; next_generation uuid;
begin
    select device_id into strict source_device from file_revision where id=new.file_id and revision=new.revision;
    next_generation := uuid_generate_v7();
    insert into file_document(file_id,revision,device_id,generation)
        values(new.file_id,new.revision,source_device,next_generation) on conflict do nothing;
    insert into file_document_job(id,file_id,revision,generation,kind)
        select uuid_generate_v7(),file_id,revision,generation,'extract'
        from file_document where file_id=new.file_id and revision=new.revision on conflict do nothing;
    return new;
end $function$;
drop trigger file_archive_ready_guard on file_archive;
drop function file_archive_ready_guard();
drop trigger file_content_archive_guard on file_content;
drop function file_content_archive_guard();
drop trigger file_revision_archive_guard on file_revision;
drop function file_revision_archive_guard();
drop trigger file_entry_archive_guard on file_entry;
drop function file_entry_archive_guard();
alter table file_content drop constraint file_content_one_origin_check, drop column origin_archive_id, alter column upload_id set not null;
alter table file_revision drop constraint file_revision_origin_shape_check, drop column origin_archive_id, drop column archive_member_index, drop column is_archive,
    alter column absolute_path set not null, alter column source_sequence set not null, alter column analysis_input_revision set not null;
drop table file_archive;
alter table file_content drop constraint file_content_archive_source_key;
drop function file_archive_guard();
drop index file_entry_archive_parent_idx;
alter table file_entry drop constraint file_entry_row_shape_check, drop constraint file_entry_sync_projection_check,
    drop column archive_file_id, drop column archive_relative_path, drop column is_archive;
alter table file_entry add constraint file_entry_row_shape_check CHECK ((((kind = 'directory'::file_entry_kind) AND (absolute_path IS NULL)) OR ((kind = 'file'::file_entry_kind) AND (parent_id IS NOT NULL) AND (absolute_path IS NOT NULL)))), add constraint file_entry_sync_projection_check CHECK ((((kind = 'directory'::file_entry_kind) AND (revision IS NULL) AND (sync_id IS NULL) AND (analysis_input_revision IS NULL) AND (current_analysis_run_id IS NULL) AND (source_file_state IS NULL) AND (source_file_state_settled_at IS NULL) AND (source_file_state_settled_by IS NULL)) OR ((kind = 'file'::file_entry_kind) AND (revision IS NOT NULL) AND (sync_id IS NOT NULL) AND (analysis_input_revision IS NOT NULL) AND (((source_file_state IS NULL) AND (source_file_state_settled_at IS NULL) AND (source_file_state_settled_by IS NULL)) OR ((source_file_state IS NOT NULL) AND (source_file_state_settled_at IS NOT NULL) AND ((source_file_state_settled_by IS NULL) OR (btrim(source_file_state_settled_by) <> ''::text)))))));
CREATE OR REPLACE FUNCTION public.file_entry_validate_hierarchy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
    parent_kind public.file_entry_kind;
    parent_hierarchy_path public.ltree;
    own_label public.ltree;
begin
    own_label := public.file_entry_uuid_label(new.id);

    if new.parent_id is null then
        if new.hierarchy_path <> own_label then
            raise exception
                'root file_entry hierarchy_path must equal its UUID label';
        end if;
        return new;
    end if;

    select parent.kind, parent.hierarchy_path
    into parent_kind, parent_hierarchy_path
    from file_entry as parent
    where parent.device_id = new.device_id
      and parent.id = new.parent_id;

    if not found or parent_kind <> 'directory' then
        raise exception
            'file_entry parent must be a directory on the same device';
    end if;

    if parent_hierarchy_path @> own_label then
        raise exception
            'file_entry UUID label must not appear in its parent hierarchy_path';
    end if;

    if new.hierarchy_path <> parent_hierarchy_path || own_label then
        raise exception
            'file_entry hierarchy_path must extend its parent hierarchy_path';
    end if;

    perform 1
    from file_entry as root
    where root.device_id = new.device_id
      and root.parent_id is null
      and root.hierarchy_path @> new.hierarchy_path;

    if not found then
        raise exception
            'file_entry hierarchy_path must belong to a root on the same device';
    end if;

    return new;
end
$function$"#).await?;
        Ok(())
    }
}
