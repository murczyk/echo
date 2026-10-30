use super::*;
use std::sync::Arc;

struct ChildExecutor {
    database: DatabaseConnection,
    root: std::path::PathBuf,
    ready: std::path::PathBuf,
    cancellation: CancellationToken,
}

#[async_trait::async_trait]
impl worker::FinalizationExecutor for ChildExecutor {
    async fn execute(
        &self,
        claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        let attempt = query::create_attempt(&self.database, claim, true)
            .await
            .unwrap();
        assert!(query::prepare_attempt(
            &self.database,
            claim,
            attempt,
            64,
            &[7; 32],
            Some(&prepared_audio())
        )
        .await
        .unwrap());
        assert!(
            query::record_write_intent(&self.database, claim, attempt, 1)
                .await
                .unwrap()
        );
        let slot = resources::try_acquire(
            &self.root,
            resources::ResourceKind::Audio,
            1,
        )
        .unwrap()
        .unwrap();
        let mut child = tokio::process::Command::new("python3");
        child.args([
            "-c",
            "import os,pathlib,sys,time; p=pathlib.Path(sys.argv[1]); t=p.with_suffix('.tmp'); t.write_text(str(os.getpid())); t.rename(p); time.sleep(60)",
        ]).arg(&self.ready);
        resources::supervise_child(slot, child, self.cancellation.clone())
            .await
            .unwrap()
            .unwrap();
        Ok(())
    }

    async fn reconcile(
        &self,
        _claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        std::future::pending().await
    }
}

#[tokio::test]
#[serial_test::serial]
async fn phase7_shutdown_joins_media_child_and_preserves_unfinished_write_credit(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let command = audio_command(Uuid::new_v4());
    let admitted = admission::admit(database, &command, &settings())
        .await
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("shutdown-child.pid");
    let child_cancellation = CancellationToken::new();
    let _cleanup = child_cancellation.clone().drop_guard();
    let worker_settings = DeviceUploadFinalizationSettings {
        enabled: false,
        file_slots: 1,
        audio_slots: 1,
        poll_seconds: 1,
        heartbeat_seconds: 1,
        shutdown_grace_seconds: 1,
        ..settings()
    };
    let registration = worker::register(
        database.clone(),
        worker_settings,
        Arc::new(ChildExecutor {
            database: database.clone(),
            root: root.path().to_path_buf(),
            ready: ready.clone(),
            cancellation: child_cancellation.clone(),
        }),
        CancellationToken::new(),
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(ready).unwrap().parse().unwrap();
    let queued =
        admission::admit(database, &audio_command(Uuid::new_v4()), &settings())
            .await
            .unwrap();
    registration.shutdown().await;
    let child_joined = unsafe { libc::kill(pid, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    let slot =
        resources::try_acquire(root.path(), resources::ResourceKind::Audio, 1)
            .unwrap();
    let released = slot.is_some();
    drop(slot);
    child_cancellation.cancel();
    wait_for_slot_release(root.path()).await;
    assert!(
        child_joined,
        "shutdown returned before killing and joining its media child"
    );
    assert!(
        released,
        "shutdown returned while a child still owned its resource slot"
    );
    let pool = database.get_postgres_connection_pool();
    let retained: (bool, bool, String) = sqlx::query_as(
        "select a.write_intent_at is not null,a.write_credit_held,j.source_release_state from device_upload_finalization_job j join device_upload_finalization_attempt a on a.id=j.active_attempt_id where j.id=$1",
    ).bind(admitted.job_id).fetch_one(pool).await.unwrap();
    assert_eq!(retained, (true, true, "held".into()));
    let untouched: (String, i64) = sqlx::query_as(
        "select status,attempt_count from device_upload_finalization_job where id=$1",
    ).bind(queued.job_id).fetch_one(pool).await.unwrap();
    assert_eq!(untouched, ("queued".into(), 0));
}
