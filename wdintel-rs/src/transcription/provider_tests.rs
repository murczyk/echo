use sea_orm::ConnectionTrait;
use std::sync::Arc;
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::Duration,
};
use uuid::Uuid;
struct Provider {
    child: OwnedChild,
    _directory: tempfile::TempDir,
    token: String,
    url: String,
    client: echo_gpu_client::EchoGpuClient,
    _executor: super::executor::Executor,
}

struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Provider {
    async fn start(env: &crate::types::Env) -> Self {
        Self::start_at(env, "127.0.0.1").await
    }

    async fn start_at(env: &crate::types::Env, host: &str) -> Self {
        let listeners = [
            TcpListener::bind("127.0.0.1:0").unwrap(),
            TcpListener::bind("127.0.0.1:0").unwrap(),
        ];
        let [rs_port, py_port] =
            listeners.map(|listener| listener.local_addr().unwrap().port());
        let directory = tempfile::tempdir().unwrap();
        let token = Uuid::new_v4().to_string();
        let token_file = directory.path().join("token");
        std::fs::write(&token_file, &token).unwrap();
        let child = OwnedChild(
            Command::new("python3")
                .arg(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../scripts/devices/device_audio_asr_fixture.py"),
                )
                .args([
                    "--rs-port",
                    &rs_port.to_string(),
                    "--py-port",
                    &py_port.to_string(),
                    "--token-file",
                ])
                .arg(token_file)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let url = format!("http://127.0.0.1:{rs_port}");
        let mut local = None;
        for instance in echo_gpu_client::list_instances(&env.dbx).await.unwrap()
        {
            echo_gpu_client::update_instance(
                &env.dbx,
                instance.id,
                echo_gpu_client::UpdateInstance {
                    is_active: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            if instance.host == host {
                local = Some(instance.id);
            }
        }
        if let Some(id) = local {
            echo_gpu_client::update_instance(
                &env.dbx,
                id,
                echo_gpu_client::UpdateInstance {
                    is_active: Some(true),
                    rs_port: Some(rs_port.into()),
                    py_port: Some(py_port.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        } else {
            echo_gpu_client::create_instance(
                &env.dbx,
                echo_gpu_client::CreateInstance {
                    name: format!("device ASR fixture {host}"),
                    host: host.into(),
                    rs_port: rs_port.into(),
                    py_port: py_port.into(),
                    train: false,
                    ordering: Some(1),
                },
            )
            .await
            .unwrap();
        }
        let executor = super::executor::client(&env.config).await.unwrap();
        let client = echo_gpu_client::EchoGpuClient::new(
            executor.database().clone(),
            echo_gpu_client::EchoGpuClientOptions {
                request_timeout: Duration::from_millis(500),
                readiness_attempts: 1,
                readiness_delay: Duration::from_millis(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut fixture = Self {
            child,
            _directory: directory,
            token,
            url,
            client,
            _executor: executor,
        };
        let http = reqwest::Client::new();
        let mut ready = false;
        for _ in 0..100 {
            assert!(
                fixture.child.0.try_wait().unwrap().is_none(),
                "owned ASR fixture exited"
            );
            if http.get(&fixture.url).send().await.is_ok()
                && http
                    .get(format!("http://127.0.0.1:{py_port}"))
                    .send()
                    .await
                    .is_ok()
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(ready, "owned ASR fixture must be ready");
        fixture
    }

    async fn control(&self, mode: &str) {
        reqwest::Client::new()
            .post(format!("{}/__fixture/control", self.url))
            .header("X-Fixture-Token", &self.token)
            .json(&if let Some(status) = mode.strip_prefix("http_") {
                serde_json::json!({"mode":"http_error","http_status":status.parse::<u16>().unwrap()})
            } else if mode == "retry_after" {
                serde_json::json!({"mode":"overloaded","overload_status":429,"retry_after":600})
            } else {
                serde_json::json!({"mode":if matches!(mode,"age_exhausted"|"missing_source"|"empty_source"|"oversized_source"|"no_storage"|"registry_unavailable"|"outcome_failure"|"no_provider") {"success"} else if mode == "attempts_exhausted" {"lost_response"} else {mode},"delay_seconds":1.0})
            })
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }

    async fn state(&self) -> serde_json::Value {
        reqwest::Client::new()
            .get(format!("{}/__fixture/state", self.url))
            .header("X-Fixture-Token", &self.token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

fn install_memory_storage(env: &mut crate::types::Env) {
    use base64::Engine;

    env.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: "test".to_string(),
        s3_secret_access_key: "test".to_string(),
        s3_endpoint: "http://127.0.0.1:1".to_string(),
        s3_region: "us-east-1".to_string(),
        s3_bucket: "transcription-test".to_string(),
        strongbox_key: base64::engine::general_purpose::STANDARD
            .encode([0; 32]),
    });
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn message_transcription_works_with_devices_disabled_without_file_registry(
) {
    use crate::entities::{signal_message_media, system_settings};
    use sea_orm::{ActiveModelTrait, Set};

    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(false),
        enable_audio_transcription: Set(true),
        ..Default::default()
    }
    .insert(&base.dbx)
    .await
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut env = base.as_ref().clone();
    env.config.file_registry = None;
    env.config.storage_dir = directory.path().display().to_string();
    env.file_registry_db = None;
    env.device_file_content = None;
    install_memory_storage(&mut env);
    env.device_audio = crate::devices::audio::build_runtime(
        &env.config,
        &env.dbx,
        None,
        env.s3.as_ref(),
        None,
    );
    let env = Arc::new(env);
    let provider = Provider::start(&env).await;
    let worker = Uuid::now_v7();
    let adapter =
        super::worker::EchoTranscriptionAdapter::new(env.clone(), worker)
            .await
            .unwrap();
    let bytes =
        crate::devices::audio::acceptance_tests::native_audio_bytes().await;
    let config = env.config.s3_config.as_ref().unwrap();
    let storage = crate::storage::S3Config::with_prefix(config, String::new());
    for encrypted in [false, true] {
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("audio/wav".into()),
            file_ext: Set(Some("wav".into())),
            file_name: Set(Some("recording.wav".into())),
            size_bytes: Set(bytes.len() as i64),
            is_encrypted: Set(encrypted),
            storage_key: Set(Some(Uuid::now_v7().to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let key = crate::transcriber::media_queue::source_key(&media);
        if encrypted {
            crate::storage::upload_encrypted_to_s3_with_operator(
                &env.s3,
                &storage,
                &config.strongbox_key,
                &key,
                bytes.clone(),
            )
            .await
            .unwrap();
        } else {
            env.s3
                .as_ref()
                .unwrap()
                .write(&key, bytes.clone())
                .await
                .unwrap();
        }
        let admitted = crate::transcriber::media_queue::reconcile_message(
            &env.dbx,
            message.id,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(admitted.queued, 1);
        let result = echo_gpu_client::run_transcriber_worker_once(
            &provider.client,
            worker,
            &super::worker::worker_policy(),
            &adapter,
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            echo_gpu_client::WorkerRunResult::Completed { .. }
        ));
        let texts =
            crate::transcriber::completed_transcriptions(&env.dbx, &[media.id])
                .await
                .unwrap();
        assert_eq!(
            texts.get(&media.id).map(String::as_str),
            Some("Автоматична транскрипція")
        );
    }
    assert!(!crate::system_settings::devices_section_enabled(&env.dbx)
        .await
        .unwrap());
}

#[actix_web::test]
#[serial_test::serial]
async fn session_loss_during_gpu_request_rejects_the_late_result() {
    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut env = base.as_ref().clone();
    env.config.storage_dir = temp.path().display().to_string();
    install_memory_storage(&mut env);
    let env = Arc::new(env);
    let provider = Provider::start(&env).await;
    provider.control("delayed").await;
    let key = "inflight/session-loss";
    env.s3
        .as_ref()
        .unwrap()
        .write(
            key,
            crate::devices::audio::acceptance_tests::native_audio_bytes().await,
        )
        .await
        .unwrap();
    let (source, _) = super::service::enqueue(&env.dbx, key).await.unwrap();
    let client = echo_gpu_client::EchoGpuClient::new(
        provider.client.database().clone(),
        echo_gpu_client::EchoGpuClientOptions {
            request_timeout: Duration::from_secs(30),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let pid: i32 = client
        .database()
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            "select pg_backend_pid() as pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let adapter = super::worker::EchoTranscriptionAdapter::new(
        env.clone(),
        Uuid::now_v7(),
    )
    .await
    .unwrap();
    let policy = super::worker::worker_policy();
    let run = echo_gpu_client::run_transcriber_worker_once(
        &client,
        Uuid::now_v7(),
        &policy,
        &adapter,
    );
    tokio::pin!(run);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut run => panic!("request finished before session loss: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(10)) => {
                    if provider.state().await["active"] == 1 { break; }
                }
            }
        }
    }).await.unwrap();
    env.dbx
        .execute_unprepared(&format!("select pg_terminate_backend({pid},5000)"))
        .await
        .unwrap();
    let replacement = super::executor::client(&env.config);
    tokio::pin!(replacement);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut replacement)
            .await
            .is_err()
    );
    env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set heartbeat_at=(now() at time zone 'utc')-interval '1 hour' where source_id='{source}'")).await.unwrap();
    let replacement =
        tokio::time::timeout(Duration::from_secs(5), &mut replacement)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0
            .state,
        "retrying"
    );
    replacement
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
    let result = tokio::time::timeout(Duration::from_secs(5), &mut run)
        .await
        .unwrap();
    assert!(
        result.is_err()
            || matches!(result, Ok(echo_gpu_client::WorkerRunResult::Stale { source_id }) if source_id == source)
    );
    let task = echo_gpu_client::lookup(&env.dbx, source)
        .await
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(task.state, "retrying");
    assert_eq!(task.attempt_count, 1);
    assert_eq!(task.transcribed_value, None);
    assert_eq!(provider.state().await["guess_requests"], 1);
    client
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
}

#[actix_web::test]
#[serial_test::serial]
async fn mixed_source_keys_use_the_same_native_provider_policy() {
    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut env = base.as_ref().clone();
    env.config.storage_dir = temp.path().display().to_string();
    install_memory_storage(&mut env);
    let env = Arc::new(env);
    let provider = Provider::start(&env).await;
    let worker = Uuid::now_v7();
    let bytes =
        crate::devices::audio::acceptance_tests::native_audio_bytes().await;
    let config = env.config.s3_config.as_ref().unwrap();
    let storage = crate::storage::S3Config::with_prefix(config, String::new());
    for prefix in ["message-media/", "device-audio/"] {
        for mode in [
            "success",
            "no_speech",
            "overloaded",
            "proxy_unavailable",
            "lost_response",
            "safe_rejection",
            "upload_not_found",
            "http_400",
            "http_401",
            "http_403",
            "http_408",
            "http_429",
            "http_500",
            "http_504",
            "retry_after",
            "invalid_response",
            "missing_id",
            "oversized_response",
            "age_exhausted",
            "attempts_exhausted",
            "missing_source",
            "empty_source",
            "oversized_source",
            "no_storage",
            "registry_unavailable",
            "outcome_failure",
            "no_provider",
        ] {
            provider.control(mode).await;
            let key = format!("{prefix}{mode}");
            let input = if mode == "empty_source" {
                actix_web::web::Bytes::new()
            } else if mode == "oversized_source" {
                actix_web::web::Bytes::from(vec![
                    0;
                    crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES
                        as usize
                        + 1
                ])
            } else {
                bytes.clone()
            };
            if mode == "missing_source" {
            } else if prefix == "message-media/" {
                env.s3
                    .as_ref()
                    .unwrap()
                    .write(&key, input.clone())
                    .await
                    .unwrap();
            } else {
                crate::storage::upload_encrypted_to_s3_with_operator(
                    &env.s3,
                    &storage,
                    &config.strongbox_key,
                    &key,
                    input,
                )
                .await
                .unwrap();
            }
            let (source, _) =
                super::service::enqueue(&env.dbx, &key).await.unwrap();
            // Isolate this boundary from older retry deadlines in the same fixture.
            env.dbx.execute_unprepared("update echo_gpu_transcription_queue set next_retry_at=(now() at time zone 'utc')+interval '1 hour' where state='retrying'").await.unwrap();
            let client = echo_gpu_client::EchoGpuClient::new(
                provider.client.database().clone(),
                echo_gpu_client::EchoGpuClientOptions {
                    request_timeout: Duration::from_millis(500),
                    max_response_body_len: 1024,
                    readiness_attempts: 1,
                    readiness_delay: Duration::from_millis(10),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            if mode == "age_exhausted" {
                env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set created_at=(now() at time zone 'utc')-interval '25 hours' where source_id='{source}'")).await.unwrap();
            } else if mode == "attempts_exhausted" {
                env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set attempt_count=7 where source_id='{source}'")).await.unwrap();
            } else if mode == "no_provider" {
                env.dbx
                    .execute_unprepared("update gpu_config set is_active=false")
                    .await
                    .unwrap();
            } else if mode == "outcome_failure" {
                env.dbx.execute_unprepared("create function fail_outcome_test() returns trigger language plpgsql as $$ begin if new.state='completed' then raise exception 'injected native save failure'; end if; return new; end $$; create trigger fail_outcome_test before update on echo_gpu_transcription_queue for each row execute function fail_outcome_test()").await.unwrap();
            }
            let mut preparation = env.as_ref().clone();
            if mode == "no_storage" {
                preparation.s3 = None;
            }
            if mode == "registry_unavailable" {
                preparation.dbx =
                    crate::new_pg_pool_from_mode(crate::types::Mode::Test)
                        .await
                        .unwrap();
                preparation.dbx.get_postgres_connection_pool().close().await;
            }
            let adapter = super::worker::EchoTranscriptionAdapter::new(
                Arc::new(preparation),
                worker,
            )
            .await
            .unwrap();
            let guesses_before =
                provider.state().await["guess_requests"].as_u64().unwrap();
            let before = chrono::Utc::now().naive_utc();
            let result = echo_gpu_client::run_transcriber_worker_once(
                &client,
                worker,
                &super::worker::worker_policy(),
                &adapter,
            )
            .await;
            if mode == "outcome_failure" {
                env.dbx.execute_unprepared("drop trigger fail_outcome_test on echo_gpu_transcription_queue; drop function fail_outcome_test()").await.unwrap();
                assert!(result.is_err());
            } else {
                assert!(result.is_ok(), "{prefix}{mode}: {result:?}");
            }
            let task = echo_gpu_client::lookup(&env.dbx, source)
                .await
                .unwrap()
                .unwrap()
                .0;
            let expected = match mode {
                "success" | "no_speech" => "completed",
                "http_400" | "http_401" | "http_403" | "invalid_response"
                | "missing_id" | "upload_not_found" | "oversized_response"
                | "age_exhausted" | "attempts_exhausted" | "missing_source"
                | "empty_source" | "oversized_source" | "no_storage" => {
                    "terminal"
                }
                "outcome_failure" => "processing",
                "no_provider" => "queued",
                _ => "retrying",
            };
            assert_eq!(task.state, expected, "{prefix}{mode}: {result:?}");
            assert_eq!(
                task.attempt_count,
                if mode == "attempts_exhausted" {
                    8
                } else if mode == "no_provider" {
                    0
                } else {
                    1
                },
                "{prefix}{mode}"
            );
            if matches!(
                mode,
                "upload_not_found"
                    | "missing_source"
                    | "empty_source"
                    | "oversized_source"
                    | "age_exhausted"
                    | "no_storage"
                    | "registry_unavailable"
                    | "no_provider"
            ) {
                assert_eq!(
                    provider.state().await["guess_requests"].as_u64().unwrap(),
                    guesses_before,
                    "{prefix}{mode}"
                );
            }
            if mode == "retry_after" {
                assert!(
                    (task.next_retry_at.unwrap() - before).num_seconds() >= 299
                );
            }
            if mode == "attempts_exhausted" {
                echo_gpu_client::run_transcriber_worker_once(
                    &client,
                    worker,
                    &super::worker::worker_policy(),
                    &adapter,
                )
                .await
                .unwrap();
                assert_eq!(
                    echo_gpu_client::lookup(&env.dbx, source)
                        .await
                        .unwrap()
                        .unwrap()
                        .0
                        .attempt_count,
                    8
                );
            }
            if mode == "outcome_failure" {
                env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set heartbeat_at=(now() at time zone 'utc')-interval '1 hour' where source_id='{source}'")).await.unwrap();
                echo_gpu_client::recover_stale(
                    client.database(),
                    chrono::Utc::now().naive_utc()
                        - chrono::Duration::seconds(120),
                    8,
                    100,
                )
                .await
                .unwrap();
                assert_eq!(
                    echo_gpu_client::lookup(&env.dbx, source)
                        .await
                        .unwrap()
                        .unwrap()
                        .0
                        .state,
                    "retrying"
                );
            }
            if mode == "no_provider" {
                env.dbx.execute_unprepared("update gpu_config set is_active=true; update echo_gpu_transcription_queue set state='terminal' where state='queued'").await.unwrap();
            }
            for _ in 0..30 {
                if provider.state().await["active"] == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(temp
                .path()
                .join("echo_audio_cache")
                .read_dir()
                .unwrap()
                .next()
                .is_none());
        }
    }
    assert_eq!(provider.state().await["max_active"], 1);
    provider
        .client
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
}
