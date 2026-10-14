use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
alter table public.device_audio
    add column automatic_transcription text,
    add column automatic_transcribed_at timestamp,
    add constraint device_audio_asr_identity_key unique (id, device_id),
    add constraint device_audio_automatic_result_check check (
        (automatic_transcription is null and automatic_transcribed_at is null)
        or (automatic_transcription is not null and automatic_transcription ~ '[^[:space:]]'
            and automatic_transcribed_at is not null and isfinite(automatic_transcribed_at))
    );

create table public.device_audio_asr_setting (
    device_id uuid primary key,
    enabled boolean not null,
    updated_at timestamptz not null,
    updated_by_login_id uuid
);

create table public.device_audio_asr_job (
    audio_id uuid primary key,
    device_id uuid not null,
    state text not null check (state in (
        'suppressed', 'policy_pending', 'queued', 'preparing', 'running',
        'retry_wait', 'succeeded', 'no_speech', 'failed', 'outcome_unknown', 'cancelled'
    )),
    trigger text not null check (trigger in ('interactive', 'background', 'backfill')),
    priority smallint not null,
    generation uuid not null,
    status_version uuid not null,
    attempt_id uuid,
    attempt_count integer not null check (attempt_count >= 0),
    created_at timestamptz not null,
    generation_started_at timestamptz not null,
    next_attempt_at timestamptz,
    owner_id uuid,
    heartbeat_at timestamptz,
    dispatched_at timestamptz,
    instance_id uuid,
    remote_audio_id uuid,
    source_sha256 bytea check (octet_length(source_sha256) = 32),
    error_code text,
    updated_at timestamptz not null,
    recovered_attempt_id uuid,
    recovery_verified_at timestamptz,
    recovery_verified_by text,
    recovery_note text,
    constraint device_audio_asr_job_audio_fk foreign key (audio_id, device_id)
        references public.device_audio (id, device_id) on delete restrict,
    constraint device_audio_asr_job_attempt_key unique (audio_id, attempt_id),
    constraint device_audio_asr_job_priority_check check (
        (trigger = 'interactive' and priority = 0)
        or (trigger = 'background' and priority = 1)
        or (trigger = 'backfill' and priority = 2)
    ),
    constraint device_audio_asr_job_due_check check (
        state not in ('queued', 'retry_wait', 'policy_pending') or next_attempt_at is not null
    ),
    constraint device_audio_asr_job_owner_check check (
        state not in ('preparing', 'running', 'outcome_unknown') or (
            attempt_id is not null and attempt_count > 0
            and owner_id is not null and heartbeat_at is not null
        )
    ),
    constraint device_audio_asr_job_dispatch_check check (
        state not in ('running', 'outcome_unknown') or (
            dispatched_at is not null and instance_id is not null
            and remote_audio_id is not null and source_sha256 is not null
        )
    ),
    constraint device_audio_asr_job_preparing_check check (
        state <> 'preparing' or dispatched_at is null
    ),
    constraint device_audio_asr_job_recovery_check check (
        (recovered_attempt_id is null and recovery_verified_at is null
            and recovery_verified_by is null and recovery_note is null)
        or (recovered_attempt_id is not null and recovery_verified_at is not null
            and recovery_verified_by is not null and length(btrim(recovery_verified_by)) > 0
            and recovery_note is not null and length(btrim(recovery_note)) > 0)
    )
);
create index device_audio_asr_job_due_idx
    on public.device_audio_asr_job (priority, next_attempt_at, audio_id)
    where state in ('queued', 'retry_wait', 'policy_pending');
create index device_audio_asr_job_device_state_idx
    on public.device_audio_asr_job (device_id, state, audio_id);

create table public.device_audio_asr_scheduler (
    id smallint primary key check (id = 1),
    slot_audio_id uuid,
    slot_attempt_id uuid,
    turn smallint not null check (turn between 0 and 9),
    constraint device_audio_asr_scheduler_slot_check check (
        (slot_audio_id is null) = (slot_attempt_id is null)
    ),
    constraint device_audio_asr_scheduler_attempt_fk foreign key (slot_audio_id, slot_attempt_id)
        references public.device_audio_asr_job (audio_id, attempt_id)
        deferrable initially deferred
);
insert into public.device_audio_asr_scheduler (id, turn) values (1, 0);

create table public.device_audio_asr_backfill (
    run_id uuid primary key,
    state text not null check (state in ('ready', 'running', 'paused', 'completed')),
    started_at timestamptz not null,
    snapshot_upper_created_at timestamptz,
    snapshot_upper_id uuid,
    device_id uuid,
    cursor_created_at timestamptz,
    cursor_id uuid,
    current_audio_id uuid,
    owner_id uuid,
    heartbeat_at timestamptz,
    checked bigint not null default 0 check (checked >= 0),
    succeeded bigint not null default 0 check (succeeded >= 0),
    skipped bigint not null default 0 check (skipped >= 0),
    no_speech bigint not null default 0 check (no_speech >= 0),
    failed bigint not null default 0 check (failed >= 0),
    recovery_required bigint not null default 0 check (recovery_required >= 0),
    completed_at timestamptz,
    constraint device_audio_asr_backfill_snapshot_check check (
        (snapshot_upper_created_at is null) = (snapshot_upper_id is null)
    ),
    constraint device_audio_asr_backfill_cursor_check check (
        (cursor_created_at is null) = (cursor_id is null)
    ),
    constraint device_audio_asr_backfill_owner_check check (
        (owner_id is null) = (heartbeat_at is null)
        and (state <> 'running' or owner_id is not null)
    ),
    constraint device_audio_asr_backfill_counts_check check (
        checked = succeeded + skipped + no_speech + failed + recovery_required
    ),
    constraint device_audio_asr_backfill_completed_check check (
        (state = 'completed') = (completed_at is not null)
    )
);
create table public.device_audio_asr_backfill_item (
    run_id uuid not null references public.device_audio_asr_backfill (run_id) on delete restrict,
    audio_id uuid not null,
    audio_created_at timestamptz not null,
    observed_generation uuid,
    outcome text check (outcome in ('succeeded', 'skipped', 'no_speech', 'failed', 'recovery_required')),
    reason_code text,
    finished_at timestamptz,
    primary key (run_id, audio_id),
    constraint device_audio_asr_backfill_item_completion_check check (
        (outcome is null and finished_at is null and reason_code is null)
        or (outcome is not null and finished_at is not null)
    )
);
create index device_audio_asr_backfill_item_keyset_idx
    on public.device_audio_asr_backfill_item (run_id, audio_created_at, audio_id);
create index device_audio_asr_backfill_item_unfinished_idx
    on public.device_audio_asr_backfill_item (run_id, audio_created_at, audio_id)
    where outcome is null;
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
lock table public.device_audio_asr_scheduler, public.device_audio_asr_setting,
    public.device_audio, public.device_audio_asr_job,
    public.device_audio_asr_backfill, public.device_audio_asr_backfill_item
    in access exclusive mode;
do $$ begin
    if exists (select 1 from public.device_audio where automatic_transcription is not null or automatic_transcribed_at is not null)
        or exists (select 1 from public.device_audio_asr_setting)
        or exists (select 1 from public.device_audio_asr_job)
        or exists (select 1 from public.device_audio_asr_scheduler where slot_audio_id is not null)
        or exists (select 1 from public.device_audio_asr_backfill)
        or exists (select 1 from public.device_audio_asr_backfill_item) then
        raise exception 'device_audio_asr rollback refused: transcription or durable ASR data exists';
    end if;
end $$;
drop table public.device_audio_asr_backfill_item;
drop table public.device_audio_asr_backfill;
drop table public.device_audio_asr_scheduler;
drop table public.device_audio_asr_job;
drop table public.device_audio_asr_setting;
alter table public.device_audio
    drop constraint device_audio_automatic_result_check,
    drop constraint device_audio_asr_identity_key,
    drop column automatic_transcribed_at,
    drop column automatic_transcription;
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
