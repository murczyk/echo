use super::tests::{audio_actor, audio_device, audio_organism};
use super::*;
use crate::entities::system_settings;
use crate::file_registry::entities::device_audio;
use crate::functest::tests::cleanup_locked;
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::cookie::{Cookie, Key};
use actix_web::{http::Method, test, web, App, HttpMessage, HttpRequest};
use sea_orm::{
    ActiveModelTrait, EntityTrait, IntoActiveModel, PaginatorTrait, Set,
};
use sha2::{Digest, Sha256};

#[path = "content_tests.rs"]
mod content_tests;

#[path = "text_tests.rs"]
mod text_tests;

#[path = "processing_tests.rs"]
mod processing_tests;

pub(super) async fn native_audio_bytes() -> web::Bytes {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("original.wav");
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
            "0.1",
            "-c:a",
            "pcm_s16le",
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

pub(super) async fn receive_command(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    device: Uuid,
    name: &str,
    bytes: web::Bytes,
) -> types::ReceiveDeviceAudioCommand {
    let handler = upload::handler(runtime, device).unwrap();
    let completed = handler
        .create_completed_upload(
            &actor,
            Default::default(),
            futures_util::stream::iter([Ok::<_, AppError>(bytes)]),
        )
        .await
        .unwrap();
    let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored {
        upload_url,
        ..
    } = completed
    else {
        panic!("completed source required")
    };
    types::ReceiveDeviceAudioCommand {
        device_id: device,
        upload_url,
        name: name.into(),
        recording_started_at: "2026-10-03T23:59:59.950001Z".parse().unwrap(),
    }
}

pub(super) async fn enabled_audio_device(
    env: &crate::types::Env,
) -> (Uuid, Uuid) {
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let organization = audio_organism(&env.dbx, None).await;
    let actor = audio_actor(&env.dbx, organization.id, &["Cyber"]).await;
    let device = audio_device(&env.dbx, &actor, organization.id, false).await;
    (actor.id, device.id)
}

async fn stored_attempt(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
    name: &str,
) -> (
    crate::file_registry::entities::device_audio_ingest::Model,
    probe::ProbedAudio,
    crate::sigint::file_upload::tus::TusUpload,
) {
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        name,
        native_audio_bytes().await,
    )
    .await;
    let (source, guard) = upload::open_completed(
        &env.device_audio,
        actor,
        device,
        &command.upload_url,
    )
    .await
    .unwrap();
    let mut attempt = query::new_attempt(actor, &command, &source);
    let old =
        (chrono::Utc::now() - chrono::Duration::minutes(10)).fixed_offset();
    attempt.created_at = Set(old);
    attempt.heartbeat_at = Set(old);
    let attempt = attempt
        .insert(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    let media = probe::probe(
        &env.device_audio,
        &source.file_path,
        command.recording_started_at,
    )
    .await
    .unwrap();
    let admission = Arc::new(
        env.device_audio
            .receive_permits
            .clone()
            .try_acquire_owned()
            .unwrap(),
    );
    let prepared = storage::prepare_source(
        source.file_path.clone(),
        source.upload_length,
        admission,
    )
    .await
    .unwrap();
    query::allow_store(
        &env.device_audio,
        &attempt,
        prepared.fingerprint,
        &media,
    )
    .await
    .unwrap();
    storage::store_and_verify(
        env.device_audio.clone(),
        attempt.storage_key.clone(),
        prepared,
    )
    .await
    .unwrap();
    drop(guard);
    (attempt, media, source)
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_cleanup_fences_live_and_uncertain_publication() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let (ready, media, source) =
        stored_attempt(&env, actor, device, "ready-before-consume").await;
    assert!(matches!(
        query::publish(&env.device_audio, &ready, &media)
            .await
            .unwrap(),
        types::ReceiveDeviceAudioOutcome::Accepted(_)
    ));
    let live =
        crate::sigint::file_upload::lock_uploaded_source(&source.file_path)
            .await
            .unwrap()
            .unwrap();
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(source.file_path.exists());
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&ready.storage_key)
        .await
        .unwrap());
    drop(live);
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(!source.file_path.exists());
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&ready.storage_key)
        .await
        .unwrap());
    let db = env.device_audio.file_database().unwrap();
    let ready = query::locked_attempt(db, ready.id).await.unwrap();
    assert_eq!(ready.status, "ready");
    assert!(ready.source_consumed_at.is_some());
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 1);

    let (storing, media, source) =
        stored_attempt(&env, actor, device, "stale-storing").await;
    cleanup_once(&env.device_audio).await.unwrap();
    assert_eq!(
        query::locked_attempt(db, storing.id).await.unwrap().status,
        "storing",
        "fresh heartbeat defers recovery"
    );
    let mut stale = query::locked_attempt(db, storing.id)
        .await
        .unwrap()
        .into_active_model();
    stale.heartbeat_at =
        Set((chrono::Utc::now() - chrono::Duration::minutes(6)).fixed_offset());
    stale.update(db).await.unwrap();
    let live =
        crate::sigint::file_upload::lock_uploaded_source(&source.file_path)
            .await
            .unwrap()
            .unwrap();
    cleanup_once(&env.device_audio).await.unwrap();
    assert_eq!(
        query::locked_attempt(db, storing.id).await.unwrap().status,
        "storing",
        "held source guard defers recovery even with old heartbeat"
    );
    drop(live);
    cleanup_once(&env.device_audio).await.unwrap();
    let deleted = query::locked_attempt(db, storing.id).await.unwrap();
    assert_eq!(deleted.status, "deleting");
    assert!(!env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&storing.storage_key)
        .await
        .unwrap());
    assert!(!source.file_path.exists());
    super::tests::assert_status(
        query::publish(&env.device_audio, &storing, &media).await,
        StatusCode::CONFLICT,
    );
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&ready.storage_key)
        .await
        .unwrap());
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_cleanup_redeletes_late_remote_put() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let (attempt, _media, _source) =
        stored_attempt(&env, actor, device, "late-remote-put").await;
    let db = env.device_audio.file_database().unwrap();
    let operator = &env.device_audio.byte_store().unwrap().operator;
    let ciphertext =
        operator.read(&attempt.storage_key).await.unwrap().to_vec();
    let mut stale = query::locked_attempt(db, attempt.id)
        .await
        .unwrap()
        .into_active_model();
    stale.heartbeat_at =
        Set((chrono::Utc::now() - chrono::Duration::minutes(6)).fixed_offset());
    stale.update(db).await.unwrap();
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(!operator.exists(&attempt.storage_key).await.unwrap());
    let tombstone = query::locked_attempt(db, attempt.id).await.unwrap();
    assert_eq!(tombstone.status, "deleting");
    assert!(
        tombstone.next_cleanup_at.unwrap()
            > chrono::Utc::now() + chrono::Duration::hours(23)
    );
    operator
        .write(&attempt.storage_key, ciphertext)
        .await
        .unwrap();
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(
        operator.exists(&attempt.storage_key).await.unwrap(),
        "daily rescan is not a tight delete loop"
    );
    let mut due = tombstone.into_active_model();
    due.next_cleanup_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
    ));
    due.update(db).await.unwrap();
    audio_child(&serde_json::json!({"action": "cleanup"})).await;
    assert!(!operator.exists(&attempt.storage_key).await.unwrap());
    assert_eq!(
        query::locked_attempt(db, attempt.id).await.unwrap().status,
        "deleting"
    );
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 0);
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_cleanup_confirms_unknown_claim_before_delete() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let db = env.device_audio.file_database().unwrap();
    for disconnect in [false, true] {
        let (attempt, _media, source) =
            stored_attempt(&env, actor, device, &format!("claim-{disconnect}"))
                .await;
        let mut stale = query::locked_attempt(db, attempt.id)
            .await
            .unwrap()
            .into_active_model();
        stale.heartbeat_at = Set((chrono::Utc::now()
            - chrono::Duration::minutes(6))
        .fixed_offset());
        stale.update(db).await.unwrap();
        let files = crate::file_registry::connect_runtime(
            &env.config,
            crate::types::Mode::Test,
        )
        .await
        .unwrap()
        .unwrap();
        let runtime = build_runtime(
            &env.config,
            &env.dbx,
            Some(&files),
            env.s3.as_ref(),
            env.metrics.clone(),
        );
        let hooks = worker::CleanupHooks {
            after_claim: Some(Arc::new({
                let db = files.connection().clone();
                move || {
                    let db = db.clone();
                    Box::pin(async move {
                        if disconnect {
                            db.close().await.unwrap();
                        }
                        anyhow::bail!("claim commit acknowledgment lost")
                    })
                }
            })),
        };
        let result = worker::cleanup_with_hooks(&runtime, &hooks).await;
        assert_eq!(result.is_err(), disconnect);
        let operator = &env.device_audio.byte_store().unwrap().operator;
        assert_eq!(
            operator.exists(&attempt.storage_key).await.unwrap(),
            disconnect,
            "unknown DB must retain remote bytes"
        );
        assert_eq!(source.file_path.exists(), disconnect);
        let claimed = query::locked_attempt(db, attempt.id).await.unwrap();
        assert_eq!(claimed.status, "deleting");
        if disconnect {
            let mut due = claimed.into_active_model();
            due.next_cleanup_at = Set(Some(
                (chrono::Utc::now() - chrono::Duration::seconds(1))
                    .fixed_offset(),
            ));
            due.update(db).await.unwrap();
            cleanup_once(&env.device_audio).await.unwrap();
            assert!(!operator.exists(&attempt.storage_key).await.unwrap());
            assert!(!source.file_path.exists());
        }
    }
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 0);
}

async fn audio_child(job: &serde_json::Value) {
    let root = std::env::var("AUDIO_TEST_ROOT")
        .expect("isolated audio environment required");
    assert!(root.starts_with("/tmp/echo-device-audio."));
    let path = std::path::PathBuf::from(&root)
        .join(format!("restart-{}.json", Uuid::new_v4()));
    tokio::fs::write(&path, serde_json::to_vec(job).unwrap())
        .await
        .unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["devices::audio::acceptance_tests::audio_cleanup_subprocess_entrypoint", "--exact", "--ignored", "--nocapture"])
        .env("DEVICE_AUDIO_CLEANUP_JOB", &path).kill_on_drop(true).output()).await.unwrap().unwrap();
    let expected_exit = if job["action"].as_str().unwrap().starts_with("crash-")
    {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            output.status.signal() == Some(libc::SIGKILL)
        }
        #[cfg(not(unix))]
        {
            output.status.success()
        }
    } else {
        output.status.success()
    };
    assert!(
        expected_exit,
        "child failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let log = std::path::PathBuf::from(&root).join(format!(
        "t010-restart-{}-{}.log",
        job["action"].as_str().unwrap(),
        Uuid::new_v4()
    ));
    tokio::fs::write(log, output.stdout).await.unwrap();
    tokio::fs::remove_file(path).await.unwrap();
}

#[cfg(target_os = "macos")]
async fn old_transport_source(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    device: Uuid,
    hours: i64,
    pending: bool,
) -> std::path::PathBuf {
    let handler = upload::handler(runtime, device).unwrap();
    let reference = completed_upload(&handler, actor).await;
    let source = handler
        .open_completed_url(&actor, &reference)
        .await
        .unwrap()
        .unwrap();
    let mut path = source.file_path;
    let date = (chrono::Local::now() - chrono::Duration::hours(hours))
        .format("%m/%d/%Y %H:%M:%S")
        .to_string();
    let result = tokio::process::Command::new("/usr/bin/SetFile")
        .args(["-d", &date])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(
        result.status.success(),
        "birth time fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        std::time::SystemTime::now()
            .duration_since(
                std::fs::metadata(&path).unwrap().created().unwrap()
            )
            .unwrap()
            >= std::time::Duration::from_secs((hours * 3600) as u64)
    );
    if pending {
        let login_directory = path.parent().unwrap();
        let root = login_directory.parent().unwrap().parent().unwrap();
        let pending_directory = root
            .join("pending")
            .join(login_directory.file_name().unwrap());
        tokio::fs::create_dir_all(&pending_directory).await.unwrap();
        let target = pending_directory.join(path.file_name().unwrap());
        tokio::fs::rename(&path, &target).await.unwrap();
        let metadata =
            std::path::PathBuf::from(format!("{}.json", path.display()));
        if metadata.exists() {
            tokio::fs::rename(metadata, format!("{}.json", target.display()))
                .await
                .unwrap();
        }
        path = target;
    }
    path
}

#[cfg(target_os = "macos")]
#[actix_web::test]
#[serial_test::serial]
async fn audio_cleanup_preserves_absolute_ttl_and_legacy_namespace() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let actor = Uuid::new_v4();
    let device = Uuid::new_v4();
    let pending =
        old_transport_source(&env.device_audio, actor, device, 5, true).await;
    let keep =
        old_transport_source(&env.device_audio, actor, device, 5, false).await;
    let expired =
        old_transport_source(&env.device_audio, actor, device, 9, false).await;
    let legacy = crate::sigint::file_upload::tus::TusHandler::new(
        env.config.storage_dir.clone(),
        "/api/sigint/file_upload/tus",
    );
    let reference = completed_upload(&legacy, actor).await;
    let legacy_source = legacy
        .open_completed_url(&actor, &reference)
        .await
        .unwrap()
        .unwrap();
    let live = crate::sigint::file_upload::lock_uploaded_source(&expired)
        .await
        .unwrap()
        .unwrap();
    for _ in 0..DEVICE_AUDIO_CLEANUP_BATCH {
        cleanup_once(&env.device_audio).await.unwrap();
        if !pending.exists() {
            break;
        }
    }
    assert!(!pending.exists(), "pending source expires at 4 h");
    assert!(keep.exists(), "completed source remains within its 8 h TTL");
    assert!(
        expired.exists(),
        "held lock protects active finalization from expiry cleanup"
    );
    drop(live);
    for _ in 0..DEVICE_AUDIO_CLEANUP_BATCH {
        cleanup_once(&env.device_audio).await.unwrap();
        if !expired.exists() {
            break;
        }
    }
    assert!(!expired.exists());
    assert!(legacy_source.file_path.exists());
    assert!(crate::sigint::file_upload::remove_consumed_upload(&keep)
        .await
        .unwrap());
    assert!(crate::sigint::file_upload::remove_consumed_upload(
        &legacy_source.file_path
    )
    .await
    .unwrap());
}

#[actix_web::test]
#[ignore = "run only as an isolated device-audio recovery subprocess"]
async fn audio_cleanup_subprocess_entrypoint() {
    let root = std::env::var("AUDIO_TEST_ROOT")
        .expect("isolated audio environment required");
    assert!(root.starts_with("/tmp/echo-device-audio."));
    let path = std::env::var("DEVICE_AUDIO_CLEANUP_JOB")
        .expect("parent recovery job required");
    assert!(path.starts_with(&root));
    let job: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    let env = crate::server::new_readonly_env(crate::types::Mode::Test)
        .await
        .unwrap();
    let store = env.device_audio.byte_store().unwrap();
    assert!(store.config.endpoint.starts_with("http://127.0.0.1:"));
    assert!(store.config.bucket.starts_with("device-audio-"));
    if job["action"] == "cleanup" {
        cleanup_once(&env.device_audio).await.unwrap();
        return;
    }
    let actor: Uuid = serde_json::from_value(job["actor"].clone()).unwrap();
    let command: types::ReceiveDeviceAudioCommand =
        serde_json::from_value(job["command"].clone()).unwrap();
    if job["action"] == "crash-locked" {
        let (_source, _guard) = upload::open_completed(
            &env.device_audio,
            actor,
            command.device_id,
            &command.upload_url,
        )
        .await
        .unwrap();
        crash_audio_child();
    }
    let crash: Arc<
        dyn Fn() -> futures_util::future::BoxFuture<'static, anyhow::Result<()>>
            + Send
            + Sync,
    > = Arc::new(|| Box::pin(async { crash_audio_child() }));
    let hooks = if job["action"] == "crash-ready" {
        ingest::IngestHooks {
            after_commit: Some(crash),
            ..Default::default()
        }
    } else if job["action"] == "crash-before-put" {
        ingest::IngestHooks {
            before_put: Some(crash),
            ..Default::default()
        }
    } else {
        ingest::IngestHooks {
            before_publication: Some(crash),
            ..Default::default()
        }
    };
    let result = ingest::receive_with_hooks(
        env.device_audio.clone(),
        actor,
        command,
        hooks,
    )
    .await;
    panic!("child did not reach the requested crash point: {result:?}");
}

fn crash_audio_child() -> ! {
    #[cfg(unix)]
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    std::process::exit(0)
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_cleanup_recovers_after_real_process_exit() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let db = env.device_audio.file_database().unwrap();
    let operator = &env.device_audio.byte_store().unwrap().operator;
    for (action, stored, ready) in [
        ("crash-locked", false, false),
        ("crash-before-put", false, false),
        ("crash-storing", true, false),
        ("crash-ready", true, true),
    ] {
        let bytes = native_audio_bytes().await;
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            action,
            bytes.clone(),
        )
        .await;
        let source = upload::handler(&env.device_audio, device)
            .unwrap()
            .open_completed_url(&actor, &command.upload_url)
            .await
            .unwrap()
            .unwrap();
        let mut attempt = query::new_attempt(actor, &command, &source);
        let old =
            (chrono::Utc::now() - chrono::Duration::minutes(10)).fixed_offset();
        attempt.created_at = Set(old);
        attempt.heartbeat_at = Set(old);
        let attempt = attempt.insert(db).await.unwrap();
        audio_child(&serde_json::json!({"action": action, "actor": actor, "command": {"device_id": command.device_id, "upload_url": command.upload_url, "name": command.name, "recording_started_at": command.recording_started_at}})).await;
        let crashed = query::locked_attempt(db, attempt.id).await.unwrap();
        assert_eq!(
            crashed.status,
            if ready {
                "ready"
            } else if action == "crash-locked" {
                "finalizing"
            } else {
                "storing"
            }
        );
        assert!(source.file_path.exists());
        assert_eq!(
            operator.exists(&attempt.storage_key).await.unwrap(),
            stored
        );
        if !ready {
            let mut stale = crashed.into_active_model();
            stale.heartbeat_at = Set((chrono::Utc::now()
                - chrono::Duration::minutes(6))
            .fixed_offset());
            stale.update(db).await.unwrap();
        }
        audio_child(&serde_json::json!({"action": "cleanup"})).await;
        assert!(!source.file_path.exists());
        assert_eq!(operator.exists(&attempt.storage_key).await.unwrap(), ready);
        let recovered = query::locked_attempt(db, attempt.id).await.unwrap();
        assert_eq!(recovered.status, if ready { "ready" } else { "deleting" });
        assert!(recovered.source_consumed_at.is_some());
        if ready {
            assert_eq!(
                storage::verified_content(
                    env.device_audio.clone(),
                    attempt.storage_key,
                    storage::SourceFingerprint {
                        size_bytes: bytes.len() as u64,
                        sha256: Sha256::digest(&bytes).into(),
                    },
                )
                .await
                .unwrap(),
                bytes
            );
        }
    }
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_http_requires_session_and_confirmed_publication() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "HTTP accepted",
        native_audio_bytes().await,
    )
    .await;
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{actor}", web::post().to(login))
            .service(routes()),
    )
    .await;
    let request = types::ReceiveDeviceAudioReq {
        device_id: device.to_string(),
        upload_url: command.upload_url.clone(),
        name: command.name.clone(),
        recording_started_at: command.recording_started_at.to_rfc3339(),
    };
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .set_json(&request)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let logged_in = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{actor}"))
            .to_request(),
    )
    .await;
    let cookie = logged_in.response().cookies().next().unwrap().into_owned();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .cookie(cookie.clone())
            .set_json(&request)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let accepted: types::ReceiveDeviceAudioRsp =
        test::read_body_json(response).await;
    assert_eq!(
        accepted.audio.recording_started_at,
        "2026-10-03T23:59:59.950001Z"
    );
    assert_eq!(
        accepted.audio.recording_ended_at,
        "2026-10-04T00:00:00.050001Z"
    );
    assert!(!accepted.audio.processed);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .cookie(cookie.clone())
            .set_json(&request)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let duplicate: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(duplicate["details"]["code"], "device_audio_name_conflict");
    let mut invalid = serde_json::to_value(&request).unwrap();
    invalid["recording_started_at"] = "2026-10-03T23:59:59".into();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .cookie(cookie.clone())
            .set_json(&invalid)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "HTTP corrupt",
        web::Bytes::from_static(b"truncated"),
    )
    .await;
    let request = types::ReceiveDeviceAudioReq {
        device_id: device.to_string(),
        upload_url: command.upload_url,
        name: command.name,
        recording_started_at: command.recording_started_at.to_rfc3339(),
    };
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .cookie(cookie)
            .set_json(&request)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_reconciles_unknown_commit_before_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let db = env.device_audio.file_database().unwrap();
    for disconnect in [false, true] {
        let files = crate::file_registry::connect_runtime(
            &env.config,
            crate::types::Mode::Test,
        )
        .await
        .unwrap()
        .unwrap();
        let runtime = build_runtime(
            &env.config,
            &env.dbx,
            Some(&files),
            env.s3.as_ref(),
            env.metrics.clone(),
        );
        let command = receive_command(
            &runtime,
            actor,
            device,
            &format!("unknown-{disconnect}"),
            bytes.clone(),
        )
        .await;
        let source = upload::handler(&runtime, device)
            .unwrap()
            .open_completed_url(&actor, &command.upload_url)
            .await
            .unwrap()
            .unwrap();
        let puts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hooks = ingest::IngestHooks {
            before_put: Some(Arc::new({
                let puts = puts.clone();
                move || {
                    let puts = puts.clone();
                    Box::pin(async move {
                        puts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    })
                }
            })),
            after_commit: Some(Arc::new({
                let connection = files.connection().clone();
                move || {
                    let connection = connection.clone();
                    Box::pin(async move {
                        if disconnect {
                            connection.close().await.unwrap();
                        }
                        anyhow::bail!("commit acknowledgment lost")
                    })
                }
            })),
            ..Default::default()
        };
        let result = ingest::receive_with_hooks(
            runtime,
            actor,
            command.clone(),
            hooks.clone(),
        )
        .await;
        if disconnect {
            assert!(result.is_err(), "closed DB cannot confirm publication");
        } else {
            assert!(matches!(
                result.unwrap(),
                types::ReceiveDeviceAudioOutcome::Accepted(_)
            ));
        }
        let attempt = query::find_attempt(db, &command.upload_url)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attempt.status, "ready");
        assert_eq!(attempt.source_consumed_at.is_none(), disconnect);
        assert_eq!(source.file_path.exists(), disconnect);
        assert_eq!(
            storage::verified_content(
                env.device_audio.clone(),
                attempt.storage_key.clone(),
                storage::SourceFingerprint {
                    size_bytes: bytes.len() as u64,
                    sha256: Sha256::digest(&bytes).into()
                }
            )
            .await
            .unwrap(),
            bytes
        );
        let operator = &env.device_audio.byte_store().unwrap().operator;
        let ciphertext =
            operator.read(&attempt.storage_key).await.unwrap().to_vec();
        assert!(matches!(
            ingest::receive_with_hooks(
                env.device_audio.clone(),
                actor,
                command,
                hooks
            )
            .await
            .unwrap(),
            types::ReceiveDeviceAudioOutcome::Duplicate
        ));
        assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            operator.read(&attempt.storage_key).await.unwrap().to_vec(),
            ciphertext
        );
    }
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 2);
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_cancellation_retains_source_and_admission() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "cancelled-http",
        native_audio_bytes().await,
    )
    .await;
    let arrived = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let hooks = ingest::IngestHooks {
        before_publication: Some(Arc::new({
            let arrived = arrived.clone();
            let release = release.clone();
            move || {
                let arrived = arrived.clone();
                let release = release.clone();
                Box::pin(async move {
                    arrived.notify_one();
                    release.notified().await;
                    Ok(())
                })
            }
        })),
        ..Default::default()
    };
    let mut client = Box::pin(ingest::receive_with_hooks(
        env.device_audio.clone(),
        actor,
        command.clone(),
        hooks,
    ));
    tokio::select! {
        _ = arrived.notified() => {}
        result = &mut client => panic!("receive ended before the publication barrier: {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => panic!("publication barrier not reached"),
    }
    drop(client);
    assert_eq!(
        env.device_audio.receive_permits.available_permits(),
        1,
        "cancelled HTTP must retain owned receive admission"
    );
    let busy = upload::open_completed(
        &env.device_audio,
        actor,
        device,
        &command.upload_url,
    )
    .await;
    assert!(
        busy.is_err(),
        "owned finalization keeps the original source guard"
    );
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let attempt = query::find_attempt(
                env.device_audio.file_database().unwrap(),
                &command.upload_url,
            )
            .await
            .unwrap()
            .unwrap();
            if attempt.status == "ready"
                && attempt.source_consumed_at.is_some()
                && env.device_audio.receive_permits.available_permits()
                    == DEVICE_AUDIO_RECEIVE_CONCURRENCY
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_storing_retry_never_repeats_put() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "interrupted-storing",
        bytes.clone(),
    )
    .await;
    let (source, guard) = upload::open_completed(
        &env.device_audio,
        actor,
        device,
        &command.upload_url,
    )
    .await
    .unwrap();
    let attempt =
        query::reserve_attempt(&env.device_audio, actor, &command, &source)
            .await
            .unwrap();
    let media = probe::probe(
        &env.device_audio,
        &source.file_path,
        command.recording_started_at,
    )
    .await
    .unwrap();
    let admission = Arc::new(
        env.device_audio
            .receive_permits
            .clone()
            .try_acquire_owned()
            .unwrap(),
    );
    let prepared = storage::prepare_source(
        source.file_path.clone(),
        source.upload_length,
        admission,
    )
    .await
    .unwrap();
    query::allow_store(
        &env.device_audio,
        &attempt,
        prepared.fingerprint,
        &media,
    )
    .await
    .unwrap();
    storage::store_and_verify(
        env.device_audio.clone(),
        attempt.storage_key.clone(),
        prepared,
    )
    .await
    .unwrap();
    drop(guard);
    let operator = &env.device_audio.byte_store().unwrap().operator;
    let ciphertext =
        operator.read(&attempt.storage_key).await.unwrap().to_vec();
    let puts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hooks = ingest::IngestHooks {
        before_put: Some(Arc::new({
            let puts = puts.clone();
            move || {
                let puts = puts.clone();
                Box::pin(async move {
                    puts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
            }
        })),
        ..Default::default()
    };
    super::tests::assert_status(
        ingest::receive_with_hooks(
            env.device_audio.clone(),
            actor,
            command.clone(),
            hooks.clone(),
        )
        .await,
        StatusCode::CONFLICT,
    );
    super::tests::assert_status(
        ingest::receive_with_hooks(
            env.device_audio.clone(),
            actor,
            command,
            hooks,
        )
        .await,
        StatusCode::CONFLICT,
    );
    assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        operator.read(&attempt.storage_key).await.unwrap().to_vec(),
        ciphertext
    );
    let db = env.device_audio.file_database().unwrap();
    let attempt = query::locked_attempt(db, attempt.id).await.unwrap();
    assert_eq!(attempt.status, "deleting");
    assert!(attempt.source_consumed_at.is_some());
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 0);
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "interrupted-storing",
        bytes,
    )
    .await;
    assert!(matches!(
        receive(&env.device_audio, actor, command).await.unwrap(),
        types::ReceiveDeviceAudioOutcome::Accepted(_)
    ));
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_rechecks_access_before_publication() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    for archive in [false, true] {
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            &format!("revoke-{archive}"),
            bytes.clone(),
        )
        .await;
        let hooks = ingest::IngestHooks {
            before_publication: Some(Arc::new({
                let db = env.dbx.clone();
                move || {
                    let db = db.clone();
                    Box::pin(async move {
                        if archive {
                            let mut device =
                                crate::entities::device::Entity::find_by_id(
                                    device,
                                )
                                .one(&db)
                                .await
                                .unwrap()
                                .unwrap()
                                .into_active_model();
                            device.archived = Set(true);
                            device.archived_at =
                                Set(Some(chrono::Utc::now().naive_utc()));
                            device.update(&db).await.unwrap();
                        } else {
                            let mut actor =
                                crate::entities::login::Entity::find_by_id(
                                    actor,
                                )
                                .one(&db)
                                .await
                                .unwrap()
                                .unwrap()
                                .into_active_model();
                            actor.roles = Set(serde_json::json!([]));
                            actor.update(&db).await.unwrap();
                        }
                        Ok(())
                    })
                }
            })),
            ..Default::default()
        };
        super::tests::assert_status(
            ingest::receive_with_hooks(
                env.device_audio.clone(),
                actor,
                command.clone(),
                hooks,
            )
            .await,
            StatusCode::FORBIDDEN,
        );
        let attempt = query::find_attempt(
            env.device_audio.file_database().unwrap(),
            &command.upload_url,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(attempt.status, "deleting");
        assert!(attempt.source_consumed_at.is_some());
        let mut actor = crate::entities::login::Entity::find_by_id(actor)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        actor.roles = Set(serde_json::json!(["Cyber"]));
        actor.update(&env.dbx).await.unwrap();
        let mut device = crate::entities::device::Entity::find_by_id(device)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        device.archived = Set(false);
        device.archived_at = Set(None);
        device.update(&env.dbx).await.unwrap();
    }
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_waits_for_internal_slots_after_admission() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let first = receive_command(
        &env.device_audio,
        actor,
        device,
        "simultaneous.wav",
        bytes.clone(),
    )
    .await;
    let second = receive_command(
        &env.device_audio,
        actor,
        device,
        "simultaneous.wav",
        bytes,
    )
    .await;
    let urls = [first.upload_url.clone(), second.upload_url.clone()];
    let probe = env
        .device_audio
        .probe_permits
        .clone()
        .try_acquire_owned()
        .unwrap();
    let decrypt = env
        .device_audio
        .decrypt_permits
        .clone()
        .try_acquire_owned()
        .unwrap();
    let runtime = env.device_audio.clone();
    let first =
        actix_web::rt::spawn(
            async move { receive(&runtime, actor, first).await },
        );
    let runtime = env.device_audio.clone();
    let second =
        actix_web::rt::spawn(
            async move { receive(&runtime, actor, second).await },
        );
    let admitted =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while env.device_audio.receive_permits.available_permits() != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
    let waiting_for_probe = !first.is_finished() && !second.is_finished();
    let receive_slots = env.device_audio.receive_permits.available_permits();
    drop(probe);
    let storing =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let db = env.device_audio.file_database().unwrap();
                let first = query::find_attempt(db, &urls[0]).await.unwrap();
                let second = query::find_attempt(db, &urls[1]).await.unwrap();
                if first
                    .as_ref()
                    .is_some_and(|attempt| attempt.status == "storing")
                    && second
                        .as_ref()
                        .is_some_and(|attempt| attempt.status == "storing")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
    let waiting_for_decrypt = !first.is_finished() && !second.is_finished();
    drop(decrypt);
    let (first, second) = tokio::join!(first, second);
    admitted.expect("both receives must reach admission");
    assert!(
        waiting_for_probe,
        "admitted receives must wait for internal decoder slots"
    );
    assert_eq!(receive_slots, 0);
    storing.unwrap();
    assert!(
        waiting_for_decrypt,
        "admitted receives must wait for internal readback slots"
    );
    let outcomes = [first.unwrap().unwrap(), second.unwrap().unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                types::ReceiveDeviceAudioOutcome::Accepted(_)
            ))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                types::ReceiveDeviceAudioOutcome::Duplicate
            ))
            .count(),
        1
    );
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_receive_duplicate_race_and_immutable_metadata() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let organization = audio_organism(&env.dbx, None).await;
    let actor = audio_actor(&env.dbx, organization.id, &["Cyber"]).await;
    let device = audio_device(&env.dbx, &actor, organization.id, false).await;
    let another = audio_device(&env.dbx, &actor, organization.id, false).await;
    let bytes = native_audio_bytes().await;
    let first = receive_command(
        &env.device_audio,
        actor.id,
        device.id,
        " АудіоЇ ",
        bytes.clone(),
    )
    .await;
    let second = receive_command(
        &env.device_audio,
        actor.id,
        device.id,
        " АудіоЇ ",
        bytes.clone(),
    )
    .await;
    let arrived = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let hooks = ingest::IngestHooks {
        before_publication: Some(Arc::new({
            let arrived = arrived.clone();
            let release = release.clone();
            move || {
                let arrived = arrived.clone();
                let release = release.clone();
                Box::pin(async move {
                    arrived.notify_one();
                    release.notified().await;
                    Ok(())
                })
            }
        })),
        ..Default::default()
    };
    let results = async {
        let one = async {
            let result = ingest::receive_with_hooks(
                env.device_audio.clone(),
                actor.id,
                first.clone(),
                hooks,
            )
            .await;
            if result.is_err() {
                arrived.notify_one();
            }
            result
        };
        let two = async {
            arrived.notified().await;
            let result =
                receive(&env.device_audio, actor.id, second.clone()).await;
            release.notify_one();
            result
        };
        futures_util::join!(one, two)
    };
    let (one, two) =
        tokio::time::timeout(std::time::Duration::from_secs(15), results)
            .await
            .unwrap();
    let status =
        |result: anyhow::Result<types::ReceiveDeviceAudioOutcome>| match result
        {
            Ok(types::ReceiveDeviceAudioOutcome::Accepted(_)) => 201,
            Ok(types::ReceiveDeviceAudioOutcome::Duplicate) => 409,
            Err(error) => {
                AppError::from(error).error_response().status().as_u16()
            }
        };
    let mut statuses = [status(one), status(two)];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    let db = env.device_audio.file_database().unwrap();
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 1);
    assert!(matches!(
        receive(&env.device_audio, actor.id, second.clone())
            .await
            .unwrap(),
        types::ReceiveDeviceAudioOutcome::Duplicate
    ));
    for modified in [
        types::ReceiveDeviceAudioCommand {
            name: "changed".into(),
            ..second.clone()
        },
        types::ReceiveDeviceAudioCommand {
            recording_started_at: second.recording_started_at
                + chrono::Duration::microseconds(1),
            ..second.clone()
        },
    ] {
        super::tests::assert_status(
            receive(&env.device_audio, actor.id, modified).await,
            StatusCode::CONFLICT,
        );
    }
    for (target, name) in [(device.id, " аудіої "), (another.id, " АудіоЇ ")]
    {
        let command = receive_command(
            &env.device_audio,
            actor.id,
            target,
            name,
            bytes.clone(),
        )
        .await;
        assert!(matches!(
            receive(&env.device_audio, actor.id, command).await.unwrap(),
            types::ReceiveDeviceAudioOutcome::Accepted(_)
        ));
    }
    let invalid = receive_command(
        &env.device_audio,
        actor.id,
        device.id,
        "reusable",
        web::Bytes::from_static(b"corrupt"),
    )
    .await;
    assert!(receive(&env.device_audio, actor.id, invalid).await.is_err());
    let valid = receive_command(
        &env.device_audio,
        actor.id,
        device.id,
        "reusable",
        bytes,
    )
    .await;
    assert!(matches!(
        receive(&env.device_audio, actor.id, valid).await.unwrap(),
        types::ReceiveDeviceAudioOutcome::Accepted(_)
    ));
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 4);
    assert_eq!(
        crate::file_registry::entities::file_entry::Entity::find()
            .count(db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        crate::file_registry::entities::file_content::Entity::find()
            .count(db)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
#[serial_test::serial]
async fn audio_storage_bounds_source_before_upload() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let admission = std::sync::Arc::new(
        env.device_audio
            .receive_permits
            .clone()
            .try_acquire_owned()
            .unwrap(),
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source");
    tokio::fs::write(&path, b"source").await.unwrap();
    let prepared = storage::prepare_source(path.clone(), 6, admission.clone())
        .await
        .unwrap();
    assert_eq!(prepared.bytes.as_ref(), b"source");
    assert_eq!(
        prepared.fingerprint.sha256,
        <[u8; 32]>::from(Sha256::digest(b"source"))
    );
    for declared in [0, 5, 7, DEVICE_AUDIO_MAX_BYTES + 1] {
        assert!(storage::prepare_source(
            path.clone(),
            declared,
            admission.clone()
        )
        .await
        .is_err());
    }
}

#[tokio::test]
#[serial_test::serial]
async fn audio_storage_upload_uses_authenticated_readback() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let runtime = env.device_audio.clone();
    let store = runtime.byte_store().expect("private test S3 is required");
    assert!(store.config.endpoint.starts_with("http://127.0.0.1:"));
    assert!(store.config.bucket.starts_with("device-audio-"));
    let admission = std::sync::Arc::new(
        runtime.receive_permits.clone().try_acquire_owned().unwrap(),
    );
    let source = b"owned audio source upload";
    let expected = storage::SourceFingerprint {
        size_bytes: source.len() as u64,
        sha256: Sha256::digest(source).into(),
    };
    let key = format!(
        "device-audio/{}/{}/{}",
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4()
    );
    let prepared = storage::PreparedSource {
        fingerprint: expected,
        bytes: web::Bytes::from_static(source),
        admission: admission.clone(),
    };
    storage::store_and_verify(runtime.clone(), key.clone(), prepared)
        .await
        .unwrap();
    assert_eq!(
        storage::verified_content(runtime.clone(), key.clone(), expected)
            .await
            .unwrap(),
        source
    );
    assert_ne!(store.operator.read(&key).await.unwrap().to_vec(), source);
    let busy = runtime.decrypt_permits.clone().try_acquire_owned().unwrap();
    super::tests::assert_status(
        storage::verified_content(runtime.clone(), key.clone(), expected).await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    drop(busy);
    store.operator.delete(&key).await.unwrap();
    assert_eq!(runtime.receive_permits.available_permits(), 1);
    drop(admission);
    assert_eq!(
        runtime.receive_permits.available_permits(),
        DEVICE_AUDIO_RECEIVE_CONCURRENCY
    );
}

#[tokio::test]
#[serial_test::serial]
async fn audio_storage_requires_authenticated_exact_source() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let runtime = env.device_audio.clone();
    let store = runtime.byte_store().expect("private test S3 is required");
    assert!(store.config.endpoint.starts_with("http://127.0.0.1:"));
    assert!(store.config.bucket.starts_with("device-audio-"));
    let key = format!(
        "device-audio/{}/{}/{}",
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4()
    );
    let source = b"authenticated original device audio";
    let expected = storage::SourceFingerprint {
        size_bytes: source.len() as u64,
        sha256: Sha256::digest(source).into(),
    };
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(store.operator.clone()),
        &store.config,
        &store.strongbox_key,
        &key,
        web::Bytes::from_static(source),
    )
    .await
    .unwrap();
    let verified =
        storage::verified_content(runtime.clone(), key.clone(), expected)
            .await
            .unwrap();
    assert_eq!(verified, source);
    assert!(storage::verified_content(
        runtime.clone(),
        key.clone(),
        storage::SourceFingerprint {
            size_bytes: expected.size_bytes + 1,
            ..expected
        }
    )
    .await
    .is_err());
    assert!(storage::verified_content(
        runtime.clone(),
        key.clone(),
        storage::SourceFingerprint {
            sha256: [0; 32],
            ..expected
        }
    )
    .await
    .is_err());
    let ciphertext = store.operator.read(&key).await.unwrap().to_vec();
    let wrong_aad = format!("{key}-different-context");
    store
        .operator
        .write(&wrong_aad, ciphertext.clone())
        .await
        .unwrap();
    assert!(storage::verified_content(
        runtime.clone(),
        wrong_aad.clone(),
        expected
    )
    .await
    .is_err());
    store.operator.delete(&wrong_aad).await.unwrap();

    let mut wrong_config = env.config.clone();
    use base64::Engine;
    wrong_config.s3_config.as_mut().unwrap().strongbox_key =
        base64::engine::general_purpose::STANDARD.encode([7; 32]);
    let wrong_key = build_runtime(
        &wrong_config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        env.s3.as_ref(),
        env.metrics.clone(),
    );
    assert!(storage::verified_content(wrong_key, key.clone(), expected)
        .await
        .is_err());
    let missing = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        env.metrics.clone(),
    );
    assert!(storage::verified_content(missing, key.clone(), expected)
        .await
        .is_err());

    store
        .operator
        .write(&key, ciphertext[..ciphertext.len() - 1].to_vec())
        .await
        .unwrap();
    assert!(
        storage::verified_content(runtime.clone(), key.clone(), expected)
            .await
            .is_err()
    );
    store.operator.write(&key, source.to_vec()).await.unwrap();
    assert!(
        storage::verified_content(runtime.clone(), key.clone(), expected)
            .await
            .is_err()
    );
    store
        .operator
        .write(
            &key,
            vec![0; DEVICE_AUDIO_MAX_CIPHERTEXT_BYTES as usize + 1],
        )
        .await
        .unwrap();
    assert!(
        storage::verified_content(runtime.clone(), key.clone(), expected)
            .await
            .is_err()
    );
    store.operator.delete(&key).await.unwrap();
    assert_eq!(
        device_audio::Entity::find()
            .count(runtime.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
}

async fn login(request: HttpRequest, actor: web::Path<String>) -> HttpResponse {
    Identity::login(&request.extensions(), actor.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

macro_rules! transport {
    ($app:expr, $cookie:expr, $method:expr, $url:expr, $headers:expr, $bytes:expr) => {{
        let mut request = test::TestRequest::default()
            .method($method)
            .uri($url)
            .cookie($cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"));
        for (name, value) in $headers {
            request = request.insert_header((*name, *value));
        }
        test::call_service(
            &$app,
            request.set_payload($bytes.to_vec()).to_request(),
        )
        .await
    }};
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_tus_resumes_and_isolates_owner_device() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut settings = system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap()
    .into_active_model();
    let organization = audio_organism(&env.dbx, None).await;
    let actor = audio_actor(&env.dbx, organization.id, &["Cyber"]).await;
    let intruder = audio_actor(&env.dbx, organization.id, &["Cyber"]).await;
    let device = audio_device(&env.dbx, &actor, organization.id, false).await;
    let another_device =
        audio_device(&env.dbx, &actor, organization.id, false).await;
    let archived = audio_device(&env.dbx, &actor, organization.id, true).await;
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{actor}", web::post().to(login))
            .service(upload::routes())
            .route(
                "/test/after-audio",
                web::get().to(|| async { HttpResponse::Ok().finish() }),
            ),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", actor.id))
            .to_request(),
    )
    .await;
    let cookie: Cookie<'static> =
        response.response().cookies().next().unwrap().into_owned();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", intruder.id))
            .to_request(),
    )
    .await;
    let intruder_cookie: Cookie<'static> =
        response.response().cookies().next().unwrap().into_owned();
    let collection = format!("/api/device/audio/{}/uploads", device.id);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/test/after-audio")
            .to_request(),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "audio routes must not shadow unrelated routes"
    );
    let bytes = b"resumed device audio source";
    let length = bytes.len().to_string();
    let response = transport!(
        app,
        cookie,
        Method::POST,
        &collection,
        &[("upload-length", length.as_str())],
        b""
    );
    assert_eq!(response.status(), StatusCode::CREATED);
    let location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(location.starts_with(&format!("{collection}/")));
    let response = transport!(
        app,
        cookie,
        Method::PATCH,
        &location,
        &[
            ("content-type", "application/offset+octet-stream"),
            ("upload-offset", "0")
        ],
        &bytes[..7]
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.headers().get("upload-offset").unwrap(), "7");
    let expires = response.headers().get("upload-expires").unwrap().clone();
    for (headers, expected) in [
        (
            vec![
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "0"),
            ],
            StatusCode::CONFLICT,
        ),
        (
            vec![("content-type", "text/plain"), ("upload-offset", "7")],
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            vec![
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "7"),
                ("tus-resumable", "0.1"),
            ],
            StatusCode::PRECONDITION_FAILED,
        ),
    ] {
        let response = transport!(
            app,
            cookie,
            Method::PATCH,
            &location,
            headers.as_slice(),
            &bytes[7..]
        );
        assert_eq!(response.status(), expected);
    }
    let response = transport!(
        app,
        cookie,
        Method::PATCH,
        &location,
        &[
            ("content-type", "application/offset+octet-stream"),
            ("upload-offset", "7")
        ],
        &[0_u8; 64]
    );
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.headers().get("upload-offset").unwrap(), "7");
    assert_eq!(response.headers().get("upload-expires").unwrap(), expires);
    let response = transport!(
        app,
        intruder_cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let other_location = location
        .replace(&device.id.to_string(), &another_device.id.to_string());
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &other_location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = transport!(
        app,
        cookie,
        Method::POST,
        &location,
        &[
            ("x-http-method-override", "PATCH"),
            ("content-type", "application/offset+octet-stream"),
            ("upload-offset", "7")
        ],
        &bytes[7..]
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(
        response.headers().get("upload-offset").unwrap(),
        length.as_str()
    );
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
    let root = std::path::PathBuf::from(&env.config.storage_dir)
        .join("device-audio-tus")
        .join(device.id.to_string());
    let handler = crate::sigint::file_upload::tus::TusHandler::new(
        root.display().to_string(),
        &collection,
    );
    let source = handler
        .open_completed_url(&actor.id, &location)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        Sha256::digest(tokio::fs::read(&source.file_path).await.unwrap()),
        Sha256::digest(bytes)
    );
    let lock =
        crate::sigint::file_upload::lock_uploaded_source(&source.file_path)
            .await
            .unwrap()
            .unwrap();
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::LOCKED);
    assert!(response.headers().contains_key("retry-after"));
    drop(lock);
    let response = transport!(
        app,
        cookie,
        Method::OPTIONS,
        &collection,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get("tus-max-size").unwrap(), "104857600");
    let response = transport!(
        app,
        cookie,
        Method::POST,
        &collection,
        &[("upload-length", "104857601")],
        b""
    );
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = transport!(
        app,
        cookie,
        Method::POST,
        &collection,
        &[
            ("upload-length", "104857600"),
            ("x-http-method-override", "PATCH")
        ],
        b""
    );
    assert_eq!(response.status(), StatusCode::CREATED);
    let cap_location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let response = transport!(
        app,
        cookie,
        Method::DELETE,
        &cap_location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = transport!(
        app,
        cookie,
        Method::DELETE,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = transport!(
        app,
        cookie,
        Method::HEAD,
        &location,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let archived_collection =
        format!("/api/device/audio/{}/uploads", archived.id);
    let response = transport!(
        app,
        cookie,
        Method::POST,
        &archived_collection,
        &[("upload-length", "1")],
        b""
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    settings.devices_section_enabled = Set(false);
    settings.update(&env.dbx).await.unwrap();
    let response = transport!(
        app,
        cookie,
        Method::OPTIONS,
        &collection,
        &[] as &[(&str, &str)],
        b""
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

async fn completed_upload(
    handler: &crate::sigint::file_upload::tus::TusHandler,
    actor: Uuid,
) -> String {
    match handler.create_completed_upload(
        &actor,
        Default::default(),
        futures_util::stream::iter([Ok::<_, crate::error::AppError>(web::Bytes::from_static(b"source"))]),
    ).await.unwrap() {
        crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url, .. } => upload_url,
        _ => panic!("completed source required"),
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_completed_source_revalidates_under_lock() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let actor = Uuid::new_v4();
    let device = Uuid::new_v4();
    let handler = upload::handler(&env.device_audio, device).unwrap();
    let url = completed_upload(&handler, actor).await;
    let (mut source, source_guard) =
        upload::open_completed(&env.device_audio, actor, device, &url)
            .await
            .unwrap();
    upload::validate_locked_source(&source).await.unwrap();
    tokio::fs::remove_file(&source.file_path).await.unwrap();
    assert!(
        upload::validate_locked_source(&source).await.is_err(),
        "source removed after open must fail"
    );
    tokio::fs::write(&source.file_path, b"short").await.unwrap();
    assert!(
        upload::validate_locked_source(&source).await.is_err(),
        "actual length must match declared length"
    );
    tokio::fs::write(&source.file_path, b"source")
        .await
        .unwrap();
    source.expires = chrono::Utc::now();
    assert!(
        upload::validate_locked_source(&source).await.is_err(),
        "captured expiry must be rechecked under guard"
    );
    source.expires = chrono::Utc::now() + chrono::Duration::hours(1);
    tokio::fs::remove_file(&source.file_path).await.unwrap();
    let external = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(external.path(), b"source").unwrap();
    std::os::unix::fs::symlink(external.path(), &source.file_path).unwrap();
    assert!(
        upload::validate_locked_source(&source).await.is_err(),
        "symlink cannot become audio source"
    );
    drop(source_guard);
    assert!(
        upload::open_completed(&env.device_audio, actor, device, &url)
            .await
            .is_err()
    );
    for (owner, target, reference) in [
        (Uuid::new_v4(), device, url.clone()),
        (actor, Uuid::new_v4(), url.clone()),
        (actor, device, format!("https://example.invalid{url}")),
        (
            actor,
            device,
            url.replace("/api/device/audio/", "/api/sigint/"),
        ),
    ] {
        assert!(upload::open_completed(
            &env.device_audio,
            owner,
            target,
            &reference
        )
        .await
        .is_err());
    }
    tokio::fs::remove_dir_all(
        std::path::PathBuf::from(&env.config.storage_dir)
            .join("device-audio-tus")
            .join(device.to_string()),
    )
    .await
    .unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_completed_source_distinguishes_pending_and_busy() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let actor = Uuid::new_v4();
    let device = Uuid::new_v4();
    let handler = upload::handler(&env.device_audio, device).unwrap();
    let url = completed_upload(&handler, actor).await;
    let (source, source_guard) =
        upload::open_completed(&env.device_audio, actor, device, &url)
            .await
            .unwrap();
    let busy = upload::open_completed(&env.device_audio, actor, device, &url)
        .await
        .map(|_| ());
    super::tests::assert_status(busy, StatusCode::SERVICE_UNAVAILABLE);
    drop(source_guard);
    let pending = source
        .file_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("pending")
        .join(source.file_path.parent().unwrap().file_name().unwrap())
        .join(source.file_path.file_name().unwrap());
    tokio::fs::create_dir_all(pending.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::rename(&source.file_path, &pending)
        .await
        .unwrap();
    tokio::fs::write(&pending, b"so").await.unwrap();
    let incomplete =
        upload::open_completed(&env.device_audio, actor, device, &url)
            .await
            .map(|_| ());
    super::tests::assert_status(incomplete, StatusCode::CONFLICT);
    assert_eq!(
        device_audio::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
    tokio::fs::remove_dir_all(
        std::path::PathBuf::from(&env.config.storage_dir)
            .join("device-audio-tus")
            .join(device.to_string()),
    )
    .await
    .unwrap();
}
