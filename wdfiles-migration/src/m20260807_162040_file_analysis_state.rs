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
                create table file_analysis_control (
                    id boolean primary key default true,
                    backfill_cursor uuid,
                    backfill_complete boolean not null default false,
                    next_generation bigint not null default 1,
                    created_at timestamp with time zone not null default now(),
                    updated_at timestamp with time zone not null default now(),
                    constraint file_analysis_control_singleton_check
                        check (id),
                    constraint file_analysis_control_next_generation_check
                        check (next_generation > 0)
                );

                insert into file_analysis_control (id) values (true);

                create table file_analysis_state (
                    file_entry_id uuid primary key
                        references file_entry(id) on delete cascade,
                    device_id uuid not null,
                    source_revision bigint not null default 1,
                    analyzed_source_revision bigint not null default 0,
                    required_generation bigint not null default 0,
                    analyzed_generation bigint not null default 0,
                    analyzed_rule_revision bigint not null default 0,
                    pending boolean not null default true,
                    lease_token uuid,
                    lease_expires_at timestamp with time zone,
                    available_at timestamp with time zone not null default now(),
                    attempt_count integer not null default 0,
                    last_error text,
                    last_attempt_at timestamp with time zone,
                    created_at timestamp with time zone not null default now(),
                    updated_at timestamp with time zone not null default now(),
                    constraint file_analysis_state_source_revision_check
                        check (source_revision > 0),
                    constraint file_analysis_state_analyzed_source_revision_check
                        check (
                            analyzed_source_revision >= 0
                            and analyzed_source_revision <= source_revision
                        ),
                    constraint file_analysis_state_required_generation_check
                        check (required_generation >= 0),
                    constraint file_analysis_state_analyzed_generation_check
                        check (
                            analyzed_generation >= 0
                            and analyzed_generation <= required_generation
                        ),
                    constraint file_analysis_state_rule_revision_check
                        check (analyzed_rule_revision >= 0),
                    constraint file_analysis_state_pending_check
                        check (
                            pending = (
                                analyzed_source_revision < source_revision
                                or analyzed_generation < required_generation
                            )
                        ),
                    constraint file_analysis_state_lease_shape_check
                        check (
                            (lease_token is null and lease_expires_at is null)
                            or (lease_token is not null and lease_expires_at is not null)
                        ),
                    constraint file_analysis_state_lease_pending_check
                        check (lease_token is null or pending),
                    constraint file_analysis_state_attempt_count_check
                        check (attempt_count >= 0),
                    constraint file_analysis_state_last_error_length_check
                        check (
                            last_error is null
                            or pg_catalog.octet_length(last_error) <= 4096
                        )
                );

                create index file_analysis_state_pending_idx
                    on file_analysis_state(available_at, file_entry_id)
                    where pending and lease_token is null;

                create index file_analysis_state_lease_idx
                    on file_analysis_state(lease_expires_at, file_entry_id)
                    where pending and lease_token is not null;

                create table file_analysis_reanalysis_job (
                    id uuid primary key,
                    device_id uuid,
                    target_rule_revision bigint not null,
                    generation bigint not null unique,
                    upper_file_entry_id uuid not null,
                    cursor_file_entry_id uuid,
                    scheduled_file_count bigint not null,
                    expanded_file_count bigint not null default 0,
                    expanded_at timestamp with time zone,
                    created_at timestamp with time zone not null default now(),
                    updated_at timestamp with time zone not null default now(),
                    constraint file_analysis_reanalysis_job_rule_revision_check
                        check (target_rule_revision >= 0),
                    constraint file_analysis_reanalysis_job_generation_check
                        check (generation > 0),
                    constraint file_analysis_reanalysis_job_cursor_check
                        check (
                            cursor_file_entry_id is null
                            or cursor_file_entry_id <= upper_file_entry_id
                        ),
                    constraint file_analysis_reanalysis_job_scheduled_count_check
                        check (scheduled_file_count > 0),
                    constraint file_analysis_reanalysis_job_expanded_count_check
                        check (expanded_file_count >= 0)
                );

                create unique index file_analysis_reanalysis_job_active_scope_uidx
                    on file_analysis_reanalysis_job(
                        coalesce(
                            device_id,
                            '00000000-0000-0000-0000-000000000000'::uuid
                        ),
                        target_rule_revision
                    )
                    where expanded_at is null;

                create index file_analysis_reanalysis_job_pending_idx
                    on file_analysis_reanalysis_job(created_at, id)
                    where expanded_at is null;

                create function public.file_analysis_enqueue_file_entry()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.kind <> 'file' then
                        return new;
                    end if;

                    if tg_op = 'UPDATE'
                        and new.name is not distinct from old.name
                        and new.absolute_path is not distinct from old.absolute_path
                        and new.extension is not distinct from old.extension then
                        return new;
                    end if;

                    insert into file_analysis_state (
                        file_entry_id,
                        device_id,
                        source_revision,
                        analyzed_source_revision,
                        required_generation,
                        analyzed_generation,
                        analyzed_rule_revision,
                        pending,
                        available_at,
                        created_at,
                        updated_at
                    ) values (
                        new.id,
                        new.device_id,
                        1,
                        0,
                        0,
                        0,
                        0,
                        true,
                        clock_timestamp(),
                        clock_timestamp(),
                        clock_timestamp()
                    )
                    on conflict (file_entry_id) do update
                    set device_id = excluded.device_id,
                        source_revision = file_analysis_state.source_revision + 1,
                        pending = true,
                        available_at = clock_timestamp(),
                        attempt_count = 0,
                        last_error = null,
                        updated_at = clock_timestamp();

                    return new;
                end
                $function$;

                create trigger file_analysis_enqueue_insert_trg
                    after insert on file_entry
                    for each row
                    execute function public.file_analysis_enqueue_file_entry();

                create trigger file_analysis_enqueue_update_trg
                    after update of name, absolute_path, extension on file_entry
                    for each row
                    execute function public.file_analysis_enqueue_file_entry();
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
                drop trigger if exists file_analysis_enqueue_update_trg
                    on file_entry;
                drop trigger if exists file_analysis_enqueue_insert_trg
                    on file_entry;
                drop function if exists public.file_analysis_enqueue_file_entry();
                drop table if exists file_analysis_reanalysis_job;
                drop table if exists file_analysis_state;
                drop table if exists file_analysis_control;
                "#,
            )
            .await?;
        Ok(())
    }
}
