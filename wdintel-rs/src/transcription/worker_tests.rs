use super::worker::*;
use echo_gpu_client::TranscriptionAdapter;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

#[actix_web::test]
#[serial_test::serial]
async fn materialization_sniffs_envelopes_for_arbitrary_keys_and_rejects_bad_audio(
) {
    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut env = base.as_ref().clone();
    env.config.storage_dir = temp.path().display().to_string();
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
    let env = Arc::new(env);
    let config = env.config.s3_config.as_ref().unwrap();
    let operator = env.s3.as_ref().unwrap();
    let wav =
        crate::devices::audio::acceptance_tests::native_audio_bytes().await;
    let storage = crate::storage::S3Config::with_prefix(config, String::new());
    let worker = uuid::Uuid::now_v7();
    let adapter = EchoTranscriptionAdapter::new(env.clone(), worker)
        .await
        .unwrap();
    for (key, encrypted) in
        [("legacy/nonstandard-name", true), ("other/plain", false)]
    {
        if encrypted {
            crate::storage::upload_encrypted_to_s3_with_operator(
                &env.s3,
                &storage,
                &config.strongbox_key,
                key,
                wav.clone(),
            )
            .await
            .unwrap();
        } else {
            operator.write(key, wav.clone()).await.unwrap();
        }
        let (source, _) = super::service::enqueue(&env.dbx, key).await.unwrap();
        let materialized =
            adapter.materialize(source, worker, 1).await.unwrap();
        assert_eq!(tokio::fs::read(&materialized.path).await.unwrap(), wav);
        assert_eq!(
            tokio::fs::metadata(&materialized.path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        adapter
            .release_materialized(source, worker, 1)
            .await
            .unwrap();
        assert!(!materialized.path.exists());
    }
    let transport = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-c:a",
            "aac",
            "-f",
            "mpegts",
            "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(transport.status.success());
    operator
        .write("legacy/transport", transport.stdout)
        .await
        .unwrap();
    let (source, _) = super::service::enqueue(&env.dbx, "legacy/transport")
        .await
        .unwrap();
    adapter.materialize(source, worker, 1).await.unwrap();
    adapter
        .release_materialized(source, worker, 1)
        .await
        .unwrap();
    let encrypted = operator
        .read("legacy/nonstandard-name")
        .await
        .unwrap()
        .to_vec();
    for (key, bytes) in [
        ("wrong-aad", encrypted),
        ("corrupt", vec![0xb1, 0xb8, 0xf5, 0]),
        ("not-audio", b"random data".to_vec()),
    ] {
        operator.write(key, bytes).await.unwrap();
        let (source, _) = super::service::enqueue(&env.dbx, key).await.unwrap();
        let error = adapter.materialize(source, worker, 1).await.unwrap_err();
        assert!(
            !error
                .downcast_ref::<echo_gpu_client::WorkError>()
                .unwrap()
                .retryable
        );
        adapter
            .release_materialized(source, worker, 1)
            .await
            .unwrap();
    }
    let mut unavailable = env.as_ref().clone();
    unavailable.dbx = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
        .await
        .unwrap();
    unavailable.dbx.get_postgres_connection_pool().close().await;
    let adapter = EchoTranscriptionAdapter::new(Arc::new(unavailable), worker)
        .await
        .unwrap();
    let error = adapter
        .materialize(uuid::Uuid::now_v7(), worker, 1)
        .await
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<echo_gpu_client::WorkError>()
            .unwrap()
            .retryable
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn permanent_storage_credentials_fail_without_retrying() {
    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    let mut env = base.as_ref().clone();
    let temporary = tempfile::tempdir().unwrap();
    env.config.storage_dir = temporary.path().display().to_string();
    let mut config = crate::storage::S3Config::with_prefix(
        env.config.s3_config.as_ref().unwrap(),
        String::new(),
    );
    config.secret_access_key = "invalid-fixture-secret".into();
    env.s3 = Some(crate::storage::build_s3_operator(&config).unwrap());
    let (source, _) = super::service::enqueue(&env.dbx, "credential-fixture")
        .await
        .unwrap();
    let worker = uuid::Uuid::now_v7();
    let adapter = EchoTranscriptionAdapter::new(Arc::new(env), worker)
        .await
        .unwrap();
    let error = adapter.materialize(source, worker, 1).await.unwrap_err();
    assert!(
        !error
            .downcast_ref::<echo_gpu_client::WorkError>()
            .unwrap()
            .retryable
    );
}
