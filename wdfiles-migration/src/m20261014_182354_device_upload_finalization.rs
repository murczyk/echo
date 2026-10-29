use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            alter table file_content_upload
                add constraint file_content_upload_source_identity_key
                    unique (id, file_id, upload_length, expected_sha256),
                add constraint file_content_upload_command_key
                    unique (id, device_id, file_id, revision, created_by_login_id, upload_length);

            create table device_upload_finalization_job (
                id uuid primary key,
                kind text not null check (kind in ('file', 'audio')),
                source_identity text not null,
                created_by_login_id uuid not null,
                device_id uuid not null,
                file_upload_id uuid,
                file_id uuid,
                revision bigint,
                audio_id uuid,
                audio_name text,
                audio_name_key bytea,
                recording_started_at timestamptz,
                upload_url text,
                source_size_bytes bigint not null check (source_size_bytes >= 0),
                source_locator text,
                pin_token uuid,
                command_version integer not null default 1 check (command_version = 1),
                status text not null default 'queued'
                    check (status in ('queued', 'processing', 'retry_wait', 'outcome_unknown', 'completed', 'failed')),
                created_at timestamptz not null default clock_timestamp(),
                updated_at timestamptz not null default clock_timestamp(),
                finished_at timestamptz,
                next_run_at timestamptz not null default clock_timestamp(),
                attempt_count bigint not null default 0 check (attempt_count >= 0),
                lease_owner uuid,
                lease_epoch bigint not null default 0 check (lease_epoch >= 0),
                lease_until timestamptz,
                active_attempt_id uuid,
                winning_attempt_id uuid,
                result jsonb,
                error_code text,
                error_message text,
                error_action text check (error_action in ('retry_poll', 'new_upload', 'correct_request', 'contact_operator')),
                source_release_state text not null default 'held'
                    check (source_release_state in ('held', 'release_pending', 'released')),
                source_released_at timestamptz,
                quota_released_at timestamptz,
                unique (kind, source_identity),
                unique (id, kind, device_id),
                foreign key (file_upload_id, device_id, file_id, revision, created_by_login_id, source_size_bytes)
                    references file_content_upload (id, device_id, file_id, revision, created_by_login_id, upload_length)
                    on delete restrict,
                constraint device_upload_finalization_job_shape_check check (coalesce(
                    (kind = 'file' and file_upload_id is not null and file_id is not null and revision is not null
                        and source_identity = file_upload_id::text and audio_id is null and audio_name is null
                        and audio_name_key is null and recording_started_at is null and upload_url is null and pin_token is null)
                    or (kind = 'audio' and file_upload_id is null and file_id is null and revision is null
                        and audio_id is not null and audio_name is not null and audio_name_key is not null
                        and recording_started_at is not null and isfinite(recording_started_at)
                        and upload_url is not null and pin_token is not null and source_size_bytes > 0
                        and octet_length(audio_name) between 1 and 1024 and audio_name_key = convert_to(audio_name, 'UTF8')
                        and source_identity ~ ('^' || device_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                        and upload_url = '/api/device/audio/' || device_id::text || '/uploads/'
                            || split_part(source_identity, '/', 2) || '.' || source_size_bytes::text), false)),
                constraint device_upload_finalization_job_locator_check check (
                    (source_locator is null and kind = 'file' and source_size_bytes = 0)
                    or (source_locator is not null and octet_length(source_locator) between 1 and 1024
                        and source_locator !~ '(^/|(^|/)\.{1,2}(/|$)|//|\\)')),
                constraint device_upload_finalization_job_time_check check (
                    isfinite(created_at) and isfinite(updated_at) and isfinite(next_run_at)
                    and updated_at >= created_at and (finished_at is null or (isfinite(finished_at) and finished_at >= created_at))
                    and (lease_until is null or isfinite(lease_until))
                    and (status in ('completed', 'failed')) = (finished_at is not null)),
                constraint device_upload_finalization_job_lease_check check (
                    (lease_owner is null) = (lease_until is null)
                    and (status <> 'processing' or lease_owner is not null)
                    and (status not in ('queued', 'retry_wait', 'completed', 'failed') or lease_owner is null)),
                constraint device_upload_finalization_job_result_check check (
                    (status = 'completed') = (result is not null)
                    and (result is null or coalesce(
                        jsonb_typeof(result) = 'object' and result->'version' = '1'::jsonb
                        and result - array['version','value'] = '{}'::jsonb
                        and jsonb_typeof(result->'value') = 'object'
                        and ((kind = 'file' and (result->'value') - array['upload_id','file_id','revision','status'] = '{}'::jsonb
                            and jsonb_typeof(result->'value'->'revision') = 'number'
                            and result->'value'->>'upload_id' = file_upload_id::text
                            and result->'value'->>'file_id' = file_id::text
                            and result->'value'->>'revision' = revision::text
                            and result->'value'->>'status' = 'completed')
                        or (kind = 'audio' and (result->'value') - 'audio' = '{}'::jsonb
                            and jsonb_typeof(result->'value'->'audio') = 'object'
                            and result->'value'->'audio' ?& array['id','device_id','name','recording_started_at','recording_ended_at','duration_seconds','processed','processing_version']
                            and (result->'value'->'audio') - array['id','device_id','name','recording_started_at','recording_ended_at','duration_seconds','processed','processing_version'] = '{}'::jsonb
                            and jsonb_typeof(result->'value'->'audio'->'name') = 'string'
                            and result->'value'->'audio'->>'name' = audio_name
                            and jsonb_typeof(result->'value'->'audio'->'recording_started_at') = 'string'
                            and (result->'value'->'audio'->>'recording_started_at')::timestamptz = recording_started_at
                            and jsonb_typeof(result->'value'->'audio'->'recording_ended_at') = 'string'
                            and isfinite((result->'value'->'audio'->>'recording_ended_at')::timestamptz)
                            and jsonb_typeof(result->'value'->'audio'->'duration_seconds') = 'number'
                            and (result->'value'->'audio'->>'duration_seconds')::numeric > 0
                            and jsonb_typeof(result->'value'->'audio'->'processed') = 'boolean'
                            and jsonb_typeof(result->'value'->'audio'->'processing_version') = 'string'
                            and (result->'value'->'audio'->>'processing_version') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            and result->'value'->'audio'->>'id' = audio_id::text
                            and result->'value'->'audio'->>'device_id' = device_id::text)), false))),
                constraint device_upload_finalization_job_error_check check (
                    (status in ('failed', 'retry_wait', 'outcome_unknown') and error_code is not null
                        and error_message is not null and error_action is not null
                        and octet_length(error_code) between 1 and 128 and octet_length(error_message) between 1 and 1024
                        and (status = 'failed' or error_action = 'retry_poll'))
                    or (status not in ('failed', 'retry_wait', 'outcome_unknown')
                        and error_code is null and error_message is null and error_action is null)),
                constraint device_upload_finalization_job_release_check check (
                    (source_release_state = 'released') = (source_released_at is not null)
                    and (source_release_state = 'held' or status in ('completed', 'failed'))
                    and (quota_released_at is null or source_release_state = 'released'))
            );
            create index device_upload_finalization_due_idx
                on device_upload_finalization_job (kind, next_run_at, created_at, id)
                where status in ('queued', 'retry_wait');
            create index device_upload_finalization_expired_idx
                on device_upload_finalization_job (kind, lease_until, id) where status = 'processing';
            create index device_upload_finalization_unknown_idx
                on device_upload_finalization_job (kind, next_run_at, created_at, id) where status = 'outcome_unknown';
            create index device_upload_finalization_actor_idx
                on device_upload_finalization_job (created_by_login_id, kind) where quota_released_at is null;
            create index device_upload_finalization_source_cleanup_idx
                on device_upload_finalization_job (source_release_state, updated_at, id)
                where status in ('completed', 'failed') and source_release_state <> 'released';

            create table device_upload_finalization_attempt (
                id uuid primary key,
                job_id uuid not null references device_upload_finalization_job(id) on delete restrict,
                kind text not null check (kind in ('file', 'audio')),
                origin text not null default 'async' check (origin in ('async', 'legacy_cleanup')),
                ordinal bigint not null check (ordinal > 0),
                lease_epoch bigint not null check (lease_epoch > 0),
                file_upload_id uuid,
                device_id uuid not null,
                audio_id uuid,
                object_key text not null unique,
                storage_policy_version integer not null default 1 check (storage_policy_version = 1),
                is_encrypted boolean not null,
                source_size_bytes bigint not null check (source_size_bytes >= 0),
                source_sha256 bytea check (source_sha256 is null or octet_length(source_sha256) = 32),
                media_type text,
                duration_seconds double precision,
                recording_ended_at timestamptz,
                phase text not null default 'preparing'
                    check (phase in ('preparing', 'prepared', 'write_intent', 'verified', 'selected', 'retired')),
                write_intent_at timestamptz,
                write_acknowledged_at timestamptz,
                verified_at timestamptz,
                write_credit_held boolean not null default false,
                write_resolved_at timestamptz,
                retired_at timestamptz,
                cleanup_next_at timestamptz,
                cleanup_confirmed_at timestamptz,
                late_write_possible boolean not null default false,
                created_at timestamptz not null default clock_timestamp(),
                updated_at timestamptz not null default clock_timestamp(),
                last_error_code text check (last_error_code is null or octet_length(last_error_code) between 1 and 128),
                unique (job_id, ordinal),
                unique (id, job_id),
                unique (id, file_upload_id, object_key),
                foreign key (job_id, kind, device_id)
                    references device_upload_finalization_job(id, kind, device_id) on delete restrict,
                constraint device_upload_finalization_attempt_shape_check check (coalesce(
                    (kind = 'file' and file_upload_id is not null and audio_id is null
                        and media_type is null and duration_seconds is null and recording_ended_at is null)
                    or (kind = 'audio' and file_upload_id is null and audio_id is not null), false)),
                constraint device_upload_finalization_attempt_key_check check (
                    origin = 'legacy_cleanup' or object_key = case kind
                        when 'file' then 'device-file-finalization/' || file_upload_id::text || '/' || id::text
                        else 'device-audio/' || device_id::text || '/' || audio_id::text || '/' || id::text end),
                constraint device_upload_finalization_attempt_evidence_check check (
                    (origin = 'legacy_cleanup' and kind = 'file' and phase = 'retired'
                        and not write_credit_held and write_intent_at is null and verified_at is null)
                    or (origin = 'async'
                        and (phase in ('preparing', 'retired') or source_sha256 is not null)
                        and (phase not in ('write_intent', 'verified', 'selected') or write_intent_at is not null)
                        and (write_intent_at is null or source_sha256 is not null)
                        and (phase not in ('verified', 'selected') or verified_at is not null)
                        and (verified_at is null or write_intent_at is not null)
                        and (write_acknowledged_at is null or write_intent_at is not null)
                        and (not write_credit_held or write_intent_at is not null)
                        and (kind = 'file' or phase in ('preparing', 'retired') or coalesce(
                            media_type is not null and duration_seconds > 0 and duration_seconds < 'Infinity'::float8
                            and recording_ended_at is not null and isfinite(recording_ended_at), false)))),
                constraint device_upload_finalization_attempt_retirement_check check (
                    (phase = 'retired') = (retired_at is not null)
                    and (cleanup_next_at is null or phase = 'retired')
                    and (cleanup_confirmed_at is null or phase = 'retired')
                    and (not late_write_possible or phase = 'retired'))
            );
            create unique index device_upload_finalization_one_write_idx
                on device_upload_finalization_attempt(job_id) where write_credit_held;
            create index device_upload_finalization_attempt_cleanup_idx
                on device_upload_finalization_attempt(kind, cleanup_next_at, id) where phase = 'retired';
            create index device_upload_finalization_credit_release_idx
                on device_upload_finalization_attempt(write_resolved_at, id)
                where write_credit_held and write_resolved_at is not null;
            alter table device_upload_finalization_job
                add constraint finalization_job_active_attempt_fk foreign key (active_attempt_id, id) references device_upload_finalization_attempt(id, job_id) on delete restrict,
                add constraint finalization_job_winning_attempt_fk foreign key (winning_attempt_id, id) references device_upload_finalization_attempt(id, job_id) on delete restrict;

            create table device_upload_finalization_budget (
                scope text primary key check (scope ~ '^(global:(file|audio)|actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(file|audio))$'),
                reserved_jobs bigint not null default 0 check (reserved_jobs >= 0),
                reserved_source_bytes bigint not null default 0 check (reserved_source_bytes >= 0),
                unresolved_writes bigint not null default 0 check (unresolved_writes >= 0),
                check (scope like 'global:%' or unresolved_writes = 0)
            );

            create function public.device_upload_finalization_job_guard()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                if tg_op = 'DELETE' then
                    raise exception 'finalization identity is permanent';
                end if;
                if row(new.id, new.kind, new.source_identity, new.created_by_login_id, new.device_id,
                    new.file_upload_id, new.file_id, new.revision, new.audio_id, new.audio_name, new.audio_name_key,
                    new.recording_started_at, new.upload_url, new.source_size_bytes, new.source_locator,
                    new.pin_token, new.command_version, new.created_at)
                    is distinct from row(old.id, old.kind, old.source_identity, old.created_by_login_id, old.device_id,
                    old.file_upload_id, old.file_id, old.revision, old.audio_id, old.audio_name, old.audio_name_key,
                    old.recording_started_at, old.upload_url, old.source_size_bytes, old.source_locator,
                    old.pin_token, old.command_version, old.created_at) then
                    raise exception 'finalization command is immutable';
                end if;
                if new.lease_epoch < old.lease_epoch or new.attempt_count < old.attempt_count
                    or (new.lease_owner is distinct from old.lease_owner and new.lease_owner is not null
                        and new.lease_epoch <= old.lease_epoch) then
                    raise exception 'finalization fence must advance';
                end if;
                if old.status in ('completed', 'failed') and row(new.status, new.result, new.error_code,
                    new.error_message, new.error_action, new.finished_at, new.updated_at, new.winning_attempt_id,
                    new.active_attempt_id, new.lease_epoch, new.attempt_count, new.next_run_at)
                    is distinct from row(old.status, old.result, old.error_code, old.error_message, old.error_action,
                    old.finished_at, old.updated_at, old.winning_attempt_id, old.active_attempt_id, old.lease_epoch,
                    old.attempt_count, old.next_run_at) then
                    raise exception 'terminal finalization snapshot is immutable';
                end if;
                if (old.source_release_state = 'released' and new.source_release_state <> 'released')
                    or (old.source_release_state = 'release_pending' and new.source_release_state = 'held')
                    or (old.source_released_at is not null and new.source_released_at is distinct from old.source_released_at)
                    or (old.quota_released_at is not null and new.quota_released_at is distinct from old.quota_released_at) then
                    raise exception 'finalization source release is irreversible';
                end if;
                return new;
            end $function$;
            create trigger device_upload_finalization_job_mutation_trg before update or delete
                on device_upload_finalization_job for each row execute function public.device_upload_finalization_job_guard();

            create function public.device_upload_finalization_attempt_guard()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            declare job device_upload_finalization_job%rowtype;
            begin
                if tg_op = 'DELETE' then raise exception 'attempt evidence is permanent'; end if;
                select * into strict job from device_upload_finalization_job where id = new.job_id;
                if row(new.file_upload_id, new.audio_id, new.source_size_bytes)
                    is distinct from row(job.file_upload_id, job.audio_id, job.source_size_bytes) then
                    raise exception 'attempt must bind its original command';
                end if;
                if new.kind = 'file' and new.source_sha256 is not null and not exists (
                    select 1 from file_content_upload where id = new.file_upload_id and expected_sha256 = new.source_sha256
                ) then raise exception 'file attempt fingerprint must match accepted upload'; end if;
                if new.origin = 'legacy_cleanup' and not exists (
                    select 1 from file_content_upload u join file_content_upload_object o on o.upload_id = u.id
                    where u.id = new.file_upload_id and u.object_key = new.object_key and o.object_key <> u.object_key
                ) then raise exception 'legacy cleanup requires a different immutable winner'; end if;
                if new.kind = 'audio' and new.duration_seconds is not null and
                    new.recording_ended_at is distinct from job.recording_started_at
                        + (round(new.duration_seconds::numeric * 1000000)::bigint * interval '1 microsecond') then
                    raise exception 'audio end must match decoded duration';
                end if;
                if tg_op = 'INSERT' then
                    if new.lease_epoch <> job.lease_epoch or job.lease_until is null or job.lease_until <= clock_timestamp()
                        or job.status not in ('processing', 'outcome_unknown') then
                        raise exception 'attempt requires current live job fence';
                    end if;
                    return new;
                end if;
                if row(new.id, new.job_id, new.kind, new.origin, new.ordinal, new.lease_epoch, new.file_upload_id,
                    new.device_id, new.audio_id, new.object_key, new.storage_policy_version, new.is_encrypted, new.created_at)
                    is distinct from row(old.id, old.job_id, old.kind, old.origin, old.ordinal, old.lease_epoch,
                    old.file_upload_id, old.device_id, old.audio_id, old.object_key, old.storage_policy_version,
                    old.is_encrypted, old.created_at) then raise exception 'attempt identity is immutable'; end if;
                if old.phase <> 'preparing' and row(new.source_size_bytes, new.source_sha256, new.media_type,
                    new.duration_seconds, new.recording_ended_at) is distinct from row(old.source_size_bytes,
                    old.source_sha256, old.media_type, old.duration_seconds, old.recording_ended_at) then
                    raise exception 'prepared fingerprint is immutable';
                end if;
                if (old.write_intent_at is not null and new.write_intent_at is distinct from old.write_intent_at)
                    or (old.write_resolved_at is not null and new.write_resolved_at is distinct from old.write_resolved_at)
                    or (old.verified_at is not null and new.verified_at is distinct from old.verified_at)
                    or (old.write_acknowledged_at is not null and new.write_acknowledged_at is distinct from old.write_acknowledged_at)
                    or (old.retired_at is not null and new.retired_at is distinct from old.retired_at)
                    or (old.write_credit_held and not new.write_credit_held and new.write_resolved_at is null) then
                    raise exception 'attempt evidence cannot be erased';
                end if;
                if new.phase <> old.phase and not (
                    (old.phase = 'preparing' and new.phase in ('prepared', 'retired'))
                    or (old.phase = 'prepared' and new.phase in ('write_intent', 'retired'))
                    or (old.phase = 'write_intent' and new.phase in ('verified', 'retired'))
                    or (old.phase = 'verified' and new.phase in ('selected', 'retired'))
                ) then raise exception 'invalid attempt transition'; end if;
                if new.phase = 'retired' and exists (select 1 from file_content_upload_object where attempt_id = new.id) then
                    raise exception 'selected provenance cannot be retired';
                end if;
                if old.phase = 'selected' and row(new.retired_at, new.cleanup_next_at, new.cleanup_confirmed_at)
                    is distinct from row(old.retired_at, old.cleanup_next_at, old.cleanup_confirmed_at) then
                    raise exception 'selected object cannot be cleaned';
                end if;
                return new;
            end $function$;
            create trigger device_upload_finalization_attempt_mutation_trg before insert or update or delete
                on device_upload_finalization_attempt for each row execute function public.device_upload_finalization_attempt_guard();

            create table file_content_upload_object (
                upload_id uuid primary key,
                file_id uuid not null,
                object_key text not null unique,
                source_size_bytes bigint not null,
                source_sha256 bytea not null,
                is_encrypted boolean not null,
                attempt_id uuid unique,
                unique (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted),
                foreign key (upload_id, file_id, source_size_bytes, source_sha256)
                    references file_content_upload(id, file_id, upload_length, expected_sha256) on delete restrict,
                foreign key (attempt_id, upload_id, object_key)
                    references device_upload_finalization_attempt(id, file_upload_id, object_key) on delete restrict
            );
            do $$ begin
                if exists (select 1 from file_content_upload u where u.status = 'completed' and not exists (
                    select 1 from file_content c where c.upload_id = u.id and c.file_id = u.file_id and c.revision = u.revision
                )) or exists (select 1 from file_content c join file_content_upload u on u.id = c.upload_id
                    where c.revision = u.revision and u.status <> 'completed') then
                    raise exception 'completed original publication provenance is missing';
                end if;
            end $$;
            insert into file_content_upload_object
                (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted)
                select c.upload_id, c.file_id, c.object_key, c.source_size_bytes, c.source_sha256, c.is_encrypted
                from file_content c join file_content_upload u on u.id = c.upload_id
                where c.revision = u.revision and u.status = 'completed';
            alter table file_content drop constraint file_content_verified_upload_binding_fk,
                add constraint file_content_verified_upload_binding_fk
                    foreign key (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted)
                    references file_content_upload_object(upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted)
                    on delete restrict;

            create function public.file_content_upload_object_guard()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            begin
                if tg_op <> 'INSERT' then raise exception 'selected provenance is immutable'; end if;
                if exists (select 1 from device_upload_finalization_attempt
                    where object_key = new.object_key and phase = 'retired') then
                    raise exception 'retired object cannot become selected provenance';
                end if;
                if new.attempt_id is null then
                    if not exists (select 1 from file_content_upload where id = new.upload_id and object_key = new.object_key) then
                        raise exception 'legacy provenance requires canonical allocation';
                    end if;
                elsif not exists (select 1 from device_upload_finalization_attempt a
                    join device_upload_finalization_job j on j.id = a.job_id
                    where a.id = new.attempt_id and a.origin = 'async' and a.kind = 'file' and a.phase = 'verified'
                        and a.verified_at is not null and a.retired_at is null
                        and a.file_upload_id = new.upload_id and a.object_key = new.object_key
                        and a.source_size_bytes = new.source_size_bytes and a.source_sha256 = new.source_sha256
                        and a.is_encrypted = new.is_encrypted and j.active_attempt_id = a.id
                        and j.lease_until > clock_timestamp() and j.status = 'processing') then
                    raise exception 'selected provenance requires verified live attempt';
                end if;
                return new;
            end $function$;
            create trigger file_content_upload_object_mutation_trg before insert or update or delete
                on file_content_upload_object for each row execute function public.file_content_upload_object_guard();

            create function public.file_content_register_object()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $function$
            declare source file_content_upload%rowtype;
            begin
                select * into strict source from file_content_upload where id = new.upload_id;
                if new.revision = source.revision and not exists (
                    select 1 from file_content_upload_object where upload_id = new.upload_id
                ) then
                    if row(new.file_id, new.object_key, new.source_size_bytes, new.source_sha256)
                        is distinct from row(source.file_id, source.object_key, source.upload_length, source.expected_sha256) then
                        raise exception 'canonical writer provenance mismatch';
                    end if;
                    insert into file_content_upload_object
                        (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted)
                        values (new.upload_id, new.file_id, new.object_key, new.source_size_bytes, new.source_sha256, new.is_encrypted);
                end if;
                return new;
            end $function$;
            create trigger file_content_00_register_object_trg before insert on file_content
                for each row when (new.upload_id is not null) execute function public.file_content_register_object();
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            do $$ begin
                if exists (select 1 from device_upload_finalization_job)
                    or exists (select 1 from device_upload_finalization_attempt)
                    or exists (select 1 from device_upload_finalization_budget
                        where reserved_jobs <> 0 or reserved_source_bytes <> 0 or unresolved_writes <> 0)
                    or exists (select 1 from file_content_upload_object o join file_content_upload u on u.id = o.upload_id
                        where o.object_key <> u.object_key or o.attempt_id is not null) then
                    raise exception 'cannot downgrade while finalization evidence or noncanonical publications exist';
                end if;
            end $$;
            drop trigger file_content_00_register_object_trg on file_content;
            drop function public.file_content_register_object();
            alter table file_content drop constraint file_content_verified_upload_binding_fk,
                add constraint file_content_verified_upload_binding_fk
                    foreign key (upload_id, file_id, object_key, source_size_bytes, source_sha256)
                    references file_content_upload(id, file_id, object_key, upload_length, expected_sha256) on delete restrict;
            drop table file_content_upload_object;
            drop function public.file_content_upload_object_guard();
            alter table device_upload_finalization_job
                drop constraint finalization_job_active_attempt_fk,
                drop constraint finalization_job_winning_attempt_fk;
            drop table device_upload_finalization_attempt;
            drop function public.device_upload_finalization_attempt_guard();
            drop table device_upload_finalization_job;
            drop function public.device_upload_finalization_job_guard();
            drop table device_upload_finalization_budget;
            alter table file_content_upload drop constraint file_content_upload_source_identity_key,
                drop constraint file_content_upload_command_key;
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
