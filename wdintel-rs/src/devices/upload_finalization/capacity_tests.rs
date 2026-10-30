use super::*;
use std::sync::Arc;

#[derive(serde::Serialize, serde::Deserialize)]
struct AdmissionInput {
    actor: Uuid,
    source: Uuid,
    size: i64,
    settings: DeviceUploadFinalizationSettings,
}

fn capacity_command(input: &AdmissionInput) -> FinalizationCommand {
    let mut command = audio_command(input.actor);
    command.device_id = input.source;
    command.source_size_bytes = input.size;
    command.source_locator = Some(format!("audio/{}", input.source));
    command.target = FinalizationTarget::Audio {
        tus_id: input.source,
        audio_id: input.source,
        name: "capacity".into(),
        recording_started_at: "2026-10-14T08:00:00.123456Z".parse().unwrap(),
        pin_token: input.source,
    };
    command
}

async fn child_database() -> DatabaseConnection {
    Database::connect(std::env::var("PHASE8_DATABASE_URL").unwrap())
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "isolated capacity subprocess entry point"]
async fn phase8_capacity_subprocess() {
    let input_path = std::env::var("PHASE8_INPUT").unwrap();
    let input: AdmissionInput =
        serde_json::from_slice(&std::fs::read(&input_path).unwrap()).unwrap();
    let database = child_database().await;
    std::fs::write(format!("{input_path}.ready"), b"ready").unwrap();
    let gate = std::env::var("PHASE8_GATE").unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while !Path::new(&gate).exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let result = match admission::admit(
        &database,
        &capacity_command(&input),
        &input.settings,
    )
    .await
    {
        Ok(snapshot) => Some(snapshot.job_id),
        Err(error) => {
            assert!(
                matches!(
                    error.downcast_ref::<FinalizationFailure>(),
                    Some(FinalizationFailure::CapacityUnavailable)
                ),
                "unexpected admission failure: {error:#}"
            );
            None
        }
    };
    if std::env::var_os("PHASE8_COMMIT_WRITE").is_some() {
        let claim = worker::claim_due(
            &database,
            FinalizationKind::FinalizationAudioKind,
            Uuid::new_v4(),
            worker::ClaimLane::Work,
            60,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(Some(claim.job_id), result);
        let attempt = query::create_attempt(&database, &claim, true)
            .await
            .unwrap();
        assert!(query::prepare_attempt(
            &database,
            &claim,
            attempt,
            64,
            &[7; 32],
            Some(&prepared_audio()),
        )
        .await
        .unwrap());
        assert!(query::record_write_intent(&database, &claim, attempt, 1)
            .await
            .unwrap());
    }
    std::fs::write(
        format!("{input_path}.result"),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
}

async fn admit_in_processes(
    env: &crate::types::Env,
    inputs: &[AdmissionInput],
) -> Vec<Option<Uuid>> {
    run_in_processes(env, inputs, false).await
}

async fn run_in_processes(
    env: &crate::types::Env,
    inputs: &[AdmissionInput],
    commit_write: bool,
) -> Vec<Option<Uuid>> {
    let root = tempfile::tempdir().unwrap();
    let gate = root.path().join("go");
    let url = crate::mk_wdfile_conn_string(
        env.config.file_registry.as_ref().unwrap(),
        Mode::Test,
    );
    let mut children = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        let path = root.path().join(index.to_string());
        std::fs::write(&path, serde_json::to_vec(input).unwrap()).unwrap();
        let mut command =
            tokio::process::Command::new(std::env::current_exe().unwrap());
        if commit_write {
            command.env("PHASE8_COMMIT_WRITE", "1");
        } else {
            command.env_remove("PHASE8_COMMIT_WRITE");
        }
        let child = command.args([
                "devices::upload_finalization::tests::capacity_tests::phase8_capacity_subprocess",
                "--exact", "--ignored", "--nocapture",
            ])
            .env("PHASE8_DATABASE_URL", &url)
            .env("PHASE8_INPUT", &path)
            .env("PHASE8_GATE", &gate)
            .stdout(std::fs::File::create(path.with_extension("stdout")).unwrap())
            .stderr(std::fs::File::create(path.with_extension("stderr")).unwrap())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        children.push((path, child));
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        while children
            .iter()
            .any(|(path, _)| !path.with_extension("ready").exists())
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        let diagnostics: Vec<_> = children
            .iter()
            .map(|(path, _)| {
                (
                    path.display().to_string(),
                    std::fs::read_to_string(path.with_extension("stdout"))
                        .unwrap(),
                    std::fs::read_to_string(path.with_extension("stderr"))
                        .unwrap(),
                )
            })
            .collect();
        panic!(
            "capacity children did not become ready: {error}: {diagnostics:?}"
        );
    });
    std::fs::write(&gate, b"go").unwrap();
    let mut results = Vec::new();
    for (path, child) in children {
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            child.wait_with_output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "capacity subprocess failed: {} {}",
            std::fs::read_to_string(path.with_extension("stdout")).unwrap(),
            std::fs::read_to_string(path.with_extension("stderr")).unwrap()
        );
        results.push(
            serde_json::from_slice(
                &std::fs::read(path.with_extension("result")).unwrap(),
            )
            .unwrap(),
        );
    }
    results
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_multiprocess_duplicate_at_full_quota_charges_once() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let actor = Uuid::new_v4();
    let source = Uuid::new_v4();
    let settings = DeviceUploadFinalizationSettings {
        audio_global_jobs: 1,
        audio_actor_jobs: 1,
        audio_global_bytes: 64,
        audio_actor_bytes: 64,
        ..settings()
    };
    let inputs: Vec<_> = (0..4)
        .map(|_| AdmissionInput {
            actor,
            source,
            size: 64,
            settings: settings.clone(),
        })
        .collect();
    let results = admit_in_processes(&env, &inputs).await;
    let job = results[0].unwrap();
    assert!(results.iter().all(|result| *result == Some(job)));
    assert_eq!(counters(database, "global:audio").await, (1, 64, 0));
    assert_eq!(
        counters(database, &format!("actor:{actor}:audio")).await,
        (1, 64, 0)
    );
    let blocked = admit_in_processes(
        &env,
        &[AdmissionInput {
            actor: Uuid::new_v4(),
            source: Uuid::new_v4(),
            size: 1,
            settings,
        }],
    )
    .await;
    assert_eq!(blocked, vec![None]);
    assert_eq!(counters(database, "global:audio").await, (1, 64, 0));
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_multiprocess_actor_and_global_count_byte_budgets_conserve() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let actor = Uuid::new_v4();
    let settings = DeviceUploadFinalizationSettings {
        audio_global_jobs: 4,
        audio_actor_jobs: 2,
        audio_global_bytes: 162,
        audio_actor_bytes: 98,
        ..settings()
    };
    let inputs: Vec<_> = (0..4)
        .map(|_| AdmissionInput {
            actor,
            source: Uuid::new_v4(),
            size: 64,
            settings: settings.clone(),
        })
        .collect();
    let results = admit_in_processes(&env, &inputs).await;
    assert_eq!(results.iter().filter(|result| result.is_some()).count(), 1);
    assert_eq!(counters(database, "global:audio").await, (1, 64, 0));
    assert_eq!(
        counters(database, &format!("actor:{actor}:audio")).await,
        (1, 64, 0)
    );
    let inputs: Vec<_> = (0..3)
        .map(|_| AdmissionInput {
            actor: Uuid::new_v4(),
            source: Uuid::new_v4(),
            size: 64,
            settings: settings.clone(),
        })
        .collect();
    let results = admit_in_processes(&env, &inputs).await;
    assert_eq!(results.iter().filter(|result| result.is_some()).count(), 1);
    assert_eq!(counters(database, "global:audio").await, (2, 128, 0));
    for (size, same_actor, accepted) in [
        (32, true, true),
        (1, true, false),
        (1, false, true),
        (1, false, false),
    ] {
        let result = admit_in_processes(
            &env,
            &[AdmissionInput {
                actor: if same_actor { actor } else { Uuid::new_v4() },
                source: Uuid::new_v4(),
                size,
                settings: settings.clone(),
            }],
        )
        .await;
        assert_eq!(result[0].is_some(), accepted);
    }
    assert_eq!(counters(database, "global:audio").await, (4, 161, 0));
    assert_eq!(
        counters(database, &format!("actor:{actor}:audio")).await,
        (2, 96, 0)
    );
    let retained: (i64, i64) = sqlx::query_as(
        "select count(*),sum(source_size_bytes)::bigint from device_upload_finalization_job where quota_released_at is null",
    ).fetch_one(database.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(retained, (4, 161));
}

struct SaturatedExecutor {
    database: DatabaseConnection,
    blocked: Uuid,
    events: tokio::sync::mpsc::UnboundedSender<(Uuid, bool)>,
}

#[async_trait::async_trait]
impl worker::FinalizationExecutor for SaturatedExecutor {
    async fn execute(
        &self,
        claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        if claim.job_id == self.blocked {
            let attempt = query::create_attempt(&self.database, claim, true)
                .await
                .unwrap();
            assert!(query::prepare_attempt(
                &self.database,
                claim,
                attempt,
                64,
                &[7; 32],
                Some(&prepared_audio()),
            )
            .await
            .unwrap());
            let error =
                query::record_write_intent(&self.database, claim, attempt, 1)
                    .await
                    .unwrap_err();
            assert!(matches!(
                error.downcast_ref::<FinalizationFailure>(),
                Some(FinalizationFailure::CapacityUnavailable)
            ));
        }
        self.events.send((claim.job_id, false)).unwrap();
        std::future::pending().await
    }

    async fn reconcile(
        &self,
        claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        self.events.send((claim.job_id, true)).unwrap();
        std::future::pending().await
    }
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_reconciliation_runs_with_held_credit_and_all_work_slots_busy() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let unknown = run_in_processes(
        &env,
        &[AdmissionInput {
            actor: Uuid::new_v4(),
            source: Uuid::new_v4(),
            size: 64,
            settings: settings(),
        }],
        true,
    )
    .await[0]
        .unwrap();
    let attempt: Uuid = sqlx::query_scalar(
        "select active_attempt_id from device_upload_finalization_job where id=$1",
    ).bind(unknown).fetch_one(database.get_postgres_connection_pool()).await.unwrap();
    make_due(database, unknown, true).await;
    let blocked =
        admission::admit(database, &audio_command(Uuid::new_v4()), &settings())
            .await
            .unwrap();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let registration = worker::register(
        database.clone(),
        DeviceUploadFinalizationSettings {
            enabled: false,
            file_slots: 1,
            audio_slots: 1,
            poll_seconds: 1,
            heartbeat_seconds: 1,
            shutdown_grace_seconds: 1,
            ..settings()
        },
        Arc::new(SaturatedExecutor {
            database: database.clone(),
            blocked: blocked.job_id,
            events,
        }),
        CancellationToken::new(),
    );
    let mut started = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while started.len() < 2 {
            started.push(received.recv().await.unwrap());
        }
    })
    .await
    .unwrap();
    registration.shutdown().await;
    assert!(started.contains(&(unknown, true)));
    assert!(started.contains(&(blocked.job_id, false)));
    assert_eq!(counters(database, "global:audio").await, (2, 128, 1));
    assert!(!query::release_write_credit(database, attempt)
        .await
        .unwrap());
}

async fn file_capacity_command(
    database: &DatabaseConnection,
) -> FinalizationCommand {
    use crate::file_registry::entities::{
        file_content_upload, file_entry,
        sea_orm_active_enums::{FileContentUploadStatus, FileEntryKind},
    };
    use sea_orm::{ActiveModelTrait, Set};

    let device = Uuid::new_v4();
    let root = Uuid::new_v4();
    let now = Utc::now();
    file_entry::ActiveModel {
        id: Set(root),
        device_id: Set(device),
        parent_id: Set(None),
        kind: Set(FileEntryKind::Directory),
        name: Set("C:\\".into()),
        hierarchy_path: Set(format!("n{}", root.simple())),
        created_at: Set(now.naive_utc()),
        updated_at: Set(now.naive_utc()),
        ..Default::default()
    }
    .insert(database)
    .await
    .unwrap();
    let file = Uuid::new_v4();
    crate::file_registry::test_support::insert_entry(
        database,
        file_entry::ActiveModel {
            id: Set(file),
            device_id: Set(device),
            parent_id: Set(Some(root)),
            kind: Set(FileEntryKind::File),
            name: Set("large.bin".into()),
            absolute_path: Set(Some("C:\\large.bin".into())),
            hierarchy_path: Set(format!(
                "n{}.n{}",
                root.simple(),
                file.simple()
            )),
            created_at: Set(now.naive_utc()),
            updated_at: Set(now.naive_utc()),
            ..Default::default()
        },
    )
    .await;
    let upload = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let size = 1024 * 1024 * 1024;
    file_content_upload::ActiveModel {
        id: Set(upload),
        device_id: Set(device),
        file_id: Set(file),
        revision: Set(1),
        created_by_login_id: Set(actor),
        upload_length: Set(size),
        expected_sha256: Set(vec![7; 32]),
        object_key: Set(format!(
            "device-file-content/{device}/{file}/1/{upload}"
        )),
        status: Set(FileContentUploadStatus::Open),
        created_at: Set(now.fixed_offset()),
        last_activity_at: Set(now.fixed_offset()),
        expires_at: Set((now + chrono::Duration::hours(1)).fixed_offset()),
        hard_expires_at: Set((now + chrono::Duration::hours(2)).fixed_offset()),
        ..Default::default()
    }
    .insert(database)
    .await
    .unwrap();
    FinalizationCommand {
        created_by_login_id: actor,
        device_id: device,
        source_size_bytes: size,
        source_locator: Some(format!("files/{upload}")),
        target: FinalizationTarget::File {
            upload_id: upload,
            file_id: file,
            revision: 1,
        },
    }
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_large_file_and_poison_audio_do_not_starve_healthy_audio() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let file_command = file_capacity_command(database).await;
    let large = admission::admit(database, &file_command, &settings())
        .await
        .unwrap();
    let poison =
        admission::admit(database, &audio_command(Uuid::new_v4()), &settings())
            .await
            .unwrap();
    let healthy =
        admission::admit(database, &audio_command(Uuid::new_v4()), &settings())
            .await
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    let file_slot =
        resources::try_acquire(root.path(), resources::ResourceKind::File, 1)
            .unwrap()
            .unwrap();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let registration = worker::register(
        database.clone(),
        DeviceUploadFinalizationSettings {
            enabled: false,
            file_slots: 1,
            audio_slots: 2,
            poll_seconds: 1,
            heartbeat_seconds: 1,
            shutdown_grace_seconds: 1,
            ..settings()
        },
        Arc::new(SaturatedExecutor {
            database: database.clone(),
            blocked: Uuid::nil(),
            events,
        }),
        CancellationToken::new(),
    );
    let mut started = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while started.len() < 3 {
            started.push(received.recv().await.unwrap());
        }
    })
    .await
    .unwrap();
    let audio_slot =
        resources::try_acquire(root.path(), resources::ResourceKind::Audio, 1)
            .unwrap();
    registration.shutdown().await;
    drop(file_slot);
    assert!(
        audio_slot.is_some(),
        "file saturation consumed audio capacity"
    );
    for job in [large.job_id, poison.job_id, healthy.job_id] {
        assert!(
            started.contains(&(job, false)),
            "independent work starved: {job}"
        );
    }
    assert_eq!(
        counters(database, "global:file").await,
        (1, 1024 * 1024 * 1024, 0)
    );
    assert_eq!(counters(database, "global:audio").await, (2, 128, 0));
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_due_claim_skips_locked_oldest_and_future_backlog() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let mut due = Vec::new();
    for offset in [30, 20, 10] {
        let job = admission::admit(
            database,
            &audio_command(Uuid::new_v4()),
            &settings(),
        )
        .await
        .unwrap();
        sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-$2*interval '1 second' where id=$1")
            .bind(job.job_id).bind(offset).execute(database.get_postgres_connection_pool()).await.unwrap();
        due.push(job.job_id);
    }
    for _ in 0..64 {
        let job = admission::admit(
            database,
            &audio_command(Uuid::new_v4()),
            &settings(),
        )
        .await
        .unwrap();
        sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()+interval '1 day' where id=$1")
            .bind(job.job_id).execute(database.get_postgres_connection_pool()).await.unwrap();
    }
    let mut locked = database
        .get_postgres_connection_pool()
        .begin()
        .await
        .unwrap();
    sqlx::query(
        "select id from device_upload_finalization_job where id=$1 for update",
    )
    .bind(due[0])
    .fetch_one(&mut *locked)
    .await
    .unwrap();
    for expected in &due[1..] {
        let claim = tokio::time::timeout(
            Duration::from_secs(2),
            worker::claim_due(
                database,
                FinalizationKind::FinalizationAudioKind,
                Uuid::new_v4(),
                worker::ClaimLane::Work,
                60,
            ),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert_eq!(claim.job_id, *expected);
    }
    assert!(worker::claim_due(
        database,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .is_none());
    locked.rollback().await.unwrap();
    let oldest = worker::claim_due(
        database,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(oldest.job_id, due[0]);
    let untouched: i64 = sqlx::query_scalar(
        "select count(*) from device_upload_finalization_job where status='queued' and attempt_count=0",
    ).fetch_one(database.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(untouched, 64);
}
