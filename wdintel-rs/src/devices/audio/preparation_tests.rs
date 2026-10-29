use super::*;

#[tokio::test]
async fn promotion_uses_interactive_capacity_and_shutdown_releases_waiters() {
    let preparation = Preparation {
        background: Arc::new(Semaphore::new(1)),
        interactive: Arc::new(Semaphore::new(1)),
        ..Preparation::new()
    };
    let background = preparation
        .background
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let (states, _) = watch::channel([State::Queued; 3]);
    let job = Job {
        interactive: AtomicBool::new(false),
        promoted: Notify::new(),
        states,
        finished: std::sync::Mutex::new(None),
    };
    let mut waiting = Box::pin(preparation.admit(Some(&job)));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    job.interactive.store(true, Ordering::Release);
    job.promoted.notify_one();
    let interactive = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(preparation.background.available_permits(), 0);
    let mut waiting = Box::pin(preparation.admit(None));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    preparation.cancellation.cancel();
    assert!(waiting.await.is_err());
    drop((background, interactive));
    preparation.shutdown().await;
}

#[actix_web::test]
#[serial_test::serial]
async fn preparation_coalesces_polls_bounds_queue_and_keeps_acceptance_independent(
) {
    use crate::devices::audio::acceptance_tests::{
        enabled_audio_device, native_audio_bytes, receive_command,
    };
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let mut runtime = (*env.device_audio).clone();
    runtime.preparation = Arc::new(Preparation {
        background_queue: Arc::new(Semaphore::new(1)),
        interactive_queue: Arc::new(Semaphore::new(1)),
        max_jobs: 2,
        waiting: Arc::new(Semaphore::new(1)),
        ..Preparation::new()
    });
    let runtime = Arc::new(runtime);
    let background = runtime
        .preparation
        .background
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_BACKGROUND_CONCURRENCY as u32)
        .await
        .unwrap();
    let interactive = runtime
        .preparation
        .interactive
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_INTERACTIVE_CONCURRENCY as u32)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for name in ["first", "second", "third"] {
        let request = receive_command(
            &runtime,
            actor,
            device,
            name,
            native_audio_bytes().await,
        )
        .await;
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            receive(&runtime, actor, request),
        )
        .await
        .unwrap()
        .unwrap();
        let ReceiveDeviceAudioOutcome::Accepted(response) = outcome else {
            panic!("accepted fixture required");
        };
        ids.push(Uuid::parse_str(&response.audio.id).unwrap());
    }
    for _ in 0..20 {
        assert_eq!(
            prepare(runtime.clone(), actor, device, ids[0], false)
                .await
                .unwrap()
                .content,
            State::Queued
        );
    }
    assert_eq!(runtime.preparation.jobs.lock().await.len(), 1);
    assert_eq!(
        prepare(runtime.clone(), actor, device, ids[1], false)
            .await
            .unwrap()
            .content,
        State::Queued
    );
    assert_eq!(runtime.preparation.jobs.lock().await.len(), 2);
    assert_eq!(
        prepare(runtime.clone(), actor, device, ids[2], false)
            .await
            .unwrap()
            .content,
        State::Queued
    );
    assert_eq!(runtime.preparation.jobs.lock().await.len(), 2);
    runtime.preparation.shutdown().await;
    assert_eq!(runtime.preparation.interactive_queue.available_permits(), 1);
    assert!(runtime.preparation.tasks.is_empty());
    drop((background, interactive));
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_api_recovery_discovers_async_audio_without_worker_notifications_or_cache(
) {
    use crate::devices::audio::acceptance_tests::async_acceptance_tests::{
        phase5_enqueue, phase5_env, phase5_wait_job,
    };
    use crate::devices::audio::acceptance_tests::{
        enabled_audio_device, native_audio_bytes, receive_command,
    };
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};

    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let mut settings = crate::entities::system_settings::Entity::find()
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    settings.enable_audio_transcription = Set(true);
    settings.update(&env.dbx).await.unwrap();
    let worker_root = tempfile::tempdir().unwrap();
    let env = phase5_env(
        &env,
        worker_root.path(),
        env.device_audio.byte_store().unwrap().operator.clone(),
    );
    let runtime = env.device_audio.clone();
    let background = runtime
        .preparation
        .background
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_BACKGROUND_CONCURRENCY as u32)
        .await
        .unwrap();
    let interactive = runtime
        .preparation
        .interactive
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_INTERACTIVE_CONCURRENCY as u32)
        .await
        .unwrap();
    let command = receive_command(
        &runtime,
        actor,
        device,
        "async-without-api-notification",
        native_audio_bytes().await,
    )
    .await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let worker =
        tokio::spawn(crate::devices::upload_finalization::worker::run_audio(
            env.clone(),
            runtime.clone(),
            cancellation.clone(),
        ));
    let files = runtime.file_database().unwrap();
    let completed = phase5_wait_job(&env, job_id, false).await;
    assert_eq!(completed.status, "completed", "{:?}", completed.error_code);
    cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
    let audio_id = completed.audio_id.unwrap();
    let audio = device_audio::Entity::find_by_id(audio_id)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.automatic_transcription_pending, Some(0));
    assert!(runtime.preparation.jobs.lock().await.is_empty());
    assert!(!worker_root.path().join("device-audio-cache").exists());

    let api_root = tempfile::tempdir().unwrap();
    let mut api_config = env.config.clone();
    api_config.storage_dir = api_root.path().to_str().unwrap().into();
    let api = build_runtime(
        &api_config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        Some(&runtime.byte_store().unwrap().operator),
        None,
    );
    assert!(!Arc::ptr_eq(&api.asr_wake, &runtime.asr_wake));
    assert!(!Arc::ptr_eq(&api.playback_cache, &runtime.playback_cache));
    assert_eq!(
        content::readiness(&api, audio_id).await.unwrap(),
        [false; 3]
    );
    recover(&api, &mut None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if content::readiness(&api, audio_id).await.unwrap() == [true; 3] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("API recovery must discover and prepare the durable publication");
    api.preparation.shutdown().await;
    let audio = device_audio::Entity::find_by_id(audio_id)
        .one(files)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.automatic_transcription_pending, Some(0));
    drop((background, interactive));
}
