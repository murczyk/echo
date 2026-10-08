use regex::Regex;
use std::sync::LazyLock;

static HOSTNAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    )
    .expect("hostname regex is valid")
});

use actix_web::{http::header::HeaderName, HttpRequest};

#[derive(serde::Deserialize)]
pub struct LoginRedirectQuery {
    pub redirect: Option<String>,
}

pub fn local_login_redirect(target: &str) -> Option<&str> {
    if !target.starts_with('/')
        || target.starts_with("//")
        || target.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let origin = url::Url::parse("https://echo.invalid").ok()?;
    let destination = origin.join(target).ok()?;
    let path = urlencoding::decode(destination.path()).ok()?;
    if destination.origin() != origin.origin()
        || target.split(['?', '#']).next()?.contains('\\')
        || path.contains('\\')
        || path.starts_with("//")
        || path.chars().any(char::is_control)
        || path.trim_end_matches('/') == "/login"
    {
        return None;
    }
    Some(target)
}

pub fn login_redirect_url(
    redirect: Option<&str>,
    api_error: Option<&str>,
) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(api_error) = api_error {
        query.append_pair("api_error", api_error);
    }
    if let Some(redirect) = redirect.and_then(local_login_redirect) {
        query.append_pair("redirect", redirect);
    }
    let query = query.finish();
    if query.is_empty() {
        "/login".to_owned()
    } else {
        format!("/login?{query}")
    }
}

pub fn extract_authority_header(req: &HttpRequest) -> Option<String> {
    if let Some(authority_header) =
        req.headers().get(HeaderName::from_static("authority"))
    {
        // Attempt to get the :authority: header first for HTTP/2
        if let Ok(authority_str) = authority_header.to_str() {
            Some(authority_str.to_string())
        } else {
            None
        }
    } else {
        // Fallback to Host header for HTTP/1.x or if :authority: is not present
        if let Some(host_header) =
            req.headers().get(HeaderName::from_static("host"))
        {
            if let Ok(host_str) = host_header.to_str() {
                Some(host_str.to_string())
            } else {
                None
            }
        } else {
            None
        }
    }
}

pub fn is_valid_hostname(hostname: &str) -> bool {
    !hostname.is_empty()
        && hostname.len() <= 253
        && HOSTNAME_RE.is_match(hostname)
}
