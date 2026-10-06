use super::*;
use crate::devices::audio::types::*;
use futures_util::StreamExt;

async fn accepted(
    env: &crate::types::Env,
    actor: Uuid,
    device: Uuid,
    bytes: web::Bytes,
) -> device_audio::Model {
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        &format!("content-{}", Uuid::new_v4()),
        bytes,
    )
    .await;
    let ReceiveDeviceAudioOutcome::Accepted(response) =
        receive(&env.device_audio, actor, command).await.unwrap()
    else {
        panic!("accepted fixture required")
    };
    device_audio::Entity::find_by_id(
        Uuid::parse_str(&response.audio.id).unwrap(),
    )
    .one(env.device_audio.file_database().unwrap())
    .await
    .unwrap()
    .unwrap()
}

async fn mp3_bytes() -> web::Bytes {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("original.mp3");
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.3",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "2",
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    tokio::fs::read(path).await.unwrap().into()
}

fn command(
    device: Uuid,
    audio: Uuid,
    representation: DeviceAudioRepresentation,
) -> OpenDeviceAudioCommand {
    OpenDeviceAudioCommand {
        device_id: device,
        audio_id: audio,
        representation,
        method: DeviceAudioMethod::Get,
        range: None,
    }
}

async fn body(content: DeviceAudioContent) -> Vec<u8> {
    let mut stream = content.stream;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    bytes
}

#[actix_web::test]
#[serial_test::serial]
async fn audio_content_range_uses_verified_plaintext() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let original = mp3_bytes().await;
    let audio = accepted(&env, actor, device, original.clone()).await;
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
    let url = format!("/api/device/audio/{device}/{}/content", audio.id);
    for (range, expected, partial) in [
        (None, original.to_vec(), false),
        (Some("bytes=0-9"), original[..10].to_vec(), true),
        (Some("bytes=10-19"), original[10..20].to_vec(), true),
        (
            Some("bytes=-7"),
            original[original.len() - 7..].to_vec(),
            true,
        ),
        (Some("bytes=20-"), original[20..].to_vec(), true),
        (Some("bytes=bad"), original.to_vec(), false),
        (Some("bytes=0-1,4-5"), original.to_vec(), false),
    ] {
        for method in [Method::GET, Method::HEAD] {
            let mut req = test::TestRequest::default()
                .method(method.clone())
                .uri(&url)
                .cookie(cookie.clone());
            if let Some(range) = range {
                req = req.insert_header(("Range", range));
            }
            let response = test::call_service(&app, req.to_request()).await;
            assert_eq!(
                response.status(),
                if partial {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                }
            );
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "audio/mpeg"
            );
            assert_eq!(
                response.headers().get("accept-ranges").unwrap(),
                "bytes"
            );
            assert_eq!(
                response
                    .headers()
                    .get("content-length")
                    .unwrap()
                    .to_str()
                    .unwrap(),
                expected.len().to_string()
            );
            assert_eq!(
                response.headers().get("cache-control").unwrap(),
                "private, no-store"
            );
            assert_eq!(
                response.headers().contains_key("content-range"),
                partial
            );
            assert_eq!(
                test::read_body(response).await.as_ref(),
                if method == Method::HEAD {
                    &[][..]
                } else {
                    expected.as_slice()
                }
            );
        }
    }
    for range in ["bytes=999999-", "bytes=-0", "bytes=8-7"] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&url)
                .cookie(cookie.clone())
                .insert_header(("Range", range))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response
                .headers()
                .get("content-range")
                .unwrap()
                .to_str()
                .unwrap(),
            format!("bytes */{}", original.len())
        );
    }
    let corrupt = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        env.s3.as_ref(),
        None,
    );
    corrupt
        .byte_store()
        .unwrap()
        .operator
        .write(&audio.storage_key, "unauthenticated")
        .await
        .unwrap();
    assert!(open_content(
        &corrupt,
        actor,
        command(device, audio.id, DeviceAudioRepresentation::Content)
    )
    .await
    .is_err());
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
async fn audio_cached_content_rechecks_access() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device, native_audio_bytes().await).await;
    let bytes = body(
        open_content(
            &env.device_audio,
            actor,
            command(device, audio.id, DeviceAudioRepresentation::Content),
        )
        .await
        .unwrap(),
    )
    .await;
    assert!(!bytes.is_empty());
    for representation in [
        DeviceAudioRepresentation::Wave,
        DeviceAudioRepresentation::Spectrogram,
    ] {
        let image = body(
            open_content(
                &env.device_audio,
                actor,
                command(device, audio.id, representation),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
    }
    let mut actor_row = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    actor_row.roles = Set(serde_json::json!([]));
    actor_row.update(&env.dbx).await.unwrap();
    for representation in [
        DeviceAudioRepresentation::Content,
        DeviceAudioRepresentation::Wave,
        DeviceAudioRepresentation::Spectrogram,
    ] {
        for method in [DeviceAudioMethod::Get, DeviceAudioMethod::Head] {
            let mut req = command(device, audio.id, representation);
            req.method = method;
            super::super::tests::assert_status(
                open_content(&env.device_audio, actor, req)
                    .await
                    .map(|_| ()),
                StatusCode::FORBIDDEN,
            );
        }
    }
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
async fn audio_cache_cleanup_preserves_live_stream_and_regenerates_expired_entry(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let original = mp3_bytes().await;
    let audio = accepted(&env, actor, device, original.clone()).await;
    let content = open_content(
        &env.device_audio,
        actor,
        command(device, audio.id, DeviceAudioRepresentation::Content),
    )
    .await
    .unwrap();
    let mut directories = tokio::fs::read_dir(
        env.device_audio.storage_dir.join("device-audio-cache"),
    )
    .await
    .unwrap();
    let directory = directories.next_entry().await.unwrap().unwrap().path();
    let used = directory.join("used");
    std::fs::File::open(&used)
        .unwrap()
        .set_modified(
            std::time::SystemTime::now()
                - std::time::Duration::from_secs(25 * 60 * 60),
        )
        .unwrap();
    audio_child(&serde_json::json!({"action":"cleanup"})).await;
    assert!(
        directory.exists(),
        "another worker must not delete an active stream cache"
    );
    assert_eq!(body(content).await, original.as_ref());
    audio_child(&serde_json::json!({"action":"cleanup"})).await;
    assert!(
        directory.exists(),
        "stream completion must refresh the last-use clock"
    );
    std::fs::File::open(&used)
        .unwrap()
        .set_modified(
            std::time::SystemTime::now()
                - std::time::Duration::from_secs(25 * 60 * 60),
        )
        .unwrap();
    audio_child(&serde_json::json!({"action":"cleanup"})).await;
    assert!(
        !directory.exists(),
        "expired inactive cache must be removed"
    );
    assert_eq!(
        body(
            open_content(
                &env.device_audio,
                actor,
                command(device, audio.id, DeviceAudioRepresentation::Content)
            )
            .await
            .unwrap()
        )
        .await,
        original.as_ref()
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
async fn audio_rendition_rechecks_access_after_real_generation() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let audio = accepted(&env, actor, device, native_audio_bytes().await).await;
    let db = env.dbx.clone();
    let hooks = content::ContentHooks {
        before_publication: Some(Arc::new(move || {
            let db = db.clone();
            Box::pin(async move {
                let mut actor_row =
                    crate::entities::login::Entity::find_by_id(actor)
                        .one(&db)
                        .await
                        .unwrap()
                        .unwrap()
                        .into_active_model();
                actor_row.roles = Set(serde_json::json!([]));
                actor_row.update(&db).await.unwrap();
                Ok(())
            })
        })),
    };
    super::super::tests::assert_status(
        content::open_with_hooks(
            env.device_audio.clone(),
            actor,
            command(device, audio.id, DeviceAudioRepresentation::Content),
            hooks,
        )
        .await
        .map(|_| ()),
        StatusCode::FORBIDDEN,
    );
    let mut directories = tokio::fs::read_dir(
        env.device_audio.storage_dir.join("device-audio-cache"),
    )
    .await
    .unwrap();
    let directory = directories.next_entry().await.unwrap().unwrap().path();
    assert!(!directory.join("content.mp3").exists());
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
async fn audio_wav_rendition_preserves_channels_and_original_metadata() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let directory = tempfile::tempdir().unwrap();
    for (layout, expected) in [("mono", 1), ("stereo", 2), ("5.1", 2)] {
        let path = directory.path().join(format!("{layout}.wav"));
        let output = tokio::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("anullsrc=r=44100:cl={layout}"),
                "-t",
                "0.1",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let original = tokio::fs::read(&path).await.unwrap();
        let audio =
            accepted(&env, actor, device, original.clone().into()).await;
        let rendition = body(
            open_content(
                &env.device_audio,
                actor,
                command(device, audio.id, DeviceAudioRepresentation::Content),
            )
            .await
            .unwrap(),
        )
        .await;
        let path = directory.path().join(format!("{layout}.mp3"));
        tokio::fs::write(&path, rendition).await.unwrap();
        let output = tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,sample_rate,channels",
                "-of",
                "json",
            ])
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let metadata: serde_json::Value =
            serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(metadata["streams"][0]["codec_name"], "mp3");
        assert_eq!(metadata["streams"][0]["sample_rate"], "48000");
        assert_eq!(metadata["streams"][0]["channels"], expected);
        let source = storage::verified_content(
            env.device_audio.clone(),
            audio.storage_key.clone(),
            storage::SourceFingerprint {
                size_bytes: original.len() as u64,
                sha256: Sha256::digest(&original).into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(source, original);
        assert_eq!(
            device_audio::Entity::find_by_id(audio.id)
                .one(env.device_audio.file_database().unwrap())
                .await
                .unwrap()
                .unwrap(),
            audio
        );
    }
}
