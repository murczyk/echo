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
            FilesystemError::CommitUncertain(anyhow::anyhow!(SENTINEL_SECRET)),
            "filesystem commit outcome uncertain",
            true,
        ),
    ];

    for (error, expected_display, has_source) in cases {
        assert_eq!(error.to_string(), expected_display);
        assert!(!error.to_string().contains(SENTINEL_SECRET));

        if has_source {
            let source = error.source().expect("source error must be retained");
            assert!(format!("{source:#}").contains(SENTINEL_SECRET));
        } else {
            assert!(error.source().is_none());
        }
    }
}
