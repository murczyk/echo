use super::{
    error::{FilesystemError, FilesystemFieldError},
    types::{FileSearchFilters, RawFileSearchFilters, SyncFileItemCommand},
};
use crate::config::{
    DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES, DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS,
    DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS,
    DEVICE_FILE_PATH_COMPONENT_MAX_CHARS, DEVICE_FILE_PATH_COMPONENT_MAX_COUNT,
    DEVICE_FILE_SEARCH_FILTER_MAX_VALUES,
    DEVICE_FILE_SEARCH_NAME_QUERY_MAX_CHARS,
    DEVICE_FILE_SEARCH_NAME_QUERY_MIN_CHARS, DEVICE_FILE_SYNC_BATCH_MAX_COUNT,
};
use std::collections::HashSet;
use uuid::Uuid;

pub(super) fn validate_absolute_path_limits(
    absolute_path: &str,
    field_path: &str,
) -> Result<(), FilesystemError> {
    if absolute_path.len() > DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES {
        return Err(validation_error(
            field_path,
            format!(
                "must contain at most {DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES} UTF-8 bytes"
            ),
        ));
    }

    let char_count = absolute_path.chars().count();
    if !(1..=DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS).contains(&char_count) {
        return Err(validation_error(
            field_path,
            format!(
                "must contain between 1 and {DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS} Unicode scalar values"
            ),
        ));
    }

    Ok(())
}

pub(super) fn validate_path_component_limits(
    components: &[&str],
    field_path: &str,
) -> Result<(), FilesystemError> {
    if !(1..=DEVICE_FILE_PATH_COMPONENT_MAX_COUNT).contains(&components.len()) {
        return Err(validation_error(
            field_path,
            format!(
                "must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_COUNT} path components"
            ),
        ));
    }

    let mut total_char_count = 0;
    for component in components {
        let char_count = component.chars().count();
        if !(1..=DEVICE_FILE_PATH_COMPONENT_MAX_CHARS).contains(&char_count) {
            return Err(validation_error(
                field_path,
                format!(
                    "each path component must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_CHARS} Unicode scalar values"
                ),
            ));
        }
        total_char_count += char_count;
    }

    if total_char_count > DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS {
        return Err(validation_error(
            field_path,
            format!(
                "path components must contain at most {DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS} Unicode scalar values in total"
            ),
        ));
    }

    Ok(())
}

pub(super) fn validate_sync_batch_size(
    item_count: usize,
) -> Result<(), FilesystemError> {
    if !(1..=DEVICE_FILE_SYNC_BATCH_MAX_COUNT).contains(&item_count) {
        return Err(validation_error(
            "files",
            format!(
                "must contain between 1 and {DEVICE_FILE_SYNC_BATCH_MAX_COUNT} items"
            ),
        ));
    }

    Ok(())
}

pub(super) fn duplicate_file_ids(
    files: &[SyncFileItemCommand],
) -> HashSet<Uuid> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();

    for file in files {
        if let Some(file_id) = file.file_id {
            if !seen.insert(file_id) {
                duplicates.insert(file_id);
            }
        }
    }

    duplicates
}

fn validation_error(field_path: &str, message: String) -> FilesystemError {
    FilesystemError::Validation(vec![FilesystemFieldError {
        path: field_path.to_string(),
        message,
    }])
}
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
            ("kinds", kinds.len()),
            ("mime_types", mime_types.len()),
            ("extensions", extensions.len()),
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
                    path: "name_query".to_string(),
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
                path: "file_metadata_modified_from".to_string(),
                message: "must be before or equal to file_metadata_modified_to"
                    .to_string(),
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
mod tests;
