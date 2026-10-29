use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            create or replace function public.device_upload_finalization_bind_file()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                if new.status = 'completed' and new.winning_attempt_id is null then
                    if new.active_attempt_id is not null or new.attempt_count <> 0 or new.lease_epoch <> 0
                        or new.source_release_state <> 'released' or new.quota_released_at is null
                        or not exists (
                            select 1 from file_content_upload u
                            join file_content c on c.upload_id = u.id and c.file_id = u.file_id and c.revision = u.revision
                            join file_content_upload_object o on o.upload_id = c.upload_id and o.object_key = c.object_key
                            where u.id = new.file_upload_id and u.status = 'completed'
                                and u.finalization_job_id is null and o.attempt_id is null and o.object_key = u.object_key
                        ) then raise exception 'synchronous adoption requires original completed publication'; end if;
                    return new;
                end if;
                update file_content_upload set finalization_job_id = new.id
                where id = new.file_upload_id
                    and (finalization_job_id is null or finalization_job_id = new.id);
                if not found then raise exception 'file finalization ownership must bind its original upload'; end if;
                return new;
            end $function$;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            lock table device_upload_finalization_job, file_content_upload in access exclusive mode;
            do $$ begin
                if exists (select 1 from device_upload_finalization_job) then
                    raise exception 'cannot downgrade with retained finalization history';
                end if;
            end $$;
            create or replace function public.device_upload_finalization_bind_file()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                update file_content_upload set finalization_job_id = new.id
                where id = new.file_upload_id
                    and (finalization_job_id is null or finalization_job_id = new.id);
                if not found then raise exception 'file finalization ownership must bind its original upload'; end if;
                return new;
            end $function$;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
