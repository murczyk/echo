use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            alter table file_content_upload
                add column finalization_job_id uuid references device_upload_finalization_job(id) on delete restrict;

            create function public.file_content_upload_finalization_guard()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                if tg_op = 'UPDATE' and old.finalization_job_id is not null
                    and new.finalization_job_id is distinct from old.finalization_job_id then
                    raise exception 'file finalization ownership is immutable';
                end if;
                if new.finalization_job_id is not null and not exists (
                    select 1 from device_upload_finalization_job j
                    where j.id = new.finalization_job_id and j.kind = 'file'
                        and j.file_upload_id = new.id and j.source_identity = new.id::text
                        and row(j.device_id, j.file_id, j.revision, j.created_by_login_id, j.source_size_bytes)
                            = row(new.device_id, new.file_id, new.revision, new.created_by_login_id, new.upload_length)
                ) then raise exception 'file finalization ownership must bind its original upload'; end if;
                return new;
            end $function$;
            create trigger file_content_upload_finalization_trg
                before insert or update of finalization_job_id on file_content_upload
                for each row execute function public.file_content_upload_finalization_guard();

            create function public.device_upload_finalization_bind_file()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                update file_content_upload set finalization_job_id = new.id
                where id = new.file_upload_id
                    and (finalization_job_id is null or finalization_job_id = new.id);
                if not found then raise exception 'file finalization ownership must bind its original upload'; end if;
                return new;
            end $function$;
            create trigger device_upload_finalization_bind_file_trg
                after insert on device_upload_finalization_job
                for each row when (new.kind = 'file')
                execute function public.device_upload_finalization_bind_file();

            update file_content_upload u set finalization_job_id = j.id
            from device_upload_finalization_job j
            where j.kind = 'file' and j.file_upload_id = u.id;

            drop index file_content_upload_reserved_count_idx;
            create index file_content_upload_reserved_count_idx
                on file_content_upload(created_by_login_id)
                include (upload_length, spool_removed_at)
                where spool_removed_at is null
                    or (status <> 'completed' and finalization_job_id is null);
            drop index file_content_upload_cleanup_idx;
            create index file_content_upload_cleanup_idx
                on file_content_upload(next_cleanup_at, id)
                where next_cleanup_at is not null and finalization_job_id is null;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            lock table device_upload_finalization_job, file_content_upload in access exclusive mode;
            do $$ begin
                if exists (select 1 from file_content_upload where finalization_job_id is not null) then
                    raise exception 'cannot downgrade with file finalization ownership evidence';
                end if;
            end $$;
            drop trigger device_upload_finalization_bind_file_trg on device_upload_finalization_job;
            drop function public.device_upload_finalization_bind_file();
            drop trigger file_content_upload_finalization_trg on file_content_upload;
            drop function public.file_content_upload_finalization_guard();
            drop index file_content_upload_reserved_count_idx;
            create index file_content_upload_reserved_count_idx
                on file_content_upload(created_by_login_id)
                where spool_removed_at is null or status <> 'completed';
            drop index file_content_upload_cleanup_idx;
            create index file_content_upload_cleanup_idx
                on file_content_upload(next_cleanup_at, id)
                where next_cleanup_at is not null;
            alter table file_content_upload drop column finalization_job_id;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
