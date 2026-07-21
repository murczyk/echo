use super::{
    error::{FilesystemError, FilesystemFieldError},
    types::{FileSearchFilters, RawFileSearchFilters},
};
use crate::config::{
    DEVICE_FILE_SEARCH_FILTER_MAX_VALUES,
    DEVICE_FILE_SEARCH_NAME_QUERY_MAX_CHARS,
    DEVICE_FILE_SEARCH_NAME_QUERY_MIN_CHARS,
};

impl TryFrom<RawFileSearchFilters> for FileSearchFilters {
    type Error = FilesystemError;

    fn try_from(raw: RawFileSearchFilters) -> Result<Self, Self::Error> {
        let RawFileSearchFilters {
            kinds,
            name_query,
            mime_types,
            extensions,
            file_metadata_modified_from,
            file_metadata_modified_to,
        } = raw;
        let mut errors = Vec::new();

        for (path, value_count) in [
            ("filters.kinds", kinds.len()),
            ("filters.mime_types", mime_types.len()),
            ("filters.extensions", extensions.len()),
        ] {
            if value_count > DEVICE_FILE_SEARCH_FILTER_MAX_VALUES {
                errors.push(FilesystemFieldError {
                    path: path.to_string(),
                    message: format!(
                        "must contain at most {DEVICE_FILE_SEARCH_FILTER_MAX_VALUES} values"
                    ),
                });
            }
        }

        let name_query = name_query.map(|name_query| {
            let name_query = name_query.trim().to_string();
            let char_count = name_query.chars().count();
            if !(DEVICE_FILE_SEARCH_NAME_QUERY_MIN_CHARS
                ..=DEVICE_FILE_SEARCH_NAME_QUERY_MAX_CHARS)
                .contains(&char_count)
            {
                errors.push(FilesystemFieldError {
                    path: "filters.name_query".to_string(),
                    message: format!(
                        "must contain between {DEVICE_FILE_SEARCH_NAME_QUERY_MIN_CHARS} and {DEVICE_FILE_SEARCH_NAME_QUERY_MAX_CHARS} Unicode scalar values"
                    ),
                });
            }
            name_query
        });

        if matches!(
            (file_metadata_modified_from, file_metadata_modified_to),
            (Some(from), Some(to)) if from > to
        ) {
            errors.push(FilesystemFieldError {
                path: "filters.file_metadata_modified_from".to_string(),
                message: "must be before or equal to filters.file_metadata_modified_to".to_string(),
            });
        }

        if !errors.is_empty() {
            return Err(FilesystemError::Validation(errors));
        }

        Ok(FileSearchFilters::from_validated_parts(
            canonicalize_values(kinds),
            name_query,
            canonicalize_values(mime_types),
            canonicalize_values(extensions),
            file_metadata_modified_from,
            file_metadata_modified_to,
        ))
    }
}

fn canonicalize_values<T: Ord>(mut values: Vec<T>) -> Vec<T> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::filesystem::types::{
        EntrySortKey, FileEntryKind, KeysetPageRequest,
    };
    use chrono::NaiveDate;

    fn raw_filters() -> RawFileSearchFilters {
        RawFileSearchFilters {
            kinds: Vec::new(),
            name_query: None,
            mime_types: Vec::new(),
            extensions: Vec::new(),
            file_metadata_modified_from: None,
            file_metadata_modified_to: None,
        }
    }

    fn validation_errors(
        result: Result<FileSearchFilters, FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn keyset_page_request_enforces_configured_limit_boundaries() {
        let default =
            KeysetPageRequest::<EntrySortKey>::try_new(None, None).unwrap();
        assert_eq!(default.limit(), 100);
        assert_eq!(default.after(), None);

        for limit in [0, 101] {
            let Err(FilesystemError::Validation(errors)) =
                KeysetPageRequest::<EntrySortKey>::try_new(Some(limit), None)
            else {
                panic!("expected invalid limit");
            };
            assert_eq!(
                errors,
                vec![FilesystemFieldError {
                    path: "limit".to_string(),
                    message: "must be between 1 and 100".to_string(),
                }]
            );
        }
    }

    #[test]
    fn filters_reject_pre_deduplication_value_counts_with_exact_paths() {
        let filters = RawFileSearchFilters {
            kinds: vec![FileEntryKind::File; 51],
            mime_types: vec!["application/json".to_string(); 51],
            extensions: vec!["json".to_string(); 51],
            ..raw_filters()
        };

        let errors = validation_errors(filters.try_into());
        assert_eq!(
            errors
                .into_iter()
                .map(|error| error.path)
                .collect::<Vec<_>>(),
            vec!["filters.kinds", "filters.mime_types", "filters.extensions",]
        );
    }

    #[test]
    fn filters_canonicalize_only_arrays_and_trim_name_query_once() {
        let filters = RawFileSearchFilters {
            kinds: vec![
                FileEntryKind::File,
                FileEntryKind::Directory,
                FileEntryKind::File,
            ],
            name_query: Some("  💾ab  ".to_string()),
            mime_types: vec![
                "text/plain".to_string(),
                " text/plain ".to_string(),
                "text/plain".to_string(),
            ],
            extensions: vec![
                "txt".to_string(),
                "TXT".to_string(),
                "txt".to_string(),
            ],
            ..raw_filters()
        };

        let filters = FileSearchFilters::try_from(filters).unwrap();
        let expected_mime_types =
            vec![" text/plain ".to_string(), "text/plain".to_string()];
        let expected_extensions = vec!["TXT".to_string(), "txt".to_string()];

        assert_eq!(
            filters.kinds(),
            &[FileEntryKind::Directory, FileEntryKind::File]
        );
        assert_eq!(filters.name_query(), Some("💾ab"));
        assert_eq!(filters.mime_types(), expected_mime_types.as_slice());
        assert_eq!(filters.extensions(), expected_extensions.as_slice());
    }

    #[test]
    fn name_query_uses_unicode_scalar_limits_and_rejects_whitespace() {
        let accepted = RawFileSearchFilters {
            name_query: Some("💾ab".to_string()),
            ..raw_filters()
        };
        assert_eq!(
            FileSearchFilters::try_from(accepted).unwrap().name_query(),
            Some("💾ab")
        );

        for name_query in ["   ".to_string(), "a".repeat(256)] {
            let errors = validation_errors(
                RawFileSearchFilters {
                    name_query: Some(name_query),
                    ..raw_filters()
                }
                .try_into(),
            );
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0].path, "filters.name_query");
        }
    }

    #[test]
    fn modified_time_range_is_validated_before_sql() {
        let from = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(11, 0, 0)
            .unwrap();
        let errors = validation_errors(
            RawFileSearchFilters {
                file_metadata_modified_from: Some(from),
                file_metadata_modified_to: Some(to),
                ..raw_filters()
            }
            .try_into(),
        );

        assert_eq!(
            errors,
            vec![FilesystemFieldError {
                path: "filters.file_metadata_modified_from".to_string(),
                message: "must be before or equal to filters.file_metadata_modified_to".to_string(),
            }]
        );
    }
}
