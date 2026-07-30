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
mod tests;
