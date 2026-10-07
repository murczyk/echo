use super::super::types::*;
use super::*;

fn request(
    audio: &device_audio::Model,
    target: bool,
    version: Uuid,
) -> serde_json::Value {
    serde_json::json!({"device_id":audio.device_id,"audio_id":audio.id,"processed":target,"expected_processing_version":version})
}

fn command(
    audio: &device_audio::Model,
    target: bool,
    version: Uuid,
) -> SetDeviceAudioProcessingCommand {
    SetDeviceAudioProcessingCommand {
        device_id: audio.device_id,
        audio_id: audio.id,
        processed: target,
        expected_processing_version: version,
    }
}

async fn traverse(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    device: Uuid,
    filtered: bool,
) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = list(
            runtime,
            actor,
            ListDeviceAudioCommand {
                device_id: device,
                unprocessed_only: filtered,
                limit: 50,
                cursor,
            },
        )
        .await
        .unwrap();
        ids.extend(page.audio.into_iter().map(|row| row.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        ids.len(),
        ids.iter().collect::<std::collections::HashSet<_>>().len()
    );
    ids
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_text_and_status_writes_do_not_conflict_for_every_reader() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let db = env.device_audio.file_database().unwrap();
    let mut rows = Vec::new();
    for index in 0..100 {
        let mut receive_request = receive_command(
            &env.device_audio,
            actor,
            device,
            &format!("status-{index}"),
            bytes.clone(),
        )
        .await;
        receive_request.recording_started_at +=
            chrono::Duration::seconds(index);
        let ReceiveDeviceAudioOutcome::Accepted(response) =
            receive(&env.device_audio, actor, receive_request)
                .await
                .unwrap()
        else {
            panic!("accepted audio required")
        };
        let mut row = device_audio::Entity::find_by_id(
            Uuid::parse_str(&response.audio.id).unwrap(),
        )
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
        row.processed = Set(index < 40);
        rows.push(row.update(db).await.unwrap());
    }
    let runtime = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        None,
    );
    let actor_row = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let expected: Vec<_> =
        rows.iter().rev().map(|row| row.id.to_string()).collect();
    let mut selected = rows[99].clone();
    for role in ["Cyber", "Admin"] {
        let reader =
            audio_actor(&env.dbx, actor_row.organism_id.unwrap(), &[role])
                .await;
        assert_eq!(
            traverse(&runtime, reader.id, device, false).await,
            expected
        );
        assert_eq!(
            traverse(&runtime, reader.id, device, true).await,
            expected[..60]
        );
        let before = selected.clone();
        let (text, status) = tokio::join!(
            save_transcription(
                &runtime,
                actor,
                SaveDeviceAudioTranscriptionCommand {
                    device_id: device,
                    audio_id: selected.id,
                    text: role.into(),
                    expected_text_version: selected.text_version
                }
            ),
            set_processed(
                &runtime,
                reader.id,
                command(&selected, true, selected.processing_version)
            )
        );
        let SaveDeviceAudioTranscriptionOutcome::Saved(text) = text.unwrap()
        else {
            panic!("independent text write must succeed")
        };
        assert!(matches!(
            status.unwrap(),
            SetDeviceAudioProcessingOutcome::Saved(_)
        ));
        selected = device_audio::Entity::find_by_id(selected.id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selected.transcription, role);
        assert!(selected.processed);
        assert_ne!(selected.text_version, before.text_version);
        assert_eq!(
            selected.text_version.to_string(),
            text.transcription.text_version
        );
        assert_ne!(selected.processing_version, before.processing_version);
        let mut preserved = before;
        preserved.transcription = role.into();
        preserved.text_version = selected.text_version;
        preserved.processed = true;
        preserved.processing_version = selected.processing_version;
        assert_eq!(selected, preserved);
        assert_eq!(
            traverse(&runtime, reader.id, device, true).await,
            expected[1..60]
        );
        assert_eq!(
            traverse(&runtime, reader.id, device, false).await,
            expected
        );
        let text_version = selected.text_version;
        assert!(matches!(
            set_processed(
                &runtime,
                reader.id,
                command(&selected, false, selected.processing_version)
            )
            .await
            .unwrap(),
            SetDeviceAudioProcessingOutcome::Saved(_)
        ));
        selected = device_audio::Entity::find_by_id(selected.id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selected.text_version, text_version);
        assert_eq!(selected.transcription, role);
        assert_eq!(
            traverse(&runtime, reader.id, device, true).await,
            expected[..60]
        );
        assert_eq!(
            traverse(&runtime, reader.id, device, false).await,
            expected
        );
    }
    let basic =
        audio_actor(&env.dbx, actor_row.organism_id.unwrap(), &["Basic"]).await;
    super::super::tests::assert_status(
        set_processed(
            &runtime,
            basic.id,
            command(&selected, true, selected.processing_version),
        )
        .await
        .map(|_| ()),
        StatusCode::FORBIDDEN,
    );
    let foreign_org = audio_organism(&env.dbx, None).await;
    let foreign = audio_actor(&env.dbx, foreign_org.id, &["Admin"]).await;
    super::super::tests::assert_status(
        set_processed(
            &runtime,
            foreign.id,
            command(&selected, true, selected.processing_version),
        )
        .await
        .map(|_| ()),
        StatusCode::NOT_FOUND,
    );
    let mut archived = crate::entities::device::Entity::find_by_id(device)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    archived.update(&env.dbx).await.unwrap();
    for target in [true, false] {
        super::super::tests::assert_status(
            set_processed(
                &runtime,
                actor,
                command(&selected, target, selected.processing_version),
            )
            .await
            .map(|_| ()),
            StatusCode::FORBIDDEN,
        );
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_processing_rechecks_access_after_waiting_for_row_lock() {
    use sea_orm::sea_query::LockType;
    use sea_orm::{
        ConnectionTrait, DatabaseBackend, FromQueryResult, QuerySelect,
        Statement, TransactionTrait,
    };
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = super::text_tests::accepted_audio(&env, actor, device).await;
    let db = env.device_audio.file_database().unwrap();
    let transaction = db.begin().await.unwrap();
    device_audio::Entity::find_by_id(audio.id)
        .lock(LockType::Update)
        .one(&transaction)
        .await
        .unwrap();
    let runtime = env.device_audio.clone();
    let request = command(&audio, true, audio.processing_version);
    let pending =
        tokio::spawn(
            async move { set_processed(&runtime, actor, request).await },
        );
    #[derive(FromQueryResult)]
    struct Waiting {
        waiting: bool,
    }
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let row = db.query_one_raw(Statement::from_string(DatabaseBackend::Postgres,
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%device_audio%' AND pid<>pg_backend_pid()) AS waiting".to_string())).await.unwrap().unwrap();
        if Waiting::from_query_result(&row, "").unwrap().waiting {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "status must reach actual blocked row lock"
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
            .one(db)
            .await
            .unwrap()
            .unwrap(),
        audio
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_processing_target_is_noop_or_version_checked() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = super::text_tests::accepted_audio(&env, actor, device).await;
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
    let logged = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{actor}"))
            .to_request(),
    )
    .await;
    let cookie = logged.response().cookies().next().unwrap().into_owned();
    let mut version = audio.processing_version;
    for (target, token, expected) in [
        (false, Uuid::new_v4(), StatusCode::OK),
        (true, version, StatusCode::OK),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/audio/processing/set")
                .cookie(cookie.clone())
                .set_json(request(&audio, target, token))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), expected);
        let saved: SetDeviceAudioProcessingRsp =
            test::read_body_json(response).await;
        assert_eq!(saved.processed, target);
        let next = Uuid::parse_str(&saved.processing_version).unwrap();
        if target {
            assert_ne!(next, version);
        } else {
            assert_eq!(next, version);
        }
        version = next;
    }
    // A lost acknowledgment and an explicit retry do not invert the target.
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/processing/set")
            .cookie(cookie.clone())
            .set_json(request(&audio, true, audio.processing_version))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let unchanged: SetDeviceAudioProcessingRsp =
        test::read_body_json(response).await;
    assert_eq!(unchanged.processing_version, version.to_string());
    for _ in 0..2 {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/audio/processing/set")
                .cookie(cookie.clone())
                .set_json(request(&audio, false, audio.processing_version))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let conflict: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(
            conflict["details"]["code"],
            "device_audio_processing_conflict"
        );
        assert_eq!(conflict["details"]["current"]["processed"], true);
        assert_eq!(
            conflict["details"]["current"]["processing_version"],
            version.to_string()
        );
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/processing/set")
            .cookie(cookie.clone())
            .set_json(request(&audio, false, version))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let reverted: SetDeviceAudioProcessingRsp =
        test::read_body_json(response).await;
    let reverted_version =
        Uuid::parse_str(&reverted.processing_version).unwrap();
    assert_ne!(reverted_version, audio.processing_version);
    // ABA: false -> true -> false does not revive the original token.
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/audio/processing/set")
            .cookie(cookie)
            .set_json(request(&audio, true, audio.processing_version))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let current = device_audio::Entity::find_by_id(audio.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap();
    let mut expected = audio;
    expected.processing_version = reverted_version;
    assert_eq!(current, expected);
}
