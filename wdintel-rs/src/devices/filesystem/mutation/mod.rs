mod file;
mod hierarchy;

use super::{
    FileMutationResult, FilesystemError, PreparedFileMutation,
    SyncFileOperation,
};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{DatabaseConnection, DatabaseTransaction};

pub(super) async fn mutate_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
) -> Result<FileMutationResult, FilesystemError> {
    mutate_file_at(transaction, mutation, Utc::now().naive_utc()).await
}

pub(super) async fn mutate_file_at(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    now: NaiveDateTime,
) -> Result<FileMutationResult, FilesystemError> {
    match mutation.operation {
        SyncFileOperation::Created => {
            file::create_file(transaction, mutation, now).await
        }
        SyncFileOperation::Updated => {
            file::update_file(transaction, mutation, now).await
        }
    }
}

pub(super) async fn reconcile_file_mutation(
    db: &DatabaseConnection,
    expected: &FileMutationResult,
    transaction_id: &str,
) -> Result<bool, FilesystemError> {
    file::reconcile_file_mutation(db, expected, transaction_id).await
}
