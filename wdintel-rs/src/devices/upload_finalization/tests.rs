use super::types::{
    FinalizationCommand, FinalizationFailure, FinalizationKind,
    FinalizationTarget, PreparedAudio, WriteResolution,
};
use super::{admission, query, recovery, resources, worker};
use crate::functest::tests::cleanup_locked;
use crate::types::{DeviceUploadFinalizationSettings, Mode};
use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend,
    Statement, TransactionTrait,
};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn audio_command(actor: Uuid) -> FinalizationCommand {
    FinalizationCommand {
        created_by_login_id: actor,
        device_id: Uuid::new_v4(),
        source_size_bytes: 64,
        source_locator: Some(format!("audio/{}", Uuid::new_v4())),
        target: FinalizationTarget::Audio {
            tus_id: Uuid::new_v4(),
            audio_id: Uuid::new_v4(),
            name: "Приймання 1".into(),
            recording_started_at: "2026-10-14T08:00:00.123456Z"
                .parse::<DateTime<Utc>>()
                .unwrap(),
            pin_token: Uuid::new_v4(),
        },
    }
}

fn settings() -> DeviceUploadFinalizationSettings {
    DeviceUploadFinalizationSettings {
        enabled: true,
        ..Default::default()
    }
}

fn prepared_audio() -> PreparedAudio {
    PreparedAudio {
        media_type: "audio/wav".into(),
        duration_seconds: 1.0,
        recording_ended_at: "2026-10-14T08:00:01.123456Z"
            .parse::<DateTime<Utc>>()
            .unwrap(),
    }
}

#[tokio::test]
#[serial_test::serial]
async fn archived_device_write_keeps_form_error_and_owned_snapshot_readable() {
    use crate::devices::tests::schema::device_active_model;
    use crate::entities::{login, system_settings};
    use crate::error::AppError;
    use crate::functest::tests::{mk_login, mk_organism};
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
    use serde_json::json;

    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let actor = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("finalization-access-{}", Uuid::new_v4())),
            organism_id: Set(Some(organism.id)),
            roles: Set(json!(["Cyber"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let device = device_active_model(
        &actor.login,
        organism.id,
        None,
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    for kind in [
        FinalizationKind::FinalizationFileKind,
        FinalizationKind::FinalizationAudioKind,
    ] {
        super::authorize_write(&env, actor.id, device.id, kind)
            .await
            .unwrap();
    }
    let mut command = audio_command(actor.id);
    command.device_id = device.id;
    let job = admission::admit(
        env.file_registry_db.as_ref().unwrap().connection(),
        &command,
        &settings(),
    )
    .await
    .unwrap();
    let mut device = device.into_active_model();
    device.archived = Set(true);
    device.archived_at = Set(Some(Utc::now().naive_utc()));
    let device = device.update(&env.dbx).await.unwrap();
    for kind in [
        FinalizationKind::FinalizationFileKind,
        FinalizationKind::FinalizationAudioKind,
    ] {
        let error = super::authorize_write(&env, actor.id, device.id, kind)
            .await
            .unwrap_err();
        assert!(
            matches!(&error, AppError::Form(fields) if fields.contains_key("device_id")),
            "archived writes must retain their permanent validation error: {error:?}"
        );
    }
    assert_eq!(
        super::get_snapshot(&env, job.job_id, actor.id)
            .await
            .unwrap()
            .job_id,
        job.job_id
    );
    let mut actor = actor.into_active_model();
    actor.roles = Set(json!([]));
    let actor = actor.update(&env.dbx).await.unwrap();
    for kind in [
        FinalizationKind::FinalizationFileKind,
        FinalizationKind::FinalizationAudioKind,
    ] {
        let error = super::authorize_write(&env, actor.id, device.id, kind)
            .await
            .unwrap_err();
        assert!(matches!(&error, AppError::Forbidden(_)), "{error:?}");
    }
    assert!(matches!(
        super::get_snapshot(&env, job.job_id, actor.id).await,
        Err(AppError::NotFound)
    ));
}

async fn counters(db: &DatabaseConnection, scope: &str) -> (i64, i64, i64) {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select reserved_jobs::bigint, reserved_source_bytes, unresolved_writes::bigint \
             from device_upload_finalization_budget where scope = $1",
            [scope.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    (
        row.try_get("", "reserved_jobs").unwrap(),
        row.try_get("", "reserved_source_bytes").unwrap(),
        row.try_get("", "unresolved_writes").unwrap(),
    )
}

async fn make_due(db: &DatabaseConnection, job: Uuid, expired: bool) {
    let sql = if expired {
        "update device_upload_finalization_job \
         set lease_until = clock_timestamp() - interval '1 second' where id = $1"
    } else {
        "update device_upload_finalization_job \
         set next_run_at = clock_timestamp() - interval '1 second' where id = $1"
    };
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [job.into()],
    ))
    .await
    .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn duplicate_source_admission_charges_once_and_release_is_idempotent() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let settings = DeviceUploadFinalizationSettings {
        enabled: true,
        audio_actor_jobs: 1,
        ..Default::default()
    };
    let command = audio_command(Uuid::new_v4());
    let submissions =
        (0..20).map(|_| admission::admit(db, &command, &settings));
    let jobs = futures::future::join_all(submissions).await;
    let job_id = jobs[0].as_ref().unwrap().job_id;
    assert!(jobs
        .iter()
        .all(|job| job.as_ref().unwrap().job_id == job_id));
    let actor_scope = format!("actor:{}:audio", command.created_by_login_id);
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
    assert_eq!(counters(db, &actor_scope).await, (1, 64, 0));

    let mut other_owner = command.clone();
    other_owner.created_by_login_id = Uuid::new_v4();
    let error = admission::admit(db, &other_owner, &settings)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(FinalizationFailure::SourceOwned)
    ));
    let mut changed_command = command.clone();
    let FinalizationTarget::Audio { name, .. } = &mut changed_command.target
    else {
        unreachable!()
    };
    *name = "Інша назва".into();
    let error = admission::admit(db, &changed_command, &settings)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(FinalizationFailure::CommandConflict)
    ));
    let next = audio_command(command.created_by_login_id);
    let error = admission::admit(db, &next, &settings).await.unwrap_err();
    assert!(matches!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(FinalizationFailure::CapacityUnavailable)
    ));
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
    assert!(!query::release_source_quota(db, job_id).await.unwrap());

    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update device_upload_finalization_job set status = 'failed', \
         finished_at = clock_timestamp(), error_code = 'invalid_media', \
         error_message = 'Invalid media', error_action = 'new_upload', \
         source_release_state = 'release_pending' \
         where id = $1",
        [job_id.into()],
    ))
    .await
    .unwrap();
    assert!(!query::release_source_quota(db, job_id).await.unwrap());
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
    let terminal = admission::admit(db, &command, &settings).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update device_upload_finalization_job \
         set source_release_state = 'released', source_released_at = clock_timestamp() \
         where id = $1",
        [job_id.into()],
    ))
    .await
    .unwrap();
    let releases = futures::future::join_all(
        (0..20).map(|_| query::release_source_quota(db, job_id)),
    )
    .await;
    assert_eq!(
        releases
            .into_iter()
            .filter(|result| *result.as_ref().unwrap())
            .count(),
        1
    );
    assert_eq!(counters(db, "global:audio").await, (0, 0, 0));
    assert_eq!(counters(db, &actor_scope).await, (0, 0, 0));
    let replay = admission::admit(
        db,
        &command,
        &DeviceUploadFinalizationSettings::default(),
    )
    .await
    .unwrap();
    assert_eq!(replay.job_id, job_id);
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(terminal).unwrap()
    );
    assert_eq!(counters(db, "global:audio").await, (0, 0, 0));
    assert_ne!(
        admission::admit(db, &next, &settings).await.unwrap().job_id,
        job_id
    );
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
}

#[tokio::test]
#[serial_test::serial]
async fn expired_fences_cannot_heartbeat_retry_or_dispatch_after_takeover() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let command = audio_command(Uuid::new_v4());
    let job = admission::admit(db, &command, &settings()).await.unwrap();
    let first = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(first.job_id, job.job_id);
    assert_eq!(first.lease_epoch, 1);
    assert!(query::heartbeat(db, &first, 60).await.unwrap());
    let attempt = query::create_attempt(db, &first, true).await.unwrap();
    make_due(db, job.job_id, true).await;
    assert!(!query::is_current(db, &first).await.unwrap());
    assert!(!query::heartbeat(db, &first, 60).await.unwrap());
    assert!(!recovery::schedule_retry(
        db,
        &first,
        &FinalizationFailure::DependencyUnavailable,
        false,
        1,
    )
    .await
    .unwrap());
    let second = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(second.job_id, first.job_id);
    assert_eq!(second.lease_epoch, 2);
    assert!(!query::heartbeat(db, &first, 60).await.unwrap());
    assert!(!query::prepare_attempt(
        db,
        &first,
        attempt,
        64,
        &[7; 32],
        Some(&prepared_audio()),
    )
    .await
    .unwrap());
    assert!(!query::record_write_intent(db, &first, attempt, 1)
        .await
        .unwrap());
    assert!(query::prepare_attempt(
        db,
        &second,
        attempt,
        64,
        &[7; 32],
        Some(&prepared_audio()),
    )
    .await
    .unwrap());
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
}

#[tokio::test]
#[serial_test::serial]
async fn retry_and_unknown_claims_preserve_the_attempt_and_use_separate_lanes()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let job = admission::admit(db, &audio_command(Uuid::new_v4()), &settings())
        .await
        .unwrap();
    let first = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    let attempt = query::create_attempt(db, &first, true).await.unwrap();
    assert!(recovery::schedule_retry(
        db,
        &first,
        &FinalizationFailure::DependencyUnavailable,
        false,
        300,
    )
    .await
    .unwrap());
    assert!(worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .is_none());
    make_due(db, job.job_id, false).await;
    let second = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(second.lease_epoch, 2);
    assert!(query::prepare_attempt(
        db,
        &second,
        attempt,
        64,
        &[7; 32],
        Some(&prepared_audio()),
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(db, &second, attempt, 1)
        .await
        .unwrap());
    assert!(!query::record_write_intent(db, &second, attempt, 1)
        .await
        .unwrap());
    assert!(!query::release_write_credit(db, attempt).await.unwrap());
    assert!(recovery::schedule_retry(
        db,
        &second,
        &FinalizationFailure::DependencyUnavailable,
        false,
        300,
    )
    .await
    .unwrap());
    let uncertain = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select status, error_action from device_upload_finalization_job where id = $1",
            [job.job_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        uncertain.try_get::<String>("", "status").unwrap(),
        "outcome_unknown"
    );
    assert_eq!(
        uncertain.try_get::<String>("", "error_action").unwrap(),
        "retry_poll"
    );
    make_due(db, job.job_id, false).await;
    assert!(worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .is_none());
    let recovery_claim = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Reconcile,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(recovery_claim.requires_reconciliation);
    assert_eq!(recovery_claim.lease_epoch, 3);
    assert!(query::create_attempt(db, &recovery_claim, true)
        .await
        .is_err());
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select active_attempt_id, (select count(*) from \
             device_upload_finalization_attempt where job_id = $1) as attempts \
             from device_upload_finalization_job where id = $1",
            [job.job_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<Uuid>("", "active_attempt_id").unwrap(),
        attempt
    );
    assert_eq!(row.try_get::<i64>("", "attempts").unwrap(), 1);
    assert_eq!(counters(db, "global:audio").await, (1, 64, 1));
    assert!(!query::release_source_quota(db, job.job_id).await.unwrap());
}

#[tokio::test]
#[serial_test::serial]
async fn committed_write_credit_survives_connection_loss_and_expired_lease() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let job = admission::admit(db, &audio_command(Uuid::new_v4()), &settings())
        .await
        .unwrap();
    let claim = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    let mut options = ConnectOptions::new(crate::mk_wdfile_conn_string(
        env.config.file_registry.as_ref().unwrap(),
        Mode::Test,
    ));
    options.max_connections(1);
    let lost = Database::connect(options).await.unwrap();
    let attempt = query::create_attempt(&lost, &claim, true).await.unwrap();
    assert!(query::prepare_attempt(
        &lost,
        &claim,
        attempt,
        64,
        &[7; 32],
        Some(&prepared_audio()),
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(&lost, &claim, attempt, 1)
        .await
        .unwrap());
    let transaction = lost.begin().await.unwrap();
    let backend: i32 = transaction
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select pg_backend_pid() as pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let killed: bool = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_terminate_backend($1, 5000) as killed",
            [backend.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "killed")
        .unwrap();
    assert!(killed);
    assert!(transaction.commit().await.is_err());
    lost.close_by_ref().await.unwrap();
    assert!(query::release_write_credit(&lost, attempt).await.is_err());
    make_due(db, job.job_id, true).await;
    assert_eq!(counters(db, "global:audio").await, (1, 64, 1));
    assert!(!query::release_write_credit(db, attempt).await.unwrap());
    assert!(worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .is_none());
    let reclaimed = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Reconcile,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reclaimed.lease_epoch, 2);
    assert!(reclaimed.requires_reconciliation);
    assert!(!query::record_write_resolution(
        db,
        &claim,
        attempt,
        WriteResolution::DefinitelyNotDispatched
    )
    .await
    .unwrap());
    assert!(!query::record_write_intent(db, &reclaimed, attempt, 1)
        .await
        .unwrap());
    assert!(query::record_write_resolution(
        db,
        &reclaimed,
        attempt,
        WriteResolution::DefinitelyNotDispatched
    )
    .await
    .unwrap());
    assert!(query::release_write_credit(db, attempt).await.unwrap());
    assert!(!query::release_write_credit(db, attempt).await.unwrap());
    assert_eq!(counters(db, "global:audio").await, (1, 64, 0));
}

async fn wait_for_slot_release(root: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if resources::try_acquire(root, resources::ResourceKind::Audio, 1)
                .unwrap()
                .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn assert_slot_available(root: &Path, available: bool) {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "devices::upload_finalization::tests::shared_slot_probe_subprocess",
                "--exact", "--ignored", "--nocapture",
            ])
            .env("FINALIZATION_SLOT_TEST_ROOT", root)
            .env("FINALIZATION_SLOT_EXPECT_AVAILABLE", if available { "1" } else { "0" })
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "slot subprocess failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "subprocess entry point; invoked by shared slot lifetime tests"]
async fn shared_slot_probe_subprocess() {
    let root = std::env::var_os("FINALIZATION_SLOT_TEST_ROOT").unwrap();
    let available =
        std::env::var("FINALIZATION_SLOT_EXPECT_AVAILABLE").unwrap() == "1";
    let slot = resources::try_acquire(
        Path::new(&root),
        resources::ResourceKind::Audio,
        1,
    )
    .unwrap();
    assert_eq!(slot.is_some(), available);
}

#[tokio::test]
async fn cancelling_outer_waiter_retains_shared_slot_until_owned_work_finishes()
{
    let root = tempfile::tempdir().unwrap();
    let slot =
        resources::try_acquire(root.path(), resources::ResourceKind::Audio, 1)
            .unwrap()
            .unwrap();
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let owned = resources::spawn_owned(slot, async move {
        released.await.unwrap();
    });
    let outer = tokio::spawn(async move { owned.await.unwrap() });
    outer.abort();
    assert!(outer.await.unwrap_err().is_cancelled());
    assert_slot_available(root.path(), false).await;
    release.send(()).unwrap();
    wait_for_slot_release(root.path()).await;
    assert_slot_available(root.path(), true).await;
    assert!(root
        .path()
        .join("device-upload-finalization-slots/audio/0.lock")
        .exists());
}

#[tokio::test]
async fn cancelled_child_is_drained_before_shared_slot_becomes_available() {
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("child.pid");
    let slot =
        resources::try_acquire(root.path(), resources::ResourceKind::Audio, 1)
            .unwrap()
            .unwrap();
    let mut child = tokio::process::Command::new("python3");
    child.args([
        "-c",
        "import os,pathlib,sys,time; p=pathlib.Path(sys.argv[1]); t=p.with_suffix('.tmp'); t.write_text(str(os.getpid())); t.rename(p); time.sleep(60)",
    ]).arg(&ready);
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let supervisor = resources::supervise_child(slot, child, cancel.clone());
    tokio::time::timeout(Duration::from_secs(10), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let child_pid: i32 =
        std::fs::read_to_string(&ready).unwrap().parse().unwrap();
    drop(supervisor);
    assert_slot_available(root.path(), false).await;
    cancel.cancel();
    wait_for_slot_release(root.path()).await;
    #[cfg(unix)]
    {
        assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    assert_slot_available(root.path(), true).await;
}

#[tokio::test]
async fn cancelled_waiter_does_not_release_a_running_blocking_child_slot() {
    let root = tempfile::tempdir().unwrap();
    let slot =
        resources::try_acquire(root.path(), resources::ResourceKind::Audio, 1)
            .unwrap()
            .unwrap();
    let (started, running) = tokio::sync::oneshot::channel::<()>();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let owned = resources::spawn_blocking_owned(slot, move || {
        started.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(30)).unwrap();
    });
    let outer = tokio::spawn(async move { owned.await.unwrap() });
    running.await.unwrap();
    outer.abort();
    assert!(outer.await.unwrap_err().is_cancelled());
    assert_slot_available(root.path(), false).await;
    release.send(()).unwrap();
    wait_for_slot_release(root.path()).await;
    assert_slot_available(root.path(), true).await;
}

#[tokio::test]
#[serial_test::serial]
async fn finalization_contract_legacy_slots_fail_closed_for_shared_work() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let root = tempfile::tempdir().unwrap();
    let unavailable = root.path().join("not-a-directory");
    std::fs::write(&unavailable, b"blocked lock infrastructure").unwrap();
    let disabled = DeviceUploadFinalizationSettings {
        enabled: false,
        audio_slots: 1,
        ..Default::default()
    };
    let enabled = DeviceUploadFinalizationSettings {
        enabled: true,
        ..disabled.clone()
    };
    let kind = resources::ResourceKind::Audio;
    assert!(resources::legacy_slot_with_settings(
        &unavailable,
        db,
        &disabled,
        kind
    )
    .await
    .unwrap()
    .is_none());
    assert!(resources::legacy_slot_with_settings(
        &unavailable,
        db,
        &enabled,
        kind
    )
    .await
    .is_err());

    let busy = resources::try_acquire(root.path(), kind, 1)
        .unwrap()
        .unwrap();
    let error =
        resources::legacy_slot_with_settings(root.path(), db, &disabled, kind)
            .await
            .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(FinalizationFailure::CapacityUnavailable)
    ));
    drop(busy);
    assert!(resources::legacy_slot_with_settings(
        root.path(),
        db,
        &disabled,
        kind
    )
    .await
    .unwrap()
    .is_some());

    admission::admit(db, &audio_command(Uuid::new_v4()), &enabled)
        .await
        .unwrap();
    assert!(resources::legacy_slot_with_settings(
        &unavailable,
        db,
        &disabled,
        kind
    )
    .await
    .is_err());
}

#[path = "shutdown_tests.rs"]
mod shutdown_tests;

#[path = "scheduling_tests.rs"]
mod scheduling_tests;

#[path = "recovery_tests.rs"]
mod recovery_tests;

#[path = "capacity_tests.rs"]
mod capacity_tests;

#[path = "storage_cleanup_tests.rs"]
mod storage_cleanup_tests;
