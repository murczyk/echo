use super::super::types::*;
use super::*;

pub(super) async fn accepted_audio(
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
    let ReceiveDeviceAudioOutcome::Accepted(response) =
        receive(&env.device_audio, actor, command).await.unwrap()
    else {
        panic!("accepted audio required")
    };
    device_audio::Entity::find_by_id(
        Uuid::parse_str(&response.audio.id).unwrap(),
    )
    .one(env.device_audio.file_database().unwrap())
    .await
    .unwrap()
    .unwrap()
}

fn save_request(
    audio: &device_audio::Model,
    text: &str,
    version: Uuid,
) -> serde_json::Value {
    serde_json::json!({"device_id":audio.device_id,"audio_id":audio.id,"text":text,"expected_text_version":version})
}

fn command(
    audio: &device_audio::Model,
    text: &str,
    version: Uuid,
) -> SaveDeviceAudioTranscriptionCommand {
    SaveDeviceAudioTranscriptionCommand {
        device_id: audio.device_id,
        audio_id: audio.id,
        text: text.into(),
        expected_text_version: version,
    }
}

fn saved_version(outcome: SaveDeviceAudioTranscriptionOutcome) -> Uuid {
    let SaveDeviceAudioTranscriptionOutcome::Saved(response) = outcome else {
        panic!("saved result required")
    };
    Uuid::parse_str(&response.transcription.text_version).unwrap()
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_text_detects_aba_concurrent_and_repeated_conflict_without_storage(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let mut audio = accepted_audio(&env, actor, device).await;
    let actor_row = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let editor =
        audio_actor(&env.dbx, actor_row.organism_id.unwrap(), &["Cyber"]).await;
    let runtime = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        None,
    );
    let mut processed = audio.clone().into_active_model();
    processed.processed = Set(true);
    audio = processed
        .update(runtime.file_database().unwrap())
        .await
        .unwrap();
    let original = audio.clone();
    let a = saved_version(
        save_transcription(
            &runtime,
            editor.id,
            command(&audio, "A", audio.text_version),
        )
        .await
        .unwrap(),
    );
    let b = saved_version(
        save_transcription(&runtime, actor, command(&audio, "B", a))
            .await
            .unwrap(),
    );
    let latest = saved_version(
        save_transcription(&runtime, editor.id, command(&audio, "A", b))
            .await
            .unwrap(),
    );
    let SaveDeviceAudioTranscriptionOutcome::Conflict { current, .. } =
        save_transcription(&runtime, actor, command(&audio, "A", a))
            .await
            .unwrap()
    else {
        panic!("stale same-text token must conflict")
    };
    assert_eq!(current.text, "A");
    assert_eq!(current.text_version, latest.to_string());
    let (first, second) = tokio::join!(
        save_transcription(&runtime, actor, command(&audio, "first", latest)),
        save_transcription(
            &runtime,
            editor.id,
            command(&audio, "second", latest)
        )
    );
    let results = [first.unwrap(), second.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                SaveDeviceAudioTranscriptionOutcome::Saved(_)
            ))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                SaveDeviceAudioTranscriptionOutcome::Conflict { .. }
            ))
            .count(),
        1
    );
    let current = detail(
        &runtime,
        actor,
        DeviceAudioDetailCommand {
            device_id: device,
            audio_id: audio.id,
        },
    )
    .await
    .unwrap();
    let v = Uuid::parse_str(&current.transcription.text_version).unwrap();
    let _lost_ack = save_transcription(
        &runtime,
        editor.id,
        command(&audio, "confirmed by reread", v),
    )
    .await
    .unwrap();
    let reread = detail(
        &runtime,
        actor,
        DeviceAudioDetailCommand {
            device_id: device,
            audio_id: audio.id,
        },
    )
    .await
    .unwrap();
    assert_eq!(reread.transcription.text, "confirmed by reread");
    assert_ne!(reread.transcription.text_version, v.to_string());
    let current = device_audio::Entity::find_by_id(audio.id)
        .one(runtime.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    let mut expected = original;
    expected.transcription = current.transcription.clone();
    expected.text_version = current.text_version;
    assert_eq!(current, expected);
    let basic =
        audio_actor(&env.dbx, actor_row.organism_id.unwrap(), &["Basic"]).await;
    let foreign_org = audio_organism(&env.dbx, None).await;
    let foreign = audio_actor(&env.dbx, foreign_org.id, &["Admin"]).await;
    for (reader, status) in [
        (basic.id, StatusCode::FORBIDDEN),
        (foreign.id, StatusCode::NOT_FOUND),
    ] {
        super::super::tests::assert_status(
            save_transcription(
                &runtime,
                reader,
                command(&audio, "denied", current.text_version),
            )
            .await
            .map(|_| ()),
            status,
        );
    }
    let mut archived = crate::entities::device::Entity::find_by_id(device)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    archived.update(&env.dbx).await.unwrap();
    super::super::tests::assert_status(
        save_transcription(
            &runtime,
            editor.id,
            command(&audio, "archived", current.text_version),
        )
        .await
        .map(|_| ()),
        StatusCode::FORBIDDEN,
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_text_rechecks_access_after_waiting_for_row_lock() {
    use sea_orm::sea_query::LockType;
    use sea_orm::{
        ConnectionTrait, DatabaseBackend, FromQueryResult, QuerySelect,
        Statement, TransactionTrait,
    };
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted_audio(&env, actor, device).await;
    let transaction = env
        .device_audio
        .file_database()
        .unwrap()
        .begin()
        .await
        .unwrap();
    device_audio::Entity::find_by_id(audio.id)
        .lock(LockType::Update)
        .one(&transaction)
        .await
        .unwrap();
    let runtime = env.device_audio.clone();
    let request = command(&audio, "must not commit", audio.text_version);
    let pending = tokio::spawn(async move {
        save_transcription(&runtime, actor, request).await
    });
    #[derive(FromQueryResult)]
    struct Waiting {
        waiting: bool,
    }
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let result = env.device_audio.file_database().unwrap().query_one_raw(Statement::from_string(DatabaseBackend::Postgres,
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%device_audio%' AND pid<>pg_backend_pid()) AS waiting".to_string())).await.unwrap().unwrap();
        if Waiting::from_query_result(&result, "").unwrap().waiting {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "save must reach actual blocked row lock"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let mut actor_row = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    actor_row.roles = Set(serde_json::json!([]));
    actor_row.update(&env.dbx).await.unwrap();
    transaction.commit().await.unwrap();
    super::super::tests::assert_status(
        pending.await.unwrap().map(|_| ()),
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        device_audio::Entity::find_by_id(audio.id)
            .one(env.device_audio.file_database().unwrap())
            .await
            .unwrap()
            .unwrap(),
        audio
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_text_cas_preserves_literal_data_and_other_fields() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted_audio(&env, actor, device).await;
    let other = accepted_audio(&env, actor, device).await;
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .app_data(web::JsonConfig::default().limit(20 * 1024 * 1024))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{actor}", web::post().to(login))
            .service(routes()),
    )
    .await;
    let logged = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{actor}"))
            .to_request(),
    )
    .await;
    let cookie = logged.response().cookies().next().unwrap().into_owned();
    let mut version = audio.text_version;
    for text in [
        "  Українська 🦆\r\n<script>alert(1)</script>\n**буквально**  "
            .to_string(),
        "".into(),
        " \n".into(),
        "Л".repeat(11 * 1024 * 1024),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/audio/transcription/save")
                .cookie(cookie.clone())
                .set_json(save_request(&audio, &text, version))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let saved: SaveDeviceAudioTranscriptionRsp =
            test::read_body_json(response).await;
        assert_eq!(saved.audio_id, audio.id.to_string());
        assert_eq!(saved.transcription.text, text);
        let next = Uuid::parse_str(&saved.transcription.text_version).unwrap();
        assert_ne!(next, version);
        version = next;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/audio/transcription/save")
                .cookie(cookie.clone())
                .set_json(save_request(&audio, &text, version))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let unchanged: SaveDeviceAudioTranscriptionRsp =
            test::read_body_json(response).await;
        assert_eq!(unchanged.transcription.text_version, version.to_string());
        let current = device_audio::Entity::find_by_id(audio.id)
            .one(env.device_audio.file_database().unwrap())
            .await
            .unwrap()
            .unwrap();
        let mut expected = audio.clone();
        expected.transcription = text;
        expected.text_version = version;
        assert_eq!(current, expected);
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/detail")
            .cookie(cookie.clone())
            .set_json(save_request(
                &audio,
                &"x".repeat(21 * 1024 * 1024),
                version,
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/transcription/save")
            .cookie(cookie.clone())
            .set_json(save_request(&audio, "stale", audio.text_version))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let conflict: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(conflict["details"]["code"], "device_audio_text_conflict");
    assert_eq!(
        conflict["details"]["current"]["text_version"],
        version.to_string()
    );
    let current_other = device_audio::Entity::find_by_id(other.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current_other, other);
}
