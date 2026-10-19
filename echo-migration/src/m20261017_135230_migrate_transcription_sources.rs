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
        manager
            .get_connection()
            .execute_unprepared(
                r#"
do $$
declare
    conflict record;
    previous_lock_timeout text := current_setting('lock_timeout');
    previous_conversion text := current_setting('echo.transcription_source_conversion', true);
    separate_history text[] := array[
        'id','source_id','transcribed_value','created_at','updated_at','finished_at',
        'started_transcription_at','transcription_scope_id','selected_audio_id',
        'actual_instance_id','worker_id'
    ];
begin
    perform set_config('lock_timeout', '5s', true);
    if not pg_try_advisory_xact_lock(36450001::bigint)
       or not pg_try_advisory_xact_lock(36450002::bigint) then
        raise exception 'Stop transcription executors before migrating sources';
    end if;
    lock table echo_gpu_transcription_queue, transcription_source in share row exclusive mode;
    lock table signal_message_media in share mode;

    create temporary table transcription_source_migration on commit drop as
    with located as (
        select queue.id, queue.created_at,
            coalesce(source.source_key, case when media.id is not null then
                'message-media/' || ltrim(coalesce(media.storage_key,
                    left(media.id::text,5) || '/' || media.id::text ||
                    case when media.is_encrypted then '' else '.plaintext' end),'/')
            end) as source_key
        from echo_gpu_transcription_queue queue
        left join transcription_source source on source.id=queue.source_id
        left join signal_message_media media on media.id=queue.source_id
    )
    select id, source_key,
        first_value(id) over(partition by source_key order by created_at,id) as keeper_id
    from located;

    select queue.id, queue.source_id into conflict
    from transcription_source_migration mapping
    join echo_gpu_transcription_queue queue on queue.id=mapping.id
    where mapping.source_key is null or mapping.source_key=''
    order by queue.id limit 1;
    if found then
        raise exception 'Missing S3 key: task_id=%, source_id=%', conflict.id, conflict.source_id;
    end if;

    select mapping.id, mapping.keeper_id, mapping.source_key into conflict
    from transcription_source_migration mapping
    join echo_gpu_transcription_queue task on task.id=mapping.id
    join echo_gpu_transcription_queue keeper on keeper.id=mapping.keeper_id
    where mapping.id<>mapping.keeper_id and (
        task.state<>'completed' or keeper.state<>'completed'
        or convert_to(task.transcribed_value,'UTF8') is distinct from convert_to(keeper.transcribed_value,'UTF8')
        or (to_jsonb(task)-separate_history) is distinct from (to_jsonb(keeper)-separate_history)
    )
    order by mapping.id limit 1;
    if found then
        raise exception 'Incompatible duplicate transcription tasks: task_id=%, keeper_id=%, source_key=%',
            conflict.id, conflict.keeper_id, conflict.source_key;
    end if;

    perform set_config('echo.transcription_source_conversion', 'on', true);
    insert into transcription_source(id,source_key)
    select uuid_generate_v7(),source_key
    from (select distinct source_key from transcription_source_migration) keys
    where true
    on conflict(source_key) do nothing;

    delete from echo_gpu_transcription_queue queue
    using transcription_source_migration mapping
    where queue.id=mapping.id and mapping.id<>mapping.keeper_id;

    update echo_gpu_transcription_queue queue set source_id=source.id
    from transcription_source_migration mapping
    join transcription_source source on source.source_key=mapping.source_key
    where queue.id=mapping.id and mapping.id=mapping.keeper_id
        and queue.source_id is distinct from source.id;

    perform set_config('echo.transcription_source_conversion', coalesce(previous_conversion,''), true);
    perform set_config('lock_timeout', previous_lock_timeout, true);
end $$;
"#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "Transcription sources were remapped and duplicate histories merged; restore a database snapshot to downgrade".into(),
        ))
    }
}
