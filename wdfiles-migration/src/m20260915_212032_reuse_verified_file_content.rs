use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            alter table file_content_upload
                add constraint file_content_upload_verified_identity_key
                unique (id, file_id, object_key, upload_length, expected_sha256);
            alter table file_content
                drop constraint file_content_upload_binding_fk,
                drop constraint file_content_upload_id_key,
                drop constraint file_content_object_key_key,
                add constraint file_content_verified_upload_binding_fk
                foreign key (upload_id, file_id, object_key, source_size_bytes, source_sha256)
                references file_content_upload (id, file_id, object_key, upload_length, expected_sha256)
                on delete restrict;
            create index file_content_upload_id_idx on file_content(upload_id);
            create index file_content_object_key_idx on file_content(object_key);

            create function public.file_content_verify_reuse()
            returns trigger language plpgsql security invoker
            set search_path = pg_catalog, public as $function$
            declare source_revision bigint;
            begin
                select revision into source_revision from file_content_upload
                    where id = new.upload_id and file_id = new.file_id;
                if source_revision is not null and new.revision <> source_revision then
                    if new.revision < source_revision or not exists (
                        select 1 from file_content c
                        join file_content_upload u on u.id = c.upload_id
                        where u.id = new.upload_id and u.status = 'completed'
                            and c.file_id = new.file_id and c.revision = source_revision
                            and c.object_key = new.object_key
                            and c.source_size_bytes = new.source_size_bytes
                            and c.source_sha256 = new.source_sha256
                            and c.is_encrypted = new.is_encrypted
                    ) then
                        raise exception 'file_content reuse requires verified original content';
                    end if;
                end if;
                return new;
            end
            $function$;
            create trigger file_content_verify_reuse_trg before insert on file_content
                for each row execute function public.file_content_verify_reuse();
        "#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            do $$ begin
                if exists (select 1 from file_content c join file_content_upload u on u.id = c.upload_id
                    where c.revision <> u.revision) then
                    raise exception 'cannot remove verified content reuse while reused revisions exist';
                end if;
            end $$;
            drop trigger file_content_verify_reuse_trg on file_content;
            drop function public.file_content_verify_reuse();
            drop index file_content_upload_id_idx;
            drop index file_content_object_key_idx;
            alter table file_content
                drop constraint file_content_verified_upload_binding_fk,
                add constraint file_content_upload_id_key unique (upload_id),
                add constraint file_content_object_key_key unique (object_key),
                add constraint file_content_upload_binding_fk
                foreign key (upload_id, file_id, revision, object_key, source_size_bytes, source_sha256)
                references file_content_upload (id, file_id, revision, object_key, upload_length, expected_sha256)
                on delete restrict;
            alter table file_content_upload drop constraint file_content_upload_verified_identity_key;
        "#).await?;
        Ok(())
    }
}
