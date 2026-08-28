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

#[derive(Debug, PartialEq, Eq)]
pub(super) enum MediaEligibility {
    Eligible,
    NonAudio,
    Oversized,
}

pub(super) fn media_eligibility(
    media: &signal_message_media::Model,
) -> MediaEligibility {
    if !crate::messenger::media::is_audio_media(media) {
        MediaEligibility::NonAudio
    } else if media.size_bytes
        > crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES
    {
        MediaEligibility::Oversized
    } else {
        MediaEligibility::Eligible
    }
}

pub async fn reconcile<C>(
    dbx: &C,
    surviving: &[signal_message_media::Model],
    superseded_ids: &[uuid::Uuid],
) -> Result<QueueMediaResult, AppError>
where
    C: ConnectionTrait,
{
    echo_gpu_client::delete_by_sources(dbx, superseded_ids)
        .await
        .context(h!())?;
    if !crate::system_settings::audio_transcription_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(QueueMediaResult::default());
    }

    let mut result = QueueMediaResult::default();
    for media in surviving {
        match media_eligibility(media) {
            MediaEligibility::Eligible => {}
            MediaEligibility::NonAudio => continue,
            MediaEligibility::Oversized => {
                result.skipped_oversized += 1;
                log::warn!(
                    "skipping oversized transcription media_id={} size_bytes={}",
                    media.id,
                    media.size_bytes
                );
                continue;
            }
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
    use super::{
        media_eligibility, reconcile, reconcile_message, MediaEligibility,
    };
    use crate::entities::{signal_message_media, system_settings};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };
    use uuid::Uuid;

    fn audio(size_bytes: i64) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::now_v7(),
            signal_message_id: 1,
            signal_message_uuid: Some(Uuid::now_v7()),
            content_type: "audio/ogg".to_string(),
            file_ext: Some("ogg".to_string()),
            file_name: Some("recording.ogg".to_string()),
            size_bytes,
            is_encrypted: false,
            storage_key: None,
            created_at: chrono::Utc::now().naive_utc(),
        }
    }

    #[test]
    fn audio_size_limit_is_inclusive() {
        assert_eq!(
            media_eligibility(&audio(104_857_600)),
            MediaEligibility::Eligible
        );
        assert_eq!(
            media_eligibility(&audio(104_857_601)),
            MediaEligibility::Oversized
        );

        let mut media = audio(1);
        media.content_type = "text/plain".to_string();
        media.file_ext = Some("txt".to_string());
        media.file_name = Some("note.txt".to_string());
        assert_eq!(media_eligibility(&media), MediaEligibility::NonAudio);
    }

    #[tokio::test]
    async fn disabled_reconcile_still_deletes_superseded_queue_items() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let source_id = Uuid::now_v7();
        echo_gpu_client::enqueue(&env.dbx, source_id).await.unwrap();

        reconcile(&env.dbx, &[], &[source_id]).await.unwrap();

        assert!(echo_gpu_client::lookup(&env.dbx, source_id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn enabled_reconcile_is_idempotent_and_tracks_final_media_state() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        system_settings::ActiveModel {
            enable_audio_transcription: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let mut eligible = audio(104_857_600);
        eligible.signal_message_id = message.id;
        let eligible =
            eligible.into_active_model().insert(&env.dbx).await.unwrap();
        let mut oversized = audio(104_857_601);
        oversized.signal_message_id = message.id;
        oversized
            .into_active_model()
            .insert(&env.dbx)
            .await
            .unwrap();
        let mut non_audio = audio(1);
        non_audio.signal_message_id = message.id;
        non_audio.content_type = "text/plain".into();
        non_audio.file_ext = Some("txt".into());
        non_audio.file_name = Some("note.txt".into());
        non_audio
            .into_active_model()
            .insert(&env.dbx)
            .await
            .unwrap();

        let first = reconcile_message(&env.dbx, message.id, &[]).await.unwrap();
        assert_eq!(first.queued, 1);
        assert_eq!(first.skipped_oversized, 1);
        let second =
            reconcile_message(&env.dbx, message.id, &[]).await.unwrap();
        assert_eq!(second.queued, 0);
        assert_eq!(second.skipped_oversized, 1);

        signal_message_media::Entity::delete_by_id(eligible.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        reconcile_message(&env.dbx, message.id, &[eligible.id])
            .await
            .unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, eligible.id)
            .await
            .unwrap()
            .is_none());

        let replacement = audio(1);
        let replacement_id = replacement.id;
        let mut replacement = replacement.into_active_model();
        replacement.signal_message_id = Set(message.id);
        replacement.insert(&env.dbx).await.unwrap();
        reconcile_message(&env.dbx, message.id, &[]).await.unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, replacement_id)
            .await
            .unwrap()
            .is_some());

        let message_id = message.id;
        let mut message = message.into_active_model();
        message.deleted = Set(true);
        message.update(&env.dbx).await.unwrap();
        reconcile_message(&env.dbx, message_id, &[]).await.unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, replacement_id)
            .await
            .unwrap()
            .is_none());
    }
}
