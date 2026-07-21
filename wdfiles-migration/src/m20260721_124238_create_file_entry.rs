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
                create extension if not exists ltree with schema public;
                create extension if not exists pg_trgm with schema public;

                create table file_entry (
                    id uuid not null,
                    device_id uuid not null,
                    parent_id uuid,
                    kind text not null,
                    name text not null,
                    name_key bytea not null,
                    path_syntax text,
                    absolute_path text,
                    hierarchy_path public.ltree not null,
                    mime_type text,
                    extension text,
                    file_metadata_created_at timestamp without time zone,
                    file_metadata_modified_at timestamp without time zone,
                    created_at timestamp without time zone not null,
                    updated_at timestamp without time zone not null,
                    constraint file_entry_pkey primary key (id),
                    constraint file_entry_device_id_id_key unique (device_id, id),
                    constraint file_entry_parent_fk
                        foreign key (device_id, parent_id)
                        references file_entry (device_id, id)
                        on delete restrict,
                    constraint file_entry_kind_check
                        check (kind in ('directory', 'file')),
                    constraint file_entry_path_syntax_check
                        check (path_syntax is null or path_syntax in ('posix', 'windows')),
                    constraint file_entry_name_not_empty_check
                        check (name <> ''),
                    constraint file_entry_name_key_check
                        check (name_key = pg_catalog.convert_to(name, 'UTF8')),
                    constraint file_entry_row_shape_check
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
                    constraint file_entry_absolute_path_length_check
                        check (
                            kind <> 'file'
                            or (
                                pg_catalog.char_length(absolute_path) between 1 and 16384
                                and pg_catalog.octet_length(
                                    pg_catalog.convert_to(absolute_path, 'UTF8')
                                ) <= 65536
                            )
                        ),
                    constraint file_entry_directory_metadata_null_check
                        check (
                            kind = 'file'
                            or (
                                mime_type is null
                                and extension is null
                                and file_metadata_created_at is null
                                and file_metadata_modified_at is null
                            )
                        ),
                    constraint file_entry_mime_type_check
                        check (
                            mime_type is null
                            or (
                                pg_catalog.btrim(mime_type) <> ''
                                and pg_catalog.char_length(mime_type) <= 255
                            )
                        ),
                    constraint file_entry_extension_check
                        check (
                            extension is null
                            or (
                                pg_catalog.btrim(extension) <> ''
                                and pg_catalog.char_length(extension) <= 255
                            )
                        )
                );

                create function public.file_entry_uuid_label(entry_id uuid)
                returns public.ltree
                language sql
                immutable
                strict
                parallel safe
                security invoker
                set search_path = pg_catalog, public
                as $function$
                    select public.text2ltree(
                        'n' || pg_catalog.replace(entry_id::text, '-', '')
                    )
                $function$;

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
                create unique index file_entry_hierarchy_uidx
                    on file_entry (device_id, hierarchy_path);
                create index file_entry_children_idx
                    on file_entry (device_id, parent_id, kind, name_key, id)
                    where parent_id is not null;
                create unique index file_entry_directory_sibling_uidx
                    on file_entry (device_id, parent_id, name_key)
                    where kind = 'directory' and parent_id is not null;
                create index file_entry_hierarchy_gist_idx
                    on file_entry using gist (hierarchy_path public.gist_ltree_ops);
                create index file_entry_search_order_idx
                    on file_entry (device_id, kind, name_key, id)
                    where parent_id is not null;
                create index file_entry_name_trgm_idx
                    on file_entry using gin (name public.gin_trgm_ops)
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
                    if exists (select 1 from file_entry) then
                        raise exception 'file_entry is not empty';
                    end if;
                end
                $$;

                drop trigger file_entry_hierarchy_trg on file_entry;
                drop trigger file_entry_immutable_update_trg on file_entry;
                drop table file_entry;
                drop function public.file_entry_validate_hierarchy();
                drop function public.file_entry_enforce_immutable_update();
                drop function public.file_entry_uuid_label(uuid);
                "#,
            )
            .await?;
        Ok(())
    }
}
