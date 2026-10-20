#[derive(Debug, thiserror::Error)]
pub(super) enum Failure {
    #[error("invalid_archive")]
    Invalid,
    #[error("unsupported_format")]
    Unsupported,
    #[error("password_protected")]
    Password,
    #[error("unsafe_path")]
    UnsafePath,
    #[error("path_conflict")]
    PathConflict,
    #[error("source_too_large")]
    SourceTooLarge,
    #[error("integrity_mismatch")]
    Integrity,
    #[error("safety_limit: {0}")]
    Limit(&'static str),
}

pub(super) fn require(condition: bool, failure: Failure) -> anyhow::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(failure.into())
    }
}

pub(super) fn classify(error: &anyhow::Error) -> (Option<&str>, Option<&str>) {
    if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
        matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT))
    }) {
        return (Some("safety_limit"), Some("scratch"));
    }
    if let Some(failure) = error.downcast_ref::<RemoteFailure>() {
        if failure.reason == "temporary_storage" {
            return (None, None);
        }
        if matches!(
            failure.reason.as_str(),
            "password_protected"
                | "invalid_archive"
                | "unsupported_format"
                | "source_too_large"
                | "unsafe_path"
                | "path_conflict"
                | "integrity_mismatch"
                | "safety_limit"
                | "storage_unavailable"
                | "internal_error"
        ) {
            return (Some(&failure.reason), failure.limit.as_deref());
        }
    }
    if let Some(failure) = error.downcast_ref::<StorageFailure>() {
        return if failure.retryable() {
            (None, None)
        } else {
            (Some("storage_unavailable"), None)
        };
    }
    if let Some(storage) = error.chain().find_map(storage_error) {
        return if temporary_storage(storage) {
            (None, None)
        } else {
            (Some("storage_unavailable"), None)
        };
    }
    let Some(failure) = error.downcast_ref::<Failure>() else {
        return if temporary(error) {
            (None, None)
        } else {
            (Some("internal_error"), None)
        };
    };
    match failure {
        Failure::Invalid => (Some("invalid_archive"), None),
        Failure::Unsupported => (Some("unsupported_format"), None),
        Failure::Password => (Some("password_protected"), None),
        Failure::UnsafePath => (Some("unsafe_path"), None),
        Failure::PathConflict => (Some("path_conflict"), None),
        Failure::SourceTooLarge => (Some("source_too_large"), None),
        Failure::Integrity => (Some("integrity_mismatch"), None),
        Failure::Limit(limit) => (Some("safety_limit"), Some(limit)),
    }
}

fn storage_error<'a>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a opendal::Error> {
    error.downcast_ref::<opendal::Error>().or_else(|| {
        error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .and_then(|source| storage_error(source))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn helper_storage_failures_preserve_retry_classification() {
        for (reason, expected) in [
            ("temporary_storage", None),
            ("storage_unavailable", Some("storage_unavailable")),
        ] {
            let error = super::RemoteFailure {
                reason: reason.into(),
                limit: None,
            }
            .into();
            assert_eq!(super::classify(&error), (expected, None));
        }
        let error = std::io::Error::other(opendal::Error::new(
            opendal::ErrorKind::PermissionDenied,
            "denied",
        ))
        .into();
        assert_eq!(
            super::classify(&error),
            (Some("storage_unavailable"), None)
        );
    }
}

#[derive(Debug, thiserror::Error)]
#[error("archive helper: {reason}")]
pub(super) struct RemoteFailure {
    pub reason: String,
    pub limit: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub(super) enum StorageFailure {
    #[error("archive S3 HTTP {0}")]
    Status(u16),
    #[error("archive S3 service error: {0}")]
    Service(String),
}

impl StorageFailure {
    fn retryable(&self) -> bool {
        match self {
            Self::Status(status) => {
                matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
            }
            Self::Service(code) => matches!(
                code.as_str(),
                "RequestTimeout"
                    | "SlowDown"
                    | "InternalError"
                    | "ServiceUnavailable"
                    | "OperationAborted"
            ),
        }
    }
}

fn temporary(error: &anyhow::Error) -> bool {
    error.chain().any(|source| {
        if let Some(error) = source.downcast_ref::<std::io::Error>() {
            return temporary_io(error);
        }
        if let Some(error) = source.downcast_ref::<opendal::Error>() {
            return temporary_storage(error);
        }
        if let Some(error) = source.downcast_ref::<reqwest::Error>() {
            return error.is_timeout() || error.is_connect();
        }
        if let Some(error) = source.downcast_ref::<sea_orm::DbErr>() {
            return match error {
                sea_orm::DbErr::ConnectionAcquire(_) => true,
                sea_orm::DbErr::Conn(sea_orm::RuntimeErr::SqlxError(error))
                | sea_orm::DbErr::Exec(sea_orm::RuntimeErr::SqlxError(error))
                | sea_orm::DbErr::Query(sea_orm::RuntimeErr::SqlxError(
                    error,
                )) => temporary_database(error),
                _ => false,
            };
        }
        if let Some(error) = source.downcast_ref::<sqlx::Error>() {
            return temporary_database(error);
        }
        false
    })
}

fn temporary_io(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
    ) || error.get_ref().is_some_and(|source| {
        if let Some(error) = source.downcast_ref::<std::io::Error>() {
            return temporary_io(error);
        }
        source
            .downcast_ref::<opendal::Error>()
            .is_some_and(temporary_storage)
    })
}

fn temporary_storage(error: &opendal::Error) -> bool {
    error.is_temporary()
        || (error.is_persistent()
            && matches!(
                error.kind(),
                opendal::ErrorKind::Unexpected
                    | opendal::ErrorKind::RateLimited
            ))
}

fn temporary_database(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => true,
        sqlx::Error::Io(error) => temporary_io(error),
        sqlx::Error::Database(error) => error.code().is_some_and(|code| {
            code.starts_with("08")
                || matches!(
                    code.as_ref(),
                    "40001"
                        | "40P01"
                        | "53300"
                        | "55P03"
                        | "57014"
                        | "57P01"
                        | "57P02"
                        | "57P03"
                        | "58030"
                )
        }),
        _ => false,
    }
}
