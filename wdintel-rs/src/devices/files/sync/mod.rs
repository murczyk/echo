pub(in crate::devices) use repository::map_session;
mod hierarchy;
mod mutation;
mod prepare;
mod repository;
pub(crate) mod worker;

const DEVICE_FILE_SYNC_SESSION_TTL_SECS: i64 = 3 * 60 * 60;
const DEVICE_FILE_SYNC_SESSION_EXPIRY_BATCH_SIZE: u64 = 100;
const DEVICE_FILE_SYNC_SESSION_EXPIRY_POLL_SECS: u64 = 60;

#[cfg(test)]
mod tests;

use super::types::{
    ApplyFileSyncBatchRsp, FileSyncSessionItemsRsp, FileSyncSessionRsp,
    RawSyncDeviceFileItem, SyncDeviceFilesRsp,
};
use super::{FilesystemError, FilesystemFieldError};
use crate::devices::devices::query::{
    self as device_query, FileRegistryDeviceAccess,
};
use crate::entities::login;
use crate::error::AppError;
use crate::file_registry::entities::sea_orm_active_enums::FileSyncItemOutcome;
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::telemetry::Metrics;
use crate::types::ShortContext;
use sea_orm::DatabaseConnection;
use uuid::Uuid;

pub(in crate::devices) struct StartSessionResult {
    pub(in crate::devices) response: FileSyncSessionRsp,
    pub(in crate::devices) created: bool,
}

#[cfg(test)]
pub(in crate::devices) async fn automatic(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
    files: Vec<RawSyncDeviceFileItem>,
) -> Result<SyncDeviceFilesRsp, AppError> {
    automatic_with_metrics(
        main_db,
        file_registry_db,
        login,
        device_id,
        files,
        None,
    )
    .await
}

pub(in crate::devices) async fn automatic_with_metrics(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
    files: Vec<RawSyncDeviceFileItem>,
    metrics: Option<&Metrics>,
) -> Result<SyncDeviceFilesRsp, AppError> {
    validate_batch_size(files.len())?;
    let device_id = authorize(main_db, login, device_id).await?;
    repository::automatic(
        file_registry_db.connection(),
        device_id,
        files,
        metrics,
    )
    .await
    .map_err(map_service_error)
}

pub(in crate::devices) async fn start_explicit(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<StartSessionResult, AppError> {
    let device_id = authorize(main_db, login, device_id).await?;
    repository::start_explicit(file_registry_db.connection(), device_id)
        .await
        .map_err(map_service_error)
}

pub(in crate::devices) async fn status(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    sync_id: Uuid,
) -> Result<FileSyncSessionRsp, AppError> {
    let response = repository::status(file_registry_db.connection(), sync_id)
        .await
        .map_err(map_service_error)?;
    authorize(
        main_db,
        login,
        Uuid::parse_str(&response.sync.device_id).expect("stored device UUID"),
    )
    .await?;
    Ok(response)
}

#[cfg(test)]
pub(in crate::devices) async fn apply_batch(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    sync_id: Uuid,
    batch_index: i32,
    files: Vec<RawSyncDeviceFileItem>,
) -> Result<ApplyFileSyncBatchRsp, AppError> {
    apply_batch_with_metrics(
        main_db,
        file_registry_db,
        login,
        sync_id,
        batch_index,
        files,
        None,
    )
    .await
}

pub(in crate::devices) async fn apply_batch_with_metrics(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    sync_id: Uuid,
    batch_index: i32,
    files: Vec<RawSyncDeviceFileItem>,
    metrics: Option<&Metrics>,
) -> Result<ApplyFileSyncBatchRsp, AppError> {
    status(main_db, file_registry_db, login, sync_id).await?;
    repository::apply_batch(
        file_registry_db.connection(),
        sync_id,
        batch_index,
        files,
        metrics,
    )
    .await
    .map_err(map_service_error)
}

pub(in crate::devices) async fn complete(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    sync_id: Uuid,
    expected_batch_count: i32,
) -> Result<FileSyncSessionRsp, AppError> {
    status(main_db, file_registry_db, login, sync_id).await?;
    repository::complete(
        file_registry_db.connection(),
        sync_id,
        expected_batch_count,
    )
    .await
    .map_err(map_service_error)
}

pub(in crate::devices) async fn items(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    sync_id: Uuid,
    outcome: Option<FileSyncItemOutcome>,
    limit: Option<u64>,
    cursor: Option<&str>,
) -> Result<FileSyncSessionItemsRsp, AppError> {
    status(main_db, file_registry_db, login, sync_id).await?;
    repository::items(
        file_registry_db.connection(),
        sync_id,
        outcome,
        limit,
        cursor,
    )
    .await
    .map_err(map_service_error)
}

async fn authorize(
    main_db: &DatabaseConnection,
    login: &login::Model,
    device_id: Uuid,
) -> Result<Uuid, AppError> {
    Ok(device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::FileSync,
    )
    .await
    .c(h!())?)
}

fn validate_batch_size(item_count: usize) -> Result<(), AppError> {
    super::validation::validate_sync_batch_size(item_count)
        .map_err(map_filesystem_error)
}

fn map_service_error(error: repository::SyncServiceError) -> AppError {
    match error {
        repository::SyncServiceError::Filesystem(error) => {
            map_filesystem_error(error)
        }
        repository::SyncServiceError::Conflict { code, message } => {
            AppError::ConflictJson {
                body: serde_json::json!({
                    "code": code,
                    "message": message,
                }),
            }
        }
    }
}

fn map_filesystem_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => validation_error(errors),
        FilesystemError::NotFound => AppError::NotFound,
        FilesystemError::Invariant(_) => AppError::BL {
            msg: "device filesystem invariant violated".to_string(),
        },
        error @ (FilesystemError::Conflict
        | FilesystemError::Dependency(_)
        | FilesystemError::Internal(_)
        | FilesystemError::CommitUncertain(_)) => AppError::AnyhowError {
            source: anyhow::Error::new(error)
                .context("failed to synchronize device files"),
        },
    }
}

fn validation_error(errors: Vec<FilesystemFieldError>) -> AppError {
    AppError::Form(
        errors
            .into_iter()
            .map(|error| (error.path, error.message))
            .collect(),
    )
}
