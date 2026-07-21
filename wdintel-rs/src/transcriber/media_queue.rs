use crate::entities::{signal_message, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct QueueMediaResult {
    pub queued: usize,
    pub skipped_oversized: usize,
}

pub async fn reconcile<C>(
    dbx: &C,
    surviving: &[signal_message_media::Model],
    superseded_ids: &[uuid::Uuid],
) -> Result<QueueMediaResult, AppError>
where
    C: ConnectionTrait,
{
    if !crate::system_settings::audio_transcription_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(QueueMediaResult::default());
    }

    echo_gpu_client::delete_by_sources(dbx, superseded_ids)
        .await
        .context(h!())?;
    let mut result = QueueMediaResult::default();
    for media in surviving {
        if !crate::messenger::media::is_audio_media(media) {
            continue;
        }
        if media.size_bytes > crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES
        {
            result.skipped_oversized += 1;
            log::warn!(
                "skipping oversized transcription media_id={} size_bytes={}",
                media.id,
                media.size_bytes
            );
            continue;
        }
        if matches!(
            echo_gpu_client::enqueue(dbx, media.id)
                .await
                .context(h!())?,
            echo_gpu_client::EnqueueOutcome::Queued
        ) {
            result.queued += 1;
        }
    }
    Ok(result)
}

pub async fn reconcile_message<C>(
    dbx: &C,
    signal_message_id: i64,
    superseded_ids: &[uuid::Uuid],
) -> Result<QueueMediaResult, AppError>
where
    C: ConnectionTrait,
{
    let message = signal_message::Entity::find_by_id(signal_message_id)
        .one(dbx)
        .await
        .c(h!())?;
    let media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .all(dbx)
        .await
        .c(h!())?;
    if message.is_some_and(|message| !message.deleted) {
        reconcile(dbx, &media, superseded_ids).await
    } else {
        let mut removed_ids = superseded_ids.to_vec();
        removed_ids.extend(media.into_iter().map(|media| media.id));
        reconcile(dbx, &[], &removed_ids).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_size_limit_is_inclusive() {
        assert_eq!(
            crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES,
            104_857_600
        );
    }
}
