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
                do $$
                begin
                    if exists (
                        select 1
                        from file_entry
                        where content_path is not null
                    ) then
                        raise exception
                            'file_entry contains legacy content_path values without file_content provenance';
                    end if;

                    if exists (
                        select 1
                        from file_revision as revision
                        join file_entry as entry
                          on entry.id = revision.id
                        where entry.device_id <> revision.device_id
                    ) then
                        raise exception
                            'file_revision contains device_id values that do not match file_entry';
                    end if;
                end
                $$;

                alter table file_revision
                    add constraint file_revision_device_file_revision_key
                        unique (device_id, id, revision),
                    add constraint file_revision_device_file_fk
                        foreign key (device_id, id)
                        references file_entry(device_id, id)
                        on delete restrict;
                alter table file_revision
                    drop constraint file_metadata_revision_file_fk;

                create type public.file_content_upload_status as enum (
                    'open',
                    'completed',
                    'aborted',
                    'expired',
                    'stale',
                    'rejected'
                );

                create table file_content_upload (
                    id uuid not null,
                    device_id uuid not null,
                    file_id uuid not null,
                    revision bigint not null,
                    created_by_login_id uuid not null,
                    upload_length bigint not null,
                    expected_sha256 bytea not null,
                    object_key text not null,
                    status public.file_content_upload_status not null,
                    created_at timestamp with time zone not null,
                    last_activity_at timestamp with time zone not null,
                    expires_at timestamp with time zone not null,
                    hard_expires_at timestamp with time zone not null,
                    spool_removed_at timestamp with time zone,
                    next_cleanup_at timestamp with time zone,
                    constraint file_content_upload_pkey
                        primary key (id),
                    constraint file_content_upload_target_fk
                        foreign key (device_id, file_id, revision)
                        references file_revision(device_id, id, revision)
                        on delete restrict,
                    constraint file_content_upload_object_key_key
                        unique (object_key),
                    constraint file_content_upload_binding_key
                        unique (
                            id,
                            file_id,
                            revision,
                            object_key,
                            upload_length,
                            expected_sha256
                        ),
                    constraint file_content_upload_length_check
                        check (upload_length >= 0),
                    constraint file_content_upload_sha256_check
                        check (pg_catalog.octet_length(expected_sha256) = 32),
                    constraint file_content_upload_empty_sha256_check
                        check (
                            upload_length <> 0
                            or expected_sha256 = pg_catalog.decode(
                                'e3b0c44298fc1c149afbf4c8996fb924'
                                || '27ae41e4649b934ca495991b7852b855',
                                'hex'
                            )
                        ),
                    constraint file_content_upload_object_key_check
                        check (
                            object_key =
                                'device-file-content/' || device_id::text
                                || '/' || file_id::text
                                || '/' || revision::text
                                || '/' || id::text
                        ),
                    constraint file_content_upload_time_check
                        check (
                            created_at <= last_activity_at
                            and last_activity_at <= expires_at
                            and expires_at <= hard_expires_at
                            and (
                                spool_removed_at is null
                                or spool_removed_at >= created_at
                            )
                            and (
                                next_cleanup_at is null
                                or next_cleanup_at >= created_at
                            )
                        ),
                    constraint file_content_upload_state_shape_check
                        check (
                            (
                                status = 'open'
                                and spool_removed_at is null
                                and next_cleanup_at = expires_at
                            )
                            or (
                                status = 'completed'
                                and (
                                    (
                                        spool_removed_at is null
                                        and next_cleanup_at is not null
                                    )
                                    or (
                                        spool_removed_at is not null
                                        and next_cleanup_at is null
                                    )
                                )
                            )
                            or (
                                status in (
                                    'aborted',
                                    'expired',
                                    'stale',
                                    'rejected'
                                )
                                and next_cleanup_at is not null
                            )
                        )
                );

                create function public.file_content_upload_enforce_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if tg_op = 'INSERT' then
                        if new.status <> 'open' then
                            raise exception
                                'file_content_upload must be created open';
                        end if;
                        return new;
                    end if;

                    if tg_op = 'DELETE' then
                        if old.status in ('open', 'completed') then
                            raise exception
                                'open or completed file_content_upload cannot be deleted';
                        end if;
                        return old;
                    end if;

                    if new.id is distinct from old.id
                        or new.device_id is distinct from old.device_id
                        or new.file_id is distinct from old.file_id
                        or new.revision is distinct from old.revision
                        or new.created_by_login_id is distinct from
                            old.created_by_login_id
                        or new.upload_length is distinct from old.upload_length
                        or new.expected_sha256 is distinct from old.expected_sha256
                        or new.object_key is distinct from old.object_key
                        or new.created_at is distinct from old.created_at
                        or new.hard_expires_at is distinct from old.hard_expires_at
                    then
                        raise exception
                            'file_content_upload target, creator, content, key, and hard expiry are immutable';
                    end if;

                    if old.status = 'open' then
                        if new.status = 'open' then
                            if new.last_activity_at < old.last_activity_at
                                or new.expires_at < old.expires_at
                                or new.spool_removed_at is not null
                            then
                                raise exception
                                    'open file_content_upload activity must be monotonic';
                            end if;
                        else
                            if new.status not in (
                                'completed',
                                'aborted',
                                'expired',
                                'stale',
                                'rejected'
                            )
                                or new.last_activity_at is distinct from
                                    old.last_activity_at
                                or new.expires_at is distinct from old.expires_at
                                or new.spool_removed_at is distinct from
                                    old.spool_removed_at
                            then
                                raise exception
                                    'invalid file_content_upload terminal transition';
                            end if;
                        end if;
                    else
                        if new.status is distinct from old.status
                            or new.last_activity_at is distinct from
                                old.last_activity_at
                            or new.expires_at is distinct from old.expires_at
                            or (
                                old.spool_removed_at is not null
                                and new.spool_removed_at is distinct from
                                    old.spool_removed_at
                            )
                        then
                            raise exception
                                'terminal file_content_upload state is immutable';
                        end if;
                    end if;

                    return new;
                end
                $function$;

                create trigger file_content_upload_mutation_trg
                    before insert or update or delete on file_content_upload
                    for each row
                    execute function
                        public.file_content_upload_enforce_mutation();

                create unique index file_content_upload_open_target_uidx
                    on file_content_upload(file_id, revision)
                    where status = 'open';
                create index file_content_upload_reserved_bytes_idx
                    on file_content_upload(created_by_login_id)
                    include (upload_length)
                    where spool_removed_at is null;
                create index file_content_upload_reserved_count_idx
                    on file_content_upload(created_by_login_id)
                    where spool_removed_at is null or status <> 'completed';
                create index file_content_upload_cleanup_idx
                    on file_content_upload(next_cleanup_at, id)
                    where next_cleanup_at is not null;

                create table file_content (
                    file_id uuid not null,
                    revision bigint not null,
                    upload_id uuid not null,
                    object_key text not null,
                    source_size_bytes bigint not null,
                    source_sha256 bytea not null,
                    is_encrypted boolean not null,
                    created_at timestamp with time zone not null,
                    constraint file_content_pkey
                        primary key (file_id, revision),
                    constraint file_content_upload_id_key
                        unique (upload_id),
                    constraint file_content_object_key_key
                        unique (object_key),
                    constraint file_content_current_pointer_key
                        unique (file_id, revision, object_key),
                    constraint file_content_revision_fk
                        foreign key (file_id, revision)
                        references file_revision(id, revision)
                        on delete restrict,
                    constraint file_content_upload_binding_fk
                        foreign key (
                            upload_id,
                            file_id,
                            revision,
                            object_key,
                            source_size_bytes,
                            source_sha256
                        )
                        references file_content_upload (
                            id,
                            file_id,
                            revision,
                            object_key,
                            upload_length,
                            expected_sha256
                        )
                        on delete restrict,
                    constraint file_content_size_check
                        check (source_size_bytes >= 0),
                    constraint file_content_sha256_check
                        check (pg_catalog.octet_length(source_sha256) = 32)
                );

                create function public.file_content_reject_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    raise exception 'file_content rows are immutable';
                end
                $function$;

                create trigger file_content_immutable_trg
                    before update or delete on file_content
                    for each row
                    execute function public.file_content_reject_mutation();

                alter table file_entry
                    add constraint file_entry_content_revision_check
                        check (content_path is null or revision is not null),
                    add constraint file_entry_current_content_fk
                        foreign key (id, revision, content_path)
                        references file_content(file_id, revision, object_key)
                        on delete restrict
                        deferrable initially deferred;
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
                do $$
                begin
                    if exists (select 1 from file_content)
                        or exists (select 1 from file_content_upload)
                        or exists (
                            select 1
                            from file_entry
                            where content_path is not null
                        )
                    then
                        raise exception
                            'cannot remove device file content schema while content data exists';
                    end if;
                end
                $$;

                alter table file_entry
                    drop constraint file_entry_current_content_fk,
                    drop constraint file_entry_content_revision_check;

                drop table file_content;
                drop function public.file_content_reject_mutation();

                drop table file_content_upload;
                drop function public.file_content_upload_enforce_mutation();
                drop type public.file_content_upload_status;

                alter table file_revision
                    add constraint file_metadata_revision_file_fk
                        foreign key (id)
                        references file_entry(id)
                        on delete restrict;
                alter table file_revision
                    drop constraint file_revision_device_file_fk,
                    drop constraint file_revision_device_file_revision_key;
                "#,
            )
            .await?;
        Ok(())
    }
}
