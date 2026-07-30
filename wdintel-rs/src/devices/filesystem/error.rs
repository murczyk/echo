use anyhow::Error as AnyhowError;
use sea_orm::{ConnAcquireErr, DbErr};
use thiserror::Error;

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FilesystemFieldError {
    pub(in crate::devices) path: String,
    pub(in crate::devices) message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::devices::filesystem) enum TransactionErrorClass {
    Retryable,
    OutcomeUncertain,
    DatabaseFailure,
}

pub(in crate::devices::filesystem) fn classify_transaction_error(
    error: &AnyhowError,
) -> TransactionErrorClass {
    match classify_database_error(error) {
        Some(DatabaseErrorClass::Conflict) => TransactionErrorClass::Retryable,
        _ if has_outcome_uncertain_transaction_error(error) => {
            TransactionErrorClass::OutcomeUncertain
        }
        Some(_) => TransactionErrorClass::DatabaseFailure,
        None => TransactionErrorClass::OutcomeUncertain,
    }
}

pub(in crate::devices::filesystem) fn map_database_error(
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

pub(in crate::devices::filesystem) fn map_transaction_body_error(
    error: AnyhowError,
) -> FilesystemError {
    map_database_error(error)
}

fn has_outcome_uncertain_transaction_error(error: &AnyhowError) -> bool {
    error.chain().any(|source| {
        let Some(sqlx::Error::Database(database_error)) =
            source.downcast_ref::<sqlx::Error>()
        else {
            return false;
        };
        match database_error.code().as_deref() {
            Some("40003") => true,
            Some(code) => code.starts_with("08"),
            None => true,
        }
    })
}

#[derive(Debug, Error)]
pub(in crate::devices) enum FilesystemError {
    #[allow(dead_code)]
    #[error("filesystem validation failed")]
    Validation(Vec<FilesystemFieldError>),
    #[allow(dead_code)]
    #[error("filesystem entry not found")]
    NotFound,
    #[allow(dead_code)]
    #[error("filesystem conflict")]
    Conflict,
    #[allow(dead_code)]
    #[error("filesystem dependency failed")]
    Dependency(#[source] anyhow::Error),
    #[error("filesystem invariant failed: {0}")]
    Invariant(&'static str),
    #[error("filesystem internal failure")]
    Internal(#[source] anyhow::Error),
    #[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    const SENTINEL_SECRET: &str = "filesystem-source-sentinel-secret";

    #[test]
    fn filesystem_error_display_labels_are_safe_and_stable() {
        let cases = [
            (
                FilesystemError::Validation(vec![FilesystemFieldError {
                    path: "absolute_path".to_string(),
                    message: "invalid".to_string(),
                }]),
                "filesystem validation failed",
                false,
            ),
            (
                FilesystemError::NotFound,
                "filesystem entry not found",
                false,
            ),
            (FilesystemError::Conflict, "filesystem conflict", false),
            (
                FilesystemError::Dependency(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem dependency failed",
                true,
            ),
            (
                FilesystemError::Invariant("safe_invariant_code"),
                "filesystem invariant failed: safe_invariant_code",
                false,
            ),
            (
                FilesystemError::Internal(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem internal failure",
                true,
            ),
            (
                FilesystemError::CommitUncertain(anyhow::anyhow!(
                    SENTINEL_SECRET
                )),
                "filesystem commit outcome uncertain",
                true,
            ),
        ];

        for (error, expected_display, has_source) in cases {
            assert_eq!(error.to_string(), expected_display);
            assert!(!error.to_string().contains(SENTINEL_SECRET));

            if has_source {
                let source =
                    error.source().expect("source error must be retained");
                assert!(format!("{source:#}").contains(SENTINEL_SECRET));
            } else {
                assert!(error.source().is_none());
            }
        }
    }
}
