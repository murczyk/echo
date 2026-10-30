use super::*;
use crate::devices::upload_finalization::{
    self, resources, types::FinalizationKind,
};
use crate::file_registry::entities::{
    device_upload_finalization_attempt, device_upload_finalization_budget,
};
use crate::types::{DeviceUploadFinalizationSettings, Env};
use actix_web::http::header::{
    HeaderMap, CACHE_CONTROL, LOCATION, RETRY_AFTER,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(in crate::devices::audio) fn phase5_env(
    env: &Env,
    storage_dir: &Path,
    operator: opendal::Operator,
) -> Arc<Env> {
    let mut env = env.clone();
    env.config.storage_dir = storage_dir.display().to_string();
    env.config.device_upload_finalization =
        Some(DeviceUploadFinalizationSettings {
            enabled: true,
            audio_slots: 2,
            decode_slots: 1,
            encryption_slots: 1,
            readback_slots: 1,
            poll_seconds: 1,
            heartbeat_seconds: 1,
            ..Default::default()
        });
    env.device_audio = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        Some(&operator),
        env.metrics.clone(),
    );
    let runtime = Arc::get_mut(&mut env.device_audio).unwrap();
    let store = runtime.byte_store().unwrap();
    let storage = crate::storage::finalization::ManagedStorage::for_test(
        operator,
        store.config.clone(),
        &store.strongbox_key,
    )
    .unwrap();
    runtime.managed_storage = Some(Arc::new(storage));
    Arc::new(env)
}

fn memory_storage() -> opendal::Operator {
    opendal::Operator::new(opendal::services::Memory::default())
        .unwrap()
        .finish()
}

macro_rules! phase5_app {
    ($env:expr) => {{
        let sessions = RedisSessionStore::new(
            crate::redis_conn_string(&$env.config).unwrap(),
        )
        .await
        .unwrap();
        test::init_service(
            App::new()
                .app_data(web::Data::from($env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(sessions, Key::generate()))
                .route("/test/login/{actor}", web::post().to(login))
                .service(upload_routes())
                .service(routes())
                .configure(upload_finalization::config),
        )
        .await
    }};
}

macro_rules! phase5_cookie {
    ($app:expr, $actor:expr) => {{
        test::call_service(
            &$app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{}", $actor))
                .to_request(),
        )
        .await
        .response()
        .cookies()
        .next()
        .unwrap()
        .into_owned()
    }};
}

async fn receive_json(
    env: Arc<Env>,
    actor: Uuid,
    request: Value,
) -> (StatusCode, HeaderMap, Value) {
    let app = phase5_app!(env);
    let cookie = phase5_cookie!(app, actor);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .cookie(cookie)
            .set_json(request)
            .to_request(),
    )
    .await;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = test::read_body(response).await;
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        Value::String(String::from_utf8_lossy(&bytes).into_owned())
    });
    (status, headers, body)
}

pub(in crate::devices::audio) async fn phase5_enqueue(
    env: Arc<Env>,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
) -> Uuid {
    let mut request = receive_request(command);
    request["async_finalization"] = true.into();
    let (status, headers, body) = receive_json(env, actor, request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let job = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"status": "queued", "job_id": job}));
    assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
    assert_eq!(headers.get(RETRY_AFTER).unwrap(), "1");
    assert_eq!(
        headers.get(LOCATION).unwrap().to_str().unwrap(),
        format!("/api/device/upload-finalization-jobs/{job}")
    );
    job
}

async fn persisted_job(
    env: &Env,
    id: Uuid,
) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find_by_id(id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn source_for(
    env: &Env,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
) -> crate::sigint::file_upload::tus::TusUpload {
    upload::handler(&env.device_audio, command.device_id)
        .unwrap()
        .open_completed_url(&actor, &command.upload_url)
        .await
        .unwrap()
        .unwrap()
}

fn pin_path(env: &Env, device: Uuid, source: Uuid) -> PathBuf {
    PathBuf::from(&env.config.storage_dir)
        .join("device-audio-tus")
        .join(device.to_string())
        .join("file_upload_tus/pins")
        .join(format!("{source}.json"))
}

async fn assert_budget(env: &Env, actor: Uuid, jobs: i64, bytes: i64) {
    let db = env.device_audio.file_database().unwrap();
    for scope in ["global:audio".to_owned(), format!("actor:{actor}:audio")] {
        let budget =
            device_upload_finalization_budget::Entity::find_by_id(scope)
                .one(db)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(budget.reserved_jobs, jobs);
        assert_eq!(budget.reserved_source_bytes, bytes);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn async_audio_admission_honors_configured_source_lock_budget() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut env = phase5_env(&env, directory.path(), memory_storage());
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .source_lock_millis = 50;
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "source lock budget",
        web::Bytes::from_static(b"source"),
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let _held =
        crate::sigint::file_upload::lock_uploaded_source(&source.file_path)
            .await
            .unwrap()
            .unwrap();
    let app = phase5_app!(env);
    let cookie = phase5_cookie!(app, actor);
    let mut request = receive_request(&command);
    request["async_finalization"] = true.into();
    let response = tokio::time::timeout(
        Duration::from_millis(250),
        test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/audio/receive")
                .cookie(cookie)
                .set_json(request)
                .to_request(),
        ),
    )
    .await
    .expect("async admission ignored its 50 ms source-lock budget");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key(RETRY_AFTER));
    assert!(!pin_path(&env, device, source.file_id).exists());
    assert_eq!(std::fs::read(&source.file_path).unwrap(), b"source");
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_admission_commits_pin_without_decode_hash_or_store() {
    use resources::ResourceKind;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let operator = memory_storage();
    let env = phase5_env(&env, directory.path(), operator.clone());
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "not decoded yet",
        web::Bytes::from_static(b"not audio"),
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let runtime = &env.device_audio;
    let _receive = runtime
        .receive_permits
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_RECEIVE_CONCURRENCY as u32)
        .await
        .unwrap();
    let _probe = runtime
        .probe_permits
        .clone()
        .acquire_many_owned(DEVICE_AUDIO_PROBE_CONCURRENCY as u32)
        .await
        .unwrap();
    let settings = env.config.device_upload_finalization.as_ref().unwrap();
    let mut guards = Vec::new();
    for (kind, slots) in [
        (ResourceKind::Audio, settings.audio_slots),
        (ResourceKind::Decode, settings.decode_slots),
        (ResourceKind::Encryption, settings.encryption_slots),
        (ResourceKind::Readback, settings.readback_slots),
    ] {
        for _ in 0..slots {
            guards.push(
                resources::try_acquire(directory.path(), kind, slots)
                    .unwrap()
                    .unwrap(),
            );
        }
    }
    let job_id = tokio::time::timeout(
        Duration::from_secs(2),
        phase5_enqueue(env.clone(), actor, &command),
    )
    .await
    .expect("admission waited for heavy processing capacity");
    let job = persisted_job(&env, job_id).await;
    assert_eq!(job.status, "queued");
    assert_eq!(job.source_identity, format!("{device}/{}", source.file_id));
    assert_eq!(job.created_by_login_id, actor);
    assert_eq!(job.source_size_bytes, 9);
    assert!(job.audio_id.is_some());
    assert!(job.pin_token.is_some());
    assert!(job.result.is_none());
    assert!(job.winning_attempt_id.is_none());
    assert!(pin_path(&env, device, source.file_id).is_file());
    assert_eq!(std::fs::read(&source.file_path).unwrap(), b"not audio");
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (0, 0, 1)
    );
    assert_eq!(
        device_upload_finalization_attempt::Entity::find()
            .count(runtime.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
    assert!(operator.list("").await.unwrap().is_empty());
    assert_budget(&env, actor, 1, 9).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_admission_canonicalizes_timestamp_but_preserves_exact_name(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let mut command = receive_command(
        &env.device_audio,
        actor,
        device,
        " запис.WAV ",
        native_audio_bytes().await,
    )
    .await;
    command.recording_started_at =
        "2026-10-03T23:59:59.950001999Z".parse().unwrap();
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let job = persisted_job(&env, job_id).await;
    assert_eq!(job.audio_name.as_deref(), Some(" запис.WAV "));
    assert_eq!(
        job.audio_name_key.as_deref(),
        Some(" запис.WAV ".as_bytes())
    );
    assert_eq!(
        job.recording_started_at.unwrap().to_rfc3339(),
        "2026-10-03T23:59:59.950001+00:00"
    );
    let mut request = receive_request(&command);
    request["async_finalization"] = true.into();
    request["recording_started_at"] = "2026-10-04T02:59:59.950001+03:00".into();
    let (status, _, body) =
        receive_json(env.clone(), actor, request.clone()).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["job_id"], job_id.to_string());
    request["name"] = "запис.WAV".into();
    let (status, _, _) = receive_json(env.clone(), actor, request).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (0, 0, 1)
    );
    assert_budget(&env, actor, 1, job.source_size_bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_admission_rejects_zero_incomplete_and_oversize_sources() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    for (case, size, expected) in [
        ("zero", 0, StatusCode::UNPROCESSABLE_ENTITY),
        ("incomplete", 2, StatusCode::CONFLICT),
        (
            "oversize",
            DEVICE_AUDIO_MAX_BYTES + 1,
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let mut command = receive_command(
            &env.device_audio,
            actor,
            device,
            case,
            web::Bytes::from_static(b"source"),
        )
        .await;
        let source = source_for(&env, actor, &command).await;
        let mut target = source.file_path.clone();
        if case == "incomplete" {
            let owner = target.parent().unwrap();
            target = owner
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("pending")
                .join(owner.file_name().unwrap())
                .join(target.file_name().unwrap());
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        } else {
            target.set_file_name(format!("{}.{size}", source.file_id));
            command.upload_url = format!(
                "/api/device/audio/{device}/uploads/{}.{size}",
                source.file_id
            );
        }
        std::fs::rename(&source.file_path, &target).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap()
            .set_len(size)
            .unwrap();
        let mut request = receive_request(&command);
        request["async_finalization"] = true.into();
        let (status, _, body) = receive_json(env.clone(), actor, request).await;
        assert_eq!(status, expected, "{case}: {body}");
        assert_eq!(
            finalization_record_counts(&env.device_audio).await,
            (0, 0, 0)
        );
        assert!(!pin_path(&env, device, source.file_id).exists());
        assert!(target.exists(), "rejected source must not be consumed");
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_pin_blocks_tus_mutation_and_legacy_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "pinned",
        native_audio_bytes().await,
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let original = std::fs::read(&source.file_path).unwrap();
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let mut disabled = (*env).clone();
    disabled
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .enabled = false;
    let disabled = Arc::new(disabled);
    let app = phase5_app!(disabled);
    let cookie = phase5_cookie!(app, actor);
    for method in [Method::PATCH, Method::DELETE] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&command.upload_url)
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .insert_header((
                    "upload-offset",
                    source.upload_length.to_string(),
                ))
                .insert_header((
                    "content-type",
                    "application/offset+octet-stream",
                ))
                .set_payload(web::Bytes::new())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{method}");
        assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
    }
    cleanup_once(&env.device_audio).await.unwrap();
    upload::handler(&env.device_audio, device)
        .unwrap()
        .cleanup_expired()
        .await
        .unwrap();
    assert!(pin_path(&env, device, source.file_id).is_file());
    assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
    assert_eq!(persisted_job(&env, job_id).await.status, "queued");
    assert_budget(&env, actor, 1, source.upload_length as i64).await;
}

#[cfg(target_os = "macos")]
#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_matching_pin_preserves_expired_source_and_fails_closed_if_corrupt(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "expired pinned",
        native_audio_bytes().await,
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let original = std::fs::read(&source.file_path).unwrap();
    phase5_enqueue(env.clone(), actor, &command).await;
    let date = (chrono::Local::now() - chrono::Duration::hours(48))
        .format("%m/%d/%Y %H:%M:%S")
        .to_string();
    let changed = tokio::process::Command::new("/usr/bin/SetFile")
        .args(["-d", &date])
        .arg(&source.file_path)
        .output()
        .await
        .unwrap();
    assert!(changed.status.success());
    let app = phase5_app!(env);
    let cookie = phase5_cookie!(app, actor);
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&command.upload_url)
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(upload::handler(&env.device_audio, device)
        .unwrap()
        .open_completed_url(&actor, &command.upload_url)
        .await
        .unwrap()
        .is_some());
    cleanup_once(&env.device_audio).await.unwrap();
    assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
    std::fs::write(pin_path(&env, device, source.file_id), b"{corrupt pin")
        .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&command.upload_url)
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert!(
        response.status().is_server_error(),
        "unreadable pin must not authorize TTL bypass"
    );
    cleanup_once(&env.device_audio).await.unwrap();
    assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
}

async fn claim_audio(
    env: &Env,
    job_id: Uuid,
    reconcile: bool,
) -> upload_finalization::types::ClaimedFinalizationJob {
    let claim = upload_finalization::worker::claim_due(
        env.device_audio.file_database().unwrap(),
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        if reconcile {
            upload_finalization::worker::ClaimLane::Reconcile
        } else {
            upload_finalization::worker::ClaimLane::Work
        },
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, job_id);
    claim
}

pub(in crate::devices::audio) async fn phase5_wait_job(
    env: &Env,
    job_id: Uuid,
    released: bool,
) -> device_upload_finalization_job::Model {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let job = persisted_job(env, job_id).await;
            if matches!(job.status.as_str(), "completed" | "failed")
                && (!released || job.quota_released_at.is_some())
            {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("audio worker did not reach the expected terminal state")
}

async fn stop_worker(
    cancellation: tokio_util::sync::CancellationToken,
    background: tokio::task::JoinHandle<()>,
) {
    cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(5), background)
        .await
        .unwrap()
        .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_registered_worker_publishes_stable_id_and_cleans_terminal_source(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let operator = memory_storage();
    let env = phase5_env(&env, directory.path(), operator.clone());
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "published once",
        bytes.clone(),
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let audio_id = persisted_job(&env, job_id).await.audio_id.unwrap();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let background = tokio::spawn(upload_finalization::worker::run_audio(
        env.clone(),
        env.device_audio.clone(),
        cancellation.clone(),
    ));
    let job = phase5_wait_job(&env, job_id, true).await;
    stop_worker(cancellation, background).await;
    assert_eq!(job.status, "completed", "{:?}", job.error_code);
    let db = env.device_audio.file_database().unwrap();
    let audio = device_audio::Entity::find_by_id(audio_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let ingest = device_audio_ingest::Entity::find_by_id(audio.ingest_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        job.winning_attempt_id.unwrap(),
    )
    .one(db)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(audio.id, audio_id);
    assert_eq!(audio.name, "published once");
    assert_eq!(audio.duration_us, 100_000);
    assert_eq!(
        audio.recording_started_at.to_rfc3339(),
        "2026-10-03T23:59:59.950001+00:00"
    );
    assert_eq!(
        audio.recording_ended_at.to_rfc3339(),
        "2026-10-04T00:00:00.050001+00:00"
    );
    assert_eq!(ingest.status, "ready");
    assert_eq!(ingest.audio_id, audio_id);
    assert_eq!(ingest.actor_id, actor);
    assert_eq!(ingest.tus_upload_id, source.file_id);
    assert_eq!(ingest.storage_key, audio.storage_key);
    assert_eq!(attempt.object_key, audio.storage_key);
    assert_eq!(attempt.phase, "selected");
    assert!(attempt.verified_at.is_some());
    assert!(!attempt.write_credit_held);
    assert!(ingest.source_consumed_at.is_some());
    assert_eq!(job.source_release_state, "released");
    assert!(job.source_released_at.is_some());
    assert!(!source.file_path.exists());
    assert!(!pin_path(&env, device, source.file_id).exists());
    assert_budget(&env, actor, 0, 0).await;
    let store = env.device_audio.byte_store().unwrap();
    let plaintext = crate::storage::download_and_decrypt_from_s3_with_operator(
        &Some(operator.clone()),
        &Some(store.config.clone()),
        &store.strongbox_key,
        &audio.storage_key,
    )
    .await
    .unwrap();
    assert_eq!(plaintext.as_slice(), bytes.as_ref());
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(operator.exists(&audio.storage_key).await.unwrap());
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (1, 1, 1)
    );
    let app = phase5_app!(env);
    let cookie = phase5_cookie!(app, actor);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!("/api/device/upload-finalization-jobs/{job_id}"))
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot["status"], "completed");
    assert_eq!(snapshot["result"], job.result.unwrap()["value"]);
    assert_eq!(snapshot["result"]["audio"]["id"], audio_id.to_string());
    assert_eq!(snapshot["result"]["audio"]["duration_seconds"], 0.1);
}

async fn encoded_audio(format: &str, duration: &str) -> web::Bytes {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(format!("source.{format}"));
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            duration,
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    tokio::fs::read(path).await.unwrap().into()
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_worker_rejects_corrupt_unsupported_and_zero_duration_after_acceptance(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let operator = memory_storage();
    let env = phase5_env(&env, directory.path(), operator.clone());
    let (actor, device) = enabled_audio_device(&env).await;
    let mut jobs = Vec::new();
    for (name, bytes, expected_code) in [
        (
            "corrupt",
            web::Bytes::from_static(b"RIFF corrupt audio"),
            "invalid_audio",
        ),
        (
            "unsupported",
            encoded_audio("flac", "0.1").await,
            "unsupported_audio",
        ),
        (
            "zero duration",
            encoded_audio("wav", "0").await,
            "invalid_audio",
        ),
    ] {
        assert!(!bytes.is_empty());
        let command =
            receive_command(&env.device_audio, actor, device, name, bytes)
                .await;
        let source = source_for(&env, actor, &command).await;
        let job_id = phase5_enqueue(env.clone(), actor, &command).await;
        jobs.push((job_id, source, expected_code));
    }
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let background = tokio::spawn(upload_finalization::worker::run_audio(
        env.clone(),
        env.device_audio.clone(),
        cancellation.clone(),
    ));
    for (job_id, source, expected_code) in jobs {
        let job = phase5_wait_job(&env, job_id, true).await;
        assert_eq!(job.status, "failed");
        assert_eq!(job.error_code.as_deref(), Some(expected_code));
        assert_eq!(job.error_action.as_deref(), Some("new_upload"));
        assert!(job.finished_at.is_some());
        assert!(job.result.is_none());
        assert!(job.winning_attempt_id.is_none());
        assert!(!source.file_path.exists());
        assert!(!pin_path(&env, device, source.file_id).exists());
    }
    stop_worker(cancellation, background).await;
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (0, 0, 3)
    );
    assert_budget(&env, actor, 0, 0).await;
    assert!(operator.list("").await.unwrap().is_empty());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_exact_name_race_publishes_only_the_winning_ingest() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let mut ids = Vec::new();
    for _ in 0..2 {
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            "same exact name",
            bytes.clone(),
        )
        .await;
        ids.push(phase5_enqueue(env.clone(), actor, &command).await);
    }
    assert_ne!(ids[0], ids[1]);
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let background = tokio::spawn(upload_finalization::worker::run_audio(
        env.clone(),
        env.device_audio.clone(),
        cancellation.clone(),
    ));
    let first = phase5_wait_job(&env, ids[0], true).await;
    let second = phase5_wait_job(&env, ids[1], true).await;
    stop_worker(cancellation, background).await;
    let (winner, loser) = if first.status == "completed" {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(winner.status, "completed");
    assert_eq!(loser.status, "failed");
    assert_eq!(
        loser.error_code.as_deref(),
        Some("device_audio_name_conflict")
    );
    assert_eq!(loser.error_action.as_deref(), Some("correct_request"));
    assert!(loser.result.is_none());
    assert!(loser.winning_attempt_id.is_none());
    let db = env.device_audio.file_database().unwrap();
    let audio = device_audio::Entity::find().one(db).await.unwrap().unwrap();
    assert_eq!(audio.id, winner.audio_id.unwrap());
    assert_ne!(audio.id, loser.audio_id.unwrap());
    let ingest = device_audio_ingest::Entity::find()
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ingest.id, audio.ingest_id);
    assert_eq!(ingest.status, "ready");
    assert_eq!(ingest.storage_key, audio.storage_key);
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (1, 1, 2)
    );
    assert_budget(&env, actor, 0, 0).await;
}

async fn prepare_remote_attempt(
    env: &Env,
    job_id: Uuid,
    source: web::Bytes,
    remote: web::Bytes,
) -> device_upload_finalization_attempt::Model {
    use upload_finalization::{
        query, recovery,
        types::{FinalizationFailure, PreparedAudio, WriteResolution},
    };

    let db = env.device_audio.file_database().unwrap();
    let claim = claim_audio(env, job_id, false).await;
    let attempt_id = query::create_attempt(db, &claim, true).await.unwrap();
    let media = PreparedAudio {
        media_type: "audio/wav".into(),
        duration_seconds: 0.1,
        recording_ended_at: "2026-10-04T00:00:00.050001Z".parse().unwrap(),
    };
    assert!(query::prepare_attempt(
        db,
        &claim,
        attempt_id,
        source.len() as i64,
        &Sha256::digest(&source).into(),
        Some(&media)
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(db, &claim, attempt_id, 4)
        .await
        .unwrap());
    let attempt =
        device_upload_finalization_attempt::Entity::find_by_id(attempt_id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
    let store = env.device_audio.byte_store().unwrap();
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(store.operator.clone()),
        &store.config,
        &store.strongbox_key,
        &attempt.object_key,
        remote,
    )
    .await
    .unwrap();
    assert!(query::record_write_resolution(
        db,
        &claim,
        attempt_id,
        WriteResolution::Acknowledged
    )
    .await
    .unwrap());
    assert!(query::release_write_credit(db, attempt_id).await.unwrap());
    assert!(recovery::schedule_retry(
        db,
        &claim,
        &FinalizationFailure::StorageOutcomeUnknown,
        true,
        1
    )
    .await
    .unwrap());
    make_due(env, job_id).await;
    attempt
}

async fn make_due(env: &Env, job_id: Uuid) {
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job_id).execute(env.device_audio.file_database().unwrap().get_postgres_connection_pool()).await.unwrap();
}

async fn assert_unknown_source(
    env: &Env,
    actor: Uuid,
    source: &crate::sigint::file_upload::tus::TusUpload,
    job_id: Uuid,
    attempt_id: Uuid,
) {
    let job = persisted_job(env, job_id).await;
    assert_eq!(job.status, "outcome_unknown");
    assert_eq!(job.error_action.as_deref(), Some("retry_poll"));
    assert!(job.result.is_none());
    assert!(job.finished_at.is_none());
    assert!(job.winning_attempt_id.is_none());
    assert_eq!(job.active_attempt_id, Some(attempt_id));
    assert_eq!(job.source_release_state, "held");
    assert!(job.quota_released_at.is_none());
    assert_eq!(
        finalization_record_counts(&env.device_audio).await,
        (0, 0, 1)
    );
    let attempts = device_upload_finalization_attempt::Entity::find()
        .all(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    assert_eq!(attempts.len(), 1);
    assert!(attempts[0].verified_at.is_none());
    assert_ne!(attempts[0].phase, "selected");
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(source.file_path.is_file());
    assert!(pin_path(env, job.device_id, source.file_id).is_file());
    assert_budget(env, actor, 1, source.upload_length as i64).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_reconciliation_requires_exact_plaintext_readback() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let mut wrong = bytes.to_vec();
    *wrong.last_mut().unwrap() ^= 1;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "wrong remote plaintext",
        bytes.clone(),
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let attempt =
        prepare_remote_attempt(&env, job_id, bytes, wrong.into()).await;
    let claim = claim_audio(&env, job_id, true).await;
    let _ = ingest::finalize_claim(&env, &env.device_audio, claim).await;
    assert_unknown_source(&env, actor, &source, job_id, attempt.id).await;
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&attempt.object_key)
        .await
        .unwrap());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_readback_outage_recovers_same_attempt_and_audio_id() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let root = remote.path().join("objects");
    std::fs::create_dir(&root).unwrap();
    let operator = opendal::Operator::new(
        opendal::services::Fs::default().root(root.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    let env = phase5_env(&env, directory.path(), operator);
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "readback outage",
        bytes.clone(),
    )
    .await;
    let source = source_for(&env, actor, &command).await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let audio_id = persisted_job(&env, job_id).await.audio_id.unwrap();
    let attempt =
        prepare_remote_attempt(&env, job_id, bytes.clone(), bytes).await;
    let saved = remote.path().join("saved");
    std::fs::rename(&root, &saved).unwrap();
    std::fs::write(&root, b"provider unavailable").unwrap();
    let claim = claim_audio(&env, job_id, true).await;
    let _ = ingest::finalize_claim(&env, &env.device_audio, claim).await;
    assert_unknown_source(&env, actor, &source, job_id, attempt.id).await;
    std::fs::remove_file(&root).unwrap();
    std::fs::rename(&saved, &root).unwrap();
    make_due(&env, job_id).await;
    let claim = claim_audio(&env, job_id, true).await;
    ingest::finalize_claim(&env, &env.device_audio, claim)
        .await
        .unwrap();
    let job = persisted_job(&env, job_id).await;
    assert_eq!(job.status, "completed");
    assert_eq!(job.audio_id, Some(audio_id));
    assert_eq!(job.winning_attempt_id, Some(attempt.id));
    let db = env.device_audio.file_database().unwrap();
    let audio = device_audio::Entity::find_by_id(audio_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.storage_key, attempt.object_key);
    assert_eq!(
        device_upload_finalization_attempt::Entity::find()
            .count(db)
            .await
            .unwrap(),
        1
    );
}

async fn completed_for_cleanup(
    env: &Arc<Env>,
    actor: Uuid,
    device: Uuid,
) -> (Uuid, crate::sigint::file_upload::tus::TusUpload) {
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "cleanup protection",
        native_audio_bytes().await,
    )
    .await;
    let source = source_for(env, actor, &command).await;
    let job_id = phase5_enqueue(env.clone(), actor, &command).await;
    let claim = claim_audio(env, job_id, false).await;
    ingest::finalize_claim(env, &env.device_audio, claim)
        .await
        .unwrap();
    let job = persisted_job(env, job_id).await;
    assert_eq!(job.status, "completed");
    assert!(job.quota_released_at.is_none());
    assert!(source.file_path.is_file());
    assert!(pin_path(env, device, source.file_id).is_file());
    (job_id, source)
}

async fn assert_terminal_source_retained(
    env: &Env,
    actor: Uuid,
    job_id: Uuid,
    size: u64,
) {
    let job = persisted_job(env, job_id).await;
    assert_eq!(job.status, "completed");
    assert!(job.source_released_at.is_none());
    assert!(job.quota_released_at.is_none());
    assert_budget(env, actor, 1, size as i64).await;
}

async fn release_terminal_source(
    env: &Env,
    actor: Uuid,
    job_id: Uuid,
    source: &crate::sigint::file_upload::tus::TusUpload,
) {
    use std::os::unix::fs::MetadataExt;
    let root = source
        .file_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let proof = root.join("locks").join(source.file_id.to_string());
    let inode = std::fs::metadata(&proof).unwrap().ino();
    for _ in 0..2 {
        super::super::async_cleanup::cleanup_source(&env.device_audio, job_id)
            .await
            .unwrap();
        let job = persisted_job(env, job_id).await;
        assert_eq!(job.source_release_state, "released");
        assert!(job.source_released_at.is_some());
        assert!(job.quota_released_at.is_some());
        assert!(!source.file_path.exists());
        assert!(!pin_path(env, job.device_id, source.file_id).exists());
        assert!(std::fs::read(&proof).unwrap().is_empty());
        assert_eq!(std::fs::metadata(&proof).unwrap().ino(), inode);
        assert_budget(env, actor, 0, 0).await;
        let selected = device_upload_finalization_attempt::Entity::find_by_id(
            job.winning_attempt_id.unwrap(),
        )
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
        assert!(env
            .device_audio
            .byte_store()
            .unwrap()
            .operator
            .exists(&selected.object_key)
            .await
            .unwrap());
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_terminal_cleanup_retains_pin_and_quota_until_source_removed(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let (job_id, source) = completed_for_cleanup(&env, actor, device).await;
    let saved = source.file_path.with_extension("retained");
    std::fs::rename(&source.file_path, &saved).unwrap();
    std::fs::create_dir(&source.file_path).unwrap();
    let _ =
        super::super::async_cleanup::cleanup_source(&env.device_audio, job_id)
            .await;
    assert_terminal_source_retained(&env, actor, job_id, source.upload_length)
        .await;
    assert!(pin_path(&env, device, source.file_id).is_file());
    assert!(saved.is_file());
    assert!(source.file_path.is_dir());
    std::fs::remove_dir(&source.file_path).unwrap();
    std::fs::rename(saved, &source.file_path).unwrap();
    release_terminal_source(&env, actor, job_id, &source).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_terminal_cleanup_rejects_replaced_tus_root() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let (job_id, source) = completed_for_cleanup(&env, actor, device).await;
    let pin = pin_path(&env, device, source.file_id);
    let root = pin.parent().unwrap().parent().unwrap();
    let saved = root.with_extension("original");
    let original = std::fs::read(&source.file_path).unwrap();
    let marker = std::fs::read(&pin).unwrap();
    std::fs::rename(root, &saved).unwrap();
    std::fs::create_dir_all(source.file_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(pin.parent().unwrap()).unwrap();
    std::fs::write(&source.file_path, &original).unwrap();
    std::fs::write(&pin, marker).unwrap();
    let _ =
        super::super::async_cleanup::cleanup_source(&env.device_audio, job_id)
            .await;
    assert_terminal_source_retained(&env, actor, job_id, source.upload_length)
        .await;
    assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
    let saved_source = saved.join(source.file_path.strip_prefix(root).unwrap());
    assert_eq!(std::fs::read(&saved_source).unwrap(), original);
    let replacement = root.with_extension("replacement");
    std::fs::rename(root, &replacement).unwrap();
    std::fs::rename(&saved, root).unwrap();
    release_terminal_source(&env, actor, job_id, &source).await;
    assert_eq!(
        std::fs::read(
            replacement.join(source.file_path.strip_prefix(root).unwrap())
        )
        .unwrap(),
        original
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn phase5_audio_terminal_cleanup_requires_pin_when_source_still_exists() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let (job_id, source) = completed_for_cleanup(&env, actor, device).await;
    let pin = pin_path(&env, device, source.file_id);
    let marker = std::fs::read(&pin).unwrap();
    let original = std::fs::read(&source.file_path).unwrap();
    std::fs::remove_file(&pin).unwrap();
    let _ =
        super::super::async_cleanup::cleanup_source(&env.device_audio, job_id)
            .await;
    assert_terminal_source_retained(&env, actor, job_id, source.upload_length)
        .await;
    assert_eq!(std::fs::read(&source.file_path).unwrap(), original);
    std::fs::write(&pin, marker).unwrap();
    release_terminal_source(&env, actor, job_id, &source).await;
}

#[path = "security_tests.rs"]
mod security_tests;

#[path = "capacity_tests.rs"]
mod capacity_tests;
