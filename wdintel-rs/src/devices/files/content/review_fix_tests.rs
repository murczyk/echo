use super::*;
use crate::devices::upload_finalization::{
    admission,
    resources::{self, ResourceKind},
    types::{FinalizationCommand, FinalizationTarget},
};

#[actix_web::test]
#[serial_test::serial]
async fn async_file_admission_honors_configured_source_lock_budget() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut env = async_file_env(&env, &fixture, true);
    Arc::get_mut(&mut env)
        .unwrap()
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .source_lock_millis = 50;
    let file = fixture.file("source-lock-budget").await;
    let upload = fixture.upload(&file, b"source").await;
    let held = fixture.seed_bytes(&upload, b"source").await;
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::super::resource_location(upload.id)
                ))
                .cookie(cookie)
                .insert_header(("tus-resumable", "1.0.0"))
                .set_json(json!({"async_finalization": true}))
                .to_request(),
        ),
    )
    .await
    .expect("async admission ignored its 50 ms source-lock budget");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(
        test::read_body_json::<Value, _>(response).await["code"],
        "upload_busy"
    );
    assert_eq!(held.offset().unwrap(), 6);
    assert_finalization_source_unpublished(&fixture, &upload, b"source").await;
}

#[actix_web::test]
#[serial_test::serial]
async fn review_r2_delete_waiting_for_admission_commit_preserves_owned_source()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let bytes = b"accepted while DELETE waits";
    let file = fixture.file("delete-admission-race").await;
    let upload = fixture.upload(&file, bytes).await;
    let source = fixture.seed_bytes(&upload, bytes).await;
    source.make_durable(upload.upload_length).await.unwrap();
    let mut transaction = fixture
        .db()
        .get_postgres_connection_pool()
        .begin()
        .await
        .unwrap();
    let pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
    let accepted = admission::admit_in(
        &mut transaction,
        &FinalizationCommand {
            created_by_login_id: fixture.login.id,
            device_id: fixture.device.id,
            source_size_bytes: bytes.len() as i64,
            source_locator: Some(format!("{}.data", upload.id)),
            target: FinalizationTarget::File {
                upload_id: upload.id,
                file_id: upload.file_id,
                revision: upload.revision,
            },
        },
        env.config.device_upload_finalization.as_ref().unwrap(),
    )
    .await
    .unwrap();
    drop(source);
    assert!(
        !crate::devices::upload_finalization::query::file_source_is_pinned(
            fixture.db(),
            upload.id,
        )
        .await
        .unwrap()
    );
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let request = test::call_service(
        &app,
        test::TestRequest::delete()
            .uri(&super::super::resource_location(upload.id))
            .cookie(cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    );
    let commit = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid)))",
                ).bind(pid).fetch_one(fixture.db().get_postgres_connection_pool())
                    .await.unwrap();
                if waiting { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("DELETE never waited on admission's row lock");
        transaction.commit().await.unwrap();
    };
    let (response, ()) = tokio::join!(request, commit);
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["code"], "upload_finalization_owned");
    assert_eq!(fixture.persisted(&upload).await.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Open);
    assert_file_job_reserved(&fixture, &upload, accepted.job_id).await;
    assert_finalization_source_unpublished(&fixture, &upload, bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn review_r3_shared_slots_refresh_near_expiry_sync_upload() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    for resource in [ResourceKind::File, ResourceKind::Encryption] {
        let bytes = b"plain text requiring encryption";
        let file = fixture.file("near-expiry-shared-slot").await;
        let mut request = fixture.request(&file, bytes);
        request.now -= Duration::seconds(
            fixture.runtime.config.upload_idle_ttl_secs as i64 - 30,
        );
        let CreateOutcome::Created(upload) = repository::create_or_replay(
            fixture.db(),
            request,
            &fixture.runtime.config,
        )
        .await
        .unwrap() else {
            panic!("expected near-expiry upload");
        };
        drop(fixture.seed_bytes(&upload, bytes).await);
        let before = fixture.persisted(&upload).await;
        let held = resources::legacy_slot(&env, resource)
            .await
            .unwrap()
            .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        let after = fixture.persisted(&upload).await;
        assert!(
            after.expires_at > before.expires_at + Duration::seconds(30),
            "retryable shared-slot failure did not refresh idle expiry"
        );
        assert_eq!(after.hard_expires_at, before.hard_expires_at);
        drop(held);
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "{}/complete",
                    super::super::resource_location(upload.id)
                ))
                .cookie(cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn review_r4_retired_cleanup_retries_failure_amid_recurring_tombstones() {
    use crate::storage::finalization::ManagedStorage;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let mut retired = Vec::new();
    for index in 0..4 {
        let bytes = b"published file with permanent canonical tombstone";
        let file = fixture.file(&format!("cleanup-fairness-{index}")).await;
        let upload = fixture.upload(&file, bytes).await;
        drop(fixture.seed_bytes(&upload, bytes).await);
        let job = admit_file_source(&fixture, &upload).await;
        let claim = claim_file_job(&fixture, job).await;
        finalizer::finalize_claim(&env, &fixture.runtime, claim)
            .await
            .unwrap();
        let id: Uuid = sqlx::query_scalar("select id from device_upload_finalization_attempt where job_id=$1 and origin='legacy_cleanup' and phase='retired'")
            .bind(job).fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
        sqlx::query("update device_upload_finalization_attempt set cleanup_next_at=clock_timestamp()-interval '1 day'+$2*interval '1 second' where id=$1")
            .bind(id).bind(index).execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
        fixture
            .runtime
            .storage
            .write(&upload.object_key, b"late obsolete PUT".to_vec())
            .await
            .unwrap();
        retired.push((id, upload.object_key));
    }
    let mut runtime = (*fixture.runtime).clone();
    runtime.config.cleanup_batch_size = 1;
    let storage_root = tempfile::tempdir().unwrap();
    let unavailable = storage_root.path().join("unavailable");
    std::fs::create_dir(&unavailable).unwrap();
    let broken = opendal::Operator::new(
        opendal::services::Fs::default().root(unavailable.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    std::fs::remove_dir(&unavailable).unwrap();
    std::fs::write(&unavailable, b"not a directory").unwrap();
    runtime.managed_storage = Arc::new(
        ManagedStorage::for_test(
            broken,
            runtime.storage_config.clone(),
            &runtime.strongbox_key,
        )
        .unwrap(),
    );
    let mut sweep = super::super::async_cleanup::TestAttemptSweep::default();
    sweep.run(&runtime).await.unwrap();
    let failed =
        device_upload_finalization_attempt::Entity::find_by_id(retired[0].0)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    assert!(failed.cleanup_confirmed_at.is_none());
    runtime.managed_storage = fixture.runtime.managed_storage.clone();
    for _ in 0..12 {
        sweep.run(&runtime).await.unwrap();
        // Advance recurring successful tombstones to due again, as after a poll interval.
        sqlx::query("update device_upload_finalization_attempt set cleanup_next_at=clock_timestamp() where phase='retired' and late_write_possible and cleanup_confirmed_at is not null")
            .execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
    }
    let failed =
        device_upload_finalization_attempt::Entity::find_by_id(retired[0].0)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    assert!(
        failed.cleanup_confirmed_at.is_some(),
        "earlier transient DELETE failure was starved by recurring successful tombstones"
    );
    for (id, key) in retired {
        assert!(!runtime.storage.exists(&key).await.unwrap());
        let tombstone =
            device_upload_finalization_attempt::Entity::find_by_id(id)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert!(tombstone.late_write_possible);
        assert!(tombstone.cleanup_next_at.is_some());
    }
}

struct CommitLossProxy {
    root: tempfile::TempDir,
    _process: tokio::process::Child,
    database: crate::file_registry::FileRegistryDb,
}

impl CommitLossProxy {
    async fn start(env: &Env) -> Self {
        let root = tempfile::tempdir().unwrap();
        let (host, port, _, _, database) = crate::wdfile_connection_parts(
            env.config.file_registry.as_ref().unwrap(),
            crate::types::Mode::Test,
        );
        assert!(
            host == "127.0.0.1" || host == "localhost",
            "fault proxy requires an owned local database"
        );
        std::fs::write(
            root.path().join("pg-control.json"),
            br#"{"mode":"normal"}"#,
        )
        .unwrap();
        let script = r#"
import json, sys
from pathlib import Path
from upload_finalization_pg_proxy import Proxy
root = Path(sys.argv[1])
with Proxy(root, {"pg_proxy_port": 0, "pg_port": int(sys.argv[2]), "files_db": sys.argv[3]}) as proxy:
    (root / "port").write_text(str(proxy.server_address[1]))
    proxy.serve_forever()
"#;
        let process = tokio::process::Command::new("python3")
            .args(["-c", script])
            .arg(root.path())
            .arg(port.to_string())
            .arg(database)
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/devices"),
            )
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !root.path().join("port").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("PostgreSQL fault proxy did not start");
        let port = std::fs::read_to_string(root.path().join("port"))
            .unwrap()
            .parse()
            .unwrap();
        let mut config = env.config.clone();
        config.file_registry.as_mut().unwrap().pg_port = Some(port);
        let database = crate::file_registry::connect_runtime(
            &config,
            crate::types::Mode::Test,
        )
        .await
        .unwrap()
        .unwrap();
        Self {
            root,
            _process: process,
            database,
        }
    }

    fn control(&self, value: Value) {
        let path = self.root.path().join("control.tmp");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        std::fs::rename(path, self.root.path().join("pg-control.json"))
            .unwrap();
    }

    async fn wait_for_loss(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let control =
                    std::fs::read(self.root.path().join("pg-control.json"))
                        .unwrap();
                if serde_json::from_slice::<Value>(&control).unwrap()["mode"]
                    == "unavailable"
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("write-intent COMMIT acknowledgement was not suppressed");
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn review_r1_lost_intent_commit_recovers_original_job_after_takeover() {
    use crate::devices::upload_finalization::{
        fault, query,
        types::FinalizationKind,
        worker::{claim_due, ClaimLane},
    };

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let proxy = CommitLossProxy::start(&env).await;
    let mut runtime = (*fixture.runtime).clone();
    runtime.file_registry_db = proxy.database.clone();
    let bytes = b"known undispatched bytes survive database outage";
    let file = fixture.file("lost-intent-commit").await;
    let upload = fixture.upload(&file, bytes).await;
    drop(fixture.seed_bytes(&upload, bytes).await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let old = claim_file_job(&fixture, job_id).await;
    proxy.control(json!({"mode": "drop-commit-and-block", "target": "write-intent", "job_id": job_id}));
    let runner_env = env.clone();
    let runner_claim = old.clone();
    let task = tokio::spawn(async move {
        finalizer::finalize_claim(&runner_env, &runtime, runner_claim).await
    });
    proxy.wait_for_loss().await;
    let attempt: Uuid = sqlx::query_scalar("select active_attempt_id from device_upload_finalization_job where id=$1")
        .bind(job_id).fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
    assert_eq!(fault::storage_dispatches(attempt), 0);
    let before =
        device_upload_finalization_attempt::Entity::find_by_id(attempt)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    assert!(before.write_intent_at.is_some());
    assert!(before.write_credit_held);
    // Expire the old owner while its connection cannot persist the zero-dispatch proof.
    sqlx::query("update device_upload_finalization_job set lease_until=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job_id).execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
    let current = claim_due(
        fixture.db(),
        FinalizationKind::FinalizationFileKind,
        Uuid::new_v4(),
        ClaimLane::Reconcile,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(current.job_id, job_id);
    assert!(current.lease_epoch > old.lease_epoch);
    proxy.control(json!({"mode": "normal"}));
    let _ = tokio::time::timeout(std::time::Duration::from_secs(20), task)
        .await
        .expect("known no-dispatch evidence did not settle after DB recovery")
        .unwrap();
    let resolved =
        device_upload_finalization_attempt::Entity::find_by_id(attempt)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        resolved.phase, "retired",
        "known no-dispatch attempt remained ambiguous"
    );
    assert!(!resolved.write_credit_held);
    assert!(resolved.write_resolved_at.is_some());
    assert_eq!(fault::storage_dispatches(attempt), 0);
    assert!(query::is_current(fixture.db(), &current).await.unwrap());
    assert!(!query::is_current(fixture.db(), &old).await.unwrap());
    finalizer::finalize_claim(&env, &fixture.runtime, current)
        .await
        .unwrap();
    let retry = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry.status, "retry_wait");
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job_id).execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_selected_file_bytes(&fixture, &upload, job_id, bytes).await;
    let completed = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.status, "completed");
    assert_eq!(
        fault::storage_dispatches(completed.winning_attempt_id.unwrap()),
        1
    );
    let credits: i64 = sqlx::query_scalar("select unresolved_writes from device_upload_finalization_budget where scope='global:file'")
        .fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
    assert_eq!(credits, 0);
}
