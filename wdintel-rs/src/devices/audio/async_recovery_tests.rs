use super::async_acceptance_tests::{
    phase5_enqueue, phase5_env, phase5_wait_job,
};
use super::*;
use crate::devices::upload_finalization::{
    self as finalization, query as jobs, resources, types::*,
};
use crate::file_registry::entities::{
    device_upload_finalization_attempt, device_upload_finalization_budget,
};
use crate::types::Env;
use sea_orm::{ColumnTrait, QueryFilter};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn recovery_env(env: &Env, root: &Path) -> Arc<Env> {
    let objects = root.join("objects");
    std::fs::create_dir_all(&objects).unwrap();
    let operator = opendal::Operator::new(
        opendal::services::Fs::default().root(objects.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    phase5_env(env, &root.join("sources"), operator)
}

async fn recovery_audio_device(env: &Env) -> (Uuid, Uuid) {
    let device = enabled_audio_device(env).await;
    system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::EnableAudioTranscription,
            sea_orm::sea_query::Expr::value(true),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    device
}

fn source_path(
    env: &Env,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
) -> PathBuf {
    let mut command = command.clone();
    let (upload, size) = async_ingest::canonicalize(&mut command).unwrap();
    pin::source_path(&env.device_audio, command.device_id, actor, upload, size)
}

fn marker_path(source: &Path, upload: Uuid) -> PathBuf {
    source
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("pins")
        .join(format!("{upload}.json"))
}

async fn job(env: &Env, id: Uuid) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find_by_id(id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn audio_job(env: &Env) -> device_upload_finalization_job::Model {
    device_upload_finalization_job::Entity::find()
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn claim(env: &Env, id: Uuid, reconcile: bool) -> ClaimedFinalizationJob {
    let claim = finalization::worker::claim_due(
        env.device_audio.file_database().unwrap(),
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        if reconcile {
            finalization::worker::ClaimLane::Reconcile
        } else {
            finalization::worker::ClaimLane::Work
        },
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, id);
    claim
}

async fn expire_claim(env: &Env, id: Uuid) {
    sqlx::query("update device_upload_finalization_job set lease_until=case when lease_owner is null then null else clock_timestamp()-interval '1 second' end,next_run_at=clock_timestamp()-interval '1 second' where id=$1 and status not in ('completed','failed')")
        .bind(id).execute(env.device_audio.file_database().unwrap().get_postgres_connection_pool()).await.unwrap();
}

async fn assert_unavailable_delete_retains_source(
    env: &Env,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
) {
    use actix_web::FromRequest;

    let files = crate::file_registry::connect_runtime(
        &env.config,
        crate::types::Mode::Test,
    )
    .await
    .unwrap()
    .unwrap();
    let runtime = build_runtime(
        &env.config,
        &env.dbx,
        Some(&files),
        env.s3.as_ref(),
        None,
    );
    let handler = upload::handler(&runtime, command.device_id).unwrap();
    files.connection().clone().close().await.unwrap();
    let (request, mut empty) = test::TestRequest::delete()
        .insert_header(("tus-resumable", "1.0.0"))
        .to_http_parts();
    let payload = web::Payload::from_request(&request, &mut empty)
        .await
        .unwrap();
    let response = handler
        .handle_request(
            &actor,
            &Method::DELETE,
            request.headers(),
            Some(command.upload_url.rsplit('/').next().unwrap().into()),
            payload,
        )
        .await;
    assert!(response
        .as_ref()
        .map_or(true, |response| response.status().is_server_error()));
    let _ = cleanup_once(&runtime).await;
    let source = source_path(env, actor, command);
    let (upload, _) = async_ingest::canonicalize(&mut command.clone()).unwrap();
    assert!(source.is_file());
    assert!(marker_path(&source, upload).is_file());
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("child did not reach {}", path.display()));
}

async fn wait_child_file(path: &Path, child: &mut tokio::process::Child) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !path.is_file() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before reaching {}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("child did not reach {}", path.display()));
}

fn start_child(
    root: &Path,
    fault_root: &Path,
    stage: &str,
    action: &str,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
    id: Option<Uuid>,
) -> tokio::process::Child {
    std::fs::create_dir_all(fault_root).unwrap();
    std::fs::write(fault_root.join(format!("{stage}.arm")), "*").unwrap();
    let request = root.join("command.json");
    std::fs::write(
        &request,
        serde_json::to_vec(&json!({
            "actor": actor, "command": receive_request(command), "job": id,
        }))
        .unwrap(),
    )
    .unwrap();
    tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["devices::audio::acceptance_tests::async_recovery_tests::phase7_audio_recovery_child", "--exact", "--ignored", "--nocapture"])
        .env("PHASE7_AUDIO_RECOVERY_ROOT", root)
        .env("PHASE7_AUDIO_RECOVERY_REQUEST", request)
        .env("PHASE7_AUDIO_RECOVERY_ACTION", action)
        .env("PHASE7_AUDIO_RECOVERY_STAGE", stage)
        .env("ECHO_UPLOAD_FINALIZATION_FAULT_ROOT", fault_root)
        .kill_on_drop(true)
        .spawn().unwrap()
}

async fn kill_at(
    root: &Path,
    stage: &str,
    action: &str,
    actor: Uuid,
    command: &types::ReceiveDeviceAudioCommand,
    id: Option<Uuid>,
) {
    let faults = root.join(format!("fault-{stage}-{}", Uuid::new_v4()));
    let mut child =
        start_child(root, &faults, stage, action, actor, command, id);
    let reached = faults.join(format!("{stage}.reached"));
    wait_child_file(&reached, &mut child).await;
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(reached).unwrap()).unwrap();
    assert_eq!(
        receipt["pid"].as_u64().unwrap(),
        u64::from(child.id().unwrap())
    );
    child.kill().await.unwrap();
    assert!(!child.wait().await.unwrap().success());
}

async fn run_to_terminal(
    env: &Arc<Env>,
    id: Uuid,
) -> device_upload_finalization_job::Model {
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel = cancellation.clone().drop_guard();
    let background = tokio::spawn(finalization::worker::run_audio(
        env.clone(),
        env.device_audio.clone(),
        cancellation.clone(),
    ));
    let terminal = phase5_wait_job(env, id, true).await;
    cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(5), background)
        .await
        .unwrap()
        .unwrap();
    terminal
}

async fn assert_publication(env: &Env, id: Uuid, bytes: &[u8]) {
    let job = job(env, id).await;
    assert_eq!(job.status, "completed", "{:?}", job.error_code);
    let db = env.device_audio.file_database().unwrap();
    let audio = device_audio::Entity::find_by_id(job.audio_id.unwrap())
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let ingest = device_audio_ingest::Entity::find_by_id(audio.ingest_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        job.winning_attempt_id.unwrap(),
    )
    .one(db)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ingest.id, attempt.id);
    assert_eq!(ingest.status, "ready");
    assert_eq!(attempt.phase, "selected");
    assert_eq!(audio.storage_key, attempt.object_key);
    assert_eq!(
        job.result.as_ref().unwrap()["value"]["audio"]["id"],
        audio.id.to_string()
    );
    assert_eq!(device_audio::Entity::find().count(db).await.unwrap(), 1);
    assert_eq!(
        device_audio_ingest::Entity::find().count(db).await.unwrap(),
        1
    );
    assert_eq!(
        device_audio::Entity::find()
            .filter(device_audio::Column::AutomaticTranscriptionPending.eq(0))
            .count(db)
            .await
            .unwrap(),
        1
    );
    let store = env.device_audio.byte_store().unwrap();
    let plaintext = crate::storage::download_and_decrypt_from_s3_with_operator(
        &Some(store.operator.clone()),
        &Some(store.config.clone()),
        &store.strongbox_key,
        &audio.storage_key,
    )
    .await
    .unwrap();
    assert_eq!(plaintext.as_slice(), bytes);
}

#[actix_web::test]
#[ignore = "child entry point; parent owns database preparation and cleanup"]
async fn phase7_audio_recovery_child() {
    let root =
        PathBuf::from(std::env::var_os("PHASE7_AUDIO_RECOVERY_ROOT").unwrap());
    let request: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var_os("PHASE7_AUDIO_RECOVERY_REQUEST").unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    let actor = Uuid::parse_str(request["actor"].as_str().unwrap()).unwrap();
    let command = &request["command"];
    let command = types::ReceiveDeviceAudioCommand {
        device_id: Uuid::parse_str(command["device_id"].as_str().unwrap())
            .unwrap(),
        name: command["name"].as_str().unwrap().into(),
        upload_url: command["upload_url"].as_str().unwrap().into(),
        recording_started_at: command["recording_started_at"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    };
    let base = crate::server::new_readonly_env(crate::types::Mode::Test)
        .await
        .unwrap();
    let env = recovery_env(&base, &root);
    let action = std::env::var("PHASE7_AUDIO_RECOVERY_ACTION").unwrap();
    if action == "receive" {
        let response =
            async_ingest::receive(&env, actor, command).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        return;
    }
    let id = Uuid::parse_str(request["job"].as_str().unwrap()).unwrap();
    if action == "cleanup" {
        async_cleanup::cleanup_source(&env.device_audio, id)
            .await
            .unwrap();
        return;
    }
    let claim = claim(&env, id, false).await;
    if action == "cancel" {
        let owned = env.clone();
        let outer = tokio::spawn(async move {
            ingest::finalize_claim(&owned, &owned.device_audio, claim).await
        });
        let faults = PathBuf::from(
            std::env::var_os("ECHO_UPLOAD_FINALIZATION_FAULT_ROOT").unwrap(),
        );
        let stage = std::env::var("PHASE7_AUDIO_RECOVERY_STAGE").unwrap();
        wait_file(&faults.join(format!("{stage}.reached"))).await;
        outer.abort();
        assert!(outer.await.unwrap_err().is_cancelled());
        let spare = resources::try_acquire(
            &env.device_audio.storage_dir,
            resources::ResourceKind::Audio,
            2,
        )
        .unwrap()
        .unwrap();
        assert!(resources::try_acquire(
            &env.device_audio.storage_dir,
            resources::ResourceKind::Audio,
            2
        )
        .unwrap()
        .is_none());
        let source = source_path(&env, actor, &command);
        let root = source.parent().unwrap().parent().unwrap().parent().unwrap();
        let (upload, _) =
            async_ingest::canonicalize(&mut command.clone()).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("locks").join(upload.to_string()))
            .unwrap();
        assert_eq!(
            fs2::FileExt::try_lock_exclusive(&lock).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(source.is_file());
        std::fs::write(faults.join("cancel.checked"), "held").unwrap();
        wait_file(&faults.join(format!("{stage}.release"))).await;
        drop(spare);
        phase5_wait_job(&env, id, false).await;
    } else {
        ingest::finalize_claim(&env, &env.device_audio, claim)
            .await
            .unwrap();
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_cleanup_child_exit_preserves_directory_proof_through_generic_pruning(
) {
    use std::os::unix::fs::MetadataExt;

    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "cleanup crash",
        bytes.clone(),
    )
    .await;
    let id = phase5_enqueue(env.clone(), actor, &command).await;
    let claim = claim(&env, id, false).await;
    ingest::finalize_claim(&env, &env.device_audio, claim)
        .await
        .unwrap();
    let before = job(&env, id).await;
    assert_eq!(before.status, "completed");
    let source = source_path(&env, actor, &command);
    let directory = source.parent().unwrap();
    let inode = std::fs::metadata(directory).unwrap().ino();
    let (upload, _) = async_ingest::canonicalize(&mut command.clone()).unwrap();
    let proof = marker_path(&source, upload)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("locks")
        .join(upload.to_string());
    let original_proof = std::fs::read(&proof).unwrap();
    let lock_inode = std::fs::metadata(&proof).unwrap().ino();
    kill_at(
        root.path(),
        "audio_source_removed",
        "cleanup",
        actor,
        &command,
        Some(id),
    )
    .await;
    assert!(!source.exists());
    assert_eq!(job(&env, id).await.source_release_state, "release_pending");
    assert_eq!(std::fs::read(&proof).unwrap(), original_proof);
    cleanup_once(&env.device_audio).await.unwrap();
    assert_eq!(std::fs::metadata(directory).unwrap().ino(), inode);
    for _ in 0..2 {
        async_cleanup::cleanup_source(&env.device_audio, id)
            .await
            .unwrap();
    }
    let after = job(&env, id).await;
    assert_eq!(after.source_release_state, "released");
    assert!(after.quota_released_at.is_some());
    assert!(std::fs::read(&proof).unwrap().is_empty());
    assert_eq!(std::fs::metadata(&proof).unwrap().ino(), lock_inode);
    assert_eq!(after.result, before.result);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.finished_at, before.finished_at);
    let budget = device_upload_finalization_budget::Entity::find_by_id(
        "global:audio".to_owned(),
    )
    .one(env.device_audio.file_database().unwrap())
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            budget.reserved_jobs,
            budget.reserved_source_bytes,
            budget.unresolved_writes
        ),
        (0, 0, 0)
    );
    assert_publication(&env, id, &bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_released_proof_recovery_preserves_lock_inode() {
    use crate::sigint::file_upload::lifecycle::UploadLock;
    use std::os::unix::fs::MetadataExt;

    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "released proof",
        bytes.clone(),
    )
    .await;
    let id = phase5_enqueue(env.clone(), actor, &command).await;
    let claim = claim(&env, id, false).await;
    ingest::finalize_claim(&env, &env.device_audio, claim)
        .await
        .unwrap();
    let source = source_path(&env, actor, &command);
    let (upload, _) = async_ingest::canonicalize(&mut command.clone()).unwrap();
    let pin = marker_path(&source, upload);
    let upload_root = pin.parent().unwrap().parent().unwrap();
    let proof = upload_root.join("locks").join(upload.to_string());
    let original = std::fs::read(&proof).unwrap();
    let descriptor = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&proof)
        .unwrap();
    let inode = descriptor.metadata().unwrap().ino();
    let db = env.device_audio.file_database().unwrap();
    let (record, _) = jobs::read_job(db, id).await.unwrap().unwrap();
    pin::LockedSource::recover(&env.device_audio, &record)
        .await
        .unwrap()
        .remove_source()
        .unwrap();
    assert!(!source.exists());
    assert!(!pin.exists());
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&proof).unwrap(), original);

    sqlx::query("update device_upload_finalization_job set source_release_state='released',source_released_at=clock_timestamp() where id=$1")
        .bind(id).execute(db.get_postgres_connection_pool()).await.unwrap();
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&proof).unwrap(), original);
    assert!(job(&env, id).await.quota_released_at.is_none());
    assert!(jobs::release_source_quota(db, id).await.unwrap());
    let released = job(&env, id).await;

    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["pin_token"] = json!(Uuid::new_v4());
    let changed = serde_json::to_vec(&changed).unwrap();
    std::fs::write(&proof, &changed).unwrap();
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&proof).unwrap(), changed);
    std::fs::write(&proof, &original).unwrap();
    let lock = UploadLock::acquire(upload_root, upload).await.unwrap();
    assert!(
        async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&proof).unwrap(), original);
    drop(lock);

    for _ in 0..2 {
        async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
            .await
            .unwrap();
        assert!(std::fs::read(&proof).unwrap().is_empty());
        assert_eq!(std::fs::metadata(&proof).unwrap().ino(), inode);
        assert_eq!(job(&env, id).await, released);
    }
    let _lock = UploadLock::acquire(upload_root, upload).await.unwrap();
    assert_eq!(
        fs2::FileExt::try_lock_exclusive(&descriptor)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_publication(&env, id, &bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_orphan_pin_requires_authoritative_absence_before_authenticated_retry(
) {
    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "orphan after child exit",
        bytes.clone(),
    )
    .await;
    let source = source_path(&env, actor, &command);
    let (upload, _) = async_ingest::canonicalize(&mut command.clone()).unwrap();
    kill_at(
        root.path(),
        "audio_source_pinned",
        "receive",
        actor,
        &command,
        None,
    )
    .await;
    let marker = marker_path(&source, upload);
    assert!(marker.is_file());
    assert_eq!(
        device_upload_finalization_job::Entity::find()
            .count(env.device_audio.file_database().unwrap())
            .await
            .unwrap(),
        0
    );
    let files = crate::file_registry::connect_runtime(
        &env.config,
        crate::types::Mode::Test,
    )
    .await
    .unwrap()
    .unwrap();
    let unavailable = build_runtime(
        &env.config,
        &env.dbx,
        Some(&files),
        env.s3.as_ref(),
        None,
    );
    files.connection().clone().close().await.unwrap();
    assert!(
        async_cleanup::reconcile_orphan(&unavailable, device, upload)
            .await
            .is_err()
    );
    let _ = cleanup_once(&unavailable).await;
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert!(marker.is_file());
    let original_marker = std::fs::read(&marker).unwrap();
    let mut changed: Value = serde_json::from_slice(&original_marker).unwrap();
    changed["pin_token"] = Uuid::new_v4().to_string().into();
    std::fs::write(&marker, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(
        async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert!(marker.is_file());
    std::fs::write(&marker, original_marker).unwrap();
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert!(!marker.exists());
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    let id = phase5_enqueue(env.clone(), actor, &command).await;
    assert_eq!(run_to_terminal(&env, id).await.status, "completed");
    assert_publication(&env, id, &bytes).await;

    let interrupted = receive_command(
        &env.device_audio,
        actor,
        device,
        "interrupted ownership proof write",
        bytes.clone(),
    )
    .await;
    kill_at(
        root.path(),
        "audio_source_pinned",
        "receive",
        actor,
        &interrupted,
        None,
    )
    .await;
    let source = source_path(&env, actor, &interrupted);
    let (upload, _) =
        async_ingest::canonicalize(&mut interrupted.clone()).unwrap();
    let marker = marker_path(&source, upload);
    let canonical = std::fs::read(&marker).unwrap();
    let proof = marker
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("locks")
        .join(upload.to_string());
    std::fs::write(&proof, b"arbitrary proof corruption").unwrap();
    assert!(
        async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
            .await
            .is_err()
    );
    assert!(marker.is_file());
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    let written = canonical.len() / 2;
    let mut interrupted_proof = vec![0; canonical.len()];
    interrupted_proof[..written].copy_from_slice(&canonical[..written]);
    std::fs::write(&proof, interrupted_proof).unwrap();
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert!(!marker.exists());
    assert!(std::fs::read(&proof).unwrap().is_empty());
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_accepted_commit_survives_child_exit_and_disabled_admission(
) {
    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "accepted before lost response",
        bytes.clone(),
    )
    .await;
    kill_at(
        root.path(),
        "audio_admission_committed",
        "receive",
        actor,
        &command,
        None,
    )
    .await;
    let accepted = audio_job(&env).await;
    assert_eq!(accepted.status, "queued");
    let source = source_path(&env, actor, &command);
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    let (upload, _) = async_ingest::canonicalize(&mut command.clone()).unwrap();
    async_cleanup::reconcile_orphan(&env.device_audio, device, upload)
        .await
        .unwrap();
    assert!(marker_path(&source, upload).is_file());
    assert_unavailable_delete_retains_source(&env, actor, &command).await;
    let budget = device_upload_finalization_budget::Entity::find_by_id(
        "global:audio".to_owned(),
    )
    .one(env.device_audio.file_database().unwrap())
    .await
    .unwrap()
    .unwrap();
    assert_eq!(budget.reserved_jobs, 1);
    assert_eq!(budget.reserved_source_bytes, bytes.len() as i64);
    let mut disabled = (*env).clone();
    disabled
        .config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .enabled = false;
    let disabled = Arc::new(disabled);
    let completed = run_to_terminal(&disabled, accepted.id).await;
    assert_eq!(completed.audio_id, accepted.audio_id);
    assert!(!source.exists());
    assert_publication(&disabled, accepted.id, &bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_storage_and_publication_child_exits_reconcile_one_atomic_publication(
) {
    for stage in [
        "storage_written",
        "storage_verified",
        "audio_publication_committed",
    ] {
        let (base, _guard) = cleanup_locked().await.unwrap();
        let root = tempfile::tempdir().unwrap();
        let env = recovery_env(&base, root.path());
        let (actor, device) = recovery_audio_device(&env).await;
        let bytes = native_audio_bytes().await;
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            stage,
            bytes.clone(),
        )
        .await;
        let id = phase5_enqueue(env.clone(), actor, &command).await;
        let accepted = job(&env, id).await;
        kill_at(root.path(), stage, "finalize", actor, &command, Some(id))
            .await;
        let interrupted = job(&env, id).await;
        let db = env.device_audio.file_database().unwrap();
        let published = stage == "audio_publication_committed";
        assert_eq!(
            device_audio::Entity::find().count(db).await.unwrap(),
            u64::from(published)
        );
        assert_eq!(
            device_audio::Entity::find()
                .filter(
                    device_audio::Column::AutomaticTranscriptionPending.eq(0)
                )
                .count(db)
                .await
                .unwrap(),
            u64::from(published)
        );
        assert_eq!(interrupted.status == "completed", published);
        assert_eq!(
            std::fs::read(source_path(&env, actor, &command)).unwrap(),
            bytes
        );
        let attempt = interrupted.active_attempt_id.unwrap();
        expire_claim(&env, id).await;
        let completed = run_to_terminal(&env, id).await;
        assert_eq!(completed.audio_id, accepted.audio_id);
        assert_eq!(completed.winning_attempt_id, Some(attempt));
        assert_eq!(
            device_upload_finalization_attempt::Entity::find()
                .count(db)
                .await
                .unwrap(),
            1
        );
        assert_publication(&env, id, &bytes).await;
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_late_put_after_takeover_reconciles_original_attempt_and_fences_stale_owner(
) {
    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "late original encrypted write",
        bytes.clone(),
    )
    .await;
    let id = phase5_enqueue(env.clone(), actor, &command).await;
    kill_at(
        root.path(),
        "write_intent",
        "finalize",
        actor,
        &command,
        Some(id),
    )
    .await;
    let interrupted = job(&env, id).await;
    let old = ClaimedFinalizationJob {
        job_id: id,
        owner: interrupted.lease_owner.unwrap(),
        lease_epoch: interrupted.lease_epoch,
        kind: FinalizationKind::FinalizationAudioKind,
        requires_reconciliation: false,
    };
    let db = env.device_audio.file_database().unwrap();
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        interrupted.active_attempt_id.unwrap(),
    )
    .one(db)
    .await
    .unwrap()
    .unwrap();
    assert!(attempt.write_credit_held);
    expire_claim(&env, id).await;
    let reclaimed = claim(&env, id, true).await;
    assert!(reclaimed.lease_epoch > old.lease_epoch);
    ingest::finalize_claim(&env, &env.device_audio, reclaimed)
        .await
        .unwrap();
    let unknown = job(&env, id).await;
    assert_eq!(unknown.status, "outcome_unknown");
    assert!(unknown.finished_at.is_none());
    assert!(source_path(&env, actor, &command).is_file());
    let store = env.device_audio.byte_store().unwrap();
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(store.operator.clone()),
        &store.config,
        &store.strongbox_key,
        &attempt.object_key,
        bytes.clone(),
    )
    .await
    .unwrap();
    expire_claim(&env, id).await;
    let completed = run_to_terminal(&env, id).await;
    assert_eq!(completed.winning_attempt_id, Some(attempt.id));
    assert!(!jobs::record_verified(db, &old, attempt.id).await.unwrap());
    ingest::finalize_claim(&env, &env.device_audio, old)
        .await
        .unwrap();
    assert!(!env
        .device_audio
        .managed_storage
        .as_ref()
        .unwrap()
        .cleanup_retired(db, attempt.id, Duration::from_secs(2))
        .await
        .unwrap());
    assert_publication(&env, id, &bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_audio_nested_cancellation_retains_source_and_slot_until_publication_finishes(
) {
    let (base, _guard) = cleanup_locked().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = recovery_env(&base, root.path());
    let (actor, device) = recovery_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        "cancel outer waiter",
        bytes.clone(),
    )
    .await;
    let id = phase5_enqueue(env.clone(), actor, &command).await;
    let stage = "storage_verified";
    let faults = root.path().join("fault-cancellation");
    let mut child = start_child(
        root.path(),
        &faults,
        stage,
        "cancel",
        actor,
        &command,
        Some(id),
    );
    wait_child_file(&faults.join("cancel.checked"), &mut child).await;
    assert_eq!(job(&env, id).await.status, "processing");
    assert!(source_path(&env, actor, &command).is_file());
    std::fs::write(faults.join(format!("{stage}.release")), "continue")
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    assert_publication(&env, id, &bytes).await;
}
