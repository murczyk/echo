use super::{
    error::{FilesystemError, FilesystemFieldError},
    types::NormalizedFileMetadata,
};
use crate::config::{
    DEVICE_FILE_EXTENSION_MAX_CHARS, DEVICE_FILE_MIME_TYPE_MAX_CHARS,
};
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};

pub(in crate::devices) fn normalize_file_metadata(
    file_name: &str,
    mime_type: Option<String>,
    extension: Option<String>,
    file_metadata_created_at: Option<DateTime<FixedOffset>>,
    file_metadata_modified_at: Option<DateTime<FixedOffset>>,
    field_prefix: &str,
) -> Result<NormalizedFileMetadata, FilesystemError> {
    let mut errors = Vec::new();
    let mime_type = normalize_explicit_value(
        mime_type.as_deref(),
        field_prefix,
        "mime_type",
        DEVICE_FILE_MIME_TYPE_MAX_CHARS,
        false,
        &mut errors,
    );
    let extension = normalize_explicit_value(
        extension.as_deref(),
        field_prefix,
        "extension",
        DEVICE_FILE_EXTENSION_MAX_CHARS,
        true,
        &mut errors,
    );

    if !errors.is_empty() {
        return Err(FilesystemError::Validation(errors));
    }

    let extension =
        extension.or_else(|| derived_extension(file_name).map(str::to_string));
    let mime_type = mime_type.or_else(|| {
        extension
            .as_deref()
            .and_then(|extension| mime_guess::from_ext(extension).first_raw())
            .map(str::to_string)
    });

    Ok(NormalizedFileMetadata {
        mime_type,
        extension,
        file_metadata_created_at: normalize_timestamp(file_metadata_created_at),
        file_metadata_modified_at: normalize_timestamp(
            file_metadata_modified_at,
        ),
    })
}

fn normalize_explicit_value(
    value: Option<&str>,
    field_prefix: &str,
    field_name: &str,
    max_chars: usize,
    reject_leading_dot: bool,
    errors: &mut Vec<FilesystemFieldError>,
) -> Option<String> {
    let value = value?;
    let value = value.trim();
    let char_count = value.chars().count();
    if !(1..=max_chars).contains(&char_count) {
        errors.push(FilesystemFieldError {
            path: format!("{field_prefix}.{field_name}"),
            message: format!(
                "must contain between 1 and {max_chars} Unicode scalar values after trimming"
            ),
        });
        return None;
    }

    if reject_leading_dot && value.starts_with('.') {
        errors.push(FilesystemFieldError {
            path: format!("{field_prefix}.{field_name}"),
            message: "must not start with '.'".to_string(),
        });
        return None;
    }

    Some(value.to_string())
}

fn derived_extension(file_name: &str) -> Option<&str> {
    let (prefix, extension) = file_name.rsplit_once('.')?;
    if prefix.is_empty() || extension.is_empty() {
        return None;
    }

    Some(extension)
}

fn normalize_timestamp(
    timestamp: Option<DateTime<FixedOffset>>,
) -> Option<NaiveDateTime> {
    timestamp.map(|timestamp| timestamp.with_timezone(&Utc).naive_utc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        DEVICE_FILE_EXTENSION_MAX_CHARS, DEVICE_FILE_MIME_TYPE_MAX_CHARS,
    };
    use chrono::{DateTime, NaiveDate};

    fn validation_errors(
        result: Result<NormalizedFileMetadata, FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn explicit_metadata_is_trimmed_and_takes_precedence_without_case_rewrite()
    {
        let metadata = normalize_file_metadata(
            "report.pdf",
            Some("  application/x-custom  ".to_string()),
            Some("  TXT  ".to_string()),
            None,
            None,
            "files[3]",
        )
        .unwrap();

        assert_eq!(metadata.mime_type.as_deref(), Some("application/x-custom"));
        assert_eq!(metadata.extension.as_deref(), Some("TXT"));
    }

    #[test]
    fn custom_and_unknown_explicit_values_are_preserved_without_filename_fallback(
    ) {
        let custom = normalize_file_metadata(
            "report.pdf",
            Some("vendor/custom".to_string()),
            Some("custom_extension".to_string()),
            None,
            None,
            "files[0]",
        )
        .unwrap();
        assert_eq!(custom.mime_type.as_deref(), Some("vendor/custom"));
        assert_eq!(custom.extension.as_deref(), Some("custom_extension"));

        let unknown_extension = normalize_file_metadata(
            "report.pdf",
            None,
            Some("not-a-known-extension".to_string()),
            None,
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(
            unknown_extension.extension.as_deref(),
            Some("not-a-known-extension")
        );
        assert_eq!(unknown_extension.mime_type, None);
    }

    #[test]
    fn derives_exact_extension_from_last_meaningful_dot() {
        let cases = [
            ("report.tar.gz", Some("gz")),
            (".bashrc", None),
            (".config.json", Some("json")),
            ("report.", None),
            ("report", None),
        ];

        for (file_name, expected_extension) in cases {
            let metadata = normalize_file_metadata(
                file_name, None, None, None, None, "files[2]",
            )
            .unwrap();
            assert_eq!(
                metadata.extension.as_deref(),
                expected_extension,
                "{file_name}"
            );
        }
    }

    #[test]
    fn derives_known_mime_and_leaves_unknown_mapping_absent() {
        let known = normalize_file_metadata(
            "report.pdf",
            None,
            None,
            None,
            None,
            "files[0]",
        )
        .unwrap();
        assert_eq!(known.extension.as_deref(), Some("pdf"));
        assert_eq!(known.mime_type.as_deref(), Some("application/pdf"));

        let unknown = normalize_file_metadata(
            "report.unmapped_extension",
            None,
            None,
            None,
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(unknown.extension.as_deref(), Some("unmapped_extension"));
        assert_eq!(unknown.mime_type, None);
    }

    #[test]
    fn normalizes_timezone_offsets_to_naive_utc() {
        let expected = NaiveDate::from_ymd_opt(2026, 7, 22)
            .unwrap()
            .and_hms_opt(9, 30, 0)
            .unwrap();
        let positive =
            DateTime::parse_from_rfc3339("2026-07-22T12:30:00+03:00").unwrap();
        let negative =
            DateTime::parse_from_rfc3339("2026-07-22T05:30:00-04:00").unwrap();
        let metadata = normalize_file_metadata(
            "report",
            None,
            None,
            Some(positive),
            Some(negative),
            "files[0]",
        )
        .unwrap();
        assert_eq!(metadata.file_metadata_created_at, Some(expected));
        assert_eq!(metadata.file_metadata_modified_at, Some(expected));

        let utc = DateTime::parse_from_rfc3339("2026-07-22T09:30:00Z").unwrap();
        let metadata = normalize_file_metadata(
            "report",
            None,
            None,
            Some(utc),
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(metadata.file_metadata_created_at, Some(expected));
        assert_eq!(metadata.file_metadata_modified_at, None);
    }

    #[test]
    fn metadata_validation_collects_mime_then_extension_errors_with_exact_paths(
    ) {
        assert_eq!(
            validation_errors(normalize_file_metadata(
                "report.pdf",
                Some("  ".to_string()),
                Some(" .txt ".to_string()),
                None,
                None,
                "files[3]",
            )),
            vec![
                FilesystemFieldError {
                    path: "files[3].mime_type".to_string(),
                    message: format!(
                        "must contain between 1 and {DEVICE_FILE_MIME_TYPE_MAX_CHARS} Unicode scalar values after trimming"
                    ),
                },
                FilesystemFieldError {
                    path: "files[3].extension".to_string(),
                    message: "must not start with '.'".to_string(),
                },
            ]
        );

        let long_extension = "a".repeat(DEVICE_FILE_EXTENSION_MAX_CHARS + 1);
        assert_eq!(
            validation_errors(normalize_file_metadata(
                "report.pdf",
                None,
                Some(long_extension),
                None,
                None,
                "files[4]",
            )),
            vec![FilesystemFieldError {
                path: "files[4].extension".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_EXTENSION_MAX_CHARS} Unicode scalar values after trimming"
                ),
            }]
        );
    }
}
