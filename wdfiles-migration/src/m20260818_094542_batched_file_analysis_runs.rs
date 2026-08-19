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
                    if to_regprocedure('uuid_generate_v7()') is null then
                        if to_regprocedure('uuidv7()') is not null then
                            execute 'create function uuid_generate_v7() returns uuid language sql volatile parallel safe as ''select pg_catalog.uuidv7()''';
                        else
                            create extension if not exists pg_uuidv7;
                        end if;
                    end if;
                end
                $$;

                do $$
                begin
                    if exists (
                        select 1
                        from file_analysis_state
                        where lease_token is not null
                          and lease_expires_at > clock_timestamp()
                    ) or exists (
                        select 1
                        from file_analysis_device_state
                        where lease_token is not null
                          and lease_expires_at > clock_timestamp()
                    ) then
                        raise exception
                            'active legacy file analysis leases must drain before cutover';
                    end if;
                end
                $$;

                drop trigger if exists
                    file_analysis_enqueue_insert_trg
                    on file_entry;
                drop trigger if exists
                    file_analysis_enqueue_update_trg
                    on file_entry;
                drop function if exists
                    public.file_analysis_enqueue_file_entry();
                drop trigger if exists
                    file_analysis_enqueue_reanalysis_device_trg
                    on file_analysis_reanalysis_job;
                drop function if exists
                    public.file_analysis_enqueue_reanalysis_device();
                drop trigger if exists
                    file_analysis_enqueue_device_state_update_trg
                    on file_analysis_state;
                drop trigger if exists
                    file_analysis_enqueue_device_state_insert_trg
                    on file_analysis_state;
                drop function if exists
                    public.file_analysis_enqueue_updated_device_states();
                drop function if exists
                    public.file_analysis_enqueue_inserted_device_states();

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

                drop table file_analysis_reanalysis_job;
                drop table file_analysis_state;
                drop table file_analysis_device_state;
                drop table file_analysis_control;
                drop table analytics_tag_rule_set_state;

                alter table file_metadata_revision
                    add column source_sequence bigint not null,
                    add column analysis_input_revision bigint not null,
                    add constraint file_metadata_revision_input_fk
                        foreign key (id, analysis_input_revision)
                        references file_metadata_revision(id, revision)
                        on delete restrict,
                    add constraint file_metadata_revision_source_sequence_key
                        unique (device_id, source_sequence),
                    add constraint file_metadata_revision_analysis_check
                        check (
                            source_sequence > 0
                            and analysis_input_revision between 1 and revision
                        );

                create index file_metadata_revision_device_file_source_idx
                    on file_metadata_revision(
                        device_id,
                        id,
                        source_sequence desc
                    );
                create index file_metadata_revision_sync_file_idx
                    on file_metadata_revision(sync_id, id);

                alter table file_entry
                    drop constraint file_entry_sync_projection_check,
                    add column analysis_input_revision bigint,
                    add column current_analysis_run_id uuid;

                create table file_device_source_state (
                    id uuid primary key,
                    last_source_sequence bigint not null default 0,
                    constraint file_device_source_state_sequence_check
                        check (last_source_sequence >= 0)
                );

                create table file_analysis_definition (
                    id uuid primary key default uuid_generate_v7(),
                    definition_sequence bigint generated always as identity,
                    analyzer_version integer not null,
                    dsl_version integer not null,
                    rules jsonb not null,
                    created_at timestamp with time zone not null
                        default clock_timestamp(),
                    constraint file_analysis_definition_sequence_key
                        unique (definition_sequence),
                    constraint file_analysis_definition_version_check
                        check (analyzer_version > 0 and dsl_version > 0),
                    constraint file_analysis_definition_rules_check
                        check (jsonb_typeof(rules) = 'array')
                );

                create function
                    public.file_analysis_definition_reject_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    raise exception
                        'file_analysis_definition rows are immutable';
                end
                $function$;

                create trigger file_analysis_definition_immutable_trg
                    before update or delete on file_analysis_definition
                    for each row
                    execute function
                        public.file_analysis_definition_reject_mutation();

                create table file_analysis_run (
                    id uuid primary key default uuid_generate_v7(),
                    run_sequence bigint generated always as identity,
                    device_id uuid not null,
                    sync_id uuid,
                    target_source_sequence bigint,
                    definition_id uuid not null,
                    item_count bigint not null default 0,
                    completed_count bigint not null default 0,
                    created_at timestamp with time zone not null
                        default clock_timestamp(),
                    prepared_at timestamp with time zone,
                    completed_at timestamp with time zone,
                    constraint file_analysis_run_sequence_key
                        unique (run_sequence),
                    constraint file_analysis_run_sync_fk
                        foreign key (sync_id)
                        references file_sync_session(id)
                        on delete restrict,
                    constraint file_analysis_run_definition_fk
                        foreign key (definition_id)
                        references file_analysis_definition(id)
                        on delete restrict,
                    constraint file_analysis_run_cause_check
                        check (
                            (sync_id is not null)
                            <> (target_source_sequence is not null)
                            and (
                                target_source_sequence is null
                                or target_source_sequence >= 0
                            )
                        ),
                    constraint file_analysis_run_count_check
                        check (
                            item_count >= 0
                            and completed_count >= 0
                            and completed_count <= item_count
                            and (
                                prepared_at is not null
                                or (
                                    completed_count = 0
                                    and completed_at is null
                                )
                            )
                            and (
                                (completed_at is not null)
                                = (
                                    prepared_at is not null
                                    and completed_count = item_count
                                )
                            )
                        )
                );

                create unique index file_analysis_run_sync_uidx
                    on file_analysis_run(sync_id)
                    where sync_id is not null;
                create index file_analysis_run_device_sequence_idx
                    on file_analysis_run(device_id, run_sequence desc);
                create index file_analysis_run_preparing_idx
                    on file_analysis_run(run_sequence)
                    where prepared_at is null;
                create index file_analysis_run_running_idx
                    on file_analysis_run(run_sequence)
                    where prepared_at is not null and completed_at is null;

                create function
                    public.file_analysis_run_reject_invalid_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if tg_op = 'DELETE' then
                        raise exception 'file_analysis_run rows cannot be deleted';
                    end if;
                    if new.id is distinct from old.id
                        or new.run_sequence is distinct from old.run_sequence
                        or new.device_id is distinct from old.device_id
                        or new.sync_id is distinct from old.sync_id
                        or new.target_source_sequence is distinct
                            from old.target_source_sequence
                        or new.definition_id is distinct from old.definition_id
                        or new.created_at is distinct from old.created_at
                        or (
                            old.prepared_at is not null
                            and new.item_count is distinct from old.item_count
                        )
                        or (
                            old.prepared_at is not null
                            and new.prepared_at is distinct from old.prepared_at
                        )
                        or (
                            old.completed_at is not null
                            and new is distinct from old
                        ) then
                        raise exception
                            'immutable file_analysis_run fields changed';
                    end if;
                    return new;
                end
                $function$;

                create trigger file_analysis_run_mutation_guard_trg
                    before update or delete on file_analysis_run
                    for each row
                    execute function
                        public.file_analysis_run_reject_invalid_mutation();

                create table file_analysis_run_item (
                    id uuid not null,
                    file_id uuid not null,
                    metadata_revision bigint not null,
                    lease_token uuid,
                    lease_expires_at timestamp with time zone,
                    result_tag_ids uuid[],
                    completed_at timestamp with time zone,
                    constraint file_analysis_run_item_pkey
                        primary key (id, file_id),
                    constraint file_analysis_run_item_run_fk
                        foreign key (id)
                        references file_analysis_run(id)
                        on delete restrict,
                    constraint file_analysis_run_item_revision_fk
                        foreign key (file_id, metadata_revision)
                        references file_metadata_revision(id, revision)
                        on delete restrict,
                    constraint file_analysis_run_item_lease_check
                        check (
                            (lease_token is null)
                            = (lease_expires_at is null)
                        ),
                    constraint file_analysis_run_item_result_check
                        check (
                            (completed_at is null)
                            = (result_tag_ids is null)
                            and (
                                completed_at is null
                                or (
                                    lease_token is null
                                    and lease_expires_at is null
                                )
                            )
                            and (
                                result_tag_ids is null
                                or array_position(result_tag_ids, null) is null
                            )
                        )
                );

                create index file_analysis_run_item_pending_idx
                    on file_analysis_run_item(
                        id,
                        lease_expires_at,
                        file_id
                    )
                    where completed_at is null;
                create index file_analysis_run_item_file_idx
                    on file_analysis_run_item(file_id, id);

                create function
                    public.file_analysis_run_item_reject_invalid_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if tg_op = 'INSERT' then
                        perform run.id
                        from file_analysis_run as run
                        where run.id = new.id
                          and run.prepared_at is null
                        for update;
                        if not found then
                            raise exception
                                'prepared analysis runs have a fixed item set';
                        end if;
                        return new;
                    end if;
                    if tg_op = 'DELETE' then
                        raise exception
                            'file_analysis_run_item rows cannot be deleted';
                    end if;
                    if new.result_tag_ids is not null then
                        if new.result_tag_ids <> (
                            select coalesce(
                                array_agg(
                                    canonical.tag_id
                                    order by canonical.tag_id
                                ),
                                '{}'::uuid[]
                            )
                            from (
                                select distinct result.tag_id
                                from unnest(new.result_tag_ids)
                                    as result(tag_id)
                            ) as canonical
                        ) then
                            raise exception
                                'analysis result tag IDs must be sorted and unique';
                        end if;
                        if exists (
                            select 1
                            from unnest(new.result_tag_ids)
                                as result(tag_id)
                            where not exists (
                                select 1
                                from file_analysis_run as run
                                join file_analysis_definition as definition
                                  on definition.id = run.definition_id
                                cross join lateral jsonb_array_elements(
                                    definition.rules
                                ) as rule(value)
                                where run.id = new.id
                                  and rule.value ->> 'tag_id'
                                    = result.tag_id::text
                            )
                        ) then
                            raise exception
                                'analysis result tag ID is not in the run definition';
                        end if;
                    end if;
                    if new.id is distinct from old.id
                        or new.file_id is distinct from old.file_id
                        or new.metadata_revision is distinct
                            from old.metadata_revision
                        or (
                            old.completed_at is not null
                            and new is distinct from old
                        )
                        or (
                            old.result_tag_ids is not null
                            and new.result_tag_ids is distinct
                                from old.result_tag_ids
                        ) then
                        raise exception
                            'immutable file_analysis_run_item fields changed';
                    end if;
                    return new;
                end
                $function$;

                create trigger file_analysis_run_item_mutation_guard_trg
                    before insert or update or delete
                    on file_analysis_run_item
                    for each row
                    execute function
                        public.file_analysis_run_item_reject_invalid_mutation();

                create function public.analytics_tag_reject_referenced_delete()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if exists (
                        select 1
                        from file_analysis_definition as definition
                        cross join lateral jsonb_array_elements(
                            definition.rules
                        ) as rule(value)
                        where rule.value ->> 'tag_id' = old.id::text
                    ) or exists (
                        select 1
                        from file_analysis_run_item as item
                        where old.id = any(item.result_tag_ids)
                    ) then
                        raise exception
                            'analytics_tag is referenced by retained analysis history';
                    end if;
                    return old;
                end
                $function$;

                create trigger analytics_tag_referenced_delete_guard_trg
                    before delete on analytics_tag
                    for each row
                    execute function
                        public.analytics_tag_reject_referenced_delete();

                alter table file_entry
                    add constraint file_entry_analysis_input_fk
                        foreign key (id, analysis_input_revision)
                        references file_metadata_revision(id, revision)
                        on delete restrict
                        deferrable initially deferred,
                    add constraint file_entry_current_analysis_fk
                        foreign key (current_analysis_run_id, id)
                        references file_analysis_run_item(id, file_id)
                        on delete restrict,
                    add constraint file_entry_sync_projection_check
                        check (
                            (
                                kind = 'file'
                                and revision is not null
                                and sync_id is not null
                                and analysis_input_revision is not null
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
                                and analysis_input_revision is null
                                and current_analysis_run_id is null
                                and source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                        );

                create function
                    public.file_entry_reject_invalid_current_analysis()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.current_analysis_run_id is null then
                        return new;
                    end if;
                    if not exists (
                        select 1
                        from file_analysis_run_item as item
                        join file_metadata_revision as target
                          on target.id = item.file_id
                         and target.revision = item.metadata_revision
                        where item.id = new.current_analysis_run_id
                          and item.file_id = new.id
                          and item.completed_at is not null
                          and target.analysis_input_revision =
                              new.analysis_input_revision
                    ) then
                        raise exception
                            'current file analysis must be complete and match the current evaluator input';
                    end if;
                    return new;
                end
                $function$;

                create constraint trigger
                    file_entry_current_analysis_guard_trg
                    after insert or update on file_entry
                    deferrable initially deferred
                    for each row
                    execute function
                        public.file_entry_reject_invalid_current_analysis();

                do $$
                begin
                    if exists (select 1 from file_sync_item)
                        or exists (select 1 from file_sync_batch)
                        or exists (select 1 from file_metadata_revision)
                        or exists (select 1 from file_sync_session)
                        or exists (select 1 from device_file_tag)
                        or exists (select 1 from file_analysis_run)
                        or exists (select 1 from file_analysis_run_item)
                        or exists (select 1 from file_device_source_state)
                        or exists (select 1 from file_entry) then
                        raise exception
                            'file registry destructive reset was incomplete';
                    end if;

                    if to_regclass('public.file_analysis_state') is not null
                        or to_regclass(
                            'public.file_analysis_reanalysis_job'
                        ) is not null
                        or to_regclass(
                            'public.file_analysis_device_state'
                        ) is not null
                        or to_regclass(
                            'public.file_analysis_control'
                        ) is not null
                        or to_regclass(
                            'public.analytics_tag_rule_set_state'
                        ) is not null then
                        raise exception 'legacy file analysis schema remains';
                    end if;

                    if exists (
                        select 1
                        from pg_catalog.pg_constraint
                        where conname in (
                            'file_metadata_revision_input_fk',
                            'file_metadata_revision_analysis_check',
                            'file_analysis_run_count_check',
                            'file_analysis_run_item_result_check',
                            'file_entry_sync_projection_check',
                            'file_entry_analysis_input_fk',
                            'file_entry_current_analysis_fk'
                        )
                          and not convalidated
                    ) then
                        raise exception
                            'batched file analysis constraint is not valid';
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
                drop trigger file_entry_current_analysis_guard_trg
                    on file_entry;
                drop function
                    public.file_entry_reject_invalid_current_analysis();

                alter table file_entry
                    drop constraint file_entry_current_analysis_fk,
                    drop constraint file_entry_analysis_input_fk,
                    drop constraint file_entry_sync_projection_check;

                drop trigger analytics_tag_referenced_delete_guard_trg
                    on analytics_tag;
                drop function public.analytics_tag_reject_referenced_delete();

                drop table file_analysis_run_item;
                drop function
                    public.file_analysis_run_item_reject_invalid_mutation();
                drop table file_analysis_run;
                drop function public.file_analysis_run_reject_invalid_mutation();
                drop table file_analysis_definition;
                drop function public.file_analysis_definition_reject_mutation();
                drop table file_device_source_state;

                alter table file_entry
                    drop column current_analysis_run_id,
                    drop column analysis_input_revision,
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

                drop index file_metadata_revision_sync_file_idx;
                drop index file_metadata_revision_device_file_source_idx;
                alter table file_metadata_revision
                    drop constraint file_metadata_revision_analysis_check,
                    drop constraint file_metadata_revision_source_sequence_key,
                    drop constraint file_metadata_revision_input_fk,
                    drop column analysis_input_revision,
                    drop column source_sequence;

                create table analytics_tag_rule_set_state (
                    id boolean primary key default true,
                    revision bigint not null default 0,
                    constraint analytics_tag_rule_set_state_singleton_check
                        check (id),
                    constraint analytics_tag_rule_set_state_revision_check
                        check (revision >= 0)
                );
                insert into analytics_tag_rule_set_state (id, revision)
                    values (true, 0);

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
                insert into file_analysis_control (
                    id,
                    backfill_cursor,
                    backfill_complete,
                    next_generation
                ) values (true, null, true, 1);

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
                    retry_exhausted boolean not null default false,
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
                                not retry_exhausted
                                and (
                                    analyzed_source_revision < source_revision
                                    or analyzed_generation < required_generation
                                )
                            )
                        ),
                    constraint file_analysis_state_lease_shape_check
                        check (
                            (lease_token is null and lease_expires_at is null)
                            or (
                                lease_token is not null
                                and lease_expires_at is not null
                            )
                        ),
                    constraint file_analysis_state_lease_pending_check
                        check (lease_token is null or pending),
                    constraint file_analysis_state_attempt_count_check
                        check (attempt_count >= 0 and attempt_count <= 10),
                    constraint file_analysis_state_retry_exhausted_check
                        check (
                            not retry_exhausted
                            or (
                                attempt_count = 10
                                and (
                                    analyzed_source_revision < source_revision
                                    or analyzed_generation < required_generation
                                )
                            )
                        ),
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
                create index file_analysis_state_device_pending_idx
                    on file_analysis_state(device_id, available_at, file_entry_id)
                    where pending;
                create index file_analysis_state_device_analyzed_idx
                    on file_analysis_state(device_id, analyzed_rule_revision)
                    where not pending;

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
                            or (
                                lease_token is not null
                                and lease_expires_at is not null
                            )
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

                create function
                    public.file_analysis_enqueue_reanalysis_device()
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
                    execute function
                        public.file_analysis_enqueue_reanalysis_device();
                "#,
            )
            .await?;
        Ok(())
    }
}
