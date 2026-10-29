use super::*;
use std::sync::Arc;

struct CompletingExecutor {
    database: DatabaseConnection,
    completed: tokio::sync::mpsc::UnboundedSender<Uuid>,
}

#[async_trait::async_trait]
impl worker::FinalizationExecutor for CompletingExecutor {
    async fn execute(
        &self,
        claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        assert!(super::super::cleanup::fail_audio(
            &self.database,
            claim,
            FinalizationFailure::InvalidAudio,
        )
        .await
        .unwrap());
        self.completed.send(claim.job_id).unwrap();
        Ok(())
    }

    async fn reconcile(
        &self,
        claim: &super::super::types::ClaimedFinalizationJob,
    ) -> anyhow::Result<()> {
        self.execute(claim).await
    }
}

#[tokio::test]
#[serial_test::serial]
async fn ready_jobs_drain_without_poll_delay_between_claims() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let database = env.file_registry_db.as_ref().unwrap().connection();
    let mut expected = Vec::new();
    for _ in 0..3 {
        expected.push(
            admission::admit(
                database,
                &audio_command(Uuid::new_v4()),
                &settings(),
            )
            .await
            .unwrap()
            .job_id,
        );
    }
    let (completed, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let registration = worker::register(
        database.clone(),
        DeviceUploadFinalizationSettings {
            file_slots: 1,
            audio_slots: 1,
            poll_seconds: 30,
            ..settings()
        },
        Arc::new(CompletingExecutor {
            database: database.clone(),
            completed,
        }),
        CancellationToken::new(),
    );
    let drained = tokio::time::timeout(Duration::from_secs(3), async {
        for job in expected {
            assert_eq!(receiver.recv().await, Some(job));
        }
    })
    .await;
    registration.shutdown().await;
    assert!(
        drained.is_ok(),
        "ready work waited for the idle polling interval"
    );
}

#[tokio::test]
async fn resource_wait_keeps_exclusion_and_obeys_deadline_and_shutdown() {
    use resources::{ResourceKind, WorkScope};

    let root = tempfile::tempdir().unwrap();
    let held = resources::try_acquire(root.path(), ResourceKind::Readback, 1)
        .unwrap()
        .unwrap();
    let pending = resources::acquire(
        root.path(),
        ResourceKind::Readback,
        1,
        Duration::from_secs(5),
    );
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut pending)
            .await
            .is_err()
    );
    drop(held);
    let acquired = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(
        resources::try_acquire(root.path(), ResourceKind::Readback, 1)
            .unwrap()
            .is_none()
    );
    let expired = resources::acquire(
        root.path(),
        ResourceKind::Readback,
        1,
        Duration::from_millis(50),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        expired.downcast_ref::<FinalizationFailure>(),
        Some(FinalizationFailure::CapacityUnavailable)
    ));

    let scope = WorkScope::new();
    let waiting_scope = scope.clone();
    let waiting_root = root.path().to_owned();
    let waiter = tokio::spawn(async move {
        waiting_scope
            .run(resources::acquire(
                &waiting_root,
                ResourceKind::Readback,
                1,
                Duration::from_secs(60),
            ))
            .await
    });
    scope.stop();
    assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    drop(acquired);
    assert!(
        resources::try_acquire(root.path(), ResourceKind::Readback, 1)
            .unwrap()
            .is_some()
    );
}
