use thiserror::Error;

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FilesystemFieldError {
    pub(in crate::devices) path: String,
    pub(in crate::devices) message: String,
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
            ),
            (FilesystemError::NotFound, "filesystem entry not found"),
            (FilesystemError::Conflict, "filesystem conflict"),
            (
                FilesystemError::Dependency(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem dependency failed",
            ),
            (
                FilesystemError::Invariant("safe_invariant_code"),
                "filesystem invariant failed: safe_invariant_code",
            ),
            (
                FilesystemError::Internal(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem internal failure",
            ),
            (
                FilesystemError::CommitUncertain(anyhow::anyhow!(
                    SENTINEL_SECRET
                )),
                "filesystem commit outcome uncertain",
            ),
        ];

        for (error, expected_display) in cases {
            let has_source = matches!(
                &error,
                FilesystemError::Dependency(_)
                    | FilesystemError::Internal(_)
                    | FilesystemError::CommitUncertain(_)
            );
            assert_eq!(error.to_string(), expected_display);
            assert!(!error.to_string().contains(SENTINEL_SECRET));

            if has_source {
                let source =
                    error.source().expect("source error must be retained");
                assert!(format!("{source:#}").contains(SENTINEL_SECRET));
            }
        }
    }
}
