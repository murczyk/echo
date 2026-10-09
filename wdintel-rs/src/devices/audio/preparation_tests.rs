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
