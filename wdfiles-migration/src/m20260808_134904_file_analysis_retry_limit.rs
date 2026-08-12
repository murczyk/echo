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
                alter table file_analysis_state
                    add column retry_exhausted boolean not null default false,
                    drop constraint file_analysis_state_pending_check,
                    drop constraint file_analysis_state_attempt_count_check;

                update file_analysis_state
                set attempt_count = least(attempt_count, 10),
                    retry_exhausted = (
                        attempt_count >= 10
                        and (
                            analyzed_source_revision < source_revision
                            or analyzed_generation < required_generation
                        )
                    ),
                    pending = (
                        attempt_count < 10
                        and (
                            analyzed_source_revision < source_revision
                            or analyzed_generation < required_generation
                        )
                    ),
                    lease_token = case
                        when attempt_count >= 10 then null
                        else lease_token
                    end,
                    lease_expires_at = case
                        when attempt_count >= 10 then null
                        else lease_expires_at
                    end,
                    updated_at = case
                        when attempt_count >= 10 then clock_timestamp()
                        else updated_at
                    end
                where attempt_count >= 10;

                alter table file_analysis_state
                    add constraint file_analysis_state_pending_check
                        check (
                            pending = (
                                not retry_exhausted
                                and (
                                    analyzed_source_revision < source_revision
                                    or analyzed_generation < required_generation
                                )
                            )
                        ),
                    add constraint file_analysis_state_attempt_count_check
                        check (attempt_count >= 0 and attempt_count <= 10),
                    add constraint file_analysis_state_retry_exhausted_check
                        check (
                            not retry_exhausted
                            or (
                                attempt_count = 10
                                and (
                                    analyzed_source_revision < source_revision
                                    or analyzed_generation < required_generation
                                )
                            )
                        );

                create or replace function public.file_analysis_enqueue_file_entry()
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
                        source_revision = file_analysis_state.source_revision + 1,
                        pending = true,
                        retry_exhausted = false,
                        available_at = clock_timestamp(),
                        attempt_count = 0,
                        last_error = null,
                        updated_at = clock_timestamp();

                    return new;
                end
                $function$;
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
                alter table file_analysis_state
                    drop constraint file_analysis_state_pending_check,
                    drop constraint file_analysis_state_attempt_count_check,
                    drop constraint file_analysis_state_retry_exhausted_check;

                update file_analysis_state
                set pending = (
                        analyzed_source_revision < source_revision
                        or analyzed_generation < required_generation
                    ),
                    retry_exhausted = false,
                    available_at = case
                        when retry_exhausted then clock_timestamp()
                        else available_at
                    end,
                    updated_at = case
                        when retry_exhausted then clock_timestamp()
                        else updated_at
                    end;

                create or replace function public.file_analysis_enqueue_file_entry()
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

                alter table file_analysis_state
                    add constraint file_analysis_state_pending_check
                        check (
                            pending = (
                                analyzed_source_revision < source_revision
                                or analyzed_generation < required_generation
                            )
                        ),
                    add constraint file_analysis_state_attempt_count_check
                        check (attempt_count >= 0),
                    drop column retry_exhausted;
                "#,
            )
            .await?;
        Ok(())
    }
}
