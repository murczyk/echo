mod file;
mod hierarchy;

use super::{
    FileMutationResult, FilesystemError, PreparedFileMutation,
    SyncFileOperation,
};
use chrono::Utc;
use sea_orm::DatabaseTransaction;

pub(super) async fn mutate_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
) -> Result<FileMutationResult, FilesystemError> {
    let now = Utc::now().naive_utc();

    match mutation.operation {
        SyncFileOperation::Created => {
            file::create_file(transaction, mutation, now).await
        }
        SyncFileOperation::Updated => {
            file::update_file(transaction, mutation, now).await
        }
    }
}
