use super::super::DeviceAudioRuntime;
use crate::file_registry::entities::device_audio as audio;
use crate::{h, types::ShortContext};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, QuerySelect, Statement,
    TransactionTrait,
};
use std::sync::Arc;
use uuid::Uuid;

#[derive(FromQueryResult)]
pub(super) struct PendingAudio {
    id: Uuid,
    device_id: Uuid,
    storage_key: String,
    automatic_transcription_pending: Option<i32>,
}
#[derive(FromQueryResult)]
struct PendingTask {
    reprocess_count: i32,
    state: String,
    transcribed_value: Option<String>,
    finished_at: Option<chrono::NaiveDateTime>,
}

impl From<audio::Model> for PendingAudio {
    fn from(audio: audio::Model) -> Self {
        Self {
            id: audio.id,
            device_id: audio.device_id,
            storage_key: audio.storage_key,
            automatic_transcription_pending: audio
                .automatic_transcription_pending,
        }
    }
}
fn pending_columns() -> [audio::Column; 4] {
    [
        audio::Column::Id,
        audio::Column::DeviceId,
        audio::Column::StorageKey,
        audio::Column::AutomaticTranscriptionPending,
    ]
}

pub(crate) async fn run(
    runtime: Arc<DeviceAudioRuntime>,
    _client: Arc<echo_gpu_client::EchoGpuClient>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let mut cursor = None;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        if let Err(error) = batch(&runtime, &mut cursor).await {
            log::error!("device transcription sync failed: {error:#}");
        } else if cursor.is_some() {
            continue;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = runtime.asr_wake.notified() => (),
            _ = tokio::time::sleep(std::time::Duration::from_millis(crate::config::ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS)) => (),
        }
    }
}

pub(super) async fn batch(
    runtime: &DeviceAudioRuntime,
    cursor: &mut Option<Uuid>,
) -> anyhow::Result<()> {
    let mut query = audio::Entity::find()
        .filter(audio::Column::AutomaticTranscriptionPending.is_not_null())
        .order_by_asc(audio::Column::Id)
        .limit(crate::transcription::ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH);
    if let Some(cursor) = *cursor {
        query = query.filter(audio::Column::Id.gt(cursor));
    }
    let rows = query
        .select_only()
        .columns(pending_columns())
        .into_model::<PendingAudio>()
        .all(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    *cursor = rows.last().map(|row| row.id);
    if rows.len()
        < crate::transcription::ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH as usize
    {
        *cursor = None;
    }
    let sources = crate::transcription::service::native_sources_by_keys(
        &runtime.dbx,
        &rows
            .iter()
            .map(|row| row.storage_key.clone())
            .collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    let active_devices = runtime
        .dbx
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select id from device where id=any($1) and not archived",
            [rows
                .iter()
                .map(|row| row.device_id)
                .collect::<Vec<_>>()
                .into()],
        ))
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.try_get::<Uuid>("", "id"))
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .c(h!())?;
    for row in rows {
        let source = sources.get(&row.storage_key);
        if active_devices.contains(&row.device_id)
            && source.is_some_and(|source| {
                source.reprocess_count
                    >= row.automatic_transcription_pending.unwrap_or(0)
                    && !matches!(
                        source.state.as_str(),
                        "completed" | "terminal"
                    )
            })
        {
            continue;
        }
        let source = source.map(|source| source.id);
        if let Err(error) = sync_registered(runtime, row, source).await {
            log::error!("device transcription sync item failed: {error:#}");
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) async fn sync(
    runtime: &DeviceAudioRuntime,
    row: PendingAudio,
) -> anyhow::Result<()> {
    sync_registered(runtime, row, None).await.c(h!())
}

async fn sync_registered(
    runtime: &DeviceAudioRuntime,
    row: PendingAudio,
    registered: Option<Uuid>,
) -> anyhow::Result<()> {
    let target = row.automatic_transcription_pending.unwrap_or(0);
    let source = if let Some(source) = registered {
        source
    } else if target == 0 {
        crate::transcription::service::enqueue(&runtime.dbx, &row.storage_key)
            .await
            .c(h!())?
            .0
    } else {
        crate::transcription::service::source_id(&runtime.dbx, &row.storage_key)
            .await
            .c(h!())?
            .ok_or_else(|| {
                anyhow::anyhow!("pending source missing for {}", row.id)
            })
            .c(h!())?
    };
    let (main, _) =
        crate::transcriber::reprocess::lock_source(&runtime.dbx, source)
            .await
            .c(h!())?;
    // Source lock precedes the files row, including reprocess replay and final apply.
    let active = main
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select not archived as active from device where id=$1 for share",
            [row.device_id.into()],
        ))
        .await
        .c(h!())?
        .map(|row| row.try_get::<bool>("", "active"))
        .transpose()
        .c(h!())?
        .unwrap_or(false);
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let Some(current) = audio::Entity::find_by_id(row.id)
        .select_only()
        .columns(pending_columns())
        .lock_exclusive()
        .into_model::<PendingAudio>()
        .one(&files)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let Some(target) = current.automatic_transcription_pending else {
        return Ok(());
    };
    if !active {
        audio::Entity::update_many()
            .col_expr(
                audio::Column::AutomaticTranscriptionPending,
                Expr::value(Option::<i32>::None),
            )
            .filter(audio::Column::Id.eq(current.id))
            .exec(&files)
            .await
            .c(h!())?;
        files.commit().await.c(h!())?;
        main.commit().await.c(h!())?;
        return Ok(());
    }
    let task = PendingTask::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select reprocess_count,state,transcribed_value,finished_at from echo_gpu_transcription_queue where source_id=$1",[source.into()]))
        .one(&main)
        .await
        .c(h!())?
        .ok_or_else(|| {
            anyhow::anyhow!("pending native task missing for {}", row.id)
        })
        .c(h!())?;
    if task.reprocess_count < target {
        // Commit no files change before resetting: the target is already durable.
        files.commit().await.c(h!())?;
        crate::transcriber::reprocess::reset_to(
            &main,
            source,
            target,
            "device pending replay",
            None,
        )
        .await
        .c(h!())?;
        main.commit().await.c(h!())?;
        return Ok(());
    }
    if !matches!(task.state.as_str(), "completed" | "terminal") {
        return Ok(());
    }
    let mut update = audio::Entity::update_many().col_expr(
        audio::Column::AutomaticTranscriptionPending,
        Expr::value(Option::<i32>::None),
    );
    if task.state == "completed" {
        let text = task
            .transcribed_value
            .filter(|text| !text.trim().is_empty());
        update = update
            .col_expr(audio::Column::AutomaticTranscription, Expr::value(text))
            .col_expr(
                audio::Column::AutomaticTranscribedAt,
                Expr::value(
                    task.finished_at
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "completed transcription has no finish time"
                            )
                        })
                        .c(h!())?,
                ),
            );
    }
    update
        .filter(audio::Column::Id.eq(current.id))
        .exec(&files)
        .await
        .c(h!())?;
    files.commit().await.c(h!())?;
    main.commit().await.c(h!())?;
    Ok(())
}
