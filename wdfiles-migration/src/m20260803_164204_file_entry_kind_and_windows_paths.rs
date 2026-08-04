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
                        where path_syntax is not null
                          and path_syntax <> 'windows'
                    ) then
                        raise exception
                            'file_entry contains non-Windows paths';
                    end if;
                end
                $$;

                drop trigger file_entry_hierarchy_trg on file_entry;
                drop trigger file_entry_immutable_update_trg on file_entry;
                drop function public.file_entry_validate_hierarchy();
                drop function public.file_entry_enforce_immutable_update();

                drop index file_entry_roots_uidx;
                drop index file_entry_children_idx;
                drop index file_entry_directory_sibling_uidx;
                drop index file_entry_search_order_idx;
                drop index file_entry_file_mime_idx;
                drop index file_entry_file_extension_idx;
                drop index file_entry_file_modified_idx;
                drop index file_entry_journal_idx;

                alter table file_entry
                    drop constraint file_entry_kind_check,
                    drop constraint file_entry_path_syntax_check,
                    drop constraint file_entry_name_key_check,
                    drop constraint file_entry_row_shape_check,
                    drop constraint file_entry_absolute_path_length_check,
                    drop constraint file_entry_directory_metadata_null_check,
                    drop constraint file_entry_directory_content_path_null_check;

                create type public.file_entry_kind as enum ('directory', 'file');
                alter table file_entry
                    alter column kind type public.file_entry_kind
                        using kind::public.file_entry_kind,
                    drop column name_key,
                    drop column path_syntax;

                alter table file_entry
                    add constraint file_entry_row_shape_check
                        check (
                            (parent_id is null
                                and kind = 'directory'
                                and absolute_path is null)
                            or (parent_id is not null
                                and kind = 'directory'
                                and absolute_path is null)
                            or (parent_id is not null
                                and kind = 'file'
                                and absolute_path is not null)
                        ),
                    add constraint file_entry_absolute_path_length_check
                        check (
                            kind <> 'file'
                            or (
                                pg_catalog.char_length(absolute_path) between 1 and 16384
                                and pg_catalog.octet_length(
                                    pg_catalog.convert_to(absolute_path, 'UTF8')
                                ) <= 65536
                            )
                        ),
                    add constraint file_entry_absolute_path_windows_check
                        check (
                            kind <> 'file'
                            or absolute_path
                                ~ '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))'
                        ),
                    add constraint file_entry_directory_metadata_null_check
                        check (
                            kind = 'file'
                            or (
                                mime_type is null
                                and extension is null
                                and file_metadata_created_at is null
                                and file_metadata_modified_at is null
                            )
                        ),
                    add constraint file_entry_directory_content_path_null_check
                        check (kind = 'file' or content_path is null);

                create function public.file_entry_enforce_immutable_update()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.id is distinct from old.id
                        or new.device_id is distinct from old.device_id
                        or new.kind is distinct from old.kind then
                        raise exception
                            'file_entry id, device_id, and kind are immutable';
                    end if;

                    if old.kind = 'directory'
                        and (
                            new.parent_id is distinct from old.parent_id
                            or new.name is distinct from old.name
                            or new.absolute_path is distinct from old.absolute_path
                            or new.hierarchy_path is distinct from old.hierarchy_path
                        ) then
                        raise exception
                            'directory file_entry structure is immutable';
                    end if;

                    return new;
                end
                $function$;

                create function public.file_entry_validate_hierarchy()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
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
                $function$;

                create trigger file_entry_immutable_update_trg
                before update on file_entry
                for each row
                execute function public.file_entry_enforce_immutable_update();

                create constraint trigger file_entry_hierarchy_trg
                after insert or update on file_entry
                deferrable initially immediate
                for each row
                execute function public.file_entry_validate_hierarchy();

                create unique index file_entry_roots_uidx
                    on file_entry (device_id, name)
                    where parent_id is null;
                create index file_entry_children_idx
                    on file_entry (device_id, parent_id, kind, name, id)
                    where parent_id is not null;
                create unique index file_entry_directory_sibling_uidx
                    on file_entry (device_id, parent_id, name)
                    where kind = 'directory' and parent_id is not null;
                create index file_entry_search_order_idx
                    on file_entry (device_id, kind, name, id)
                    where parent_id is not null;
                create index file_entry_file_mime_idx
                    on file_entry (device_id, mime_type, id)
                    where kind = 'file' and mime_type is not null;
                create index file_entry_file_extension_idx
                    on file_entry (device_id, extension, id)
                    where kind = 'file' and extension is not null;
                create index file_entry_file_modified_idx
                    on file_entry (device_id, file_metadata_modified_at, id)
                    where kind = 'file' and file_metadata_modified_at is not null;
                create index file_entry_journal_idx
                    on file_entry (device_id, updated_at desc, id desc)
                    where kind = 'file';
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
                drop trigger file_entry_hierarchy_trg on file_entry;
                drop trigger file_entry_immutable_update_trg on file_entry;
                drop function public.file_entry_validate_hierarchy();
                drop function public.file_entry_enforce_immutable_update();

                drop index file_entry_roots_uidx;
                drop index file_entry_children_idx;
                drop index file_entry_directory_sibling_uidx;
                drop index file_entry_search_order_idx;
                drop index file_entry_file_mime_idx;
                drop index file_entry_file_extension_idx;
                drop index file_entry_file_modified_idx;
                drop index file_entry_journal_idx;

                alter table file_entry
                    drop constraint file_entry_row_shape_check,
                    drop constraint file_entry_absolute_path_length_check,
                    drop constraint file_entry_absolute_path_windows_check,
                    drop constraint file_entry_directory_metadata_null_check,
                    drop constraint file_entry_directory_content_path_null_check;

                alter table file_entry
                    add column name_key bytea,
                    add column path_syntax text;
                update file_entry
                set name_key = pg_catalog.convert_to(name, 'UTF8'),
                    path_syntax = case
                        when parent_id is null or kind = 'file' then 'windows'
                        else null
                    end;
                alter table file_entry
                    alter column name_key set not null,
                    alter column kind type text using kind::text;
                drop type public.file_entry_kind;

                alter table file_entry
                    add constraint file_entry_kind_check
                        check (kind in ('directory', 'file')),
                    add constraint file_entry_path_syntax_check
                        check (path_syntax is null or path_syntax in ('posix', 'windows')),
                    add constraint file_entry_name_key_check
                        check (name_key = pg_catalog.convert_to(name, 'UTF8')),
                    add constraint file_entry_row_shape_check
                        check (
                            (parent_id is null
                                and kind = 'directory'
                                and path_syntax is not null
                                and absolute_path is null)
                            or (parent_id is not null
                                and kind = 'directory'
                                and path_syntax is null
                                and absolute_path is null)
                            or (parent_id is not null
                                and kind = 'file'
                                and path_syntax is not null
                                and absolute_path is not null)
                        ),
                    add constraint file_entry_absolute_path_length_check
                        check (
                            kind <> 'file'
                            or (
                                pg_catalog.char_length(absolute_path) between 1 and 16384
                                and pg_catalog.octet_length(
                                    pg_catalog.convert_to(absolute_path, 'UTF8')
                                ) <= 65536
                            )
                        ),
                    add constraint file_entry_directory_metadata_null_check
                        check (
                            kind = 'file'
                            or (
                                mime_type is null
                                and extension is null
                                and file_metadata_created_at is null
                                and file_metadata_modified_at is null
                            )
                        ),
                    add constraint file_entry_directory_content_path_null_check
                        check (kind = 'file' or content_path is null);

                create function public.file_entry_enforce_immutable_update()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.id is distinct from old.id
                        or new.device_id is distinct from old.device_id
                        or new.kind is distinct from old.kind then
                        raise exception
                            'file_entry id, device_id, and kind are immutable';
                    end if;

                    if old.kind = 'directory'
                        and (
                            new.parent_id is distinct from old.parent_id
                            or new.name is distinct from old.name
                            or new.name_key is distinct from old.name_key
                            or new.path_syntax is distinct from old.path_syntax
                            or new.absolute_path is distinct from old.absolute_path
                            or new.hierarchy_path is distinct from old.hierarchy_path
                        ) then
                        raise exception
                            'directory file_entry structure is immutable';
                    end if;

                    return new;
                end
                $function$;

                create function public.file_entry_validate_hierarchy()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                declare
                    parent_kind text;
                    parent_hierarchy_path public.ltree;
                    root_path_syntax text;
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

                    select root.path_syntax
                    into root_path_syntax
                    from file_entry as root
                    where root.device_id = new.device_id
                      and root.parent_id is null
                      and root.hierarchy_path @> new.hierarchy_path;

                    if not found then
                        raise exception
                            'file_entry hierarchy_path must belong to a root on the same device';
                    end if;

                    if new.kind = 'file'
                        and new.path_syntax is distinct from root_path_syntax then
                        raise exception
                            'file_entry path_syntax must match its root';
                    end if;

                    return new;
                end
                $function$;

                create trigger file_entry_immutable_update_trg
                before update on file_entry
                for each row
                execute function public.file_entry_enforce_immutable_update();

                create constraint trigger file_entry_hierarchy_trg
                after insert or update on file_entry
                deferrable initially immediate
                for each row
                execute function public.file_entry_validate_hierarchy();

                create unique index file_entry_roots_uidx
                    on file_entry (device_id, path_syntax, name_key)
                    where parent_id is null;
                create index file_entry_children_idx
                    on file_entry (device_id, parent_id, kind, name_key, id)
                    where parent_id is not null;
                create unique index file_entry_directory_sibling_uidx
                    on file_entry (device_id, parent_id, name_key)
                    where kind = 'directory' and parent_id is not null;
                create index file_entry_search_order_idx
                    on file_entry (device_id, kind, name_key, id)
                    where parent_id is not null;
                create index file_entry_file_mime_idx
                    on file_entry (device_id, mime_type, id)
                    where kind = 'file' and mime_type is not null;
                create index file_entry_file_extension_idx
                    on file_entry (device_id, extension, id)
                    where kind = 'file' and extension is not null;
                create index file_entry_file_modified_idx
                    on file_entry (device_id, file_metadata_modified_at, id)
                    where kind = 'file' and file_metadata_modified_at is not null;
                create index file_entry_journal_idx
                    on file_entry (device_id, updated_at desc, id desc)
                    where kind = 'file';
                "#,
            )
            .await?;
        Ok(())
    }
}
