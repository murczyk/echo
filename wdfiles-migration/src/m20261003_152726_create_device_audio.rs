use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
                create table public.device_audio_ingest (
                    id uuid primary key,
                    audio_id uuid not null unique,
                    device_id uuid not null,
                    actor_id uuid not null,
                    tus_upload_ref text not null unique,
                    tus_upload_id uuid not null unique,
                    tus_owner_id uuid not null,
                    name text not null,
                    name_key bytea not null,
                    recording_started_at timestamptz not null,
                    created_at timestamptz not null,
                    storage_key text not null unique,
                    status text not null,
                    lease_token uuid not null,
                    heartbeat_at timestamptz not null,
                    source_size_bytes bigint,
                    source_sha256 bytea,
                    duration_us bigint,
                    mime_type text,
                    cleanup_token uuid,
                    next_cleanup_at timestamptz,
                    source_consumed_at timestamptz,
                    last_error text,
                    constraint device_audio_ingest_binding_key
                        unique (id, audio_id, device_id, storage_key),
                    constraint device_audio_ingest_owner_check
                        check (tus_owner_id = actor_id),
                    constraint device_audio_ingest_upload_ref_check check (
                        octet_length(tus_upload_ref) > 0
                    ),
                    constraint device_audio_ingest_name_check check (
                        octet_length(name) between 1 and 1024
                        and name_key = convert_to(name, 'UTF8')
                    ),
                    constraint device_audio_ingest_storage_key_check check (
                        storage_key = 'device-audio/' || device_id::text
                            || '/' || audio_id::text || '/' || id::text
                    ),
                    constraint device_audio_ingest_status_check check (
                        status in ('finalizing', 'storing', 'ready', 'deleting')
                    ),
                    constraint device_audio_ingest_time_check check (
                        isfinite(recording_started_at) and isfinite(created_at)
                        and isfinite(heartbeat_at) and heartbeat_at >= created_at
                        and (next_cleanup_at is null or isfinite(next_cleanup_at))
                        and (source_consumed_at is null or (
                            isfinite(source_consumed_at)
                            and source_consumed_at >= created_at
                        ))
                    ),
                    constraint device_audio_ingest_size_check check (
                        source_size_bytes is null
                        or source_size_bytes between 1 and 104857600
                    ),
                    constraint device_audio_ingest_sha256_check check (
                        source_sha256 is null or octet_length(source_sha256) = 32
                    ),
                    constraint device_audio_ingest_duration_check check (
                        duration_us is null or duration_us > 0
                    ),
                    constraint device_audio_ingest_mime_check check (
                        mime_type is null or mime_type in ('audio/wav', 'audio/mpeg')
                    ),
                    constraint device_audio_ingest_validated_check check (
                        status not in ('storing', 'ready') or (
                            source_size_bytes is not null
                            and source_sha256 is not null
                            and duration_us is not null and mime_type is not null
                        )
                    ),
                    constraint device_audio_ingest_cleanup_check check (
                        status <> 'deleting' or (
                            cleanup_token is not null and next_cleanup_at is not null
                        )
                    ),
                    constraint device_audio_ingest_error_check check (
                        last_error is null or octet_length(last_error) <= 4096
                    )
                );
                create index device_audio_ingest_heartbeat_idx
                    on public.device_audio_ingest (heartbeat_at, id)
                    where status in ('finalizing', 'storing');
                create index device_audio_ingest_cleanup_idx
                    on public.device_audio_ingest (next_cleanup_at, id)
                    where status = 'deleting';
                create index device_audio_ingest_ready_source_idx
                    on public.device_audio_ingest (created_at, id)
                    where status = 'ready' and source_consumed_at is null;

                create function public.device_audio_ingest_enforce_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if tg_op = 'INSERT' then
                        if new.status <> 'finalizing' then
                            raise exception 'device_audio_ingest must start finalizing';
                        end if;
                        return new;
                    end if;
                    if tg_op = 'DELETE' then
                        raise exception 'device_audio_ingest rows cannot be deleted';
                    end if;
                    if row(new.id, new.audio_id, new.device_id, new.actor_id,
                        new.tus_upload_ref, new.tus_upload_id, new.tus_owner_id,
                        new.name, new.name_key, new.recording_started_at,
                        new.created_at, new.storage_key)
                        is distinct from
                        row(old.id, old.audio_id, old.device_id, old.actor_id,
                        old.tus_upload_ref, old.tus_upload_id, old.tus_owner_id,
                        old.name, old.name_key, old.recording_started_at,
                        old.created_at, old.storage_key)
                    then
                        raise exception 'device_audio_ingest identity is immutable';
                    end if;
                    if old.status = 'ready' then
                        if (to_jsonb(new) - 'source_consumed_at') is distinct from
                            (to_jsonb(old) - 'source_consumed_at')
                            or (old.source_consumed_at is not null
                                and new.source_consumed_at is distinct from old.source_consumed_at)
                        then
                            raise exception 'ready device_audio_ingest is immutable';
                        end if;
                        return new;
                    end if;
                    if old.status <> 'finalizing' and
                        row(new.source_size_bytes, new.source_sha256,
                            new.duration_us, new.mime_type) is distinct from
                        row(old.source_size_bytes, old.source_sha256,
                            old.duration_us, old.mime_type)
                    then
                        raise exception 'validated device_audio_ingest media is immutable';
                    end if;
                    if (old.status = 'finalizing' and new.status not in ('finalizing', 'storing', 'deleting'))
                        or (old.status = 'storing' and new.status not in ('storing', 'ready', 'deleting'))
                        or (old.status = 'deleting' and new.status <> 'deleting')
                    then
                        raise exception 'invalid device_audio_ingest transition';
                    end if;
                    return new;
                end
                $function$;
                create trigger device_audio_ingest_mutation_trg
                    before insert or update or delete on public.device_audio_ingest
                    for each row execute function public.device_audio_ingest_enforce_mutation();

                create table public.device_audio (
                    id uuid primary key,
                    device_id uuid not null,
                    ingest_id uuid not null unique,
                    name text not null,
                    name_key bytea not null,
                    recording_started_at timestamptz not null,
                    duration_us bigint not null,
                    recording_ended_at timestamptz not null,
                    created_at timestamptz not null,
                    mime_type text not null,
                    source_size_bytes bigint not null,
                    source_sha256 bytea not null,
                    storage_key text not null unique,
                    transcription text not null,
                    text_version uuid not null,
                    processed boolean not null,
                    processing_version uuid not null,
                    constraint device_audio_device_name_key unique (device_id, name_key),
                    constraint device_audio_ingest_binding_fk
                        foreign key (ingest_id, id, device_id, storage_key)
                        references public.device_audio_ingest (id, audio_id, device_id, storage_key)
                        on delete restrict,
                    constraint device_audio_name_check check (
                        octet_length(name) between 1 and 1024
                        and name_key = convert_to(name, 'UTF8')
                    ),
                    constraint device_audio_duration_check check (duration_us > 0),
                    constraint device_audio_time_check check (
                        isfinite(recording_started_at) and isfinite(recording_ended_at)
                        and isfinite(created_at) and recording_ended_at > recording_started_at
                        and extract(epoch from (recording_ended_at - recording_started_at))
                            * 1000000 = duration_us
                    ),
                    constraint device_audio_mime_check check (mime_type in ('audio/wav', 'audio/mpeg')),
                    constraint device_audio_size_check check (source_size_bytes between 1 and 104857600),
                    constraint device_audio_sha256_check check (octet_length(source_sha256) = 32),
                    constraint device_audio_storage_key_check check (octet_length(storage_key) > 0)
                );
                create index device_audio_device_started_id_idx
                    on public.device_audio (device_id, recording_started_at desc, id desc);
                create index device_audio_unprocessed_started_id_idx
                    on public.device_audio (device_id, recording_started_at desc, id desc)
                    where processed = false;

                create function public.device_audio_enforce_mutation()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if tg_op = 'DELETE' then
                        raise exception 'device_audio rows cannot be deleted';
                    end if;
                    if row(new.id, new.device_id, new.ingest_id, new.name,
                        new.name_key, new.recording_started_at, new.duration_us,
                        new.recording_ended_at, new.created_at, new.mime_type,
                        new.source_size_bytes, new.source_sha256, new.storage_key)
                        is distinct from row(old.id, old.device_id, old.ingest_id,
                        old.name, old.name_key, old.recording_started_at, old.duration_us,
                        old.recording_ended_at, old.created_at, old.mime_type,
                        old.source_size_bytes, old.source_sha256, old.storage_key)
                    then
                        raise exception 'device_audio identity and media are immutable';
                    end if;
                    return new;
                end
                $function$;
                create trigger device_audio_mutation_trg
                    before update or delete on public.device_audio
                    for each row execute function public.device_audio_enforce_mutation();
            "#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
                lock table public.device_audio, public.device_audio_ingest
                    in access exclusive mode;
                do $$
                begin
                    if exists (select 1 from public.device_audio)
                        or exists (select 1 from public.device_audio_ingest)
                    then
                        raise exception 'device_audio rollback refused: audio or ingest data exists';
                    end if;
                end
                $$;
                drop table public.device_audio;
                drop function public.device_audio_enforce_mutation();
                drop table public.device_audio_ingest;
                drop function public.device_audio_ingest_enforce_mutation();
            "#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
