use anyhow::Error as AnyhowError;
use sea_orm::{ConnAcquireErr, DbErr};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FilesystemFieldError {
    pub(in crate::devices) path: String,
    pub(in crate::devices) message: String,
}

pub(in crate::devices::files) fn map_database_error(
    error: AnyhowError,
) -> FilesystemError {
    match classify_database_error(&error) {
        Some(DatabaseErrorClass::Conflict) => FilesystemError::Conflict,
        Some(DatabaseErrorClass::Dependency) => {
            FilesystemError::Dependency(error)
        }
        Some(DatabaseErrorClass::Internal) | None => {
            FilesystemError::Internal(error)
        }
    }
}

#[derive(Clone, Copy)]
enum DatabaseErrorClass {
    Conflict,
    Dependency,
    Internal,
}

fn classify_database_error(error: &AnyhowError) -> Option<DatabaseErrorClass> {
    for source in error.chain() {
        if matches!(
            source.downcast_ref::<DbErr>(),
            Some(DbErr::ConnectionAcquire(_) | DbErr::Conn(_))
        ) || source.downcast_ref::<ConnAcquireErr>().is_some()
        {
            return Some(DatabaseErrorClass::Dependency);
        }
        if let Some(error) = source.downcast_ref::<sqlx::Error>() {
            return Some(classify_sqlx_error(error));
        }
    }
    None
}

fn classify_sqlx_error(error: &sqlx::Error) -> DatabaseErrorClass {
    match error {
        sqlx::Error::Database(error) => match error.code().as_deref() {
            Some("40001" | "40P01") => DatabaseErrorClass::Conflict,
            Some(code)
                if code.starts_with("08")
                    || matches!(
                        code,
                        "53300" | "57P01" | "57P02" | "57P03"
                    ) =>
            {
                DatabaseErrorClass::Dependency
            }
            Some(_) | None => DatabaseErrorClass::Internal,
        },
        sqlx::Error::Configuration(_)
        | sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed
        | sqlx::Error::BeginFailed => DatabaseErrorClass::Dependency,
        _ => DatabaseErrorClass::Internal,
    }
}

pub(in crate::devices::files) fn map_transaction_body_error(
    error: AnyhowError,
) -> FilesystemError {
    map_database_error(error)
}

#[derive(Debug, Error)]
pub(in crate::devices) enum FilesystemError {
    #[error("filesystem validation failed")]
    Validation(Vec<FilesystemFieldError>),

    #[error("filesystem entry not found")]
    NotFound,

    #[error("filesystem conflict")]
    Conflict,

    #[error("filesystem dependency failed")]
    Dependency(#[source] anyhow::Error),
    #[error("filesystem invariant failed: {0}")]
    Invariant(&'static str),
    #[error("filesystem internal failure")]
    Internal(#[source] anyhow::Error),

    #[error("filesystem commit outcome uncertain")]
    CommitUncertain(#[source] anyhow::Error),
}

impl FilesystemError {
    pub(super) fn invalid_cursor() -> Self {
        Self::Validation(vec![FilesystemFieldError {
            path: "cursor".to_string(),
            message: "invalid cursor".to_string(),
        }])
    }
}
