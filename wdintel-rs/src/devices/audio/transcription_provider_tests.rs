use super::super::{source, worker};
use super::*;
use sha2::{Digest, Sha256};
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Provider {
    child: OwnedChild,
    _directory: tempfile::TempDir,
    token: String,
    url: String,
    client: echo_gpu_client::EchoGpuClient,
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
        let client = echo_gpu_client::EchoGpuClient::new(
            env.dbx.clone(),
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
            .json(&serde_json::json!({"mode":mode,"delay_seconds":1.0}))
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

    async fn run_once(&self, env: &crate::types::Env) -> bool {
        worker::run_once(env.device_audio.clone(), &self.client, Uuid::new_v4())
            .await
            .unwrap()
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn materialization_uses_verified_original_and_removes_only_its_private_copy(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let audio = accepted(&env, actor, device).await;
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    let materialized = source::materialize(env.device_audio.clone(), &claim)
        .await
        .expect(
            "ASR must read the retained original independently of graphics",
        );
    let bytes = tokio::fs::read(&materialized.path).await.unwrap();
    assert_eq!(bytes.len() as i64, audio.source_size_bytes);
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    assert_eq!(digest.as_slice(), audio.source_sha256);
    let path = materialized.path.clone();
    drop(materialized);
    assert!(!path.exists());
    let mut changed = claim.clone();
    changed.source.sha256[0] ^= 1;
    assert!(source::materialize(env.device_audio.clone(), &changed)
        .await
        .is_err());
    let store = env.device_audio.byte_store().unwrap();
    let mut corrupt = bytes;
    *corrupt.last_mut().unwrap() ^= 1;
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(store.operator.clone()),
        &store.config,
        &store.strongbox_key,
        &audio.storage_key,
        corrupt.into(),
    )
    .await
    .unwrap();
    assert!(source::materialize(env.device_audio.clone(), &claim)
        .await
        .is_err());
    let no_storage = build_runtime(
        &env.config,
        &env.dbx,
        env.file_registry_db.as_ref(),
        None,
        None,
    );
    assert!(source::materialize(no_storage, &claim).await.is_err());
}

#[actix_web::test]
#[serial_test::serial]
async fn provider_executor_saves_success_and_no_speech_without_a_browser() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    for mode in ["success", "no_speech"] {
        provider.control(mode).await;
        let audio = accepted(&env, actor, device).await;
        assert!(worker::run_once(
            env.device_audio.clone(),
            &provider.client,
            Uuid::new_v4()
        )
        .await
        .unwrap());
        let current = device_audio::Entity::find_by_id(audio.id)
            .one(env.device_audio.file_database().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            current.automatic_transcription.as_deref(),
            (mode == "success").then_some("Автоматична транскрипція")
        );
        assert_eq!(current.text_version, audio.text_version);
        assert_eq!(current.processing_version, audio.processing_version);
        assert_eq!(
            recovery_tests::job(&env, audio.id).await.state,
            if mode == "success" {
                "succeeded"
            } else {
                "no_speech"
            }
        );
    }
    assert_eq!(provider.state().await["inferences"], 2);
    assert_eq!(provider.state().await["max_active"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn lost_provider_response_never_dispatches_a_second_inference() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    provider.control("lost_response").await;
    let audio = accepted(&env, actor, device).await;
    assert!(worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.state,
        "outcome_unknown"
    );
    for _ in 0..2 {
        assert!(!worker::run_once(
            env.device_audio.clone(),
            &provider.client,
            Uuid::new_v4()
        )
        .await
        .unwrap());
    }
    assert_eq!(provider.state().await["inferences"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn proxy_unavailable_response_never_dispatches_a_second_inference() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    provider.control("proxy_unavailable").await;
    let audio = accepted(&env, actor, device).await;
    assert!(provider.run_once(&env).await);
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.state,
        "outcome_unknown"
    );
    assert_eq!(provider.state().await["active"], 1);
    accepted(&env, actor, device).await;
    assert!(!provider.run_once(&env).await);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(!provider.run_once(&env).await);
    assert_eq!(provider.state().await["inferences"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn overloaded_provider_releases_slot_and_retries_after_bounded_delay() {
    use crate::devices::audio::tests::{
        audio_actor, audio_device, audio_organism,
    };

    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    let organization = audio_organism(&env.dbx, None).await;
    let other_actor = audio_actor(&env.dbx, organization.id, &["Cyber"]).await;
    let other_device =
        audio_device(&env.dbx, &other_actor, organization.id, false).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    for (status, retry_after, delay) in
        [(503, Some(60), 60), (429, Some(600), 300), (503, None, 5)]
    {
        reqwest::Client::new()
            .post(format!("{}/__fixture/control", provider.url))
            .header("X-Fixture-Token", &provider.token)
            .json(&serde_json::json!({
                "mode": "overloaded",
                "overload_status": status,
                "retry_after": retry_after,
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let audio = accepted(&env, actor, device).await;
        assert!(provider.run_once(&env).await);
        let waiting = recovery_tests::job(&env, audio.id).await;
        assert_eq!(waiting.state, "retry_wait", "HTTP {status}");
        assert_eq!(waiting.attempt_count, 1);
        assert_eq!(waiting.error_code.as_deref(), Some("provider_overloaded"));
        let actual_delay =
            waiting.next_attempt_at.unwrap() - waiting.updated_at;
        assert!(actual_delay >= chrono::Duration::seconds(delay - 1));
        assert!(actual_delay <= chrono::Duration::seconds(delay));
        assert!(waiting.attempt_id.is_none());
        assert!(!provider.run_once(&env).await);
        provider.control("success").await;
        let other = accepted(&env, other_actor.id, other_device.id).await;
        assert!(provider.run_once(&env).await);
        assert_eq!(
            recovery_tests::job(&env, other.id).await.state,
            "succeeded"
        );
        let mut due = waiting.into_active_model();
        due.next_attempt_at = Set(Some(
            (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
        ));
        due.update(env.device_audio.file_database().unwrap())
            .await
            .unwrap();
        assert!(provider.run_once(&env).await);
        assert_eq!(
            recovery_tests::job(&env, audio.id).await.state,
            "succeeded"
        );
    }
    assert_eq!(provider.state().await["inferences"], 6);
    assert_eq!(provider.state().await["max_active"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn unavailable_provider_does_not_consume_attempts_and_safe_rejection_retries(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let mut provider = Provider::start(&env).await;
    let audio = accepted(&env, actor, device).await;
    provider.control("safe_rejection").await;
    assert!(worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    let failed = recovery_tests::job(&env, audio.id).await;
    assert_eq!(failed.state, "retry_wait");
    assert_eq!(failed.attempt_count, 1);
    assert_eq!(provider.state().await["inferences"], 0);
    let mut due = failed.into_active_model();
    due.next_attempt_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
    ));
    due.update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    provider.control("success").await;
    assert!(worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert_eq!(recovery_tests::job(&env, audio.id).await.state, "succeeded");
    assert_eq!(provider.state().await["inferences"], 1);
    provider.child.0.kill().unwrap();
    provider.child.0.wait().unwrap();
    let unavailable = accepted(&env, actor, device).await;
    assert!(!worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert_eq!(
        recovery_tests::job(&env, unavailable.id)
            .await
            .attempt_count,
        0
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn a_definite_result_retries_database_persistence_without_redispatch() {
    use sea_orm::ConnectionTrait;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    let audio = accepted(&env, actor, device).await;
    let files = env.device_audio.file_database().unwrap();
    let name = format!("asr_fault_{}", Uuid::new_v4().simple());
    files.execute_unprepared(&format!(
        "CREATE SEQUENCE {name}; CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{}'::uuid AND nextval('{name}')=1 THEN RAISE EXCEPTION 'owned ASR persistence fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE OF automatic_transcription ON device_audio FOR EACH ROW EXECUTE FUNCTION {name}();", audio.id
    )).await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        worker::run_once(
            env.device_audio.clone(),
            &provider.client,
            Uuid::new_v4(),
        ),
    )
    .await;
    files.execute_unprepared(&format!("DROP TRIGGER {name} ON device_audio; DROP FUNCTION {name}(); DROP SEQUENCE {name};")).await.unwrap();
    assert!(result.unwrap().unwrap());
    assert_eq!(recovery_tests::job(&env, audio.id).await.state, "succeeded");
    assert_eq!(provider.state().await["inferences"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn later_chunk_error_preserves_unknown_slot_and_never_replays_earlier_chunks(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    provider
        .client
        .update_settings(&echo_gpu_client::EchoGpuSettings {
            trim_long_audio: true,
        })
        .await
        .unwrap();
    provider.control("chunk_error").await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("long.wav");
    let output = tokio::process::Command::new("ffmpeg")
        .kill_on_drop(true)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000",
            "-t",
            "50",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "chunked.wav",
        tokio::fs::read(path).await.unwrap().into(),
    )
    .await;
    let types::ReceiveDeviceAudioOutcome::Accepted(response) =
        receive(&env.device_audio, actor, command).await.unwrap()
    else {
        panic!("accepted audio required");
    };
    let id = Uuid::parse_str(&response.audio.id).unwrap();
    assert!(worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert_eq!(provider.state().await["inferences"], 2);
    assert_eq!(recovery_tests::job(&env, id).await.state, "outcome_unknown");
    assert!(!worker::run_once(
        env.device_audio.clone(),
        &provider.client,
        Uuid::new_v4()
    )
    .await
    .unwrap());
    assert_eq!(provider.state().await["inferences"], 2);
}

#[actix_web::test]
#[serial_test::serial]
async fn shutdown_finishes_the_dispatched_attempt_and_stops_new_admissions() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    provider.control("lost_response").await;
    let audio = accepted(&env, actor, device).await;
    let cancellation = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(
        env.device_audio.clone(),
        Arc::new(provider.client.clone()),
        cancellation.clone(),
    ));
    tokio::time::timeout(Duration::from_secs(10), async {
        while provider.state().await["inferences"] != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.state,
        "outcome_unknown"
    );
    let next = accepted(&env, actor, device).await;
    assert_eq!(recovery_tests::job(&env, next.id).await.attempt_count, 0);
    assert_eq!(provider.state().await["inferences"], 1);
}

#[actix_web::test]
#[serial_test::serial]
async fn a_definite_safe_failure_retries_persistence_without_losing_its_outcome(
) {
    use sea_orm::ConnectionTrait;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let provider = Provider::start(&env).await;
    provider.control("safe_rejection").await;
    let audio = accepted(&env, actor, device).await;
    let files = env.device_audio.file_database().unwrap();
    let name = format!("asr_fault_{}", Uuid::new_v4().simple());
    files.execute_unprepared(&format!(
        "CREATE SEQUENCE {name}; CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.audio_id='{}'::uuid AND NEW.state='retry_wait' AND nextval('{name}')=1 THEN RAISE EXCEPTION 'owned ASR persistence fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE OF state ON device_audio_asr_job FOR EACH ROW EXECUTE FUNCTION {name}();", audio.id
    )).await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        worker::run_once(
            env.device_audio.clone(),
            &provider.client,
            Uuid::new_v4(),
        ),
    )
    .await;
    files.execute_unprepared(&format!("DROP TRIGGER {name} ON device_audio_asr_job; DROP FUNCTION {name}(); DROP SEQUENCE {name};")).await.unwrap();
    assert!(result.unwrap().unwrap());
    assert_eq!(
        recovery_tests::job(&env, audio.id).await.state,
        "retry_wait"
    );
    assert_eq!(provider.state().await["inferences"], 0);
}

#[actix_web::test]
#[serial_test::serial]
async fn cached_audio_on_an_unhealthy_provider_does_not_consume_attempt_budget()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = enabled_audio_device(&env).await;
    enable_asr(&env).await;
    let cached = Provider::start(&env).await;
    let audio = accepted(&env, actor, device).await;
    let claim = asr_query::claim(&env.device_audio, Uuid::new_v4())
        .await
        .unwrap()
        .unwrap();
    let original = source::materialize(env.device_audio.clone(), &claim)
        .await
        .unwrap();
    let handle = cached
        .client
        .ensure_uploaded(None, &original.path, "cached.wav")
        .await
        .unwrap();
    asr_query::fail(
        &env.device_audio,
        &claim,
        super::super::Failure::Safe("fixture_preparation"),
    )
    .await
    .unwrap();
    let mut queued = recovery_tests::job(&env, audio.id)
        .await
        .into_active_model();
    queued.attempt_count = Set(0);
    queued.next_attempt_at = Set(Some(
        (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
    ));
    queued
        .update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    let healthy = Provider::start_at(&env, "localhost").await;
    let instance = echo_gpu_client::get_instance(&env.dbx, handle.instance_id)
        .await
        .unwrap();
    echo_gpu_client::update_instance(
        &env.dbx,
        handle.instance_id,
        echo_gpu_client::UpdateInstance {
            is_active: Some(true),
            py_port: Some(instance.rs_port),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for _ in 0..9 {
        assert!(tokio::time::timeout(
            Duration::from_secs(5),
            worker::run_once(
                env.device_audio.clone(),
                &healthy.client,
                Uuid::new_v4()
            )
        )
        .await
        .expect("provider wait must persist and release the slot")
        .unwrap());
        let waiting = recovery_tests::job(&env, audio.id).await;
        assert_eq!(waiting.state, "retry_wait");
        assert_eq!(waiting.attempt_count, 0);
        let mut due = waiting.into_active_model();
        due.next_attempt_at = Set(Some(
            (chrono::Utc::now() - chrono::Duration::seconds(1)).fixed_offset(),
        ));
        due.update(env.device_audio.file_database().unwrap())
            .await
            .unwrap();
    }
    assert_eq!(healthy.state().await["inferences"], 0);
    assert_eq!(cached.state().await["inferences"], 0);
    let run =
        super::super::backfill_query::snapshot(&env.device_audio, Some(device))
            .await
            .unwrap();
    let owner = Uuid::new_v4();
    super::super::backfill_query::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    let exit = tokio::time::timeout(
        Duration::from_secs(5),
        super::super::backfill::drive(
            &env.device_audio,
            &healthy.client,
            run,
            owner,
            &tokio_util::sync::CancellationToken::new(),
        ),
    )
    .await
    .expect("backfill must pause when its cached provider is unavailable")
    .unwrap();
    assert_eq!(exit, 3);
    let report = super::super::backfill_query::report(&env.device_audio, run)
        .await
        .unwrap();
    assert_eq!((report.checked, report.unfinished), (0, 1));
    super::super::backfill_query::release(&env.device_audio, run, owner, false)
        .await
        .unwrap();
    echo_gpu_client::update_instance(
        &env.dbx,
        handle.instance_id,
        echo_gpu_client::UpdateInstance {
            py_port: Some(instance.py_port),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut due = recovery_tests::job(&env, audio.id)
        .await
        .into_active_model();
    due.next_attempt_at = Set(Some(chrono::Utc::now().fixed_offset()));
    due.update(env.device_audio.file_database().unwrap())
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    super::super::backfill_query::acquire(&env.device_audio, run, owner)
        .await
        .unwrap();
    assert_eq!(
        super::super::backfill::drive(
            &env.device_audio,
            &healthy.client,
            run,
            owner,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(recovery_tests::job(&env, audio.id).await.state, "succeeded");
    assert_eq!(cached.state().await["inferences"], 1);
}
