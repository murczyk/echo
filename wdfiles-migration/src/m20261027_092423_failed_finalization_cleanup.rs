use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            create or replace function public.device_upload_finalization_attempt_guard()
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
                    select 1 from file_content_upload u
                    left join file_content_upload_object o on o.upload_id = u.id
                    where u.id = new.file_upload_id and u.object_key = new.object_key
                        and (o.object_key <> u.object_key or (o.upload_id is null and not exists (
                            select 1 from device_upload_finalization_attempt a where a.job_id = new.job_id
                                and (a.write_credit_held or (a.write_intent_at is not null
                                    and a.phase not in ('retired', 'selected')))
                        )))
                ) then raise exception 'legacy cleanup requires an unselected canonical allocation'; end if;
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
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            lock table device_upload_finalization_attempt in share row exclusive mode;
            do $$ begin
                if exists (
                    select 1 from device_upload_finalization_attempt a
                    where a.origin = 'legacy_cleanup' and not exists (
                        select 1 from file_content_upload u
                        join file_content_upload_object o on o.upload_id = u.id
                        where u.id = a.file_upload_id and u.object_key = a.object_key
                            and o.object_key <> u.object_key
                    )
                ) then
                    raise exception 'cannot downgrade finalization with unselected canonical cleanup evidence';
                end if;
            end $$;
            create or replace function public.device_upload_finalization_attempt_guard()
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
        "#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }
}
