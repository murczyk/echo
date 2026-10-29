use super::*;
use crate::storage::finalization::{
    ManagedObject, ManagedPayload, ManagedStorage, ManagedWriteOutcome,
};
use opendal::raw::{oio, Access, AccessorInfo, OpWrite, RpWrite};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug)]
enum Failure {
    Digest,
    Size,
    Write,
    Timeout,
    Close,
    None,
}

#[derive(Debug, Default)]
struct MultipartState {
    parts: AtomicUsize,
    writes: AtomicUsize,
    abort_entered: Notify,
    abort_release: Notify,
    abort_finished: Notify,
}

#[derive(Debug, Clone)]
struct MultipartStorage {
    state: Arc<MultipartState>,
    failure: Failure,
}

impl Access for MultipartStorage {
    type Reader = ();
    type Writer = Self;
    type Lister = ();
    type Deleter = ();

    fn info(&self) -> Arc<AccessorInfo> {
        let info = AccessorInfo::default();
        info.set_native_capability(opendal::Capability {
            write: true,
            write_can_multi: true,
            ..Default::default()
        });
        Arc::new(info)
    }

    async fn write(
        &self,
        _: &str,
        _: OpWrite,
    ) -> opendal::Result<(RpWrite, Self::Writer)> {
        Ok((RpWrite::default(), self.clone()))
    }
}

fn injected_error() -> opendal::Error {
    opendal::Error::new(opendal::ErrorKind::Unexpected, "injected write error")
}

impl oio::Write for MultipartStorage {
    async fn write(&mut self, bytes: opendal::Buffer) -> opendal::Result<()> {
        if self.state.writes.fetch_add(1, Ordering::SeqCst) > 0 {
            match self.failure {
                Failure::Write => return Err(injected_error()),
                Failure::Timeout => std::future::pending::<()>().await,
                _ => {}
            }
        }
        self.state.parts.fetch_add(bytes.len(), Ordering::SeqCst);
        Ok(())
    }

    async fn close(&mut self) -> opendal::Result<opendal::Metadata> {
        if matches!(self.failure, Failure::Close) {
            return Err(injected_error());
        }
        self.state.parts.store(0, Ordering::SeqCst);
        Ok(opendal::Metadata::new(opendal::EntryMode::FILE))
    }

    async fn abort(&mut self) -> opendal::Result<()> {
        self.state.abort_entered.notify_one();
        self.state.abort_release.notified().await;
        self.state.parts.store(0, Ordering::SeqCst);
        self.state.abort_finished.notify_one();
        Ok(())
    }
}

#[tokio::test]
#[serial_test::serial]
async fn managed_multipart_failures_abort_before_releasing_source_and_slot() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    for failure in [
        Failure::Digest,
        Failure::Size,
        Failure::Write,
        Failure::Timeout,
        Failure::Close,
        Failure::None,
    ] {
        exercise_failure(db, failure).await;
    }
}

async fn exercise_failure(db: &DatabaseConnection, failure: Failure) {
    let directory = tempfile::tempdir().unwrap();
    let bytes = vec![
        0x42;
        crate::devices::config::DEVICE_FILE_CONTENT_STREAM_CHUNK_BYTES
            * 2
            + 1
    ];
    let (claim, object) = prepare_write(db, failure, &bytes).await;
    let (storage, state) = multipart_storage(failure);
    let source_id = Uuid::new_v4();
    let source = crate::sigint::file_upload::lifecycle::UploadLock::acquire(
        directory.path(),
        source_id,
    )
    .await
    .unwrap();
    let source_probe = std::fs::File::open(
        directory.path().join("locks").join(source_id.to_string()),
    )
    .unwrap();
    let guard = resources::try_acquire(
        directory.path(),
        resources::ResourceKind::Audio,
        1,
    )
    .unwrap()
    .unwrap()
    .with_owner(Arc::new(source));
    let source_path = directory.path().join("source");
    tokio::fs::write(&source_path, &bytes).await.unwrap();
    let payload = ManagedPayload::Plaintext(
        tokio::fs::File::open(source_path).await.unwrap(),
    );
    let scope = resources::WorkScope::new();
    let timeout = if matches!(failure, Failure::Timeout) {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(5)
    };
    let outcome = scope
        .run(async {
            storage
                .dispatch(
                    db.clone(),
                    claim,
                    object,
                    payload,
                    guard,
                    16,
                    timeout,
                )
                .await
                .unwrap()
        })
        .await;
    assert_cleanup(
        failure,
        outcome,
        &state,
        &scope,
        directory.path(),
        &source_probe,
    )
    .await;
}

async fn prepare_write(
    db: &DatabaseConnection,
    failure: Failure,
    bytes: &[u8],
) -> (super::super::types::ClaimedFinalizationJob, ManagedObject) {
    let size = bytes.len() as u64 - u64::from(matches!(failure, Failure::Size));
    let mut command = audio_command(Uuid::new_v4());
    command.source_size_bytes = size as i64;
    let job = admission::admit(db, &command, &settings()).await.unwrap();
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
    assert_eq!(claim.job_id, job.job_id);
    let attempt = query::create_attempt(db, &claim, false).await.unwrap();
    let hash: [u8; 32] = if matches!(failure, Failure::Digest) {
        [0; 32]
    } else {
        Sha256::digest(bytes).into()
    };
    assert!(query::prepare_attempt(
        db,
        &claim,
        attempt,
        size as i64,
        &hash,
        Some(&prepared_audio())
    )
    .await
    .unwrap());
    let object_key: String = sqlx::query_scalar(
        "select object_key from device_upload_finalization_attempt where id=$1",
    )
    .bind(attempt)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    let object = ManagedObject {
        attempt_id: attempt,
        object_key,
        size,
        sha256: hash,
        is_encrypted: false,
    };
    (claim, object)
}

fn multipart_storage(
    failure: Failure,
) -> (Arc<ManagedStorage>, Arc<MultipartState>) {
    let state = Arc::new(MultipartState::default());
    let operator = opendal::OperatorBuilder::new(MultipartStorage {
        state: state.clone(),
        failure,
    })
    .finish();
    let storage = Arc::new(
        ManagedStorage::for_test(
            operator,
            crate::storage::S3Config {
                bucket: "multipart-cleanup".into(),
                region: String::new(),
                endpoint: String::new(),
                access_key_id: String::new(),
                secret_access_key: String::new(),
                prefix: String::new(),
            },
            &crate::storage::generate_strongbox_key_b64(),
        )
        .unwrap(),
    );
    (storage, state)
}

async fn assert_cleanup(
    failure: Failure,
    outcome: ManagedWriteOutcome,
    state: &MultipartState,
    scope: &resources::WorkScope,
    root: &Path,
    source_probe: &std::fs::File,
) {
    if matches!(failure, Failure::None) {
        assert!(matches!(outcome, ManagedWriteOutcome::Acknowledged));
        assert!(tokio::time::timeout(
            Duration::from_millis(25),
            state.abort_entered.notified()
        )
        .await
        .is_err());
    } else {
        let ManagedWriteOutcome::PossiblyDispatched(error) = outcome else {
            panic!("{failure:?}: {outcome:?}");
        };
        match failure {
            Failure::Digest | Failure::Size => assert_eq!(
                error.downcast_ref::<FinalizationFailure>(),
                Some(&FinalizationFailure::SourceDigestMismatch)
            ),
            Failure::Timeout => {
                assert!(error.is::<tokio::time::error::Elapsed>());
                assert!(state.writes.load(Ordering::SeqCst) >= 2);
            }
            Failure::Write | Failure::Close => {
                assert!(error.is::<opendal::Error>())
            }
            Failure::None => unreachable!(),
        }
        assert!(
            state.parts.load(Ordering::SeqCst) > 0,
            "{failure:?}: no multipart data was dispatched"
        );
        tokio::time::timeout(
            Duration::from_secs(2),
            state.abort_entered.notified(),
        )
        .await
        .expect("unfinished multipart write was not aborted");
        assert!(
            resources::try_acquire(root, resources::ResourceKind::Audio, 1)
                .unwrap()
                .is_none(),
            "slot released before multipart abort completed"
        );
        assert!(
            fs2::FileExt::try_lock_exclusive(source_probe).is_err(),
            "source released before multipart abort completed"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(25), scope.wait())
                .await
                .is_err(),
            "work scope stopped waiting before multipart cleanup completed"
        );
        state.abort_release.notify_one();
        tokio::time::timeout(
            Duration::from_secs(2),
            state.abort_finished.notified(),
        )
        .await
        .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(2), scope.wait())
        .await
        .unwrap();
    assert!(
        resources::try_acquire(root, resources::ResourceKind::Audio, 1)
            .unwrap()
            .is_some()
    );
    fs2::FileExt::try_lock_exclusive(source_probe).unwrap();
    assert_eq!(state.parts.load(Ordering::SeqCst), 0);
}
