use super::*;
use crate::devices::filesystem::FilesystemFieldError;

#[test]
fn read_error_mapping_preserves_application_taxonomy() {
    let validation = map_read_error(FilesystemError::Validation(vec![
        FilesystemFieldError {
            path: "cursor".to_string(),
            message: "invalid cursor".to_string(),
        },
        FilesystemFieldError {
            path: "name_query".to_string(),
            message: "must not be empty".to_string(),
        },
    ]));
    let AppError::Form(errors) = validation else {
        panic!("validation must map to form errors");
    };
    assert_eq!(errors.get("cursor"), Some(&"invalid cursor".to_string()));
    assert_eq!(
        errors.get("name_query"),
        Some(&"must not be empty".to_string())
    );

    assert!(matches!(
        map_read_error(FilesystemError::NotFound),
        AppError::NotFound
    ));
    assert!(matches!(
        map_read_error(FilesystemError::Invariant("internal_detail")),
        AppError::BL { msg }
            if msg == "device filesystem invariant violated"
    ));

    let internal = map_read_error(FilesystemError::Internal(anyhow::anyhow!(
        "database connection failed"
    )));
    let AppError::AnyhowError { source } = internal else {
        panic!("internal filesystem error must retain its source");
    };
    assert_eq!(source.to_string(), "failed to read device filesystem");
    assert!(source.chain().any(|error| matches!(
        error.downcast_ref::<FilesystemError>(),
        Some(FilesystemError::Internal(_))
    )));
}

#[test]
fn sync_commit_uncertainty_remains_fatal_with_its_source() {
    let error = map_sync_error(FilesystemError::CommitUncertain(
        anyhow::anyhow!("stage-eleven-uncertain"),
    ));
    let AppError::AnyhowError { source } = error else {
        panic!("commit uncertainty must remain a top-level error");
    };
    assert_eq!(source.to_string(), "failed to sync device filesystem");
    assert!(source.chain().any(|error| matches!(
        error.downcast_ref::<FilesystemError>(),
        Some(FilesystemError::CommitUncertain(_))
    )));
    assert!(source
        .chain()
        .any(|error| error.to_string().contains("stage-eleven-uncertain")));
}
