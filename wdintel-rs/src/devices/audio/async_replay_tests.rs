use super::async_acceptance_tests::phase5_env;
use super::*;
use crate::devices::upload_finalization::{
    self, types::FinalizationKind, worker::ClaimLane,
};
use crate::file_registry::entities::{
    device_upload_finalization_attempt, device_upload_finalization_budget,
};
use crate::types::Env;
use actix_web::http::header::{
    HeaderMap, CACHE_CONTROL, LOCATION, RETRY_AFTER,
};
use serde_json::{json, Value};
use std::time::Duration;

macro_rules! replay_app {
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

macro_rules! replay_cookie {
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

macro_rules! post_receive {
    ($app:expr, $cookie:expr, $request:expr) => {
        test::call_service(
            &$app,
            test::TestRequest::post()
                .uri("/api/device/audio/receive")
                .cookie($cookie.clone())
                .set_json(&$request)
                .to_request(),
        )
    };
}

macro_rules! receive_batch {
    ($app:expr, $cookie:expr, $requests:expr) => {{
        futures_util::future::join_all($requests.into_iter().map(|request| {
            let app = &$app;
            let cookie = $cookie.clone();
            async move {
                let response = test::call_service(
                    app,
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
                let body = serde_json::from_slice::<Value>(&bytes)
                    .unwrap_or_else(|_| {
                        Value::String(
                            String::from_utf8_lossy(&bytes).into_owned(),
                        )
                    });
                (status, headers, body)
            }
        }))
        .await
    }};
}

fn test_env(env: &Env, directory: &tempfile::TempDir) -> Arc<Env> {
    phase5_env(
        env,
        directory.path(),
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    )
}

fn disabled_env(env: &Env) -> Arc<Env> {
    let mut env = env.clone();
    env.config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .enabled = false;
    Arc::new(env)
}

fn async_request(command: &types::ReceiveDeviceAudioCommand) -> Value {
    let mut request = receive_request(command);
    request["async_finalization"] = true.into();
    request
}

async fn job(env: &Env, id: Uuid) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find_by_id(id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn source(
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

async fn finish(env: &Env, id: Uuid) {
    let claim = upload_finalization::worker::claim_due(
        env.device_audio.file_database().unwrap(),
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, id);
    ingest::finalize_claim(env, &env.device_audio, claim)
        .await
        .unwrap();
}

async fn assert_counts(env: &Env, expected: (u64, u64, u64, u64)) {
    let (audio, ingests, jobs) =
        finalization_record_counts(&env.device_audio).await;
    let attempts = device_upload_finalization_attempt::Entity::find()
        .count(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    assert_eq!((audio, ingests, jobs, attempts), expected);
}

async fn assert_budget(env: &Env, actor: Uuid, jobs: i64, bytes: i64) {
    for scope in ["global:audio".to_owned(), format!("actor:{actor}:audio")] {
        let budget =
            device_upload_finalization_budget::Entity::find_by_id(scope)
                .one(env.device_audio.file_database().unwrap())
                .await
                .unwrap();
        assert_eq!(budget.as_ref().map_or(0, |row| row.reserved_jobs), jobs);
        assert_eq!(
            budget.as_ref().map_or(0, |row| row.reserved_source_bytes),
            bytes
        );
        assert_eq!(budget.as_ref().map_or(0, |row| row.unresolved_writes), 0);
    }
}

fn assert_queued(headers: &HeaderMap, body: &Value, id: Uuid) {
    assert_eq!(body, &json!({"status":"queued", "job_id":id}));
    assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
    assert_eq!(headers.get(RETRY_AFTER).unwrap(), "1");
    assert_eq!(
        headers.get(LOCATION).unwrap().to_str().unwrap(),
        format!("/api/device/upload-finalization-jobs/{id}")
    );
}

fn assert_unavailable(headers: &HeaderMap, body: &Value) {
    let seconds: u64 = headers
        .get(RETRY_AFTER)
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=300).contains(&seconds));
    assert!(body.get("job_id").is_none());
    assert!(body.get("audio").is_none());
}

async fn edit_audio(env: &Env, actor: Uuid, audio_id: Uuid) {
    let db = env.device_audio.file_database().unwrap();
    let audio = device_audio::Entity::find_by_id(audio_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        set_processed(
            &env.device_audio,
            actor,
            types::SetDeviceAudioProcessingCommand {
                device_id: audio.device_id,
                audio_id,
                processed: true,
                expected_processing_version: audio.processing_version,
            }
        )
        .await
        .unwrap(),
        types::SetDeviceAudioProcessingOutcome::Saved(_)
    ));
    assert!(matches!(
        save_transcription(
            &env.device_audio,
            actor,
            types::SaveDeviceAudioTranscriptionCommand {
                device_id: audio.device_id,
                audio_id,
                text: "Пізніше відредагована транскрипція".into(),
                expected_text_version: audio.text_version,
            }
        )
        .await
        .unwrap(),
        types::SaveDeviceAudioTranscriptionOutcome::Saved(_)
    ));
    let changed = device_audio::Entity::find_by_id(audio_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert!(changed.processed);
    assert_ne!(changed.processing_version, audio.processing_version);
    assert_eq!(changed.transcription, "Пізніше відредагована транскрипція");
}

#[actix_web::test]
#[serial_test::serial]
#[ignore = "flaky under CI load: a contender gets 503 upload_busy"]
async fn phase6_audio_twenty_concurrent_async_replays_own_one_source() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "twenty repeated commands",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let request = async_request(&command);
    let responses = receive_batch!(app, cookie, vec![request.clone(); 20]);
    let id =
        Uuid::parse_str(responses[0].2["job_id"].as_str().unwrap()).unwrap();
    for (status, headers, body) in responses {
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_queued(&headers, &body, id);
    }
    assert_counts(&env, (0, 0, 1, 0)).await;
    assert_budget(&env, actor, 1, source.upload_length as i64).await;
    let disabled = disabled_env(&env);
    let app = replay_app!(disabled);
    let cookie = replay_cookie!(app, actor);
    for (status, headers, body) in
        receive_batch!(app, cookie, vec![request; 20])
    {
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_queued(&headers, &body, id);
    }
    assert_counts(&env, (0, 0, 1, 0)).await;
    assert_budget(&env, actor, 1, source.upload_length as i64).await;
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .list("")
        .await
        .unwrap()
        .is_empty());
    assert!(source.file_path.is_file());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_replay_normalizes_time_and_rejects_changed_command_or_actor(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let owner = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let other =
        audio_actor(&env.dbx, owner.organism_id.unwrap(), &["Cyber"]).await;
    let another_device =
        audio_device(&env.dbx, &owner, owner.organism_id.unwrap(), false).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        " точна назва ",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let request = async_request(&command);
    let accepted = post_receive!(app, cookie, request).await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body: Value = test::read_body_json(accepted).await;
    let id = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
    let mut equivalent = request.clone();
    equivalent["recording_started_at"] =
        "2026-10-04T02:59:59.950001999+03:00".into();
    equivalent["upload_url"] = format!(
        "/api/device/audio/{device}/uploads/{}.00{}",
        source.file_id.to_string().to_uppercase(),
        source.upload_length
    )
    .into();
    let response = post_receive!(app, cookie, equivalent).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["job_id"], id.to_string());
    for (field, value, expected) in [
        ("name", Value::from("точна назва"), StatusCode::CONFLICT),
        (
            "recording_started_at",
            Value::from("2026-10-03T23:59:59.950002Z"),
            StatusCode::CONFLICT,
        ),
        (
            "device_id",
            Value::from(another_device.id.to_string()),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let mut changed = request.clone();
        changed[field] = value;
        let response = post_receive!(app, cookie, changed).await;
        assert_eq!(response.status(), expected, "{field}");
    }
    let other_cookie = replay_cookie!(app, other.id);
    for payload in [request.clone(), {
        let mut changed = request.clone();
        changed["name"] = "changed by another actor".into();
        changed
    }] {
        let response = post_receive!(app, other_cookie, payload).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let body = String::from_utf8(test::read_body(response).await.to_vec())
            .unwrap();
        assert!(!body.contains(&id.to_string()));
        assert!(!body.contains(&source.file_path.display().to_string()));
    }
    assert_counts(&env, (0, 0, 1, 0)).await;
    assert_budget(&env, actor, 1, source.upload_length as i64).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_completed_replay_is_frozen_after_edits_cleanup_and_disable(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "frozen completed receipt",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let id = super::async_acceptance_tests::phase5_enqueue(
        env.clone(),
        actor,
        &command,
    )
    .await;
    finish(&env, id).await;
    super::super::async_cleanup::cleanup_source(&env.device_audio, id)
        .await
        .unwrap();
    let completed = job(&env, id).await;
    assert_eq!(completed.status, "completed");
    assert!(!source.file_path.exists());
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let response = post_receive!(app, cookie, async_request(&command)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let frozen: Value = test::read_body_json(response).await;
    assert_eq!(frozen["result"]["audio"]["processed"], false);
    let audio_id = completed.audio_id.unwrap();
    edit_audio(&env, actor, audio_id).await;
    let disabled = disabled_env(&env);
    let app = replay_app!(disabled);
    let cookie = replay_cookie!(app, actor);
    for (status, headers, body) in
        receive_batch!(app, cookie, vec![async_request(&command); 20])
    {
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
        assert_eq!(body, frozen);
    }
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!("/api/device/upload-finalization-jobs/{id}"))
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot, frozen);
    let response = post_receive!(app, cookie, receive_request(&command)).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let duplicate: Value = test::read_body_json(response).await;
    assert_eq!(duplicate["details"]["code"], "device_audio_name_conflict");
    assert_eq!(job(&env, id).await, completed);
    assert_counts(&env, (1, 1, 1, 1)).await;
    assert_budget(&env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_failed_replay_after_cleanup_never_retries_or_recharges() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "frozen failure",
        web::Bytes::from_static(b"corrupt audio"),
    )
    .await;
    let source = source(&env, actor, &command).await;
    let id = super::async_acceptance_tests::phase5_enqueue(
        env.clone(),
        actor,
        &command,
    )
    .await;
    finish(&env, id).await;
    super::super::async_cleanup::cleanup_source(&env.device_audio, id)
        .await
        .unwrap();
    let failed = job(&env, id).await;
    assert_eq!(failed.status, "failed");
    assert!(!source.file_path.exists());
    let disabled = disabled_env(&env);
    let app = replay_app!(disabled);
    let cookie = replay_cookie!(app, actor);
    let responses =
        receive_batch!(app, cookie, vec![async_request(&command); 20]);
    let frozen = responses[0].2.clone();
    assert_eq!(frozen["status"], "failed");
    assert_eq!(frozen["job_id"], id.to_string());
    assert_eq!(frozen["error"]["code"], "invalid_audio");
    assert_eq!(frozen["error"]["action"], "new_upload");
    assert!(frozen["result"].is_null());
    assert!(frozen["finished_at"].is_string());
    for (status, headers, body) in responses {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
        assert_eq!(body, frozen);
    }
    let response = post_receive!(app, cookie, receive_request(&command)).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(job(&env, id).await, failed);
    assert_counts(&env, (0, 0, 1, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .list("")
        .await
        .unwrap()
        .is_empty());
}

async fn set_actor_roles(env: &Env, actor: Uuid, roles: Value) {
    let actor = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut actor = actor.into_active_model();
    actor.roles = Set(roles);
    actor.update(&env.dbx).await.unwrap();
}

async fn reject_legacy_command_changes(
    env: &Arc<Env>,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
    source: &crate::sigint::file_upload::tus::TusUpload,
) {
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    for (field, value) in [
        ("name", Value::from("another legacy name")),
        (
            "recording_started_at",
            Value::from("2026-10-03T23:59:59.950002Z"),
        ),
        (
            "upload_url",
            Value::from(format!(
                "/api/device/audio/{}/uploads/{}.{}",
                command.device_id,
                source.file_id,
                source.upload_length + 1
            )),
        ),
    ] {
        let mut changed = async_request(command);
        changed[field] = value;
        let response = post_receive!(app, cookie, changed).await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{field}");
    }
    let owner = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let other =
        audio_actor(&env.dbx, owner.organism_id.unwrap(), &["Cyber"]).await;
    authorize_source(&env.device_audio, other.id, command.device_id)
        .await
        .unwrap();
    let cookie = replay_cookie!(app, other.id);
    let response = post_receive!(app, cookie, async_request(command)).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_counts(env, (1, 1, 0, 0)).await;
    assert_budget(env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_twenty_way_sync_adoption_works_disabled_with_read_access()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "own synchronous audio",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let response = post_receive!(app, cookie, receive_request(&command)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let original: Value = test::read_body_json(response).await;
    let audio_id =
        Uuid::parse_str(original["audio"]["id"].as_str().unwrap()).unwrap();
    assert!(!source.file_path.exists());
    assert_counts(&env, (1, 1, 0, 0)).await;
    reject_legacy_command_changes(&env, actor, &command, &source).await;
    let db = env.device_audio.file_database().unwrap();
    let ingest = query::find_attempt(db, &command.upload_url)
        .await
        .unwrap()
        .unwrap();
    let stored = env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .read(&ingest.storage_key)
        .await
        .unwrap()
        .to_vec();
    set_actor_roles(&env, actor, json!([crate::config::ROLE_CYBER_VIEWER]))
        .await;
    authorize_read(&env.device_audio, actor, device)
        .await
        .unwrap();
    assert!(authorize_source(&env.device_audio, actor, device)
        .await
        .is_err());
    let disabled = disabled_env(&env);
    let app = replay_app!(disabled);
    let cookie = replay_cookie!(app, actor);
    let mut equivalent = async_request(&command);
    equivalent["recording_started_at"] =
        "2026-10-04T02:59:59.950001999+03:00".into();
    equivalent["upload_url"] = format!(
        "/api/device/audio/{device}/uploads/{}.00{}",
        source.file_id.to_string().to_uppercase(),
        source.upload_length
    )
    .into();
    let requests: Vec<_> = (0..20)
        .map(|index| {
            if index % 2 == 0 {
                equivalent.clone()
            } else {
                async_request(&command)
            }
        })
        .collect();
    let responses = receive_batch!(app, cookie, requests);
    assert_eq!(responses[0].0, StatusCode::OK, "{}", responses[0].2);
    let frozen = responses[0].2.clone();
    let id = Uuid::parse_str(frozen["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(frozen["status"], "completed");
    assert_eq!(frozen["result"], original);
    for (status, headers, body) in responses {
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
        assert_eq!(body, frozen);
    }
    let adopted = job(&env, id).await;
    assert_eq!(adopted.audio_id, Some(audio_id));
    assert_eq!(adopted.source_release_state, "released");
    assert_eq!(adopted.attempt_count, 0);
    set_actor_roles(&env, actor, json!(["Cyber"])).await;
    edit_audio(&env, actor, audio_id).await;
    set_actor_roles(&env, actor, json!([crate::config::ROLE_CYBER_VIEWER]))
        .await;
    let cookie = replay_cookie!(app, actor);
    for (status, _, body) in
        receive_batch!(app, cookie, vec![async_request(&command); 20])
    {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, frozen);
    }
    assert_eq!(
        query::find_attempt(db, &command.upload_url)
            .await
            .unwrap()
            .unwrap(),
        ingest
    );
    assert_eq!(
        env.device_audio
            .byte_store()
            .unwrap()
            .operator
            .read(&ingest.storage_key)
            .await
            .unwrap()
            .to_vec(),
        stored
    );
    assert_counts(&env, (1, 1, 1, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_adopting_ready_ingest_preserves_legacy_source_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let (attempt, media, source) =
        stored_attempt(&env, actor, device, "retained own ready").await;
    assert!(matches!(
        query::publish(&env.device_audio, &attempt, &media)
            .await
            .unwrap(),
        types::ReceiveDeviceAudioOutcome::Accepted(_)
    ));
    let db = env.device_audio.file_database().unwrap();
    let ready = query::locked_attempt(db, attempt.id).await.unwrap();
    assert_eq!(ready.status, "ready");
    assert!(ready.source_consumed_at.is_none());
    assert!(source.file_path.is_file());
    let command = types::ReceiveDeviceAudioCommand {
        device_id: device,
        upload_url: ready.tus_upload_ref.clone(),
        name: ready.name.clone(),
        recording_started_at: ready
            .recording_started_at
            .with_timezone(&chrono::Utc),
    };
    let disabled = disabled_env(&env);
    let app = replay_app!(disabled);
    let cookie = replay_cookie!(app, actor);
    let response = post_receive!(app, cookie, async_request(&command)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let receipt: Value = test::read_body_json(response).await;
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["result"]["audio"]["id"], ready.audio_id.to_string());
    assert_eq!(receipt["result"]["audio"]["name"], "retained own ready");
    assert_eq!(receipt["result"]["audio"]["duration_seconds"], 0.1);
    assert_budget(&env, actor, 0, 0).await;
    cleanup_once(&env.device_audio).await.unwrap();
    assert!(!source.file_path.exists());
    let cleaned = query::locked_attempt(db, attempt.id).await.unwrap();
    assert_eq!(cleaned.status, "ready");
    assert!(cleaned.source_consumed_at.is_some());
    assert!(env
        .device_audio
        .byte_store()
        .unwrap()
        .operator
        .exists(&ready.storage_key)
        .await
        .unwrap());
    let response = post_receive!(app, cookie, async_request(&command)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let replay: Value = test::read_body_json(response).await;
    assert_eq!(replay, receipt);
    assert_counts(&env, (1, 1, 1, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_matching_name_from_another_upload_is_not_adopted() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let original = receive_command(
        &env.device_audio,
        actor,
        device,
        "same name different source",
        bytes.clone(),
    )
    .await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let response = post_receive!(app, cookie, receive_request(&original)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let receipt: Value = test::read_body_json(response).await;
    let original_id =
        Uuid::parse_str(receipt["audio"]["id"].as_str().unwrap()).unwrap();
    let another = receive_command(
        &env.device_audio,
        actor,
        device,
        "same name different source",
        bytes,
    )
    .await;
    let response = post_receive!(app, cookie, async_request(&another)).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = test::read_body_json(response).await;
    let id = Uuid::parse_str(accepted["job_id"].as_str().unwrap()).unwrap();
    let accepted = job(&env, id).await;
    assert_eq!(accepted.status, "queued");
    assert!(accepted.result.is_none());
    assert_ne!(accepted.audio_id, Some(original_id));
    finish(&env, id).await;
    let failed = job(&env, id).await;
    assert_eq!(failed.status, "failed");
    assert_eq!(
        failed.error_code.as_deref(),
        Some("device_audio_name_conflict")
    );
    assert!(failed.result.is_none());
    let response = post_receive!(app, cookie, async_request(&another)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let replay: Value = test::read_body_json(response).await;
    assert_eq!(replay["status"], "failed");
    assert!(replay["result"].is_null());
    assert_counts(&env, (1, 1, 1, 1)).await;
    let audio = device_audio::Entity::find()
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(audio.id, original_id);
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_legacy_nonready_deleting_and_unknown_owners_block_admission(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let db = env.device_audio.file_database().unwrap();
    for state in [
        "finalizing",
        "storing",
        "deleting",
        "publication_outcome_unknown",
    ] {
        let (attempt, source) = if state == "finalizing" {
            let command = receive_command(
                &env.device_audio,
                actor,
                device,
                state,
                native_audio_bytes().await,
            )
            .await;
            let source = source(&env, actor, &command).await;
            let attempt = query::new_attempt(actor, &command, &source)
                .insert(db)
                .await
                .unwrap();
            (attempt, source)
        } else {
            let (attempt, _, source) =
                stored_attempt(&env, actor, device, state).await;
            (query::locked_attempt(db, attempt.id).await.unwrap(), source)
        };
        let attempt = if state == "deleting" {
            query::mark_deleting(db, attempt, "legacy cleanup owns the source")
                .await
                .unwrap()
        } else if state == "publication_outcome_unknown" {
            let mut attempt = attempt.into_active_model();
            attempt.last_error =
                Set(Some("publication_outcome_unknown".into()));
            attempt.update(db).await.unwrap()
        } else {
            attempt
        };
        let command = types::ReceiveDeviceAudioCommand {
            device_id: device,
            upload_url: attempt.tus_upload_ref.clone(),
            name: attempt.name.clone(),
            recording_started_at: attempt
                .recording_started_at
                .with_timezone(&chrono::Utc),
        };
        for (status, headers, body) in
            receive_batch!(app, cookie, vec![async_request(&command); 20])
        {
            assert_eq!(
                status,
                StatusCode::SERVICE_UNAVAILABLE,
                "{state}: {body}"
            );
            assert_unavailable(&headers, &body);
        }
        assert_eq!(
            query::locked_attempt(db, attempt.id).await.unwrap(),
            attempt
        );
        assert!(source.file_path.is_file());
    }
    assert_counts(&env, (0, 4, 0, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_twenty_mixed_replays_keep_sync_503_and_async_202() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "mixed requests",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let id = super::async_acceptance_tests::phase5_enqueue(
        env.clone(),
        actor,
        &command,
    )
    .await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let requests: Vec<_> = (0..20)
        .map(|index| {
            let mut request = receive_request(&command);
            if index % 2 == 0 {
                request["async_finalization"] = true.into();
            } else if index % 4 == 1 {
                request["async_finalization"] = false.into();
            }
            request
        })
        .collect();
    for (index, (status, headers, body)) in
        receive_batch!(app, cookie, requests)
            .into_iter()
            .enumerate()
    {
        if index % 2 == 0 {
            assert_eq!(status, StatusCode::ACCEPTED);
            assert_queued(&headers, &body, id);
        } else {
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_unavailable(&headers, &body);
        }
    }
    assert_counts(&env, (0, 0, 1, 0)).await;
    assert_budget(&env, actor, 1, source.upload_length as i64).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_busy_sync_owner_blocks_async_then_adopts_original_publication(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "busy synchronous owner",
        native_audio_bytes().await,
    )
    .await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let hooks = ingest::IngestHooks {
        before_put: Some(Arc::new({
            let entered = entered.clone();
            let release = release.clone();
            move || {
                let entered = entered.clone();
                let release = release.clone();
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(())
                })
            }
        })),
        ..Default::default()
    };
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let synchronous = async {
        let result = ingest::receive_with_hooks(
            env.device_audio.clone(),
            actor,
            command.clone(),
            hooks,
        )
        .await;
        entered.notify_one();
        result
    };
    let asynchronous = async {
        entered.notified().await;
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            post_receive!(app, cookie, async_request(&command)),
        )
        .await;
        release.notify_one();
        response
    };
    let (synchronous, asynchronous) = tokio::join!(synchronous, asynchronous);
    let types::ReceiveDeviceAudioOutcome::Accepted(published) =
        synchronous.unwrap()
    else {
        panic!("sync owner must finish publishing")
    };
    let response = asynchronous
        .expect("async admission blocked behind synchronous heavy work");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key(RETRY_AFTER));
    assert_counts(&env, (1, 1, 0, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
    let response = post_receive!(app, cookie, async_request(&command)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let adopted: Value = test::read_body_json(response).await;
    assert_eq!(adopted["status"], "completed");
    assert_eq!(adopted["result"]["audio"]["id"], published.audio.id);
    assert_counts(&env, (1, 1, 1, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_audio_sync_url_errors_keep_legacy_contract() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = test_env(&env, &directory);
    let (actor, device) = enabled_audio_device(&env).await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "legacy synchronous URL contract",
        native_audio_bytes().await,
    )
    .await;
    let source = source(&env, actor, &command).await;
    let app = replay_app!(env);
    let cookie = replay_cookie!(app, actor);
    let response = post_receive!(app, cookie, receive_request(&command)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(!source.file_path.exists());
    assert_counts(&env, (1, 1, 0, 0)).await;
    for explicit_false in [false, true] {
        let mut request = receive_request(&command);
        if explicit_false {
            request["async_finalization"] = false.into();
        }
        for (case, upload_url) in [
            (
                "wrong size",
                format!(
                    "/api/device/audio/{device}/uploads/{}.{}",
                    source.file_id,
                    source.upload_length + 1
                ),
            ),
            (
                "zero-padded length",
                format!(
                    "/api/device/audio/{device}/uploads/{}.00{}",
                    source.file_id, source.upload_length
                ),
            ),
            (
                "uppercase UUID and zero-padded length",
                format!(
                    "/api/device/audio/{device}/uploads/{}.00{}",
                    source.file_id.to_string().to_uppercase(),
                    source.upload_length
                ),
            ),
        ] {
            let mut changed = request.clone();
            changed["upload_url"] = upload_url.into();
            let response = post_receive!(app, cookie, changed).await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{case}, explicit false={explicit_false}"
            );
        }
        let response = post_receive!(app, cookie, request).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let duplicate: Value = test::read_body_json(response).await;
        assert_eq!(duplicate["details"]["code"], "device_audio_name_conflict");
    }
    assert_counts(&env, (1, 1, 0, 0)).await;
    assert_budget(&env, actor, 0, 0).await;
}
