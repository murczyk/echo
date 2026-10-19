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
        manager.get_connection().execute_unprepared(r#"create index signal_message_media_transcription_source_idx on public.signal_message_media
    (('message-media/' || ltrim(coalesce(storage_key, left(id::text,5) || '/' || id::text || case when is_encrypted then '' else '.plaintext' end),'/')));
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


drop trigger if exists echo_gpu_transcription_queue_capture_iggy_edit on echo_gpu_transcription_queue;
create trigger echo_gpu_transcription_queue_capture_iggy_edit
after insert or update of source_id, state, transcribed_value or delete
on echo_gpu_transcription_queue
for each row execute function capture_api_integration_iggy_media_result('source_id');
"#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration("Source-key integration requires the matching application; downgrade is manual".into()))
    }
}
