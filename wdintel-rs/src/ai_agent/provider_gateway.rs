use super::auth;
use crate::config::{
    AI_AGENT_OPENAI_API_BASE, AI_AGENT_OPENAI_REASONING_NONE_MODEL_PREFIX,
    AI_AGENT_PROVIDER_ERROR_MAX_BYTES,
    AI_AGENT_PROVIDER_ERROR_MESSAGE_MAX_CHARS, AI_AGENT_PROVIDER_GATEWAY_PATH,
    AI_AGENT_PROVIDER_REQUEST_MAX_BYTES, AI_AGENT_PROVIDER_REQUEST_TIMEOUT_SEC,
    AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES,
};
use crate::error::AppError;
use crate::h;
use crate::types::{info, warn, Env, ShortContext};
use actix_web::http::{header, StatusCode};
use actix_web::{post, web, HttpRequest, HttpResponse};
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[post("/api/ai-agent/provider/v1/chat/completions")]
pub async fn chat_completions(
    env: web::Data<Env>,
    http_req: HttpRequest,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    debug_assert_eq!(
        AI_AGENT_PROVIDER_GATEWAY_PATH,
        "/api/ai-agent/provider/v1/chat/completions"
    );
    let Some(capability) = bearer_capability(&http_req) else {
        return Ok(provider_error(
            StatusCode::UNAUTHORIZED,
            "Provider capability is invalid",
        ));
    };
    let Some(ai_engine) =
        auth::authorize_provider_capability(&env, capability).await?
    else {
        return Ok(provider_error(
            StatusCode::UNAUTHORIZED,
            "Provider capability is invalid or expired",
        ));
    };
    let body = read_bounded_payload(payload).await?;
    let Some((body, streamed)) =
        validate_request_body(&body, &ai_engine.model_name)
    else {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider request is invalid",
        ));
    };
    proxy_openai_request(ai_engine, body, streamed).await
}

fn bearer_capability(http_req: &HttpRequest) -> Option<&str> {
    let value = http_req
        .headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = value.strip_prefix("Bearer ")?;
    (token.len() == 43
        && token.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }))
    .then_some(token)
}

async fn read_bounded_payload(
    mut payload: web::Payload,
) -> Result<Bytes, AppError> {
    let mut body = web::BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len())
            > AI_AGENT_PROVIDER_REQUEST_MAX_BYTES
        {
            return Ok(Bytes::new());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

fn validate_request_body(
    body: &[u8],
    expected_model_name: &str,
) -> Option<(Value, bool)> {
    if body.is_empty() || body.len() > AI_AGENT_PROVIDER_REQUEST_MAX_BYTES {
        return None;
    }
    let mut body: Value = serde_json::from_slice(body).ok()?;
    let body = body.as_object_mut()?;
    if body.get("model")?.as_str()? != expected_model_name {
        return None;
    }
    let messages = body.get("messages")?.as_array()?;
    if messages.is_empty() || messages.len() > 512 {
        return None;
    }
    let streamed = match body.get("stream") {
        Some(streamed) => streamed.as_bool()?,
        None => false,
    };
    normalize_reasoning_effort(body, expected_model_name);
    body.insert("store".to_string(), Value::Bool(false));
    Some((Value::Object(body.clone()), streamed))
}

fn normalize_reasoning_effort(
    body: &mut serde_json::Map<String, Value>,
    expected_model_name: &str,
) {
    body.remove("reasoning_effort");
    if expected_model_name
        .starts_with(AI_AGENT_OPENAI_REASONING_NONE_MODEL_PREFIX)
    {
        body.insert(
            "reasoning_effort".to_string(),
            Value::String("none".to_string()),
        );
    }
}

async fn proxy_openai_request(
    ai_engine: crate::entities::ai_engine::Model,
    body: Value,
    streamed: bool,
) -> Result<HttpResponse, AppError> {
    let started_at = Instant::now();
    let reasoning_effort_present = body.get("reasoning_effort").is_some();
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(AI_AGENT_PROVIDER_REQUEST_TIMEOUT_SEC))
        .build()
        .c(h!())?;
    let token = ai_engine
        .token
        .as_deref()
        .ok_or(AppError::Unauthenticated)?;
    let response = client
        .post(format!("{AI_AGENT_OPENAI_API_BASE}/chat/completions"))
        .bearer_auth(token)
        .header(
            reqwest::header::ACCEPT,
            if streamed {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .json(&body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            warn!(
                "AI agent provider gateway transport failure timeout={} connect={} duration_ms={}",
                err.is_timeout(),
                err.is_connect(),
                started_at.elapsed().as_millis()
            );
            return Ok(provider_error(
                StatusCode::BAD_GATEWAY,
                "Provider connection failed",
            ));
        }
    };
    let status = response.status().as_u16();
    let upstream_request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| super::access::truncate(value, 200));
    let status =
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    if !status.is_success() {
        let metadata = read_provider_error_metadata(response).await;
        info!(
            "AI agent provider gateway response engine_id={} status={} duration_ms={} upstream_request_id={:?} reasoning_effort_present={} error_type={:?} error_code={:?} error_param={:?} error_kind={:?} error_message={:?}",
            ai_engine.id,
            status,
            started_at.elapsed().as_millis(),
            upstream_request_id,
            reasoning_effort_present,
            metadata.error_type,
            metadata.error_code,
            metadata.error_param,
            metadata.error_kind,
            metadata.error_message
        );
        return Ok(provider_error(status, "Provider request failed"));
    }
    info!(
        "AI agent provider gateway response engine_id={} status={} duration_ms={} upstream_request_id={:?}",
        ai_engine.id,
        status,
        started_at.elapsed().as_millis(),
        upstream_request_id
    );
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let expected_content_type = if streamed {
        "text/event-stream"
    } else {
        "application/json"
    };
    if !content_type
        .to_ascii_lowercase()
        .starts_with(expected_content_type)
    {
        warn!(
            "AI agent provider gateway rejected unexpected content type engine_id={} status={}",
            ai_engine.id, status
        );
        return Ok(provider_error(
            StatusCode::BAD_GATEWAY,
            "Provider returned an invalid response",
        ));
    }
    let engine_id = ai_engine.id;
    let stream = response.bytes_stream().scan(
        0_usize,
        move |response_bytes, chunk| {
            let result = match chunk {
                Ok(chunk) => {
                    *response_bytes = response_bytes.saturating_add(chunk.len());
                    if *response_bytes > AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES {
                        warn!(
                            "AI agent provider gateway response limit exceeded engine_id={engine_id}"
                        );
                        Err(actix_web::error::ErrorBadGateway(
                            "Provider response exceeded limit",
                        ))
                    } else {
                        Ok(chunk)
                    }
                }
                Err(_) => {
                    warn!(
                        "AI agent provider gateway response stream failed engine_id={engine_id}"
                    );
                    Err(actix_web::error::ErrorBadGateway(
                        "Provider response was interrupted",
                    ))
                }
            };
            futures_util::future::ready(Some(result))
        },
    );
    Ok(HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, expected_content_type))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .streaming(stream))
}

#[derive(Default)]
struct ProviderErrorMetadata {
    error_type: Option<String>,
    error_code: Option<String>,
    error_param: Option<String>,
    error_kind: Option<&'static str>,
    error_message: Option<String>,
}

async fn read_provider_error_metadata(
    response: reqwest::Response,
) -> ProviderErrorMetadata {
    let mut stream = response.bytes_stream();
    let mut body = web::BytesMut::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return ProviderErrorMetadata::default();
        };
        if body.len().saturating_add(chunk.len())
            > AI_AGENT_PROVIDER_ERROR_MAX_BYTES
        {
            return ProviderErrorMetadata::default();
        }
        body.extend_from_slice(&chunk);
    }
    parse_provider_error_metadata(&body)
}

fn parse_provider_error_metadata(body: &[u8]) -> ProviderErrorMetadata {
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return ProviderErrorMetadata::default();
    };
    let Some(error) = body.get("error").and_then(Value::as_object) else {
        return ProviderErrorMetadata::default();
    };
    ProviderErrorMetadata {
        error_type: sanitized_provider_error_field(error.get("type")),
        error_code: sanitized_provider_error_field(error.get("code")),
        error_param: sanitized_provider_error_field(error.get("param")),
        error_kind: provider_error_kind(error.get("message")),
        error_message: truncated_provider_error_message(error.get("message")),
    }
}

fn provider_error_kind(value: Option<&Value>) -> Option<&'static str> {
    let value = value?.as_str()?.to_ascii_lowercase();
    if value.contains("unsupported parameter") {
        Some("unsupported_parameter")
    } else if value.contains("unsupported value") {
        Some("unsupported_value")
    } else if value.contains("required parameter")
        || value.contains("is required")
    {
        Some("required_parameter")
    } else if value.contains("not supported") {
        Some("not_supported")
    } else if value.contains("invalid") {
        Some("invalid")
    } else {
        None
    }
}

fn sanitized_provider_error_field(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    (!value.is_empty()
        && value.len() <= 200
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.' | b'[' | b']')
        }))
    .then(|| value.to_string())
}

fn truncated_provider_error_message(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty()).then(|| {
        super::access::truncate(
            value,
            AI_AGENT_PROVIDER_ERROR_MESSAGE_MAX_CHARS,
        )
    })
}

fn provider_error(status: StatusCode, message: &'static str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(json!({
            "error": {
                "message": message,
                "type": "provider_gateway_error"
            }
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    #[test]
    fn accepts_only_exact_capability_bearer_shape() {
        let request = TestRequest::default()
            .insert_header((
                header::AUTHORIZATION,
                format!("Bearer {}", "A".repeat(43)),
            ))
            .to_http_request();
        assert_eq!(bearer_capability(&request).unwrap(), "A".repeat(43));

        let request = TestRequest::default()
            .insert_header((header::AUTHORIZATION, "Bearer real-openai-key"))
            .to_http_request();
        assert!(bearer_capability(&request).is_none());
    }

    #[test]
    fn validates_model_and_forces_request_storage_off() {
        let body = br#"{
            "model":"gpt-test",
            "messages":[{"role":"user","content":"hello"}],
            "stream":true,
            "reasoning_effort":"none",
            "store":true
        }"#;
        let (body, streamed) = validate_request_body(body, "gpt-test").unwrap();
        assert!(streamed);
        assert_eq!(body["store"], false);
        assert!(body.get("reasoning_effort").is_none());
        assert!(validate_request_body(body.to_string().as_bytes(), "other")
            .is_none());
    }

    #[test]
    fn forces_reasoning_effort_none_for_gpt_5_models() {
        let body = br#"{
            "model":"gpt-5.6-luna",
            "messages":[{"role":"user","content":"hello"}],
            "reasoning_effort":"high"
        }"#;
        let (body, _) = validate_request_body(body, "gpt-5.6-luna").unwrap();
        assert_eq!(body["reasoning_effort"], "none");
    }

    #[test]
    fn rejects_empty_or_oversized_message_lists() {
        assert!(validate_request_body(
            br#"{"model":"gpt-test","messages":[]}"#,
            "gpt-test"
        )
        .is_none());
        let body = json!({
            "model": "gpt-test",
            "messages": (0..513).map(|_| json!({"role": "user", "content": "x"})).collect::<Vec<_>>()
        });
        assert!(
            validate_request_body(body.to_string().as_bytes(), "gpt-test")
                .is_none()
        );
    }

    #[test]
    fn extracts_provider_error_metadata() {
        let metadata = parse_provider_error_metadata(
            br#"{"error":{"message":"Unsupported value: 'none' does not support reasoning_effort.","type":"invalid_request_error","code":"bad_schema","param":"tools[0].function.parameters"}}"#,
        );
        assert_eq!(
            metadata.error_type.as_deref(),
            Some("invalid_request_error")
        );
        assert_eq!(metadata.error_code.as_deref(), Some("bad_schema"));
        assert_eq!(
            metadata.error_param.as_deref(),
            Some("tools[0].function.parameters")
        );
        assert_eq!(metadata.error_kind, Some("unsupported_value"));
        assert_eq!(
            metadata.error_message.as_deref(),
            Some(
                "Unsupported value: 'none' does not support reasoning_effort."
            )
        );

        let metadata = parse_provider_error_metadata(
            br#"{"error":{"type":"invalid request\nsecret","param":"tools: secret"}}"#,
        );
        assert!(metadata.error_type.is_none());
        assert!(metadata.error_param.is_none());

        let metadata = parse_provider_error_metadata(
            br#"{"error":{"message":"Unsupported value for a field","param":"reasoning_effort"}}"#,
        );
        assert_eq!(metadata.error_kind, Some("unsupported_value"));

        let metadata = parse_provider_error_metadata(
            format!(
                r#"{{"error":{{"message":"{}"}}}}"#,
                "x".repeat(AI_AGENT_PROVIDER_ERROR_MESSAGE_MAX_CHARS + 1)
            )
            .as_bytes(),
        );
        assert_eq!(
            metadata.error_message.as_ref().map(String::len),
            Some(AI_AGENT_PROVIDER_ERROR_MESSAGE_MAX_CHARS)
        );
    }
}
