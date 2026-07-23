mod file;
mod hierarchy;

use super::{
    FileMutationResult, FilesystemError, PreparedFileMutation,
    SyncFileOperation,
};
use chrono::Utc;
use sea_orm::{DatabaseConnection, DatabaseTransaction};

#[cfg(test)]
use super::map_transaction_body_error;
#[cfg(test)]
use crate::h;
#[cfg(test)]
use crate::types::ShortContext;
#[cfg(test)]
use chrono::NaiveDateTime;
#[cfg(test)]
use sea_orm::{ConnectionTrait, DbBackend, Statement};
#[cfg(test)]
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
#[cfg(test)]
use tokio::sync::Barrier;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RetryableSqlstate {
    SerializationFailure,
    DeadlockDetected,
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct MutationAttemptBarriers {
    pub(super) entered: Arc<Barrier>,
    pub(super) resume: Arc<Barrier>,
}

#[cfg(test)]
impl MutationAttemptBarriers {
    pub(super) fn new(entered: Arc<Barrier>, resume: Arc<Barrier>) -> Self {
        Self { entered, resume }
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(super) enum MutationCommitFault {
    LoseCommitAcknowledgement,
    UnknownWithoutCommit {
        after_rollback: Option<MutationAttemptBarriers>,
    },
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MutationAttemptIdentity {
    pub(super) file_id: uuid::Uuid,
    pub(super) candidate_root_entry_id: uuid::Uuid,
    pub(super) candidate_directory_entry_ids: Vec<uuid::Uuid>,
}

#[cfg(test)]
enum MutationAttemptTestBehavior {
    PauseAfterOptimisticReadOnce {
        optimistic_read: Arc<Barrier>,
        resume: Arc<Barrier>,
        paused: AtomicBool,
    },
    RaiseRetryableSqlstateBeforeCommit {
        code: RetryableSqlstate,
        remaining: AtomicUsize,
    },
    NoFault,
    CommitFault(MutationCommitFault),
}

#[cfg(test)]
pub(super) struct MutationAttemptTestControl {
    target_absolute_path: String,
    behavior: MutationAttemptTestBehavior,
    attempt_now: Option<NaiveDateTime>,
    attempts: AtomicUsize,
    identities: Mutex<Vec<MutationAttemptIdentity>>,
}

#[cfg(test)]
impl MutationAttemptTestControl {
    pub(super) fn pause_after_optimistic_read_once(
        target_absolute_path: impl Into<String>,
        optimistic_read: Arc<Barrier>,
        resume: Arc<Barrier>,
    ) -> Self {
        Self::new(
            target_absolute_path,
            MutationAttemptTestBehavior::PauseAfterOptimisticReadOnce {
                optimistic_read,
                resume,
                paused: AtomicBool::new(false),
            },
            None,
        )
    }

    pub(super) fn raise_retryable_sqlstate_before_commit(
        target_absolute_path: impl Into<String>,
        code: RetryableSqlstate,
        remaining: usize,
    ) -> Self {
        Self::new(
            target_absolute_path,
            MutationAttemptTestBehavior::RaiseRetryableSqlstateBeforeCommit {
                code,
                remaining: AtomicUsize::new(remaining),
            },
            None,
        )
    }

    pub(super) fn lose_commit_acknowledgement(
        target_absolute_path: impl Into<String>,
    ) -> Self {
        Self::new(
            target_absolute_path,
            MutationAttemptTestBehavior::CommitFault(
                MutationCommitFault::LoseCommitAcknowledgement,
            ),
            None,
        )
    }

    pub(super) fn unknown_without_commit(
        target_absolute_path: impl Into<String>,
        attempt_now: Option<NaiveDateTime>,
        after_rollback: Option<MutationAttemptBarriers>,
    ) -> Self {
        Self::new(
            target_absolute_path,
            MutationAttemptTestBehavior::CommitFault(
                MutationCommitFault::UnknownWithoutCommit { after_rollback },
            ),
            attempt_now,
        )
    }

    pub(super) fn fixed_attempt_now(
        target_absolute_path: impl Into<String>,
        attempt_now: NaiveDateTime,
    ) -> Self {
        Self::new(
            target_absolute_path,
            MutationAttemptTestBehavior::NoFault,
            Some(attempt_now),
        )
    }

    fn new(
        target_absolute_path: impl Into<String>,
        behavior: MutationAttemptTestBehavior,
        attempt_now: Option<NaiveDateTime>,
    ) -> Self {
        Self {
            target_absolute_path: target_absolute_path.into(),
            behavior,
            attempt_now,
            attempts: AtomicUsize::new(0),
            identities: Mutex::new(Vec::new()),
        }
    }

    pub(super) fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    pub(super) fn identities(&self) -> Vec<MutationAttemptIdentity> {
        self.identities
            .lock()
            .expect("mutation attempt identities lock poisoned")
            .clone()
    }

    pub(super) fn record_attempt(&self, mutation: &PreparedFileMutation) {
        if !self.is_target(mutation) {
            return;
        }

        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.identities
            .lock()
            .expect("mutation attempt identities lock poisoned")
            .push(MutationAttemptIdentity {
                file_id: mutation.file_id,
                candidate_root_entry_id: mutation.candidate_root_entry_id,
                candidate_directory_entry_ids: mutation
                    .candidate_directory_entry_ids
                    .clone(),
            });
    }

    pub(super) fn attempt_now(
        &self,
        mutation: &PreparedFileMutation,
    ) -> Option<NaiveDateTime> {
        self.is_target(mutation)
            .then_some(self.attempt_now)
            .flatten()
    }

    pub(super) async fn pause_after_optimistic_read(
        &self,
        mutation: &PreparedFileMutation,
    ) {
        if !self.is_target(mutation) {
            return;
        }

        let MutationAttemptTestBehavior::PauseAfterOptimisticReadOnce {
            optimistic_read,
            resume,
            paused,
        } = &self.behavior
        else {
            return;
        };
        if paused
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            optimistic_read.wait().await;
            resume.wait().await;
        }
    }

    pub(super) async fn inject_retryable_sqlstate_before_commit(
        &self,
        transaction: &DatabaseTransaction,
        mutation: &PreparedFileMutation,
    ) -> Result<(), FilesystemError> {
        let Some(code) = self.take_retryable_sqlstate(mutation) else {
            return Ok(());
        };
        let statement = match code {
            RetryableSqlstate::SerializationFailure => Statement::from_string(
                DbBackend::Postgres,
                "do $$ begin raise sqlstate '40001'; end $$;".to_string(),
            ),
            RetryableSqlstate::DeadlockDetected => Statement::from_string(
                DbBackend::Postgres,
                "do $$ begin raise sqlstate '40P01'; end $$;".to_string(),
            ),
        };
        transaction
            .execute(statement)
            .await
            .c(h!())
            .map_err(map_transaction_body_error)?;
        Ok(())
    }

    pub(super) fn commit_fault(
        &self,
        mutation: &PreparedFileMutation,
    ) -> Option<MutationCommitFault> {
        if !self.is_target(mutation) {
            return None;
        }

        match &self.behavior {
            MutationAttemptTestBehavior::CommitFault(fault) => {
                Some(fault.clone())
            }
            _ => None,
        }
    }

    fn is_target(&self, mutation: &PreparedFileMutation) -> bool {
        mutation.source_path.absolute_path == self.target_absolute_path
    }

    fn take_retryable_sqlstate(
        &self,
        mutation: &PreparedFileMutation,
    ) -> Option<RetryableSqlstate> {
        if !self.is_target(mutation) {
            return None;
        }

        let MutationAttemptTestBehavior::RaiseRetryableSqlstateBeforeCommit {
            code,
            remaining,
        } = &self.behavior
        else {
            return None;
        };
        let mut remaining_attempts = remaining.load(Ordering::SeqCst);
        while remaining_attempts != 0 {
            match remaining.compare_exchange(
                remaining_attempts,
                remaining_attempts - 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(*code),
                Err(actual) => remaining_attempts = actual,
            }
        }

        None
    }
}

pub(super) async fn mutate_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    #[cfg(test)] test_control: Option<&MutationAttemptTestControl>,
) -> Result<FileMutationResult, FilesystemError> {
    #[cfg(test)]
    if let Some(test_control) = test_control {
        test_control.record_attempt(mutation);
    }

    let now = Utc::now().naive_utc();
    #[cfg(test)]
    let now = test_control
        .and_then(|test_control| test_control.attempt_now(mutation))
        .unwrap_or(now);
    let result = match mutation.operation {
        SyncFileOperation::Created => {
            file::create_file(transaction, mutation, now).await
        }
        SyncFileOperation::Updated => {
            file::update_file(
                transaction,
                mutation,
                now,
                #[cfg(test)]
                test_control,
            )
            .await
        }
    }?;

    #[cfg(test)]
    if let Some(test_control) = test_control {
        test_control
            .inject_retryable_sqlstate_before_commit(transaction, mutation)
            .await?;
    }

    Ok(result)
}

pub(super) async fn reconcile_file_mutation(
    db: &DatabaseConnection,
    expected: &FileMutationResult,
    transaction_id: &str,
) -> Result<bool, FilesystemError> {
    file::reconcile_file_mutation(db, expected, transaction_id).await
}
