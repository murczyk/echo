use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            lock table device_upload_finalization_job in share row exclusive mode;
            create table device_upload_finalization_terminal_metric (
                kind text not null check (kind in ('file', 'audio')),
                status text not null check (status in ('completed', 'failed')),
                jobs bigint not null check (jobs > 0),
                oldest_created_at timestamptz not null check (isfinite(oldest_created_at)),
                primary key (kind, status)
            );
            insert into device_upload_finalization_terminal_metric (kind, status, jobs, oldest_created_at)
                select kind, status, count(*), min(created_at)
                from device_upload_finalization_job
                where status in ('completed', 'failed')
                group by kind, status;

            create function public.device_upload_finalization_record_terminal_metric()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                if tg_op = 'UPDATE' then
                    if old.status in ('completed', 'failed') then return new; end if;
                end if;
                insert into public.device_upload_finalization_terminal_metric (kind, status, jobs, oldest_created_at)
                    values (new.kind, new.status, 1, new.created_at)
                    on conflict (kind, status) do update
                    set jobs = device_upload_finalization_terminal_metric.jobs + 1,
                        oldest_created_at = least(device_upload_finalization_terminal_metric.oldest_created_at,
                            excluded.oldest_created_at);
                return new;
            end $function$;
            create trigger device_upload_finalization_terminal_metric_trg
                after insert or update of status on device_upload_finalization_job
                for each row when (new.status in ('completed', 'failed'))
                execute function public.device_upload_finalization_record_terminal_metric();
            create index device_upload_finalization_active_metrics_idx
                on device_upload_finalization_job (kind, status, created_at)
                where status in ('queued', 'processing', 'retry_wait', 'outcome_unknown');
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            lock table device_upload_finalization_job in share row exclusive mode;
            drop trigger device_upload_finalization_terminal_metric_trg on device_upload_finalization_job;
            drop function public.device_upload_finalization_record_terminal_metric();
            drop table device_upload_finalization_terminal_metric;
            drop index device_upload_finalization_active_metrics_idx;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
