use super::worker::recover_original;
use super::*;
use crate::config::{MessengerMediaCacheConfig, S3Config};
use crate::types::Mode;
use actix_web::{
    http::{header, StatusCode},
    test::TestRequest,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter,
    Set,
};
use serial_test::serial;
use uuid::Uuid;

fn config(directory: &Path) -> Config {
    let mut config = crate::config::read_config(Mode::Test).unwrap();
    config.storage_dir = directory.display().to_string();
    config.s3_config = Some(S3Config {
        s3_endpoint: "https://storage.invalid".to_string(),
        s3_region: "test".to_string(),
        s3_bucket: "media-test".to_string(),
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        strongbox_key: String::new(),
    });
    config.messenger_media_cache = Some(MessengerMediaCacheConfig {
        enabled: true,
        min_free_space_bytes: 0,
        ..Default::default()
    });
    config
}

fn media(key: &str, size: i64) -> signal_message_media::Model {
    signal_message_media::Model {
        id: Uuid::now_v7(),
        signal_message_id: 0,
        signal_message_uuid: None,
        content_type: "video/mp4".to_string(),
        file_ext: Some("mp4".to_string()),
        file_name: Some("original.mp4".to_string()),
        size_bytes: size,
        created_at: Utc::now().naive_utc(),
        is_encrypted: false,
        storage_key: Some(key.to_string()),
    }
}

#[tokio::test]
async fn concurrent_reservations_preserve_protected_originals() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = config(directory.path());
    config
        .messenger_media_cache
        .as_mut()
        .unwrap()
        .max_total_size_bytes = 10;
    let source = directory.path().join("source");
    fs::write(&source, b"ready").await.unwrap();
    stage_upload(&config, "protected", 5, false, &source, false)
        .await
        .unwrap();
    let protected = media("protected", 5);
    pin_media(&config, &protected, Utc::now().timestamp())
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        stage_upload(&config, "first", 5, false, &source, false),
        stage_upload(&config, "second", 5, false, &source, false),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    files::cleanup(&config).await.unwrap();
    let path = ready_original(&config, &protected).await.unwrap().unwrap();
    assert_eq!(fs::read(path).await.unwrap(), b"ready");
}

#[tokio::test]
async fn disk_floor_and_changed_sources_leave_no_ready_partial_object() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = config(directory.path());
    let source = directory.path().join("source");
    fs::write(&source, b"ready").await.unwrap();
    assert!(stage_upload(&config, "changed", 6, false, &source, false)
        .await
        .is_err());
    assert!(ready_original(&config, &media("changed", 6))
        .await
        .unwrap()
        .is_none());
    config
        .messenger_media_cache
        .as_mut()
        .unwrap()
        .min_free_space_bytes = u64::MAX;
    stage_upload_best_effort(&config, "floor", 5, false, &source, false).await;
    assert!(ready_original(&config, &media("floor", 5))
        .await
        .unwrap()
        .is_none());
    assert_eq!(fs::read(source).await.unwrap(), b"ready");
}

#[tokio::test]
#[serial]
async fn recovery_preserves_a_newer_publication_pin() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let mut env = env.as_ref().clone();
    let directory = tempfile::tempdir().unwrap();
    env.config = config(directory.path());
    enable_cache(&env).await;
    let storage =
        crate::storage::S3Config::from(env.config.s3_config.as_ref().unwrap());
    let operator = opendal::Operator::new(opendal::services::Memory::default())
        .unwrap()
        .finish();
    operator
        .write(&storage.prefixed_key("recovery"), b"ready".as_slice())
        .await
        .unwrap();
    env.s3 = Some(operator);
    env.s3_config = Some(storage);
    let source = directory.path().join("source");
    fs::write(&source, b"ready").await.unwrap();
    stage_upload(&env.config, "recovery", 5, false, &source, false)
        .await
        .unwrap();
    let media = media("recovery", 5);
    pin_media(&env.config, &media, Utc::now().timestamp() + 60)
        .await
        .unwrap();
    let entry = entry(&env.config, &media).unwrap();
    let retain_until = entry.metadata().await.unwrap().unwrap().retain_until;
    fs::remove_file(entry.path("original")).await.unwrap();
    env.config
        .messenger_media_cache
        .as_mut()
        .unwrap()
        .max_total_size_bytes = 10;
    fs::write(entry.path("reservation"), 10u64.to_le_bytes())
        .await
        .unwrap();
    fs::write(entry.path("original.tmp"), b"partial")
        .await
        .unwrap();
    recover_original(&env, &media, Utc::now().timestamp() - 3600)
        .await
        .unwrap();
    assert_eq!(
        entry.metadata().await.unwrap().unwrap().retain_until,
        retain_until
    );
    assert_eq!(
        fs::read(entry.ready(false).await.unwrap().unwrap())
            .await
            .unwrap(),
        b"ready"
    );
}

#[tokio::test]
async fn restart_cleanup_preserves_committed_pins_and_removes_abandoned_staging(
) {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let source = directory.path().join("source");
    fs::write(&source, b"ready").await.unwrap();
    for key in ["committed", "abandoned"] {
        stage_upload(&config, key, 5, false, &source, false)
            .await
            .unwrap();
    }
    let committed = media("committed", 5);
    pin_media(&config, &committed, Utc::now().timestamp())
        .await
        .unwrap();
    let abandoned = entry(&config, &media("abandoned", 5)).unwrap();
    let mut metadata = abandoned.metadata().await.unwrap().unwrap();
    metadata.staged_at -=
        crate::config::MESSENGER_MEDIA_LOCAL_CACHE_ORPHAN_TTL_SECS + 1;
    abandoned.write_metadata(&metadata).await.unwrap();
    let restarted = config.clone();
    files::cleanup(&restarted).await.unwrap();
    assert!(ready_original(&restarted, &committed)
        .await
        .unwrap()
        .is_some());
    assert!(abandoned.ready(false).await.unwrap().is_none());
    discard_upload_best_effort(&config, "committed", 5, false).await;
    assert!(ready_original(&config, &committed).await.unwrap().is_some());
}

#[actix_web::test]
#[serial]
async fn copied_references_extend_retention_and_serve_ranges_during_origin_outage(
) {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let mut env = env.as_ref().clone();
    let directory = tempfile::tempdir().unwrap();
    env.config = config(directory.path());
    enable_cache(&env).await;
    env.s3 = None;
    env.s3_config = None;
    let message =
        crate::functest::tests::mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
    let source = directory.path().join("source");
    fs::write(&source, b"original bytes").await.unwrap();
    let mut original = media("shared", 14).into_active_model();
    original.signal_message_id = Set(message.id);
    original.is_encrypted = Set(true);
    let original = original.insert(&env.dbx).await.unwrap();
    stage_upload(&env.config, "shared", 14, true, &source, false)
        .await
        .unwrap();
    pin_media(&env.config, &original, Utc::now().timestamp())
        .await
        .unwrap();
    let entry = entry(&env.config, &original).unwrap();
    let before = entry.metadata().await.unwrap().unwrap().retain_until;
    let copy_message =
        crate::functest::tests::mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
    crate::sigint::direct_submit::query::copy_signal_message_media(
        &env,
        &env.dbx,
        copy_message.id,
        copy_message.id_uuid,
        std::slice::from_ref(&original),
    )
    .await
    .unwrap();
    let copied = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(copy_message.id),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    pin_media(&env.config, &copied, Utc::now().timestamp() + 60)
        .await
        .unwrap();
    assert_eq!(entry.id, super::entry(&env.config, &copied).unwrap().id);
    assert!(
        entry.metadata().await.unwrap().unwrap().retain_until >= before + 60
    );
    for (range, status, expected) in [
        (
            Some("bytes=0-0"),
            StatusCode::PARTIAL_CONTENT,
            b"o".as_slice(),
        ),
        (
            Some("bytes=-5"),
            StatusCode::PARTIAL_CONTENT,
            b"bytes".as_slice(),
        ),
        (None, StatusCode::OK, b"original bytes".as_slice()),
    ] {
        let mut request = TestRequest::default();
        if let Some(range) = range {
            request = request.insert_header((header::RANGE, range));
        }
        let response = crate::rer_importer::serve_messenger_media(
            &request.to_http_request(),
            &env,
            &copied,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(
            actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap(),
            expected
        );
    }
    let request = TestRequest::default()
        .insert_header((header::RANGE, "bytes=50-60"))
        .to_http_request();
    let response =
        crate::rer_importer::serve_messenger_media(&request, &env, &copied)
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    signal_message_media::Entity::delete_by_id(original.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    let unreferenced =
        crate::sigint::direct_submit::query::find_unreferenced_media(
            &env.dbx,
            std::slice::from_ref(&original),
        )
        .await
        .unwrap();
    assert!(unreferenced.is_empty());
    crate::messenger::media::delete_stored_media_files(
        &env.dbx,
        &unreferenced,
        &[],
        &env.config,
        &env.s3,
    )
    .await;
    assert!(entry.ready(false).await.unwrap().is_some());
    signal_message_media::Entity::delete_by_id(copied.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    let unreferenced =
        crate::sigint::direct_submit::query::find_unreferenced_media(
            &env.dbx,
            std::slice::from_ref(&copied),
        )
        .await
        .unwrap();
    assert_eq!(unreferenced.len(), 1);
    crate::messenger::media::delete_stored_media_files(
        &env.dbx,
        &unreferenced,
        &[],
        &env.config,
        &env.s3,
    )
    .await;
    assert!(entry.ready(false).await.unwrap().is_none());
}

#[tokio::test]
#[serial]
async fn normalized_playback_is_fast_start_and_preserves_original_bytes() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let mut env = env.as_ref().clone();
    let directory = tempfile::tempdir().unwrap();
    env.config = config(directory.path());
    enable_cache(&env).await;
    let original = directory.path().join("original.mp4");
    let status = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=160x90:rate=25",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&original)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let mut data = fs::read(&original).await.unwrap();
    let avcc = data
        .windows(4)
        .position(|window| window == b"avcC")
        .unwrap();
    data[avcc + 7] = 13;
    fs::write(&original, &data).await.unwrap();
    let media = media("normalization", data.len() as i64);
    stage_upload(
        &env.config,
        "normalization",
        media.size_bytes,
        false,
        &original,
        false,
    )
    .await
    .unwrap();
    pin_media(&env.config, &media, Utc::now().timestamp())
        .await
        .unwrap();
    playback::prepare(&env, &media).await.unwrap();
    let status = playback_status(std::sync::Arc::new(env.clone()), &media)
        .await
        .unwrap();
    let playback::PlaybackStatus::Ready(path) = status else {
        panic!("playback copy was not published")
    };
    playback::mp4::validate(&path).await.unwrap();
    assert_eq!(
        fs::read(ready_original(&env.config, &media).await.unwrap().unwrap())
            .await
            .unwrap(),
        data
    );
    assert_eq!(fs::read(original).await.unwrap(), data);
}

#[tokio::test]
#[serial]
async fn cold_plaintext_video_never_waits_for_local_cache_population() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let mut env = env.as_ref().clone();
    let directory = tempfile::tempdir().unwrap();
    env.config = config(directory.path());
    enable_cache(&env).await;
    let env = std::sync::Arc::new(env);
    for size in [40 << 30, 20 << 20] {
        let media = media("cold-video", size);
        let status = playback_status(env.clone(), &media).await.unwrap();
        assert!(matches!(status, playback::PlaybackStatus::Original));
    }
}

async fn enable_cache(env: &Env) {
    use sea_orm::ConnectionTrait;
    env.dbx.execute_unprepared("insert into system_settings (rer_analysis_units_exact_match_only_default, rer_duty_test_enabled, rer_duty_test_since_ms, rer_duty_test_limit, rer_duty_poll_interval_sec, messenger_media_cache_enabled, messenger_media_cache_min_free_gib) values (true, false, 0, 1, 5, true, 0)").await.unwrap();
}
