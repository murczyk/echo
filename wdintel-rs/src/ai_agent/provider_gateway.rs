use super::auth;
use super::reasoning::{ProviderApi, ProviderPurpose};
use crate::config::{
    AI_AGENT_GLM_5_3_PROVIDER_REQUEST_TIMEOUT_SEC, AI_AGENT_OPENAI_GPT_6_LUNA,
    AI_AGENT_OPENAI_GPT_6_SOL, AI_AGENT_OPENAI_REASONING_NONE_MODEL_PREFIX,
    AI_AGENT_PROVIDER_CONTEXT_LIMIT_MESSAGE, AI_AGENT_PROVIDER_ERROR_MAX_BYTES,
    AI_AGENT_PROVIDER_ERROR_MESSAGE_MAX_CHARS,
    AI_AGENT_PROVIDER_OUTPUT_LIMIT_MESSAGE,
    AI_AGENT_PROVIDER_REQUEST_MAX_BYTES, AI_AGENT_PROVIDER_REQUEST_TIMEOUT_SEC,
    AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES, AI_AGENT_PROVIDER_STREAM_MAX_BYTES,
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
    provider_call(env, http_req, payload, ProviderApi::OpenaiCompletions).await
}

#[post("/api/ai-agent/provider/v1/responses")]
pub async fn responses(
    env: web::Data<Env>,
    http_req: HttpRequest,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    provider_call(env, http_req, payload, ProviderApi::OpenaiResponses).await
}

async fn provider_call(
    env: web::Data<Env>,
    http_req: HttpRequest,
    payload: web::Payload,
    api: ProviderApi,
) -> Result<HttpResponse, AppError> {
    let purpose = http_req
        .headers()
        .get(crate::config::AI_AGENT_REASONING_PURPOSE_HEADER);
    let Some(purpose) = ProviderPurpose::parse(
        purpose.map(|value| value.to_str().unwrap_or("invalid")),
    ) else {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider purpose is invalid",
        ));
    };
    let Some(capability) = bearer_capability(&http_req) else {
        return Ok(provider_error(
            StatusCode::UNAUTHORIZED,
            "Provider capability is invalid",
        ));
    };
    let body = read_bounded_payload(payload).await.c(h!())?;
    let Some(requested_model_name) = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|body| {
            body.get("model").and_then(Value::as_str).map(str::to_owned)
        })
    else {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider request is invalid",
        ));
    };
    let Some(authorization) = auth::authorize_provider_call(
        &env,
        capability,
        &requested_model_name,
        purpose,
    )
    .await
    .c(h!())?
    else {
        return Ok(provider_error(
            StatusCode::UNAUTHORIZED,
            "Provider capability is invalid or expired",
        ));
    };
    if authorization.research_limit_reached {
        return Ok(provider_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Provider research budget exhausted",
        ));
    }
    let allowed_api = authorization
        .execution_policy
        .as_ref()
        .map_or(ProviderApi::OpenaiCompletions, |policy| policy.api);
    if api != allowed_api {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider transport is unavailable for this request",
        ));
    }
    let validated = match api {
        ProviderApi::OpenaiCompletions => {
            validate_request_body(&body, &authorization.ai_engine.model_name)
        }
        ProviderApi::OpenaiResponses => {
            validate_responses_body(&body, &authorization.ai_engine.model_name)
        }
    };
    let Some((mut body, streamed)) = validated else {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider request is invalid",
        ));
    };
    let images_allowed = match image_parts(&body) {
        ImageParts::None => true,
        ImageParts::Invalid => false,
        ImageParts::Inline => super::uploads::agent_api::vision_enabled(
            &env,
            authorization.ai_engine.id,
        )
        .await
        .c(h!())?,
    };
    if !images_allowed {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider request is invalid",
        ));
    }
    if !purpose_request_is_allowed(
        &body,
        api,
        purpose,
        authorization.checkpoint_max_tokens,
    ) {
        return Ok(provider_error(
            StatusCode::BAD_REQUEST,
            "Provider purpose request is invalid",
        ));
    }
    let mut deadline = authorization.deadline_at;
    if let Some(policy) = &authorization.execution_policy {
        let effort = match purpose {
            ProviderPurpose::Research => &policy.reasoning_effort,
            ProviderPurpose::Checkpoint => &policy.checkpoint_effort,
            ProviderPurpose::Synthesis => &policy.synthesis_effort,
        };
        let body = body.as_object_mut().c(h!())?;
        body.remove("reasoning_effort");
        body.remove("reasoning");
        if let Some(effort) = effort {
            match api {
                ProviderApi::OpenaiCompletions => {
                    body.insert("reasoning_effort".to_string(), json!(effort));
                }
                ProviderApi::OpenaiResponses => {
                    body.insert(
                        "reasoning".to_string(),
                        json!({ "effort": effort }),
                    );
                    body.insert(
                        "include".to_string(),
                        json!(["reasoning.encrypted_content"]),
                    );
                }
            }
        }
        if purpose != ProviderPurpose::Synthesis {
            deadline = deadline.map(|deadline| {
                deadline - policy.finalization_seconds as i64 * 1000
            });
        }
    }
    info!("AI agent provider policy request_id={} engine_id={} api={:?} purpose={:?} effort={:?}", authorization.request_id, authorization.ai_engine.id, api, purpose, body.get("reasoning_effort").or_else(|| body.get("reasoning")));
    proxy_provider_call(
        &env.ai_engine_client,
        authorization.ai_engine,
        body,
        streamed,
        ProviderCallContext {
            api,
            deadline,
            request_id: Some(authorization.request_id),
            turn_timeout_sec: super::reasoning::limits(
                authorization.execution_policy.as_ref(),
            )
            .provider_turn_timeout_sec,
        },
    )
    .await
}

fn validate_responses_body(
    body: &[u8],
    expected_model_name: &str,
) -> Option<(Value, bool)> {
    if body.is_empty() || body.len() > AI_AGENT_PROVIDER_REQUEST_MAX_BYTES {
        return None;
    }
    let mut body: Value = serde_json::from_slice(body).ok()?;
    let object = body.as_object_mut()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "model"
                | "input"
                | "instructions"
                | "tools"
                | "tool_choice"
                | "parallel_tool_calls"
                | "stream"
                | "max_output_tokens"
                | "temperature"
                | "top_p"
                | "text"
                | "include"
                | "reasoning"
                | "store"
                | "prompt_cache_key"
                | "prompt_cache_retention"
                | "prompt_cache_options"
        )
    }) {
        return None;
    }
    if object.get("model")?.as_str()? != expected_model_name {
        return None;
    }
    let input = object.get("input")?.as_array()?;
    if input.is_empty()
        || input.len() > 512
        || input.iter().any(|item| !responses_input_is_allowed(item))
    {
        return None;
    }
    if let Some(tools) = object.get_mut("tools") {
        for tool in tools.as_array_mut()? {
            let tool = tool.as_object_mut()?;
            if tool.get("type")?.as_str()? != "function" {
                return None;
            }
            if tool.get("strict").is_none_or(Value::is_null) {
                tool.insert("strict".to_string(), json!(false));
            }
        }
    }
    if object.get("tool_choice").is_some_and(|choice| {
        !matches!(choice.as_str(), Some("none" | "auto" | "required"))
            && !(choice.get("type").and_then(Value::as_str) == Some("function")
                && choice.get("name").is_some_and(Value::is_string))
    }) {
        return None;
    }
    let streamed = object
        .get("stream")
        .map(Value::as_bool)
        .unwrap_or(Some(false))?;
    object.insert("store".to_string(), json!(false));
    Some((body, streamed))
}

fn responses_input_is_allowed(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        None | Some("message") => {
            matches!(
                item.get("role").and_then(Value::as_str),
                Some("system" | "developer" | "user" | "assistant")
            ) && item.get("content").is_some_and(|content| {
                content.is_string()
                    || content.as_array().is_some_and(|parts| {
                        parts.iter().all(responses_part_is_allowed)
                    })
            })
        }
        Some("function_call") => ["call_id", "name", "arguments"]
            .iter()
            .all(|key| item.get(*key).is_some_and(Value::is_string)),
        Some("function_call_output") => {
            item.get("call_id").is_some_and(Value::is_string)
                && item.get("output").is_some_and(|output| {
                    output.is_string()
                        || output.as_array().is_some_and(|parts| {
                            parts.iter().all(responses_part_is_allowed)
                        })
                })
        }
        Some("reasoning") => {
            item.get("encrypted_content").is_some_and(Value::is_string)
        }
        _ => false,
    }
}

fn responses_part_is_allowed(part: &Value) -> bool {
    match part.get("type").and_then(Value::as_str) {
        Some("input_text" | "output_text") => {
            part.get("text").is_some_and(Value::is_string)
        }
        Some("input_image") => part
            .get("image_url")
            .and_then(Value::as_str)
            .is_some_and(is_inline_image_url),
        _ => false,
    }
}

/// Images may only arrive inline; remote URLs would let the agent make the
/// provider fetch arbitrary addresses.
fn is_inline_image_url(url: &str) -> bool {
    ["image/jpeg", "image/png", "image/webp"]
        .iter()
        .any(|mime| {
            url.strip_prefix("data:")
                .and_then(|rest| rest.strip_prefix(mime))
                .and_then(|rest| rest.strip_prefix(";base64,"))
                .is_some_and(|data| !data.is_empty())
        })
}

#[derive(Debug, PartialEq, Eq)]
enum ImageParts {
    None,
    Inline,
    Invalid,
}

/// Scans a provider body for image parts of either OpenAI API shape.
fn image_parts(body: &Value) -> ImageParts {
    fn visit(value: &Value, found: &mut ImageParts) {
        match value {
            Value::Array(values) => {
                values.iter().for_each(|value| visit(value, found))
            }
            Value::Object(object) => {
                let url = match object.get("type").and_then(Value::as_str) {
                    Some("input_image") => {
                        Some(object.get("image_url").and_then(Value::as_str))
                    }
                    Some("image_url") => Some(
                        object
                            .get("image_url")
                            .and_then(|image| image.get("url"))
                            .and_then(Value::as_str),
                    ),
                    _ => None,
                };
                match url {
                    Some(Some(url)) if is_inline_image_url(url) => {
                        if *found == ImageParts::None {
                            *found = ImageParts::Inline;
                        }
                    }
                    Some(_) => *found = ImageParts::Invalid,
                    None => {
                        object.values().for_each(|value| visit(value, found))
                    }
                }
            }
            _ => {}
        }
    }
    let mut found = ImageParts::None;
    for key in ["messages", "input"] {
        if let Some(value) = body.get(key) {
            visit(value, &mut found);
        }
    }
    found
}

fn purpose_request_is_allowed(
    body: &Value,
    api: ProviderApi,
    purpose: ProviderPurpose,
    checkpoint_max_tokens: Option<i32>,
) -> bool {
    if purpose == ProviderPurpose::Synthesis
        && ["tools", "functions", "function_call"].iter().any(|key| {
            body.get(*key).is_some_and(|value| {
                value.as_array().is_none_or(|values| !values.is_empty())
            })
        })
    {
        return false;
    }
    if api == ProviderApi::OpenaiCompletions {
        return checkpoint_request_is_allowed(body, checkpoint_max_tokens);
    }
    let Some(max_tokens) = checkpoint_max_tokens else {
        return true;
    };
    body.get("max_output_tokens")
        .and_then(Value::as_i64)
        .is_some_and(|tokens| tokens > 0 && tokens <= i64::from(max_tokens))
        && body.get("tools").is_none()
        && body
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|input| {
                input.iter().all(|item| {
                    matches!(
                        item.get("role").and_then(Value::as_str),
                        Some("user" | "system" | "developer")
                    )
                })
            })
}

fn checkpoint_request_is_allowed(
    body: &Value,
    max_tokens: Option<i32>,
) -> bool {
    let Some(max_tokens) = max_tokens else {
        return true;
    };
    let budgets = ["max_tokens", "max_completion_tokens"]
        .into_iter()
        .filter_map(|key| body.get(key))
        .collect::<Vec<_>>();
    if budgets.is_empty()
        || !budgets.iter().all(|budget| {
            budget.as_i64().is_some_and(|budget| {
                budget > 0 && budget <= i64::from(max_tokens)
            })
        })
    {
        return false;
    }
    for key in ["tools", "tool_choice", "functions", "function_call"] {
        if body.get(key).is_some() {
            return false;
        }
    }
    if body.get("n").is_some_and(|count| count.as_i64() != Some(1)) {
        return false;
    }
    body.get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().all(|message| {
                matches!(
                    message.get("role").and_then(Value::as_str),
                    Some("system" | "user")
                )
            })
        })
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
    if expected_model_name == crate::config::AI_AGENT_GLM_5_3 {
        body.insert(
            "reasoning_effort".to_string(),
            Value::String("max".to_string()),
        );
        body.insert("thinking".to_string(), json!({ "type": "enabled" }));
        return;
    }
    if expected_model_name
        .starts_with(AI_AGENT_OPENAI_REASONING_NONE_MODEL_PREFIX)
        || expected_model_name == AI_AGENT_OPENAI_GPT_6_SOL
        || expected_model_name == AI_AGENT_OPENAI_GPT_6_LUNA
    {
        body.insert(
            "reasoning_effort".to_string(),
            Value::String("none".to_string()),
        );
    }
}

fn provider_request_timeout(
    ai_engine: &crate::entities::ai_engine::Model,
    streamed: bool,
) -> Duration {
    let seconds = if streamed
        && ai_engine.model_name == crate::config::AI_AGENT_GLM_5_3
        && crate::ai_engine::client::is_government_url(&ai_engine.url)
    {
        AI_AGENT_GLM_5_3_PROVIDER_REQUEST_TIMEOUT_SEC
    } else {
        AI_AGENT_PROVIDER_REQUEST_TIMEOUT_SEC
    };
    Duration::from_secs(seconds)
}

#[cfg(test)]
async fn proxy_provider_request(
    client: &crate::ai_engine::AiEngineClient,
    ai_engine: crate::entities::ai_engine::Model,
    body: Value,
    streamed: bool,
) -> Result<HttpResponse, AppError> {
    proxy_provider_call(
        client,
        ai_engine,
        body,
        streamed,
        ProviderCallContext {
            api: ProviderApi::OpenaiCompletions,
            deadline: None,
            request_id: None,
            turn_timeout_sec: None,
        },
    )
    .await
}

struct ProviderCallContext {
    api: ProviderApi,
    deadline: Option<i64>,
    request_id: Option<uuid::Uuid>,
    /// Longer turn timeout of a 4-hour Deep request; still capped by its deadline.
    turn_timeout_sec: Option<u64>,
}

async fn proxy_provider_call(
    client: &crate::ai_engine::client::AiEngineClient,
    ai_engine: crate::entities::ai_engine::Model,
    body: Value,
    streamed: bool,
    context: ProviderCallContext,
) -> Result<HttpResponse, AppError> {
    let ProviderCallContext {
        api,
        deadline,
        request_id,
        turn_timeout_sec,
    } = context;
    let started_at = Instant::now();
    let reasoning_effort_present = body.get("reasoning_effort").is_some()
        || body.get("reasoning").is_some();
    let message_count = body
        .get("messages")
        .or_else(|| body.get("input"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let max_output_tokens = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_output_tokens"))
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64);
    let request_bytes = body.to_string().len();
    let timeout = turn_timeout_sec.map_or_else(
        || provider_request_timeout(&ai_engine, streamed),
        Duration::from_secs,
    );
    let timeout = deadline.map_or(timeout, |deadline| {
        timeout.min(Duration::from_millis(
            deadline
                .saturating_sub(chrono::Utc::now().timestamp_millis())
                .max(1) as u64,
        ))
    });
    let response = tokio::time::timeout(timeout, async {
        match api {
            ProviderApi::OpenaiCompletions => {
                client.send(&ai_engine, body, timeout).await
            }
            ProviderApi::OpenaiResponses => {
                client.send_responses(&ai_engine, body, timeout).await
            }
        }
    })
    .await
    .map_err(anyhow::Error::from)
    .and_then(|response| response);
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            warn!(
                "AI agent provider gateway transport failure request_id={request_id:?} timeout={} connect={} duration_ms={}",
                err.downcast_ref::<reqwest::Error>().is_some_and(reqwest::Error::is_timeout),
                err.downcast_ref::<reqwest::Error>().is_some_and(reqwest::Error::is_connect),
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
            "AI agent provider gateway response request_id={request_id:?} engine_id={} status={} duration_ms={} upstream_request_id={:?} reasoning_effort_present={} message_count={} request_bytes={} max_output_tokens={:?} error_type={:?} error_code={:?} error_param={:?} error_kind={:?} error_message={:?}",
            ai_engine.id,
            status,
            started_at.elapsed().as_millis(),
            upstream_request_id,
            reasoning_effort_present,
            message_count,
            request_bytes,
            max_output_tokens,
            metadata.error_type,
            metadata.error_code,
            metadata.error_param,
            metadata.error_kind,
            metadata.error_message
        );
        let message = match metadata.error_kind {
            Some("context_limit") => AI_AGENT_PROVIDER_CONTEXT_LIMIT_MESSAGE,
            Some("output_limit") => AI_AGENT_PROVIDER_OUTPUT_LIMIT_MESSAGE,
            _ => "Provider request failed",
        };
        return Ok(provider_error(status, message));
    }
    info!(
        "AI agent provider gateway response request_id={request_id:?} engine_id={} status={} duration_ms={} upstream_request_id={:?} message_count={} request_bytes={} max_output_tokens={:?}",
        ai_engine.id,
        status,
        started_at.elapsed().as_millis(),
        upstream_request_id,
        message_count,
        request_bytes,
        max_output_tokens
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
    let response_limit = if streamed {
        AI_AGENT_PROVIDER_STREAM_MAX_BYTES
    } else {
        AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES
    };
    let stream_deadline = deadline.map_or(timeout, |deadline| {
        Duration::from_millis(
            deadline
                .saturating_sub(chrono::Utc::now().timestamp_millis())
                .max(1) as u64,
        )
    });
    let stream = response.bytes_stream().scan(
        0_usize,
        move |response_bytes, chunk| {
            let result = match chunk {
                Ok(chunk) => {
                    *response_bytes = response_bytes.saturating_add(chunk.len());
                    if *response_bytes > response_limit {
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
                Err(err) => {
                    warn!(
                        "AI agent provider gateway response stream failed request_id={request_id:?} engine_id={engine_id} timeout={} duration_ms={}",
                        err.is_timeout(),
                        started_at.elapsed().as_millis()
                    );
                    Err(actix_web::error::ErrorBadGateway(
                        "Provider response was interrupted",
                    ))
                }
            };
            futures_util::future::ready(Some(result))
        },
    );
    let mut response = if streamed {
        super::event_stream_response(status, "no-store, no-transform")
    } else {
        let mut response = HttpResponse::build(status);
        response
            .insert_header((header::CONTENT_TYPE, expected_content_type))
            .insert_header((header::CACHE_CONTROL, "no-store"));
        response
    };
    Ok(response.streaming(enforce_stream_deadline(stream, stream_deadline)))
}

fn enforce_stream_deadline(
    stream: impl futures_util::Stream<Item = Result<Bytes, actix_web::Error>>,
    timeout: Duration,
) -> impl futures_util::Stream<Item = Result<Bytes, actix_web::Error>> {
    let deadline = tokio::time::Instant::now() + timeout;
    futures_util::stream::unfold(
        (Box::pin(stream), false),
        move |(mut stream, finished)| async move {
            if finished {
                return None;
            }
            match tokio::time::timeout_at(deadline, stream.next()).await {
                Ok(chunk) => chunk.map(|chunk| (chunk, (stream, false))),
                Err(_) => Some((
                    Err(actix_web::error::ErrorBadGateway(
                        "Provider response deadline reached",
                    )),
                    (stream, true),
                )),
            }
        },
    )
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
    if value.contains("max_tokens or model output limit")
        || value.contains("maximum output token limit")
        || value.contains("output token limit was reached")
    {
        Some("output_limit")
    } else if value.contains("context window")
        || value.contains("maximum context length")
        || value.contains("prompt is too long")
    {
        Some("context_limit")
    } else if value.contains("unsupported parameter") {
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

    #[test]
    fn issue_3962_image_parts_must_be_inline() {
        let inline = "data:image/jpeg;base64,/9j/4AAQ";
        let chat = json!({"messages":[{"role":"user","content":[
            {"type":"text","text":"Що на фото?"},
            {"type":"image_url","image_url":{"url":inline}}
        ]}]});
        assert_eq!(image_parts(&chat), ImageParts::Inline);
        let mut remote = chat.clone();
        remote["messages"][0]["content"][1]["image_url"]["url"] =
            json!("https://example.invalid/a.png");
        assert_eq!(image_parts(&remote), ImageParts::Invalid);
        let mut svg = chat.clone();
        svg["messages"][0]["content"][1]["image_url"]["url"] =
            json!("data:image/svg+xml;base64,PHN2Zz4=");
        assert_eq!(image_parts(&svg), ImageParts::Invalid);
        assert_eq!(
            image_parts(&json!({"messages":[{"role":"user","content":"hi"}]})),
            ImageParts::None
        );
        let tool_output = json!({"input":[{"type":"function_call_output","call_id":"c1",
            "output":[{"type":"input_text","text":"ok"},{"type":"input_image","detail":"auto","image_url":inline}]}]});
        assert_eq!(image_parts(&tool_output), ImageParts::Inline);
        assert!(responses_input_is_allowed(&tool_output["input"][0]));
        let user = json!({"role":"user","content":[{"type":"input_image","image_url":"https://example.invalid/a.png"}]});
        assert!(!responses_input_is_allowed(&user));
    }

    #[test]
    fn issue_3724_checkpoint_scope_rejected_tools_and_excess_output() {
        let body = json!({"model":"gpt-6-luna","messages":[{"role":"system","content":"Checkpoint"},{"role":"user","content":"Evidence"}],"max_tokens":8192});
        assert!(checkpoint_request_is_allowed(&body, Some(8192)));
        for (field, value) in [
            ("tools", json!([])),
            ("max_tokens", json!(8193)),
            ("max_completion_tokens", json!(8193)),
            ("n", json!(2)),
        ] {
            let mut invalid = body.clone();
            invalid[field] = value;
            assert!(
                !checkpoint_request_is_allowed(&invalid, Some(8192)),
                "{field}"
            );
        }
        let mut invalid = body.clone();
        invalid["messages"][1]["role"] = json!("assistant");
        assert!(!checkpoint_request_is_allowed(&invalid, Some(8192)));
        assert!(checkpoint_request_is_allowed(&invalid, None));
    }

    #[test]
    fn issue_3724_responses_kept_search_filters_optional() {
        let parameters = json!({
            "type": "object",
            "properties": {
                "period": {"type": "object"},
                "selectedCallsigns": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1
                }
            },
            "required": ["period"],
            "additionalProperties": false
        });
        let mut body = json!({
            "model": "gpt-6-sol",
            "input": [{"role": "user", "content": "Read the latest messages"}],
            "tools": [{"type": "function", "name": "echo_inbox_messages", "parameters": parameters}]
        });
        for strict in [
            None,
            Some(Value::Null),
            Some(json!(false)),
            Some(json!(true)),
        ] {
            if let Some(strict) = &strict {
                body["tools"][0]["strict"] = strict.clone();
            }
            let (accepted, _) = validate_responses_body(
                &serde_json::to_vec(&body).unwrap(),
                "gpt-6-sol",
            )
            .unwrap();
            assert_eq!(
                accepted["tools"][0]["strict"],
                strict
                    .filter(|value| !value.is_null())
                    .unwrap_or(json!(false))
            );
            assert_eq!(accepted["tools"][0]["parameters"], parameters);
        }
    }

    #[test]
    fn issue_3724_responses_rejected_hosted_tools_and_stored_references() {
        let body = json!({"model":"gpt-6-sol","input":[{"role":"user","content":"Find evidence"}],"tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}],"store":true});
        let (accepted, _) = validate_responses_body(
            &serde_json::to_vec(&body).unwrap(),
            "gpt-6-sol",
        )
        .unwrap();
        assert_eq!(accepted["store"], false);
        for (field, value) in [
            ("previous_response_id", json!("another-response")),
            ("conversation", json!("another-conversation")),
            ("background", json!(true)),
            ("prompt", json!({"id":"stored-prompt"})),
            ("tool_choice", json!({"type":"web_search"})),
            ("tools", json!([{"type":"web_search"}])),
            (
                "input",
                json!([{"type":"item_reference","id":"another-item"}]),
            ),
            (
                "input",
                json!([{"role":"user","content":[{"type":"input_file","file_id":"another-file"}]}]),
            ),
        ] {
            let mut invalid = body.clone();
            invalid[field] = value;
            assert!(
                validate_responses_body(
                    &serde_json::to_vec(&invalid).unwrap(),
                    "gpt-6-sol"
                )
                .is_none(),
                "{field}"
            );
        }
        assert!(!purpose_request_is_allowed(
            &accepted,
            ProviderApi::OpenaiResponses,
            ProviderPurpose::Synthesis,
            None
        ));
        assert!(!purpose_request_is_allowed(
            &accepted,
            ProviderApi::OpenaiResponses,
            ProviderPurpose::Checkpoint,
            Some(8192)
        ));
    }

    fn checkpoint_stream_fixture() -> Bytes {
        let frame = format!(
            "data: {}\n\n",
            json!({
                "id": "checkpoint-fixture",
                "model": "glm-5.3",
                "system_fingerprint": "metadata".repeat(32),
                "choices": [{"index": 0, "delta": {"reasoning_content": "x"}, "finish_reason": null}],
            })
        );
        let finish = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices": [{"index": 0, "delta": {"content": "Retained evidence https://example.invalid/?m=last"}, "finish_reason": "stop"}], "usage": {"completion_tokens": 8193}})
        );
        Bytes::from(frame.repeat(8192) + &finish)
    }

    async fn checkpoint_fixture_reply(
        events: web::Data<Bytes>,
        body: web::Json<Value>,
    ) -> HttpResponse {
        if body["stream"].as_bool().unwrap_or(false) {
            HttpResponse::Ok()
                .content_type("text/event-stream")
                .body(events.get_ref().clone())
        } else {
            HttpResponse::Ok()
                .content_type("application/json")
                .body(json!({"content": "x".repeat(AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES)}).to_string())
        }
    }

    fn checkpoint_fixture_server(
        events: Bytes,
    ) -> (actix_web::dev::Server, std::net::SocketAddr) {
        use actix_web::{App, HttpServer};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = HttpServer::new(move || {
            App::new().app_data(web::Data::new(events.clone())).route(
                "/v1/chat/completions",
                web::post().to(checkpoint_fixture_reply),
            )
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        (server, address)
    }

    fn checkpoint_fixture_engine(
        address: std::net::SocketAddr,
    ) -> crate::entities::ai_engine::Model {
        crate::entities::ai_engine::Model {
            id: uuid::Uuid::now_v7(),
            name: "checkpoint fixture".into(),
            url: format!("http://{address}/v1"),
            token: None,
            model_name: "glm-5.3".into(),
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
            enabled: true,
            callsign_enabled: false,
            ocr_enabled: false,
            ocr_request_profile: "default".into(),
        }
    }

    #[actix_web::test]
    async fn issue_3724_preserved_large_reasoning_stream_and_json_limit() {
        use actix_web::body::to_bytes;
        let interrupted = enforce_stream_deadline(
            futures_util::stream::pending(),
            Duration::from_millis(1),
        )
        .collect::<Vec<_>>()
        .await;
        assert_eq!(interrupted.len(), 1);
        assert!(interrupted[0].is_err());
        let events = checkpoint_stream_fixture();
        assert!(events.len() > AI_AGENT_PROVIDER_RESPONSE_MAX_BYTES);
        let (server, address) = checkpoint_fixture_server(events.clone());
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let client = crate::ai_engine::AiEngineClient::new(
            sea_orm::DatabaseConnection::default(),
            None,
        )
        .unwrap();
        let ai_engine = checkpoint_fixture_engine(address);
        let response = proxy_provider_request(
            &client,
            ai_engine.clone(),
            json!({"stream": true}),
            true,
        )
        .await
        .unwrap();
        assert_eq!(to_bytes(response.into_body()).await.unwrap(), events);
        let response = proxy_provider_request(
            &client,
            ai_engine,
            json!({"stream": false}),
            false,
        )
        .await
        .unwrap();
        assert!(to_bytes(response.into_body()).await.is_err());
        handle.stop(false).await;
        task.await.unwrap().unwrap();
    }

    #[test]
    fn issue_3724_allowed_long_glm_streams_within_request_deadline() {
        let mut ai_engine =
            checkpoint_fixture_engine("127.0.0.1:1".parse().unwrap());
        let regular =
            Duration::from_secs(AI_AGENT_PROVIDER_REQUEST_TIMEOUT_SEC);
        assert_eq!(provider_request_timeout(&ai_engine, true), regular);
        ai_engine.url = crate::config::AI_GOV_UA_API_BASE.to_string();
        assert_eq!(
            provider_request_timeout(&ai_engine, true),
            Duration::from_secs(crate::config::AI_AGENT_DISPATCHER_TIMEOUT_SEC)
        );
        assert_eq!(provider_request_timeout(&ai_engine, false), regular);
        ai_engine.model_name =
            crate::config::AI_AGENT_OPENAI_GPT_6_LUNA.to_string();
        assert_eq!(provider_request_timeout(&ai_engine, true), regular);
    }

    #[actix_web::test]
    async fn open_event_stream_delivers_first_frame_with_compression_enabled() {
        use actix_web::{body::MessageBody, middleware::Compress, web, App};
        use futures_util::{future::poll_fn, stream};

        let app = actix_web::test::init_service(
            App::new().wrap(Compress::default()).route(
                "/events",
                web::get().to(|| async {
                    let stream = stream::once(async {
                        Ok::<_, AppError>(Bytes::from_static(
                            b"id: 1\nevent: request_start\ndata: {}\n\n",
                        ))
                    })
                    .chain(stream::pending());
                    super::super::event_stream_response(
                        StatusCode::OK,
                        "no-cache, no-transform",
                    )
                    .streaming(stream)
                }),
            ),
        )
        .await;
        let request = actix_web::test::TestRequest::get()
            .uri("/events")
            .insert_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
            .to_request();
        let response = actix_web::test::call_service(&app, request).await;
        let mut body = Box::pin(response.into_body());
        let chunk = tokio::time::timeout(
            Duration::from_secs(1),
            poll_fn(|context| body.as_mut().poll_next(context)),
        )
        .await
        .expect("#3064: the first event must arrive before the stream ends")
        .expect("the event stream stays open")
        .unwrap();
        assert_eq!(chunk, b"id: 1\nevent: request_start\ndata: {}\n\n"[..]);
    }
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
    fn forces_reasoning_effort_none_for_chat_tool_models() {
        for engine in ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna"]
        {
            for effort in [None, Some("high")] {
                let mut body = json!({
                    "model": engine,
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [{"type": "function", "function": {
                        "name": "echo_probe", "parameters": {"type": "object"}
                    }}]
                });
                if let Some(effort) = effort {
                    body["reasoning_effort"] = json!(effort);
                }
                let (body, _) =
                    validate_request_body(body.to_string().as_bytes(), engine)
                        .unwrap();
                assert_eq!(body["reasoning_effort"], "none");
            }
        }
    }

    #[test]
    fn kharkiv_3724_preserves_glm_maximum_reasoning() {
        let request = json!({
            "model": "glm-5.3",
            "messages": [{ "role": "user", "content": "Report" }],
            "reasoning_effort": "none",
            "thinking": { "type": "disabled" }
        });
        let (request, _) = validate_request_body(
            request.to_string().as_bytes(),
            crate::config::AI_AGENT_GLM_5_3,
        )
        .unwrap();
        assert_eq!(request["reasoning_effort"], "max");
        assert_eq!(request["thinking"]["type"], "enabled");
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

    #[test]
    fn classifies_provider_token_limits() {
        assert_eq!(
            provider_error_kind(Some(&json!(
                "Could not finish the message because max_tokens or model output limit was reached"
            ))),
            Some("output_limit")
        );
        assert_eq!(
            provider_error_kind(Some(&json!(
                "This model's maximum context length was exceeded"
            ))),
            Some("context_limit")
        );
    }
}
