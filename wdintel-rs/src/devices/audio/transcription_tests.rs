use super::super::acceptance_tests::{
    enabled_audio_device, native_audio_bytes, receive_command,
};
use super::super::*;
use crate::file_registry::entities::device_audio;
use crate::functest::tests::cleanup_locked;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, EntityTrait, IntoActiveModel, Set,
};
#[path = "transcription_settings_tests.rs"]
mod settings_tests;

async fn accepted(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
) -> device_audio::Model {
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        &Uuid::new_v4().to_string(),
        native_audio_bytes().await,
    )
    .await;
    let types::ReceiveDeviceAudioOutcome::Accepted(response) =
        receive(&env.device_audio, actor, command).await.unwrap()
    else {
        panic!("audio must be accepted")
    };
    device_audio::Entity::find_by_id(
        Uuid::parse_str(&response.audio.id).unwrap(),
    )
    .one(env.device_audio.file_database().unwrap())
    .await
    .unwrap()
    .unwrap()
}

async fn enable_asr(env: &crate::types::Env) {
    let settings = crate::system_settings::get_active_system_settings(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut settings = settings.into_active_model();
    settings.enable_audio_transcription = Set(true);
    settings.update(&env.dbx).await.unwrap();
}

async fn local(env: &crate::types::Env, id: Uuid) -> device_audio::Model {
    device_audio::Entity::find_by_id(id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}
async fn sync(env: &crate::types::Env, id: Uuid) -> anyhow::Result<()> {
    super::reconcile::sync(&env.device_audio, local(env, id).await.into()).await
}
async fn finish(
    env: &crate::types::Env,
    key: &str,
    text: Option<&str>,
) -> Uuid {
    let (source, _) = crate::transcription::service::enqueue(&env.dbx, key)
        .await
        .unwrap();
    env.dbx.execute_raw(sea_orm::Statement::from_sql_and_values(sea_orm::DbBackend::Postgres,
        "update echo_gpu_transcription_queue set state='completed',transcribed_value=$2,finished_at=now() at time zone 'utc' where source_id=$1", [source.into(),text.into()])).await.unwrap();
    source
}
#[actix_web::test]
#[serial_test::serial]
async fn publication_survives_enqueue_reply_loss_and_local_apply_failure() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    assert_eq!(audio.automatic_transcription_pending, Some(0));
    let source = finish(&env, &audio.storage_key, Some("автоматичний")).await;
    let files = env.device_audio.file_database().unwrap();
    files.execute_unprepared("create function reject_test_auto_apply() returns trigger language plpgsql as $$ begin raise exception 'files unavailable'; end $$; create trigger reject_test_auto_apply before update of automatic_transcription on device_audio for each row execute function reject_test_auto_apply()").await.unwrap();
    let result = sync(&env, audio.id).await;
    files.execute_unprepared("drop trigger reject_test_auto_apply on device_audio; drop function reject_test_auto_apply()").await.unwrap();
    assert!(result.is_err());
    assert_eq!(
        local(&env, audio.id).await.automatic_transcription_pending,
        Some(0)
    );
    sync(&env, audio.id).await.unwrap();
    sync(&env, audio.id).await.unwrap();
    let saved = local(&env, audio.id).await;
    assert_eq!(
        saved.automatic_transcription.as_deref(),
        Some("автоматичний")
    );
    assert!(saved.automatic_transcribed_at.is_some());
    assert_eq!(saved.automatic_transcription_pending, None);
    assert_eq!(
        (
            saved.transcription,
            saved.text_version,
            saved.processed,
            saved.processing_version
        ),
        (
            audio.transcription,
            audio.text_version,
            audio.processed,
            audio.processing_version
        )
    );
    let task = echo_gpu_client::lookup(&env.dbx, source)
        .await
        .unwrap()
        .unwrap()
        .0;
    assert_eq!((task.attempt_count, task.reprocess_count), (0, 0));
}
#[actix_web::test]
#[serial_test::serial]
async fn saved_text_and_no_speech_do_not_read_native_queue() {
    use super::{ActorAudioCommand, AudioTarget, StatusCommand};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    for text in [Some("збережений"), None] {
        let audio = accepted(&env, actor, device).await;
        finish(&env, &audio.storage_key, text).await;
        sync(&env, audio.id).await.unwrap();
        env.dbx.execute_unprepared("alter table echo_gpu_transcription_queue rename to test_unavailable_native_queue").await.unwrap();
        let response = super::status(
            &env.device_audio,
            StatusCommand {
                audio: ActorAudioCommand {
                    actor_id: actor,
                    target: AudioTarget {
                        device_id: device,
                        audio_id: audio.id,
                    },
                },
                known_version: None,
            },
        )
        .await;
        env.dbx.execute_unprepared("alter table test_unavailable_native_queue rename to echo_gpu_transcription_queue").await.unwrap();
        let snapshot = response.unwrap().snapshot.unwrap();
        assert_eq!(snapshot.text.as_deref(), text);
        assert_eq!(
            snapshot.state,
            if text.is_some() {
                types::DeviceAudioAutomaticTranscriptionState::AudioAsrSucceeded
            } else {
                types::DeviceAudioAutomaticTranscriptionState::AudioAsrNoSpeech
            }
        );
    }
}
#[actix_web::test]
#[serial_test::serial]
async fn shared_reprocess_replays_one_target_and_rejects_old_local_snapshot() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let source = finish(&env, &audio.storage_key, Some("old")).await;
    sync(&env, audio.id).await.unwrap();
    let old = local(&env, audio.id).await;
    assert!(!crate::transcriber::reprocess::request_if_state(
        &env.dbx,
        Some(env.device_audio.file_database().unwrap()),
        source,
        "terminal",
        "state-filter regression",
        None
    )
    .await
    .unwrap());
    assert_eq!(old, local(&env, audio.id).await);
    assert_eq!(
        echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0
            .reprocess_count,
        0
    );
    let target = crate::transcriber::reprocess::request(
        &env.dbx,
        Some(env.device_audio.file_database().unwrap()),
        source,
        "retry",
        Some("test"),
    )
    .await
    .unwrap();
    assert_eq!(target, 1);
    // Fast completion before a lost HTTP reply is replayed.
    finish(&env, &audio.storage_key, Some("new")).await;
    assert_eq!(
        crate::transcriber::reprocess::request(
            &env.dbx,
            Some(env.device_audio.file_database().unwrap()),
            source,
            "retry",
            Some("test")
        )
        .await
        .unwrap(),
        1
    );
    super::reconcile::sync(&env.device_audio, old.into())
        .await
        .unwrap();
    assert_eq!(
        local(&env, audio.id)
            .await
            .automatic_transcription
            .as_deref(),
        Some("new")
    );
    assert_eq!(
        echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0
            .reprocess_count,
        1
    );
    assert_eq!(
        crate::transcriber::reprocess::request(
            &env.dbx,
            Some(env.device_audio.file_database().unwrap()),
            source,
            "new command",
            Some("test")
        )
        .await
        .unwrap(),
        2
    );
}
#[actix_web::test]
#[serial_test::serial]
async fn durable_reprocess_intent_recovers_before_reset_and_keeps_old_text_on_terminal(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let source = finish(&env, &audio.storage_key, Some("old")).await;
    sync(&env, audio.id).await.unwrap();
    let files = env.device_audio.file_database().unwrap();
    files.execute_unprepared(&format!("update device_audio set automatic_transcription_pending=1 where id='{}'",audio.id)).await.unwrap();
    sync(&env, audio.id).await.unwrap();
    assert_eq!(
        echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0
            .reprocess_count,
        1
    );
    assert_eq!(
        local(&env, audio.id).await.automatic_transcription_pending,
        Some(1)
    );
    env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set state='terminal',last_error='fixture' where source_id='{source}'")).await.unwrap();
    sync(&env, audio.id).await.unwrap();
    let saved = local(&env, audio.id).await;
    assert_eq!(saved.automatic_transcription.as_deref(), Some("old"));
    assert_eq!(saved.automatic_transcription_pending, None);
}

#[actix_web::test]
#[serial_test::serial]
async fn disabling_preserves_accepted_work_and_archive_forbids_new_local_apply()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    super::set_settings(
        &env.device_audio,
        super::SetSettingsCommand {
            scope: super::SettingsCommand {
                actor_id: actor,
                device_id: device,
            },
            enabled: false,
        },
    )
    .await
    .unwrap();
    finish(&env, &audio.storage_key, Some("accepted")).await;
    sync(&env, audio.id).await.unwrap();
    assert_eq!(
        local(&env, audio.id)
            .await
            .automatic_transcription
            .as_deref(),
        Some("accepted")
    );
    let disabled = accepted(&env, actor, device).await;
    assert!(disabled.automatic_transcription_pending.is_none());
    super::set_settings(
        &env.device_audio,
        super::SetSettingsCommand {
            scope: super::SettingsCommand {
                actor_id: actor,
                device_id: device,
            },
            enabled: true,
        },
    )
    .await
    .unwrap();
    let archived = accepted(&env, actor, device).await;
    finish(&env, &archived.storage_key, Some("must not apply")).await;
    env.dbx.execute_unprepared(&format!("update device set archived=true,archived_at=now() where id='{device}'")).await.unwrap();
    let error = super::retry(
        &env.device_audio,
        super::ActorAudioCommand {
            actor_id: actor,
            target: super::AudioTarget {
                device_id: device,
                audio_id: archived.id,
            },
        },
    )
    .await
    .unwrap_err();
    let response = actix_web::ResponseError::error_response(
        &crate::error::AppError::from(error),
    );
    assert_eq!(response.status(), actix_web::http::StatusCode::FORBIDDEN);
    assert_eq!(
        actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap(),
        "Forbidden"
    );
    sync(&env, archived.id).await.unwrap();
    let saved = local(&env, archived.id).await;
    assert!(saved.automatic_transcription.is_none());
    assert!(saved.automatic_transcription_pending.is_none());
}

#[actix_web::test]
#[serial_test::serial]
async fn pending_sync_reaches_result_beyond_a_full_pending_page() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let bytes = native_audio_bytes().await;
    let mut audios = Vec::new();
    for _ in 0..=crate::transcription::ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH {
        let (actor, device) = enabled_audio_device(&env).await;
        enable_asr(&env).await;
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            &Uuid::new_v4().to_string(),
            bytes.clone(),
        )
        .await;
        let types::ReceiveDeviceAudioOutcome::Accepted(response) =
            receive(&env.device_audio, actor, command).await.unwrap()
        else {
            panic!("audio must be accepted")
        };
        audios.push((Uuid::parse_str(&response.audio.id).unwrap(), device));
    }
    let (id, _) = audios.into_iter().max_by_key(|(id, _)| *id).unwrap();
    let selected = local(&env, id).await;
    finish(&env, &selected.storage_key, Some("later page result")).await;
    let mut cursor = None;
    super::reconcile::batch(&env.device_audio, &mut cursor)
        .await
        .unwrap();
    assert!(cursor.is_some());
    assert!(local(&env, id).await.automatic_transcription.is_none());
    super::reconcile::batch(&env.device_audio, &mut cursor)
        .await
        .unwrap();
    assert!(cursor.is_none());
    let saved = local(&env, id).await;
    assert_eq!(
        saved.automatic_transcription.as_deref(),
        Some("later page result")
    );
    assert_eq!(saved.automatic_transcription_pending, None);
}

#[actix_web::test]
#[serial_test::serial]
async fn pending_batch_skips_active_work_without_taking_source_locks() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let (source, _) =
        crate::transcription::service::enqueue(&env.dbx, &audio.storage_key)
            .await
            .unwrap();
    let (locked, _) =
        crate::transcriber::reprocess::lock_source(&env.dbx, source)
            .await
            .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        super::reconcile::batch(&env.device_audio, &mut None),
    )
    .await;
    locked.rollback().await.unwrap();
    assert!(result.is_ok(), "pending sweep waited on an active source");
    result.unwrap().unwrap();
    assert_eq!(
        local(&env, audio.id).await.automatic_transcription_pending,
        Some(0)
    );
}
