use super::super::acceptance_tests::{
    enabled_audio_device, native_audio_bytes, receive_command,
};
use super::super::*;
use super::query as asr_query;
use crate::file_registry::entities::{device_audio, device_audio_asr_job};
use crate::functest::tests::cleanup_locked;
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};

#[path = "transcription_interactive_tests.rs"]
mod interactive_tests;

#[path = "transcription_backfill_tests.rs"]
mod backfill_tests;

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

#[actix_web::test]
#[serial_test::serial]
async fn asr_publication_is_durable_without_a_worker_and_preserves_manual_fields(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let settings = crate::entities::system_settings::Entity::find()
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut settings = settings.into_active_model();
    settings.enable_audio_transcription = Set(true);
    settings.update(&env.dbx).await.unwrap();
    let audio = accepted(&env, actor, device).await;
    let job = device_audio_asr_job::Entity::find_by_id(audio.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    assert!(job.is_some(), "publication must atomically persist new-audio ASR admission before worker wake");
    let job = job.unwrap();
    assert_eq!(job.state, "queued");
    assert_eq!(job.trigger, "background");
    assert_eq!(job.attempt_count, 0);
    assert!(audio.automatic_transcription.is_none());
    assert_eq!(audio.transcription, "");
    assert!(!audio.processed);
}

async fn enable_asr(env: &crate::types::Env) {
    let settings = crate::entities::system_settings::Entity::find()
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut settings = settings.into_active_model();
    settings.enable_audio_transcription = Set(true);
    settings.update(&env.dbx).await.unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn scheduler_keeps_weighted_progress_across_independent_owners() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let db = env.device_audio.file_database().unwrap();
    for (priority, trigger, count) in [
        (0, "interactive", 9),
        (1, "background", 2),
        (2, "backfill", 2),
    ] {
        for _ in 0..count {
            let audio = accepted(&env, actor, device).await;
            let mut job = recovery_tests::job(&env, audio.id)
                .await
                .into_active_model();
            job.priority = Set(priority);
            job.trigger = Set(trigger.into());
            job.update(db).await.unwrap();
        }
    }
    let mut served = [0; 3];
    for _ in 0..10 {
        let owner = Uuid::new_v4();
        let claim = asr_query::claim(&env.device_audio, owner)
            .await
            .unwrap()
            .unwrap();
        let job = recovery_tests::job(&env, claim.target.audio_id).await;
        assert_eq!(job.owner_id, Some(owner));
        served[job.priority as usize] += 1;
        assert!(asr_query::dispatch(
            &env.device_audio,
            &claim,
            Uuid::new_v4(),
            Uuid::new_v4()
        )
        .await
        .unwrap());
        assert!(
            asr_query::complete(&env.device_audio, &claim, "fair result")
                .await
                .unwrap()
        );
    }
    assert_eq!(served, [8, 1, 1]);
}

#[actix_web::test]
#[serial_test::serial]
async fn pending_policy_resolves_once_without_reviving_suppressed_audio() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let db = env.device_audio.file_database().unwrap();
    let first = accepted(&env, actor, device).await;
    let second = accepted(&env, actor, device).await;
    for audio in [&first, &second] {
        let mut job = recovery_tests::job(&env, audio.id)
            .await
            .into_active_model();
        job.state = Set("policy_pending".into());
        job.update(db).await.unwrap();
    }
    asr_query::resolve_pending(&env.device_audio).await.unwrap();
    assert_eq!(recovery_tests::job(&env, first.id).await.state, "queued");
    let mut job = recovery_tests::job(&env, second.id)
        .await
        .into_active_model();
    job.state = Set("policy_pending".into());
    job.update(db).await.unwrap();
    let mut settings = crate::entities::system_settings::Entity::find()
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    settings.enable_audio_transcription = Set(false);
    settings.update(&env.dbx).await.unwrap();
    asr_query::resolve_pending(&env.device_audio).await.unwrap();
    assert_eq!(
        recovery_tests::job(&env, second.id).await.state,
        "suppressed"
    );
    enable_asr(&env).await;
    asr_query::resolve_pending(&env.device_audio).await.unwrap();
    assert_eq!(
        recovery_tests::job(&env, second.id).await.state,
        "suppressed"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn asr_single_slot_and_completion_preserve_concurrent_manual_save_and_versions(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let db = env.device_audio.file_database().unwrap();
    let (first, second) = tokio::join!(
        asr_query::claim(&env.device_audio, Uuid::new_v4()),
        asr_query::claim(&env.device_audio, Uuid::new_v4())
    );
    let claims: Vec<_> = [first.unwrap(), second.unwrap()]
        .into_iter()
        .flatten()
        .collect();
    assert_eq!(
        claims.len(),
        1,
        "independent owners must share one durable slot"
    );
    let claim = &claims[0];
    assert!(asr_query::dispatch(
        &env.device_audio,
        claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    let (saved, finished) = tokio::join!(
        save_transcription(
            &env.device_audio,
            actor,
            types::SaveDeviceAudioTranscriptionCommand {
                device_id: device,
                audio_id: audio.id,
                text: "  ручний\n".into(),
                expected_text_version: audio.text_version,
            }
        ),
        asr_query::complete(&env.device_audio, claim, "автоматичний")
    );
    let types::SaveDeviceAudioTranscriptionOutcome::Saved(saved) =
        saved.unwrap()
    else {
        panic!("manual save must succeed")
    };
    assert!(finished.unwrap());
    assert!(
        !asr_query::complete(&env.device_audio, claim, "late overwrite")
            .await
            .unwrap()
    );
    let current = device_audio::Entity::find_by_id(audio.id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.transcription, "  ручний\n");
    assert_eq!(
        current.text_version.to_string(),
        saved.transcription.text_version
    );
    assert_eq!(
        current.automatic_transcription.as_deref(),
        Some("автоматичний")
    );
    assert_eq!(current.processing_version, audio.processing_version);
    assert_eq!(current.processed, audio.processed);
}

#[actix_web::test]
#[serial_test::serial]
async fn asr_no_speech_is_terminal_and_an_old_unadmitted_audio_is_never_discovered(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let old = accepted(&env, actor, device).await;
    let db = env.device_audio.file_database().unwrap();
    device_audio_asr_job::Entity::delete_by_id(old.id)
        .exec(db)
        .await
        .unwrap();
    let audio = accepted(&env, actor, device).await;
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .expect("new audio must be claimed");
    assert_eq!(claim.target.audio_id, audio.id);
    assert!(asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert!(asr_query::complete(&env.device_audio, &claim, " \n\t")
        .await
        .unwrap());
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    let job = device_audio_asr_job::Entity::find_by_id(audio.id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.state, "no_speech");
    assert!(device_audio_asr_job::Entity::find_by_id(old.id)
        .one(db)
        .await
        .unwrap()
        .is_none());
    assert!(device_audio::Entity::find_by_id(audio.id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .automatic_transcription
        .is_none());
}

#[path = "transcription_recovery_tests.rs"]
mod recovery_tests;

#[path = "transcription_provider_tests.rs"]
mod provider_tests;

#[actix_web::test]
#[serial_test::serial]
async fn status_is_read_only_versioned_and_uses_actual_edit_roles() {
    use super::{status, ActorAudioCommand, AudioTarget, StatusCommand};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    device_audio_asr_job::Entity::delete_by_id(audio.id)
        .exec(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    let request = |known_version| StatusCommand {
        audio: ActorAudioCommand {
            actor_id: actor,
            target: AudioTarget {
                device_id: device,
                audio_id: audio.id,
            },
        },
        known_version,
    };
    let first = status::status(&env.device_audio, request(None))
        .await
        .unwrap();
    let snapshot = first.snapshot.unwrap();
    assert_eq!(
        snapshot.state,
        types::DeviceAudioAutomaticTranscriptionState::AudioAsrNotRequested
    );
    assert!(snapshot.text.is_none());
    assert!(first.availability.can_edit_manual);
    assert!(
        status::status(&env.device_audio, request(Some(snapshot.version)))
            .await
            .unwrap()
            .snapshot
            .is_none()
    );
    assert!(device_audio_asr_job::Entity::find_by_id(audio.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .is_none());
    let mut login = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    login.roles = Set(serde_json::json!(["CyberViewer"]));
    login.update(&env.dbx).await.unwrap();
    let viewer =
        status::status(&env.device_audio, request(Some(snapshot.version)))
            .await
            .unwrap();
    assert!(viewer.snapshot.is_none());
    assert!(!viewer.availability.can_edit_manual);
    assert!(!viewer.availability.can_manage_setting);
    let detail = detail(
        &env.device_audio,
        actor,
        types::DeviceAudioDetailCommand {
            device_id: device,
            audio_id: audio.id,
        },
    )
    .await
    .unwrap();
    assert!(!detail.can_edit);
    let detail = serde_json::to_value(detail).unwrap();
    assert_eq!(detail["automatic_transcription"]["state"], "not_requested");
    assert_eq!(detail["transcription"]["text"], "");
    let mut foreign = request(None);
    foreign.audio.target.device_id = Uuid::new_v4();
    assert!(status::status(&env.device_audio, foreign).await.is_err());
}

#[actix_web::test]
#[serial_test::serial]
async fn policy_before_dispatch_blocks_and_after_dispatch_allows_only_active_device_completion(
) {
    use crate::file_registry::entities::device_audio_asr_setting as setting;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let files = env.device_audio.file_database().unwrap();
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    let mut preference = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    preference.enabled = Set(false);
    preference.update(files).await.unwrap();
    assert!(!asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert!(asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    let mut preference = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    preference.enabled = Set(true);
    preference.update(files).await.unwrap();
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    assert!(asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    let mut preference = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    preference.enabled = Set(false);
    preference.update(files).await.unwrap();
    assert!(asr_query::complete(
        &env.device_audio,
        &claim,
        "already dispatched"
    )
    .await
    .unwrap());
    assert_eq!(
        device_audio::Entity::find_by_id(audio.id)
            .one(files)
            .await
            .unwrap()
            .unwrap()
            .automatic_transcription
            .as_deref(),
        Some("already dispatched")
    );
    let mut preference = setting::Entity::find_by_id(device)
        .one(files)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    preference.enabled = Set(true);
    preference.update(files).await.unwrap();
    let archived_audio = accepted(&env, actor, device).await;
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    assert!(asr_query::dispatch(
        &env.device_audio,
        &claim,
        Uuid::new_v4(),
        Uuid::new_v4()
    )
    .await
    .unwrap());
    let mut archived = crate::entities::device::Entity::find_by_id(device)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    archived.update(&env.dbx).await.unwrap();
    assert!(
        asr_query::complete(&env.device_audio, &claim, "must not publish")
            .await
            .unwrap()
    );
    assert_eq!(
        recovery_tests::job(&env, archived_audio.id).await.state,
        "cancelled"
    );
    assert!(device_audio::Entity::find_by_id(archived_audio.id)
        .one(files)
        .await
        .unwrap()
        .unwrap()
        .automatic_transcription
        .is_none());
}
