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
                create type public.source_file_state_kind
                    as enum ('scanned', 'downloaded', 'changed');
                create type public.file_sync_session_mode
                    as enum ('automatic', 'explicit');
                create type public.file_sync_session_status
                    as enum (
                        'open',
                        'completed',
                        'completed_with_errors',
                        'expired'
                    );
                create type public.file_sync_batch_status
                    as enum ('processing', 'applied', 'applied_with_errors');
                create type public.file_sync_item_outcome
                    as enum ('created', 'updated', 'rejected');

                create table file_sync_session (
                    sync_id uuid primary key,
                    device_id uuid not null,
                    mode public.file_sync_session_mode not null,
                    status public.file_sync_session_status not null,
                    next_batch_index integer not null default 0,
                    received_count bigint not null default 0,
                    accepted_count bigint not null default 0,
                    created_count bigint not null default 0,
                    updated_count bigint not null default 0,
                    rejected_count bigint not null default 0,
                    created_at timestamp with time zone not null,
                    updated_at timestamp with time zone not null,
                    completed_at timestamp with time zone,
                    expires_at timestamp with time zone,
                    constraint file_sync_session_nonnegative_check
                        check (
                            next_batch_index >= 0
                            and received_count >= 0
                            and accepted_count >= 0
                            and created_count >= 0
                            and updated_count >= 0
                            and rejected_count >= 0
                        ),
                    constraint file_sync_session_count_check
                        check (
                            received_count = accepted_count + rejected_count
                            and accepted_count = created_count + updated_count
                        ),
                    constraint file_sync_session_status_shape_check
                        check (
                            (status = 'open' and completed_at is null)
                            or (
                                status in ('completed', 'completed_with_errors')
                                and completed_at is not null
                            )
                            or (status = 'expired' and completed_at is null)
                        ),
                    constraint file_sync_session_result_status_check
                        check (
                            status not in ('completed', 'completed_with_errors')
                            or (status = 'completed' and rejected_count = 0)
                            or (
                                status = 'completed_with_errors'
                                and rejected_count > 0
                            )
                        ),
                    constraint file_sync_session_expiry_shape_check
                        check (
                            (mode = 'automatic' and expires_at is null)
                            or (
                                mode = 'explicit'
                                and (
                                    (status in ('open', 'expired') and expires_at is not null)
                                    or (
                                        status in ('completed', 'completed_with_errors')
                                        and expires_at is null
                                    )
                                )
                            )
                        )
                );

                create unique index file_sync_session_open_device_uidx
                    on file_sync_session(device_id)
                    where status = 'open';
                create index file_sync_session_expiry_idx
                    on file_sync_session(status, expires_at)
                    where status = 'open';

                create table file_sync_batch (
                    sync_id uuid not null,
                    batch_index integer not null,
                    status public.file_sync_batch_status not null,
                    received_count bigint not null default 0,
                    accepted_count bigint not null default 0,
                    created_count bigint not null default 0,
                    updated_count bigint not null default 0,
                    rejected_count bigint not null default 0,
                    created_at timestamp with time zone not null,
                    applied_at timestamp with time zone,
                    constraint file_sync_batch_pkey
                        primary key (sync_id, batch_index),
                    constraint file_sync_batch_session_fk
                        foreign key (sync_id)
                        references file_sync_session(sync_id)
                        on delete restrict,
                    constraint file_sync_batch_nonnegative_check
                        check (
                            batch_index >= 0
                            and received_count >= 0
                            and accepted_count >= 0
                            and created_count >= 0
                            and updated_count >= 0
                            and rejected_count >= 0
                        ),
                    constraint file_sync_batch_count_check
                        check (
                            received_count = accepted_count + rejected_count
                            and accepted_count = created_count + updated_count
                        ),
                    constraint file_sync_batch_status_shape_check
                        check (
                            (
                                status = 'processing'
                                and applied_at is null
                                and received_count = 0
                                and accepted_count = 0
                                and created_count = 0
                                and updated_count = 0
                                and rejected_count = 0
                            )
                            or (
                                status in ('applied', 'applied_with_errors')
                                and applied_at is not null
                            )
                        ),
                    constraint file_sync_batch_result_status_check
                        check (
                            status = 'processing'
                            or (status = 'applied' and rejected_count = 0)
                            or (
                                status = 'applied_with_errors'
                                and rejected_count > 0
                            )
                        )
                );

                create table file_metadata_revision (
                    file_id uuid not null,
                    revision bigint not null,
                    device_id uuid not null,
                    sync_id uuid not null,
                    name text not null,
                    absolute_path text not null,
                    mime_type text,
                    extension text,
                    file_metadata_created_at timestamp with time zone,
                    file_metadata_modified_at timestamp with time zone,
                    source_file_state public.source_file_state_kind,
                    source_file_state_settled_at timestamp with time zone,
                    source_file_state_settled_by text,
                    created_at timestamp with time zone not null,
                    constraint file_metadata_revision_pkey
                        primary key (file_id, revision),
                    constraint file_metadata_revision_file_fk
                        foreign key (file_id)
                        references file_entry(id)
                        on delete restrict,
                    constraint file_metadata_revision_session_fk
                        foreign key (sync_id)
                        references file_sync_session(sync_id)
                        on delete restrict,
                    constraint file_metadata_revision_revision_check
                        check (revision >= 1),
                    constraint file_metadata_revision_name_check
                        check (name <> ''),
                    constraint file_metadata_revision_absolute_path_check
                        check (
                            pg_catalog.char_length(absolute_path) between 1 and 16384
                            and pg_catalog.octet_length(
                                pg_catalog.convert_to(absolute_path, 'UTF8')
                            ) <= 65536
                        ),
                    constraint file_metadata_revision_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and source_file_state_settled_by is not null
                                and pg_catalog.btrim(
                                    source_file_state_settled_by
                                ) <> ''
                            )
                        )
                );

                create function public.file_metadata_revision_reject_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    raise exception 'file_metadata_revision rows are immutable';
                end
                $function$;

                create trigger file_metadata_revision_immutable_trg
                    before update or delete on file_metadata_revision
                    for each row
                    execute function public.file_metadata_revision_reject_mutation();

                create table file_sync_item (
                    sync_id uuid not null,
                    batch_index integer not null,
                    item_index integer not null,
                    outcome public.file_sync_item_outcome,
                    file_id uuid,
                    absolute_path text not null,
                    mime_type text,
                    extension text,
                    file_metadata_created_at timestamp with time zone,
                    file_metadata_modified_at timestamp with time zone,
                    source_file_state public.source_file_state_kind,
                    source_file_state_settled_at timestamp with time zone,
                    source_file_state_settled_by text,
                    revision bigint,
                    root_id uuid,
                    error_code text,
                    error_message text,
                    field_errors jsonb not null default '[]'::jsonb,
                    created_at timestamp with time zone not null,
                    constraint file_sync_item_pkey
                        primary key (sync_id, batch_index, item_index),
                    constraint file_sync_item_batch_fk
                        foreign key (sync_id, batch_index)
                        references file_sync_batch(sync_id, batch_index)
                        on delete restrict,
                    constraint file_sync_item_file_fk
                        foreign key (file_id)
                        references file_entry(id)
                        on delete restrict,
                    constraint file_sync_item_revision_fk
                        foreign key (file_id, revision)
                        references file_metadata_revision(file_id, revision)
                        on delete restrict,
                    constraint file_sync_item_index_check
                        check (item_index >= 0),
                    constraint file_sync_item_field_errors_check
                        check (jsonb_typeof(field_errors) = 'array'),
                    constraint file_sync_item_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and source_file_state_settled_by is not null
                                and pg_catalog.btrim(
                                    source_file_state_settled_by
                                ) <> ''
                            )
                        ),
                    constraint file_sync_item_outcome_shape_check
                        check (
                            (
                                outcome is null
                                and file_id is null
                                and revision is null
                                and root_id is null
                                and error_code is null
                                and error_message is null
                                and field_errors = '[]'::jsonb
                            )
                            or (
                                outcome in ('created', 'updated')
                                and file_id is not null
                                and revision is not null
                                and root_id is not null
                                and error_code is null
                                and error_message is null
                                and field_errors = '[]'::jsonb
                            )
                            or (
                                outcome = 'rejected'
                                and file_id is null
                                and revision is null
                                and root_id is null
                                and error_code is not null
                                and error_message is not null
                            )
                        )
                );

                create unique index file_sync_item_accepted_path_uidx
                    on file_sync_item(sync_id, absolute_path)
                    where outcome in ('created', 'updated');
                create index file_sync_item_result_order_idx
                    on file_sync_item(sync_id, batch_index, item_index)
                    where outcome is not null;

                alter table file_entry
                    add column revision bigint,
                    add column sync_id uuid,
                    add column source_file_state public.source_file_state_kind,
                    add column source_file_state_settled_at timestamp with time zone,
                    add column source_file_state_settled_by text;

                drop trigger if exists device_file_track_analysis_start_trg
                    on file_analysis_device_state;
                drop function if exists public.device_file_track_analysis_start();

                drop table if exists device_file_sync_batch_entry;
                drop table if exists device_file_sync_batch;

                truncate table
                    file_sync_item,
                    file_sync_batch,
                    file_metadata_revision,
                    file_sync_session,
                    device_file_tag,
                    file_analysis_state,
                    file_analysis_reanalysis_job,
                    file_analysis_device_state,
                    file_analysis_control,
                    file_entry;

                insert into file_analysis_control (
                    id,
                    backfill_cursor,
                    backfill_complete,
                    next_generation
                ) values (true, null, true, 1);

                drop trigger file_entry_immutable_update_trg on file_entry;
                create trigger file_entry_immutable_update_trg
                    before update on file_entry
                    for each row
                    when (
                        new.id is distinct from old.id
                        or new.device_id is distinct from old.device_id
                        or new.parent_id is distinct from old.parent_id
                        or new.kind is distinct from old.kind
                        or new.name is distinct from old.name
                        or new.absolute_path is distinct from old.absolute_path
                        or new.hierarchy_path is distinct from old.hierarchy_path
                    )
                    execute function public.file_entry_enforce_immutable_update();

                drop trigger file_entry_hierarchy_trg on file_entry;
                create constraint trigger file_entry_hierarchy_trg
                    after insert on file_entry
                    deferrable initially immediate
                    for each row
                    execute function public.file_entry_validate_hierarchy();
                create constraint trigger file_entry_hierarchy_update_trg
                    after update on file_entry
                    deferrable initially immediate
                    for each row
                    when (
                        new.id is distinct from old.id
                        or new.device_id is distinct from old.device_id
                        or new.parent_id is distinct from old.parent_id
                        or new.kind is distinct from old.kind
                        or new.hierarchy_path is distinct
                            from old.hierarchy_path
                    )
                    execute function public.file_entry_validate_hierarchy();

                drop trigger file_analysis_enqueue_update_trg on file_entry;
                drop trigger file_analysis_enqueue_insert_trg on file_entry;
                drop function public.file_analysis_enqueue_file_entry();

                drop trigger file_analysis_enqueue_device_state_trg
                    on file_analysis_state;
                drop function public.file_analysis_enqueue_device_state();

                create function
                    public.file_analysis_enqueue_inserted_device_states()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    insert into file_analysis_device_state (
                        device_id,
                        pending,
                        available_at,
                        created_at,
                        updated_at
                    )
                    select
                        state.device_id,
                        true,
                        min(state.available_at),
                        clock_timestamp(),
                        clock_timestamp()
                    from new_analysis_states as state
                    where state.pending
                    group by state.device_id
                    on conflict (device_id) do update
                    set pending = true,
                        available_at = least(
                            file_analysis_device_state.available_at,
                            excluded.available_at
                        ),
                        updated_at = clock_timestamp();

                    return null;
                end
                $function$;

                create function
                    public.file_analysis_enqueue_updated_device_states()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    insert into file_analysis_device_state (
                        device_id,
                        pending,
                        available_at,
                        created_at,
                        updated_at
                    )
                    select
                        new_state.device_id,
                        true,
                        min(new_state.available_at),
                        clock_timestamp(),
                        clock_timestamp()
                    from new_analysis_states as new_state
                    join old_analysis_states as old_state
                      using (file_entry_id)
                    where new_state.pending
                      and (
                          new_state.device_id is distinct
                              from old_state.device_id
                          or new_state.source_revision is distinct
                              from old_state.source_revision
                          or new_state.required_generation is distinct
                              from old_state.required_generation
                          or new_state.pending is distinct
                              from old_state.pending
                          or new_state.available_at is distinct
                              from old_state.available_at
                      )
                    group by new_state.device_id
                    on conflict (device_id) do update
                    set pending = true,
                        available_at = least(
                            file_analysis_device_state.available_at,
                            excluded.available_at
                        ),
                        updated_at = clock_timestamp();

                    return null;
                end
                $function$;

                create trigger file_analysis_enqueue_device_state_insert_trg
                    after insert on file_analysis_state
                    referencing new table as new_analysis_states
                    for each statement
                    execute function
                        public.file_analysis_enqueue_inserted_device_states();
                create trigger file_analysis_enqueue_device_state_update_trg
                    after update on file_analysis_state
                    referencing
                        old table as old_analysis_states
                        new table as new_analysis_states
                    for each statement
                    execute function
                        public.file_analysis_enqueue_updated_device_states();

                alter table file_entry
                    add constraint file_entry_current_revision_fk
                        foreign key (id, revision)
                        references file_metadata_revision(file_id, revision)
                        on delete restrict
                        deferrable initially deferred,
                    add constraint file_entry_current_session_fk
                        foreign key (sync_id)
                        references file_sync_session(sync_id)
                        on delete restrict,
                    add constraint file_entry_sync_projection_check
                        check (
                            (
                                kind = 'file'
                                and revision is not null
                                and sync_id is not null
                                and (
                                    (
                                        source_file_state is null
                                        and source_file_state_settled_at is null
                                        and source_file_state_settled_by is null
                                    )
                                    or (
                                        source_file_state is not null
                                        and source_file_state_settled_at is not null
                                        and source_file_state_settled_by is not null
                                        and pg_catalog.btrim(
                                            source_file_state_settled_by
                                        ) <> ''
                                    )
                                )
                            )
                            or (
                                kind = 'directory'
                                and revision is null
                                and sync_id is null
                                and source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                        );

                create unique index file_entry_device_absolute_path_uidx
                    on file_entry(device_id, absolute_path)
                    where kind = 'file';

                do $$
                begin
                    if exists (select 1 from file_sync_item)
                        or exists (select 1 from file_sync_batch)
                        or exists (select 1 from file_metadata_revision)
                        or exists (select 1 from file_sync_session)
                        or exists (select 1 from device_file_tag)
                        or exists (select 1 from file_analysis_state)
                        or exists (select 1 from file_analysis_reanalysis_job)
                        or exists (select 1 from file_analysis_device_state)
                        or exists (select 1 from file_entry) then
                        raise exception 'file registry destructive reset was incomplete';
                    end if;

                    if (select count(*) from file_analysis_control) <> 1
                        or not exists (
                            select 1
                            from file_analysis_control
                            where id
                              and backfill_cursor is null
                              and backfill_complete
                              and next_generation = 1
                        ) then
                        raise exception 'file analysis control was not reset cleanly';
                    end if;

                    if not exists (
                        select 1
                        from pg_catalog.pg_index
                        where indexrelid =
                            'file_entry_device_absolute_path_uidx'::regclass
                          and indisunique
                          and indisvalid
                    ) then
                        raise exception 'current file path unique index is invalid';
                    end if;

                    if exists (
                        select 1
                        from pg_catalog.pg_constraint
                        where conname in (
                            'file_sync_session_nonnegative_check',
                            'file_sync_session_count_check',
                            'file_sync_session_status_shape_check',
                            'file_sync_session_result_status_check',
                            'file_sync_session_expiry_shape_check',
                            'file_sync_batch_nonnegative_check',
                            'file_sync_batch_count_check',
                            'file_sync_batch_status_shape_check',
                            'file_sync_batch_result_status_check',
                            'file_metadata_revision_revision_check',
                            'file_metadata_revision_source_state_check',
                            'file_sync_item_index_check',
                            'file_sync_item_source_state_check',
                            'file_sync_item_outcome_shape_check',
                            'file_entry_sync_projection_check',
                            'file_entry_current_revision_fk',
                            'file_entry_current_session_fk'
                        )
                          and not convalidated
                    ) then
                        raise exception 'batched file sync constraint is not valid';
                    end if;
                end
                $$;
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
                drop trigger if exists file_entry_hierarchy_update_trg
                    on file_entry;
                drop trigger file_entry_hierarchy_trg on file_entry;
                drop trigger file_entry_immutable_update_trg on file_entry;
                create trigger file_entry_immutable_update_trg
                    before update on file_entry
                    for each row
                    execute function public.file_entry_enforce_immutable_update();
                create constraint trigger file_entry_hierarchy_trg
                    after insert or update on file_entry
                    deferrable initially immediate
                    for each row
                    execute function public.file_entry_validate_hierarchy();

                drop trigger
                    file_analysis_enqueue_device_state_update_trg
                    on file_analysis_state;
                drop trigger
                    file_analysis_enqueue_device_state_insert_trg
                    on file_analysis_state;
                drop function
                    public.file_analysis_enqueue_updated_device_states();
                drop function
                    public.file_analysis_enqueue_inserted_device_states();

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
                        retry_exhausted,
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
                        false,
                        clock_timestamp(),
                        clock_timestamp(),
                        clock_timestamp()
                    )
                    on conflict (file_entry_id) do update
                    set device_id = excluded.device_id,
                        source_revision =
                            file_analysis_state.source_revision + 1,
                        pending = true,
                        retry_exhausted = false,
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

                drop index if exists file_entry_device_absolute_path_uidx;

                alter table file_entry
                    drop constraint if exists file_entry_current_revision_fk,
                    drop constraint if exists file_entry_current_session_fk,
                    drop constraint if exists file_entry_sync_projection_check;

                drop trigger if exists file_metadata_revision_immutable_trg
                    on file_metadata_revision;
                drop function if exists public.file_metadata_revision_reject_mutation();

                drop table if exists file_sync_item;
                drop table if exists file_sync_batch;
                drop table if exists file_metadata_revision;
                drop table if exists file_sync_session;

                alter table file_entry
                    drop column if exists revision,
                    drop column if exists sync_id,
                    drop column if exists source_file_state,
                    drop column if exists source_file_state_settled_at,
                    drop column if exists source_file_state_settled_by;

                drop type if exists public.file_sync_item_outcome;
                drop type if exists public.file_sync_batch_status;
                drop type if exists public.file_sync_session_status;
                drop type if exists public.file_sync_session_mode;
                drop type if exists public.source_file_state_kind;
                "#,
            )
            .await?;
        Ok(())
    }
}
