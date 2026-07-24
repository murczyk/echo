use crate::config::SERVER_JSON_PAYLOAD_MAX_BYTES;
use crate::error::AppError;
use actix_web::dev::Payload;
use actix_web::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use actix_web::HttpRequest;
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;

pub(super) async fn read_json_body(
    request: &HttpRequest,
    payload: &mut Payload,
) -> Result<Vec<u8>, AppError> {
    validate_json_content_type(request)?;
    read_body(payload, request_content_length(request)).await
}

pub(super) async fn require_empty_body(
    payload: &mut Payload,
) -> Result<(), AppError> {
    let body = read_body(payload, None).await?;
    if body.is_empty() {
        Ok(())
    } else {
        Err(body_form_error("Request body must be absent"))
    }
}

pub(super) fn decode_json<T>(body: &[u8]) -> Result<T, AppError>
where
    T: DeserializeOwned,
{
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let value = serde_path_to_error::deserialize(&mut deserializer)
        .map_err(map_deserialize_error)?;
    deserializer
        .end()
        .map_err(|_| body_form_error("Invalid JSON"))?;
    Ok(value)
}

fn validate_json_content_type(request: &HttpRequest) -> Result<(), AppError> {
    let Some(content_type) = request.headers().get(CONTENT_TYPE) else {
        return Err(body_form_error("Content-Type must be application/json"));
    };
    let Ok(content_type) = content_type.to_str() else {
        return Err(body_form_error("Content-Type must be application/json"));
    };
    let media_type = content_type
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or_default();
    if media_type.eq_ignore_ascii_case("application/json") {
        Ok(())
    } else {
        Err(body_form_error("Content-Type must be application/json"))
    }
}

async fn read_body(
    payload: &mut Payload,
    content_length: Option<usize>,
) -> Result<Vec<u8>, AppError> {
    if content_length
        .is_some_and(|length| length > SERVER_JSON_PAYLOAD_MAX_BYTES)
    {
        return Err(body_form_error("Request body is too large"));
    }

    let mut body = Vec::with_capacity(
        content_length
            .unwrap_or_default()
            .min(SERVER_JSON_PAYLOAD_MAX_BYTES),
    );
    while let Some(chunk) = payload.next().await {
        let chunk =
            chunk.map_err(|_| body_form_error("Invalid request body"))?;
        if chunk.len() > SERVER_JSON_PAYLOAD_MAX_BYTES - body.len() {
            return Err(body_form_error("Request body is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn request_content_length(request: &HttpRequest) -> Option<usize> {
    request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn map_deserialize_error(
    error: serde_path_to_error::Error<serde_json::Error>,
) -> AppError {
    let path = error.path().to_string();
    let source = error.into_inner();
    let source_message = source.to_string();
    let field = structural_field(&source_message);
    let path = structural_path(&path, field.as_deref());
    let message = if source.is_syntax() || source.is_eof() {
        "Invalid JSON"
    } else if source_message.contains("unknown field") {
        "Unknown field"
    } else if source_message.contains("missing field") {
        "Required field is missing"
    } else if source_message.contains("canonical lowercase hyphenated UUID") {
        "Must be a canonical lowercase hyphenated UUID"
    } else if source_message.contains("field cannot be null") {
        "Field cannot be null"
    } else if source_message.contains("RFC 3339 timestamp") {
        "Must be an RFC 3339 timestamp with an explicit timezone"
    } else {
        "Invalid value type"
    };
    form_error(path, message)
}

fn structural_field(message: &str) -> Option<String> {
    ["unknown field `", "missing field `"]
        .into_iter()
        .find_map(|prefix| {
            let value = message.split_once(prefix)?.1;
            Some(value.split_once('`')?.0.to_string())
        })
}

fn structural_path(path: &str, field: Option<&str>) -> String {
    let path = path.trim_start_matches('.');
    let path = if path == "?" { "" } else { path };
    match (path.is_empty(), field) {
        (true, Some(field)) => field.to_string(),
        (true, None) => "body".to_string(),
        (false, Some(field)) if path.rsplit('.').next() != Some(field) => {
            format!("{path}.{field}")
        }
        _ => path.to_string(),
    }
}

fn body_form_error(message: &str) -> AppError {
    form_error("body".to_string(), message)
}

fn form_error(path: String, message: &str) -> AppError {
    AppError::Form(BTreeMap::from([(path, message.to_string())]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::api::types::{
        NullablePatch, RequiredPatch, SearchDeviceFilesReq, SyncDeviceFilesReq,
        UpdateDeviceReq,
    };

    fn form_path<T>(result: Result<T, AppError>) -> String {
        let Err(AppError::Form(errors)) = result else {
            panic!("expected form error");
        };
        errors.into_keys().next().unwrap()
    }

    #[test]
    fn decode_reports_top_level_and_nested_structural_paths() {
        assert_eq!(
            form_path(decode_json::<UpdateDeviceReq>(br#"{"unexpected":1}"#)),
            "unexpected"
        );
        assert_eq!(
            form_path(decode_json::<SyncDeviceFilesReq>(
                br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a","unexpected":1}]}"#,
            )),
            "files[0].unexpected"
        );
        assert_eq!(form_path(decode_json::<UpdateDeviceReq>(b"{")), "body",);
    }

    #[test]
    fn decode_rejects_noncanonical_uuid_and_explicit_null_file_id() {
        assert_eq!(
            form_path(decode_json::<SyncDeviceFilesReq>(
                br#"{"device_id":"018F0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a"}]}"#,
            )),
            "device_id"
        );
        assert_eq!(
            form_path(decode_json::<SyncDeviceFilesReq>(
                br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"file_id":null,"absolute_path":"/a"}]}"#,
            )),
            "files[0].file_id"
        );
    }

    #[test]
    fn decode_preserves_missing_null_and_value_patch_states() {
        let request = decode_json::<UpdateDeviceReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","external_url":null,"custom_fields":{},"name":"Analytical"}"#,
        )
        .unwrap();

        assert_eq!(request.source_label, RequiredPatch::Missing);
        assert_eq!(request.external_url, NullablePatch::Null);
        assert_eq!(
            request.custom_fields,
            RequiredPatch::Value(BTreeMap::new()),
        );
        assert_eq!(
            request.name,
            NullablePatch::Value("Analytical".to_string()),
        );
        assert_eq!(request.aor_ids, RequiredPatch::Missing);
        assert_eq!(request.unit_id, NullablePatch::Missing);

        assert_eq!(
            form_path(decode_json::<UpdateDeviceReq>(
                br#"{"device_id":"018f0000-0000-7000-8000-000000000000","source_label":null}"#,
            )),
            "source_label",
        );
    }

    #[test]
    fn timestamp_filters_require_a_zone_but_sync_timestamps_are_item_data() {
        assert_eq!(
            form_path(decode_json::<SearchDeviceFilesReq>(
                br#"{"device_id":"018f0000-0000-7000-8000-000000000000","scope_entry_id":"018f0000-0000-7000-8000-000000000001","file_metadata_modified_from":"2026-07-23T12:00:00"}"#,
            )),
            "file_metadata_modified_from",
        );

        let request = decode_json::<SyncDeviceFilesReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a","file_metadata_created_at":"not-a-timestamp"}]}"#,
        )
        .unwrap();
        assert_eq!(
            request.files[0].file_metadata_created_at.as_deref(),
            Some("not-a-timestamp"),
        );
    }
}
