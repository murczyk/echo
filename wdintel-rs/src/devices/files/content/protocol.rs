use actix_web::body::BoxBody;
use actix_web::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use actix_web::http::StatusCode;
use actix_web::{HttpResponse, ResponseError};
use base64::Engine;
use chrono::{DateTime, FixedOffset, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::tus::{format_upload_expires, TUS_VERSION};

pub(crate) const CONTENT_TYPE_PATCH: &str = "application/offset+octet-stream";
pub(crate) const TUS_EXTENSIONS: &str = "creation,expiration";

pub(crate) const TUS_RESUMABLE: HeaderName =
    HeaderName::from_static("tus-resumable");
pub(crate) const TUS_VERSION_HEADER: HeaderName =
    HeaderName::from_static("tus-version");
pub(crate) const TUS_EXTENSION: HeaderName =
    HeaderName::from_static("tus-extension");
pub(crate) const TUS_MAX_SIZE: HeaderName =
    HeaderName::from_static("tus-max-size");
pub(crate) const UPLOAD_LENGTH: HeaderName =
    HeaderName::from_static("upload-length");
pub(crate) const UPLOAD_OFFSET: HeaderName =
    HeaderName::from_static("upload-offset");
pub(crate) const UPLOAD_METADATA: HeaderName =
    HeaderName::from_static("upload-metadata");
pub(crate) const UPLOAD_EXPIRES: HeaderName =
    HeaderName::from_static("upload-expires");

#[derive(Debug)]
pub(crate) struct ContentError {
    status: StatusCode,
    code: Option<&'static str>,
    headers: Vec<(HeaderName, String)>,
    app_error: Option<AppError>,
}

impl ContentError {
    pub(crate) fn bad_request(code: &'static str) -> Self {
        Self::domain(StatusCode::BAD_REQUEST, code)
    }

    pub(crate) fn not_found() -> Self {
        Self::domain(StatusCode::NOT_FOUND, "not_found")
    }

    pub(crate) fn conflict(code: &'static str) -> Self {
        Self::domain(StatusCode::CONFLICT, code)
    }

    pub(crate) fn gone(code: &'static str) -> Self {
        Self::domain(StatusCode::GONE, code)
    }

    pub(crate) fn precondition_failed() -> Self {
        Self::domain(StatusCode::PRECONDITION_FAILED, "unsupported_tus_version")
            .header(TUS_VERSION_HEADER, TUS_VERSION)
    }

    pub(crate) fn payload_too_large(code: Option<&'static str>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code,
            headers: Vec::new(),
            app_error: None,
        }
    }

    pub(crate) fn unsupported_media_type() -> Self {
        Self::domain(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_content_type")
    }

    pub(crate) fn unprocessable(code: &'static str) -> Self {
        Self::domain(StatusCode::UNPROCESSABLE_ENTITY, code)
    }

    pub(crate) fn unavailable(
        code: &'static str,
        retry_after_secs: u64,
    ) -> Self {
        Self::domain(StatusCode::SERVICE_UNAVAILABLE, code)
            .header(header::RETRY_AFTER, retry_after_secs.to_string())
    }

    pub(crate) fn method_not_allowed() -> Self {
        Self::domain(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed")
    }

    pub(crate) fn from_app(error: AppError) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: None,
            headers: Vec::new(),
            app_error: Some(error),
        }
    }

    pub(crate) fn is_unavailable(&self) -> bool {
        self.status == StatusCode::SERVICE_UNAVAILABLE
    }

    pub(crate) fn header(
        mut self,
        name: HeaderName,
        value: impl Into<String>,
    ) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    fn domain(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code: Some(code),
            headers: Vec::new(),
            app_error: None,
        }
    }
}

impl From<AppError> for ContentError {
    fn from(error: AppError) -> Self {
        Self::from_app(error)
    }
}

pub(crate) fn render(
    result: Result<HttpResponse, ContentError>,
    is_head: bool,
) -> HttpResponse {
    let response = match result {
        Ok(response) => response,
        Err(error) => render_error(error),
    };
    decorate(response, is_head)
}

pub(crate) fn options(max_upload_size: u64) -> HttpResponse {
    HttpResponse::NoContent()
        .insert_header((TUS_VERSION_HEADER, TUS_VERSION))
        .insert_header((TUS_EXTENSION, TUS_EXTENSIONS))
        .insert_header((TUS_MAX_SIZE, max_upload_size.to_string()))
        .finish()
}

pub(crate) fn parse_upload_length(
    headers: &HeaderMap,
    max_upload_size: u64,
) -> Result<u64, ContentError> {
    let values: Vec<_> = headers.get_all(&UPLOAD_LENGTH).collect();
    if values.len() != 1 {
        return Err(ContentError::bad_request("invalid_upload_length"));
    }
    let length = values[0]
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ContentError::bad_request("invalid_upload_length"))?;
    if length > max_upload_size {
        return Err(ContentError::payload_too_large(None));
    }
    Ok(length)
}

pub(crate) fn parse_upload_offset(
    headers: &HeaderMap,
) -> Result<u64, ContentError> {
    let values: Vec<_> = headers.get_all(&UPLOAD_OFFSET).collect();
    if values.len() != 1 {
        return Err(ContentError::bad_request("invalid_upload_offset"));
    }
    values[0]
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ContentError::bad_request("invalid_upload_offset"))
}

pub(crate) fn parse_sha256_metadata(
    headers: &HeaderMap,
    upload_length: u64,
) -> Result<[u8; 32], ContentError> {
    let values: Vec<_> = headers.get_all(&UPLOAD_METADATA).collect();
    if values.len() != 1 {
        return Err(ContentError::bad_request("invalid_upload_metadata"));
    }
    let metadata = values[0]
        .to_str()
        .map_err(|_| ContentError::bad_request("invalid_upload_metadata"))?;
    if metadata.contains(',') {
        return Err(ContentError::bad_request("invalid_upload_metadata"));
    }
    let mut parts = metadata.split_ascii_whitespace();
    if parts.next() != Some("sha256") {
        return Err(ContentError::bad_request("invalid_upload_metadata"));
    }
    let encoded = parts
        .next()
        .ok_or_else(|| ContentError::bad_request("invalid_upload_metadata"))?;
    if parts.next().is_some() {
        return Err(ContentError::bad_request("invalid_upload_metadata"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ContentError::bad_request("invalid_upload_metadata"))?;
    let digest: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ContentError::bad_request("invalid_upload_metadata"))?;
    if upload_length == 0 && digest != empty_sha256() {
        return Err(ContentError::unprocessable("sha256_mismatch"));
    }
    Ok(digest)
}

pub(crate) fn canonical_metadata(digest: &[u8; 32]) -> String {
    format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

pub(crate) fn upload_expires(expires: DateTime<FixedOffset>) -> String {
    format_upload_expires(expires.with_timezone(&Utc))
}

pub(crate) fn require_patch_content_type(
    headers: &HeaderMap,
) -> Result<(), ContentError> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        == Some(CONTENT_TYPE_PATCH)
    {
        Ok(())
    } else {
        Err(ContentError::unsupported_media_type())
    }
}

pub(crate) fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn empty_sha256() -> [u8; 32] {
    Sha256::digest([]).into()
}

fn render_error(error: ContentError) -> HttpResponse {
    let ContentError {
        status,
        code,
        headers,
        app_error,
    } = error;
    let mut response = if let Some(app_error) = app_error {
        app_error.error_response()
    } else if let Some(code) = code {
        HttpResponse::build(status).json(json!({ "code": code }))
    } else {
        HttpResponse::build(status).finish()
    };
    for (name, value) in headers {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

fn decorate(mut response: HttpResponse, is_head: bool) -> HttpResponse {
    response
        .headers_mut()
        .insert(TUS_RESUMABLE, HeaderValue::from_static(TUS_VERSION));
    if is_head {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );
        response.map_body(|_, _| BoxBody::new(()))
    } else {
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_strict_and_accepts_canonical_empty_digest() {
        let mut headers = HeaderMap::new();
        headers.insert(
            UPLOAD_METADATA,
            HeaderValue::from_static(
                "sha256 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            ),
        );
        assert_eq!(parse_sha256_metadata(&headers, 0).unwrap(), empty_sha256());

        headers.insert(
            UPLOAD_METADATA,
            HeaderValue::from_static("sha256 AA==,filename dGVzdA=="),
        );
        assert_eq!(
            parse_sha256_metadata(&headers, 1).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn every_rendered_response_gets_tus_header() {
        let response = render(Err(ContentError::not_found()), false);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers().get(TUS_RESUMABLE).unwrap(), TUS_VERSION);
    }
}
