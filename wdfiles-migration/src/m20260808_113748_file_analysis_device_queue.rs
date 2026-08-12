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
                create table file_analysis_device_state (
                    device_id uuid primary key,
                    pending boolean not null default true,
                    lease_token uuid,
                    lease_expires_at timestamp with time zone,
                    available_at timestamp with time zone not null default now(),
                    created_at timestamp with time zone not null default now(),
                    updated_at timestamp with time zone not null default now(),
                    constraint file_analysis_device_state_lease_shape_check
                        check (
                            (lease_token is null and lease_expires_at is null)
                            or (lease_token is not null and lease_expires_at is not null)
                        ),
                    constraint file_analysis_device_state_lease_pending_check
                        check (lease_token is null or pending)
                );

                create index file_analysis_device_state_pending_idx
                    on file_analysis_device_state(available_at, device_id)
                    where pending and lease_token is null;

                create index file_analysis_device_state_lease_idx
                    on file_analysis_device_state(lease_expires_at, device_id)
                    where pending and lease_token is not null;

                create index file_analysis_state_device_pending_idx
                    on file_analysis_state(device_id, available_at, file_entry_id)
                    where pending;

                create index file_analysis_state_device_analyzed_idx
                    on file_analysis_state(device_id, analyzed_rule_revision)
                    where not pending;

                create function public.file_analysis_enqueue_device_state()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if not new.pending then
                        return new;
                    end if;

                    insert into file_analysis_device_state (
                        device_id,
                        pending,
                        available_at,
                        created_at,
                        updated_at
                    ) values (
                        new.device_id,
                        true,
                        new.available_at,
                        clock_timestamp(),
                        clock_timestamp()
                    )
                    on conflict (device_id) do update
                    set pending = true,
                        available_at = least(
                            file_analysis_device_state.available_at,
                            excluded.available_at
                        ),
                        updated_at = clock_timestamp();

                    return new;
                end
                $function$;

                create trigger file_analysis_enqueue_device_state_trg
                    after insert or update of
                        device_id,
                        source_revision,
                        required_generation,
                        pending,
                        available_at
                    on file_analysis_state
                    for each row
                    execute function public.file_analysis_enqueue_device_state();

                create function public.file_analysis_enqueue_reanalysis_device()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.device_id is null or new.expanded_at is not null then
                        return new;
                    end if;

                    insert into file_analysis_device_state (
                        device_id,
                        pending,
                        available_at,
                        created_at,
                        updated_at
                    ) values (
                        new.device_id,
                        true,
                        clock_timestamp(),
                        clock_timestamp(),
                        clock_timestamp()
                    )
                    on conflict (device_id) do update
                    set pending = true,
                        available_at = least(
                            file_analysis_device_state.available_at,
                            excluded.available_at
                        ),
                        updated_at = clock_timestamp();

                    return new;
                end
                $function$;

                create trigger file_analysis_enqueue_reanalysis_device_trg
                    after insert on file_analysis_reanalysis_job
                    for each row
                    execute function public.file_analysis_enqueue_reanalysis_device();

                insert into file_analysis_device_state (
                    device_id,
                    pending,
                    available_at,
                    created_at,
                    updated_at
                )
                select
                    device_id,
                    true,
                    min(available_at),
                    clock_timestamp(),
                    clock_timestamp()
                from file_analysis_state
                where pending
                group by device_id
                on conflict (device_id) do update
                set pending = true,
                    available_at = least(
                        file_analysis_device_state.available_at,
                        excluded.available_at
                    ),
                    updated_at = clock_timestamp();

                insert into file_analysis_device_state (
                    device_id,
                    pending,
                    available_at,
                    created_at,
                    updated_at
                )
                select
                    device_id,
                    true,
                    clock_timestamp(),
                    clock_timestamp(),
                    clock_timestamp()
                from file_analysis_reanalysis_job
                where device_id is not null and expanded_at is null
                group by device_id
                on conflict (device_id) do update
                set pending = true,
                    available_at = least(
                        file_analysis_device_state.available_at,
                        excluded.available_at
                    ),
                    updated_at = clock_timestamp();
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
                drop trigger if exists file_analysis_enqueue_reanalysis_device_trg
                    on file_analysis_reanalysis_job;
                drop function if exists public.file_analysis_enqueue_reanalysis_device();
                drop trigger if exists file_analysis_enqueue_device_state_trg
                    on file_analysis_state;
                drop function if exists public.file_analysis_enqueue_device_state();
                drop index if exists file_analysis_state_device_analyzed_idx;
                drop index if exists file_analysis_state_device_pending_idx;
                drop table if exists file_analysis_device_state;
                "#,
            )
            .await?;
        Ok(())
    }
}
