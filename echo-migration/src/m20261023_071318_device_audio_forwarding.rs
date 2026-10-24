use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table public.device_audio_forwarding_settings (
    device_id uuid primary key references device(id) on delete cascade,
    enabled boolean not null,
    version uuid not null,
    updated_at timestamptz not null,
    updated_by uuid not null references login(id)
);
create table public.device_audio_forwarding_group (
    device_id uuid not null references device(id) on delete cascade,
    group_master_key text not null references signal_group(master_key) on delete cascade,
    created_by uuid not null references login(id),
    created_at timestamptz not null,
    primary key(device_id, group_master_key)
);
create index device_audio_forwarding_group_group_idx on public.device_audio_forwarding_group(group_master_key);
create table public.device_audio_forwarding_delivery (
    audio_id uuid not null,
    group_master_key text not null,
    signal_message_id bigint references signal_message(id) on delete set null,
    outcome text not null check (outcome in ('delivered', 'group_unavailable')),
    created_at timestamptz not null default now(),
    primary key(audio_id, group_master_key)
);
create table public.signal_message_audio_ref (
    id uuid primary key,
    signal_message_id bigint not null references signal_message(id) on delete cascade,
    audio_id uuid not null,
    transcription_source_id uuid not null references transcription_source(id),
    file_name_override text,
    created_at timestamp not null default (now() at time zone 'UTC'),
    unique(signal_message_id, audio_id)
);
create index signal_message_audio_ref_audio_idx on public.signal_message_audio_ref(audio_id);
create index signal_message_audio_ref_source_idx on public.signal_message_audio_ref(transcription_source_id);
create table public.signal_message_audio_search (
    id uuid primary key references signal_message_audio_ref(id) on delete cascade,
    signal_message_id bigint not null references signal_message(id) on delete cascade,
    file_name text not null
);
create index signal_message_audio_search_message_idx on public.signal_message_audio_search(signal_message_id);
create index signal_message_audio_search_name_idx on public.signal_message_audio_search using gin(file_name gin_trgm_ops);
create trigger signal_message_audio_search_changed
    after insert or update or delete on public.signal_message_audio_search
    for each row execute function attachment_search_track_media();

create or replace function capture_api_integration_iggy_media_result()
returns trigger language plpgsql as $$
declare
    old_media_id uuid;
    new_media_id uuid;
    item_id bigint;
begin
    if current_setting('echo.transcription_source_conversion', true) = 'on' then return coalesce(new,old); end if;
    if not api_integration_iggy_has_publisher() then
        return coalesce(new, old);
    end if;
    if tg_op = 'UPDATE' and old is not distinct from new then
        return new;
    end if;
    if tg_op <> 'INSERT' then
        old_media_id := (to_jsonb(old) ->> tg_argv[0])::uuid;
    end if;
    if tg_op <> 'DELETE' then
        new_media_id := (to_jsonb(new) ->> tg_argv[0])::uuid;
    end if;
    for item_id in
        select distinct matched.signal_message_id from (
            select media.signal_message_id
            from transcription_source source
            join signal_message_media media on source.source_key = 'message-media/' || ltrim(coalesce(media.storage_key, left(media.id::text,5) || '/' || media.id::text || case when media.is_encrypted then '' else '.plaintext' end),'/')
            join sigint_inbox_item item on item.id = media.signal_message_id
            where tg_table_name = 'echo_gpu_transcription_queue' and source.id in(old_media_id,new_media_id)
            union all
            select ref.signal_message_id
            from signal_message_audio_ref ref
            join sigint_inbox_item item on item.id=ref.signal_message_id
            where tg_table_name = 'echo_gpu_transcription_queue'
                and ref.transcription_source_id in(old_media_id,new_media_id)
            union all
            select media.signal_message_id
            from signal_message_media media
            join sigint_inbox_item item on item.id = media.signal_message_id
            where tg_table_name <> 'echo_gpu_transcription_queue' and media.id in(old_media_id,new_media_id)
        ) matched
    loop
        perform queue_api_integration_iggy_event(
            item_id,
            jsonb_build_object('event_type', 'sigint_inbox_item_updated')
        );
    end loop;
    return coalesce(new, old);
end;
$$;


"#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", file!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration("Audio forwarding references and delivery history must be retained; disable forwarding and repair forward".into()))
    }
}
