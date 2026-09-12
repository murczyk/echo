use actix_web::http::header::{HeaderMap, HeaderName};
use actix_web::http::Method;
use chrono::{DateTime, Utc};

pub(crate) const TUS_VERSION: &str = "1.0.0";

const HEADER_NAME_TUS_RESUMABLE: HeaderName =
    HeaderName::from_static("tus-resumable");
const HEADER_NAME_HTTP_METHOD_OVERRIDE: HeaderName =
    HeaderName::from_static("x-http-method-override");

pub(crate) fn has_supported_version(headers: &HeaderMap) -> bool {
    headers
        .get(&HEADER_NAME_TUS_RESUMABLE)
        .and_then(|value| value.to_str().ok())
        == Some(TUS_VERSION)
}

pub(crate) fn effective_resource_method(
    method: &Method,
    headers: &HeaderMap,
    allowed_overrides: &[Method],
) -> Method {
    if method != Method::POST {
        return method.clone();
    }
    let Some(override_method) = headers
        .get(&HEADER_NAME_HTTP_METHOD_OVERRIDE)
        .and_then(|value| value.to_str().ok())
    else {
        return method.clone();
    };
    allowed_overrides
        .iter()
        .find(|allowed| allowed.as_str().eq_ignore_ascii_case(override_method))
        .cloned()
        .unwrap_or_else(|| method.clone())
}

pub(crate) fn format_upload_expires(expires: DateTime<Utc>) -> String {
    expires.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::HeaderValue;
    use chrono::TimeZone;

    #[test]
    fn supported_version_requires_exact_tus_version() {
        let mut headers = HeaderMap::new();
        assert!(!has_supported_version(&headers));

        headers.insert(
            HEADER_NAME_TUS_RESUMABLE.clone(),
            HeaderValue::from_static(TUS_VERSION),
        );
        assert!(has_supported_version(&headers));

        headers.insert(
            HEADER_NAME_TUS_RESUMABLE.clone(),
            HeaderValue::from_static("1.1.0"),
        );
        assert!(!has_supported_version(&headers));
    }

    #[test]
    fn resource_method_override_is_limited_to_allowed_methods() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HEADER_NAME_HTTP_METHOD_OVERRIDE.clone(),
            HeaderValue::from_static("delete"),
        );

        assert_eq!(
            effective_resource_method(
                &Method::POST,
                &headers,
                &[Method::PATCH, Method::DELETE],
            ),
            Method::DELETE,
        );
        assert_eq!(
            effective_resource_method(
                &Method::POST,
                &headers,
                &[Method::PATCH]
            ),
            Method::POST,
        );
        assert_eq!(
            effective_resource_method(
                &Method::PATCH,
                &headers,
                &[Method::PATCH, Method::DELETE],
            ),
            Method::PATCH,
        );
    }

    #[test]
    fn upload_expiry_uses_http_date_format() {
        let expires = Utc
            .with_ymd_and_hms(2026, 9, 5, 12, 34, 56)
            .single()
            .unwrap();

        assert_eq!(
            format_upload_expires(expires),
            "Sat, 05 Sep 2026 12:34:56 GMT",
        );
    }
}
