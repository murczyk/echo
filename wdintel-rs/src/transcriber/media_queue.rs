use crate::entities::{signal_message, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, TransactionTrait,
};

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
    _superseded_ids: &[uuid::Uuid],
) -> Result<QueueMediaResult, AppError>
where
    C: ConnectionTrait + TransactionTrait,
{
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
            crate::transcription::service::enqueue(dbx, &source_key(media))
                .await
                .context(h!())?
                .1,
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
    C: ConnectionTrait + TransactionTrait,
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

pub fn source_key(media: &signal_message_media::Model) -> String {
    crate::storage::join_paths(
        crate::config::S3_MEDIA_ROOT_PREFIX,
        &crate::messenger::media::media_object_key(media),
    )
}

pub const SOURCE_KEY_SQL: &str = "'message-media/' || ltrim(coalesce(media.storage_key, left(media.id::text,5) || '/' || media.id::text || case when media.is_encrypted then '' else '.plaintext' end),'/')";

#[cfg(test)]
mod tests {
    use super::{
        media_eligibility, reconcile, reconcile_message, MediaEligibility,
    };
    use crate::entities::{signal_message_media, system_settings};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ConnectionTrait, EntityTrait,
        IntoActiveModel,
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
    #[serial_test::serial]
    async fn shared_storage_key_has_one_native_task() {
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
        let mut media = Vec::new();
        for _ in 0..2 {
            let mut item = audio(8);
            item.signal_message_id = message.id;
            item.storage_key = Some("shared-queue-source".into());
            media
                .push(item.into_active_model().insert(&env.dbx).await.unwrap());
        }
        let result = reconcile(&env.dbx, &media, &[]).await.unwrap();
        assert_eq!(result.queued, 1);
        let replay = reconcile(&env.dbx, &media, &[]).await.unwrap();
        assert_eq!(replay.queued, 0);
        env.dbx.execute_unprepared("update echo_gpu_transcription_queue set state='completed',transcribed_value='shared transcript',finished_at=now() at time zone 'utc'").await.unwrap();
        let texts = crate::transcriber::completed_transcriptions(
            &env.dbx,
            &media.iter().map(|media| media.id).collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        assert_eq!(texts.len(), 2);
        assert!(media
            .iter()
            .all(|media| texts.get(&media.id).map(String::as_str)
                == Some("shared transcript")));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn disabled_reconcile_retains_shared_native_results() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let source_id = Uuid::now_v7();
        echo_gpu_client::enqueue(&env.dbx, source_id).await.unwrap();

        reconcile(&env.dbx, &[], &[source_id]).await.unwrap();

        assert!(echo_gpu_client::lookup(&env.dbx, source_id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
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

        let source = crate::transcription::service::source_id(
            &env.dbx,
            &super::source_key(&eligible),
        )
        .await
        .unwrap()
        .unwrap();
        signal_message_media::Entity::delete_by_id(eligible.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        reconcile_message(&env.dbx, message.id, &[eligible.id])
            .await
            .unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .is_some());

        let replacement = audio(1);
        let replacement_key = super::source_key(&replacement);
        let mut replacement = replacement.into_active_model();
        replacement.signal_message_id = Set(message.id);
        replacement.insert(&env.dbx).await.unwrap();
        reconcile_message(&env.dbx, message.id, &[]).await.unwrap();
        let replacement_id = crate::transcription::service::source_id(
            &env.dbx,
            &replacement_key,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, replacement_id)
            .await
            .unwrap()
            .is_some());

        let message_id = message.id;
        let mut message = message.into_active_model();
        message.deleted = Set(true);
        message.update(&env.dbx).await.unwrap();
        reconcile_message(&env.dbx, message_id, &[]).await.unwrap();
        let replacement_id = crate::transcription::service::source_id(
            &env.dbx,
            &replacement_key,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, replacement_id)
            .await
            .unwrap()
            .is_some());
    }
}
