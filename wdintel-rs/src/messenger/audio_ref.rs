use crate::entities::signal_message_media;
use crate::file_registry::entities::device_audio;
use crate::{
    h,
    types::{Env, ShortContext},
};
use sea_orm::*;
use uuid::Uuid;

#[derive(Clone, FromQueryResult)]
pub(crate) struct AudioReference {
    pub id: Uuid,
    pub signal_message_id: i64,
    pub audio_id: Uuid,
    pub transcription_source_id: Uuid,
    pub created_at: chrono::NaiveDateTime,
    pub file_name_override: Option<String>,
}

pub(crate) async fn attach(
    env: &Env,
    db: &DatabaseTransaction,
    message: i64,
    audio: &device_audio::Model,
) -> anyhow::Result<Uuid> {
    let source =
        crate::transcription::service::register(db, &audio.storage_key)
            .await
            .c(h!())?;
    let row = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into signal_message_audio_ref(id,signal_message_id,audio_id,transcription_source_id) values($1,$2,$3,$4) on conflict(signal_message_id,audio_id) do update set audio_id=excluded.audio_id returning id",
        [Uuid::now_v7().into(), message.into(), audio.id.into(), source.into()])).await.c(h!())?.c(h!())?;
    if audio.source_size_bytes
        <= crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES
        && crate::system_settings::audio_transcription_enabled(db)
            .await
            .c(h!())?
    {
        // The source lock precedes the files row, as in explicit ASR retries.
        env.file_registry_db().c(h!())?.connection().execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update device_audio set automatic_transcription_pending=coalesce(automatic_transcription_pending,0) where id=$1", [audio.id.into()])).await.c(h!())?;
        echo_gpu_client::enqueue(db, source).await.c(h!())?;
    }
    let id = row.try_get("", "id").c(h!())?;
    let current = reference(db, id).await.c(h!())?.c(h!())?;
    index_name(
        db,
        id,
        message,
        current.file_name_override.as_deref().unwrap_or(&audio.name),
    )
    .await
    .c(h!())?;
    Ok(id)
}

pub(crate) async fn reference<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> anyhow::Result<Option<AudioReference>> {
    AudioReference::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select * from signal_message_audio_ref where id=$1",
        [id.into()],
    ))
    .one(db)
    .await
    .c(h!())
}

pub(crate) async fn audio(
    env: &Env,
    reference: &AudioReference,
) -> anyhow::Result<device_audio::Model> {
    device_audio::Entity::find_by_id(reference.audio_id)
        .one(env.file_registry_db().c(h!())?.connection())
        .await
        .c(h!())?
        .c(h!())
}

pub(crate) fn is_reference(media: &signal_message_media::Model) -> bool {
    media.storage_key.as_deref().is_some_and(|key| {
        key.starts_with(
            crate::config::ECHO_AUDIO_TRANSCRIPTION_DEVICE_SOURCE_PREFIX,
        )
    })
}

// A read projection only: audio metadata is never inserted into signal_message_media.
fn media(
    reference: AudioReference,
    audio: device_audio::Model,
) -> signal_message_media::Model {
    signal_message_media::Model {
        id: reference.id,
        signal_message_id: reference.signal_message_id,
        signal_message_uuid: None,
        content_type: audio.mime_type,
        file_ext: std::path::Path::new(&audio.name)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_string),
        file_name: Some(reference.file_name_override.unwrap_or(audio.name)),
        size_bytes: audio.source_size_bytes,
        created_at: reference.created_at,
        is_encrypted: true,
        storage_key: Some(audio.storage_key),
    }
}

pub(crate) async fn authorized(
    env: &Env,
    actor: &Uuid,
    id: Uuid,
) -> Result<signal_message_media::Model, crate::error::AppError> {
    if let Some(reference) = reference(&env.dbx, id).await.c(h!())? {
        crate::messenger::media::ensure_media_access(
            &env.dbx,
            actor,
            reference.signal_message_id,
        )
        .await
        .c(h!())?;
        let audio = audio(env, &reference).await.c(h!())?;
        return Ok(media(reference, audio));
    }
    let media = find(env, id)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    crate::messenger::media::ensure_media_access(
        &env.dbx,
        actor,
        media.signal_message_id,
    )
    .await
    .c(h!())?;
    Ok(media)
}

pub(crate) async fn find(
    env: &Env,
    id: Uuid,
) -> anyhow::Result<Option<signal_message_media::Model>> {
    if let Some(stored) = signal_message_media::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        return Ok(Some(stored));
    }
    let Some(reference) = reference(&env.dbx, id).await.c(h!())? else {
        return Ok(None);
    };
    let audio = audio(env, &reference).await.c(h!())?;
    Ok(Some(media(reference, audio)))
}

pub(crate) async fn for_messages<C: ConnectionTrait>(
    env: &Env,
    db: &C,
    messages: &[i64],
) -> anyhow::Result<Vec<signal_message_media::Model>> {
    load_messages(env, db, messages, false).await.c(h!())
}

pub(crate) async fn for_messages_locked(
    env: &Env,
    db: &DatabaseTransaction,
    messages: &[i64],
) -> anyhow::Result<Vec<signal_message_media::Model>> {
    load_messages(env, db, messages, true).await.c(h!())
}

async fn load_messages<C: ConnectionTrait>(
    env: &Env,
    db: &C,
    messages: &[i64],
    lock: bool,
) -> anyhow::Result<Vec<signal_message_media::Model>> {
    if messages.is_empty() {
        return Ok(vec![]);
    }
    let mut query = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .is_in(messages.to_vec()),
        )
        .order_by_asc(signal_message_media::Column::Id);
    if lock {
        query = query.lock_exclusive();
    }
    let mut stored = query.all(db).await.c(h!())?;
    let refs = AudioReference::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        format!("select * from signal_message_audio_ref where signal_message_id=any($1) order by id{}", if lock { " for update" } else { "" }), [messages.to_vec().into()])).all(db).await.c(h!())?;
    if !refs.is_empty() {
        let audio =
            device_audio::Entity::find()
                .filter(device_audio::Column::Id.is_in(
                    refs.iter().map(|row| row.audio_id).collect::<Vec<_>>(),
                ))
                .all(env.file_registry_db().c(h!())?.connection())
                .await
                .c(h!())?
                .into_iter()
                .map(|audio| (audio.id, audio))
                .collect::<std::collections::HashMap<_, _>>();
        for reference in refs {
            let audio = audio.get(&reference.audio_id).c(h!())?.clone();
            stored.push(media(reference, audio));
        }
    }
    stored.sort_by_key(|media| media.id);
    Ok(stored)
}

pub(crate) async fn bytes(
    env: &Env,
    media: &signal_message_media::Model,
) -> anyhow::Result<Vec<u8>> {
    let reference = reference(&env.dbx, media.id).await.c(h!())?.c(h!())?;
    let audio = audio(env, &reference).await.c(h!())?;
    crate::devices::audio::shared_bytes(&env.device_audio, &audio)
        .await
        .c(h!())
}

pub(crate) async fn delete<C: ConnectionTrait>(
    db: &C,
    message: i64,
    ids: &[Uuid],
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "delete from signal_message_audio_ref where signal_message_id=$1 and id=any($2)", [message.into(), ids.to_vec().into()])).await.c(h!())?;
    Ok(())
}

pub(crate) async fn rename<C: ConnectionTrait>(
    db: &C,
    message: i64,
    id: Uuid,
    name: &str,
) -> anyhow::Result<bool> {
    let updated = db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update signal_message_audio_ref set file_name_override=$3 where signal_message_id=$1 and id=$2", [message.into(), id.into(), name.into()])).await.c(h!())?.rows_affected() > 0;
    if updated {
        index_name(db, id, message, name).await.c(h!())?;
    }
    Ok(updated)
}

async fn index_name<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
    message: i64,
    name: &str,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into signal_message_audio_search(id,signal_message_id,file_name) values($1,$2,$3) on conflict(id) do update set file_name=excluded.file_name where signal_message_audio_search.file_name is distinct from excluded.file_name", [id.into(), message.into(), name.into()])).await.c(h!())?;
    Ok(())
}

pub(crate) async fn copy<C: ConnectionTrait>(
    env: &Env,
    db: &C,
    message: i64,
    media: &[signal_message_media::Model],
) -> anyhow::Result<()> {
    for media in media.iter().filter(|media| is_reference(media)) {
        let reference = reference(db, media.id).await.c(h!())?.c(h!())?;
        let audio = audio(env, &reference).await.c(h!())?;
        let override_name = media
            .file_name
            .as_ref()
            .filter(|name| **name != audio.name)
            .cloned();
        let created = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into signal_message_audio_ref(id,signal_message_id,audio_id,transcription_source_id,file_name_override) values($1,$2,$3,$4,$5) on conflict(signal_message_id,audio_id) do nothing returning id",
            [Uuid::now_v7().into(), message.into(), reference.audio_id.into(), reference.transcription_source_id.into(), override_name.into()])).await.c(h!())?;
        if let Some(created) = created {
            index_name(
                db,
                created.try_get("", "id").c(h!())?,
                message,
                media.file_name.as_deref().unwrap_or(&audio.name),
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

pub(crate) async fn reconcile(
    env: &Env,
    db: &DatabaseTransaction,
    message: i64,
) -> anyhow::Result<()> {
    if !crate::system_settings::audio_transcription_enabled(db)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    let refs = AudioReference::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select ref.* from signal_message_audio_ref ref join signal_message message on message.id=ref.signal_message_id where ref.signal_message_id=$1 and not message.deleted", [message.into()])).all(db).await.c(h!())?;
    for reference in refs {
        let audio = audio(env, &reference).await.c(h!())?;
        attach(env, db, message, &audio).await.c(h!())?;
    }
    Ok(())
}
