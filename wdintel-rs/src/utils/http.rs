use actix_web::{http::header::HeaderName, HttpRequest};

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
