use super::*;
use crate::ai_engine::types::SaveAiGovUaSettingsReq;
use crate::functest::tests::cleanup_locked;
use base64::Engine;
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(start_paused = true)]
async fn issue_3913_government_cooldown_is_shared_across_engine_rows_and_respects_deadlines(
) {
    for model_name in [AI_ENGINE_GLM_5_3_MODEL, "gpt-6.1-sol"] {
        let client =
            AiEngineClient::new(DatabaseConnection::default(), None).unwrap();
        let engine = ai_engine::Model {
            id: uuid::Uuid::new_v4(),
            name: "Government GLM".to_string(),
            url: AI_GOV_UA_API_BASE.to_string(),
            token: None,
            model_name: model_name.to_string(),
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
            enabled: true,
            callsign_enabled: true,
            ocr_enabled: false,
            ocr_request_profile: "openai_vision".to_string(),
            unhealthy: None,
            health_message: None,
            health_updated_at: None,
            health_updated_by_login_id: None,
        };
        let other_engine = ai_engine::Model {
            id: uuid::Uuid::new_v4(),
            name: "Another government GLM".to_string(),
            ..engine.clone()
        };
        client
            .government_cooldown(&engine.model_name)
            .await
            .observe(
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                &reqwest::header::HeaderMap::new(),
            )
            .await
            .unwrap();
        let started = tokio::time::Instant::now();
        for (engine, responses) in [
            (&engine, false),
            (&other_engine, false),
            (&other_engine, true),
        ] {
            let request_started = tokio::time::Instant::now();
            let error = if responses {
                client
                    .send_responses(engine, json!({}), Duration::from_secs(10))
                    .await
            } else {
                client
                    .send(engine, json!({}), Duration::from_secs(10))
                    .await
            }
            .unwrap_err();
            assert!(error
                .chain()
                .any(|error| error.is::<tokio::time::error::Elapsed>()));
            assert_eq!(request_started.elapsed(), Duration::from_secs(10));
        }
        client
            .government_cooldown(&engine.model_name)
            .await
            .wait()
            .await;
        assert_eq!(started.elapsed(), Duration::from_secs(60));
    }
}

#[tokio::test]
async fn direct_openai_engine_is_refused_before_any_request() {
    let client =
        AiEngineClient::new(DatabaseConnection::default(), None).unwrap();
    let mut engine = metrics_test_engine("https://api.openai.com/v1");
    engine.token = Some("stored-token".to_string());
    let error = client
        .send_agent_request_inner(
            &engine,
            json!({}),
            Duration::from_secs(1),
            false,
        )
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("OpenAI"), "{error:#}");
}

fn settings_request(secret: Option<&str>) -> SaveAiGovUaSettingsReq {
    SaveAiGovUaSettingsReq {
        enabled: true,
        tenant_id: "43a7b066-fe01-43db-b0ea-a9c1f1a18fc5".into(),
        client_id: "00000000-0000-0000-0000-000000000001".into(),
        scope: "api://test-inference/.default".into(),
        client_secret: secret.map(str::to_string),
        clear_client_secret: false,
    }
}

async fn read_http_body(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = stream.read(&mut chunk).await.unwrap();
        assert_ne!(read, 0);
        request.extend_from_slice(&chunk[..read]);
        let Some(end) = request
            .windows(4)
            .position(|chunk| chunk == b"\r\n\r\n")
            .map(|end| end + 4)
        else {
            continue;
        };
        let headers = std::str::from_utf8(&request[..end]).unwrap();
        let length: usize = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .unwrap()
            .1
            .trim()
            .parse()
            .unwrap();
        if request.len() >= end + length {
            return request[end..end + length].to_vec();
        }
    }
}

async fn token_server() -> (Url, Arc<AtomicUsize>, tokio::task::JoinHandle<()>)
{
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint =
        Url::parse(&format!("http://{}/token", listener.local_addr().unwrap()))
            .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let body = read_http_body(&mut stream).await;
            let form = url::form_urlencoded::parse(&body)
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(form.get("grant_type").unwrap(), "client_credentials");
            assert!(matches!(
                form.get("client_secret").unwrap().as_ref(),
                "secret&first" | "secret-second"
            ));
            let sequence = requests.fetch_add(1, Ordering::SeqCst) + 1;
            let body = json!({ "token_type": "Bearer", "expires_in": 3600, "access_token": format!("token-{sequence}") }).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    (endpoint, count, task)
}

async fn rejecting_server(
) -> (Url, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http_body(&mut stream).await;
            requests.fetch_add(1, Ordering::SeqCst);
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        }
    });
    (endpoint, count, task)
}

async fn interrupted_stream_server() -> (Url, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http_body(&mut stream).await;
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000\r\nConnection: close\r\n\r\ndata: {\"choices\":[]}\n\n").await.unwrap();
    });
    (endpoint, task)
}

// Regression: https://github.com/echoua/echo/issues/3682
#[tokio::test]
#[serial]
async fn azure_settings_rotation_singleflight_expiry_and_bounded_retry() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let first =
        gov::save(&env.dbx, Some(&key), settings_request(Some("secret&first")))
            .await
            .unwrap();
    let encrypted = first.client_secret_encrypted.as_deref().unwrap();
    assert!(!encrypted.contains("secret&first"));
    assert_eq!(
        gov::decrypt_secret(Some(&key), encrypted).unwrap(),
        "secret&first"
    );
    assert!(gov::decrypt_secret(None, encrypted).is_err());
    let response =
        serde_json::to_value(gov::settings_response(first.clone())).unwrap();
    assert_eq!(response["hasClientSecret"], true);
    assert!(!response.to_string().contains(encrypted));
    let preserved = gov::save(&env.dbx, Some(&key), settings_request(None))
        .await
        .unwrap();
    assert_eq!(
        first.client_secret_encrypted,
        preserved.client_secret_encrypted
    );
    let (endpoint, token_count, token_task) = token_server().await;
    let mut client =
        AiEngineClient::new(env.dbx.clone(), Some(key.clone())).unwrap();
    client.token_endpoint = Some(endpoint);
    let requests = (0..12).map(|_| client.government_token(&preserved, None));
    assert!(futures_util::future::join_all(requests)
        .await
        .into_iter()
        .all(|token| token.unwrap() == "token-1"));
    assert_eq!(token_count.load(Ordering::SeqCst), 1);
    client.token.lock().await.as_mut().unwrap().refresh_at = Instant::now();
    assert_eq!(
        client.government_token(&preserved, None).await.unwrap(),
        "token-2"
    );
    let rotated = gov::save(
        &env.dbx,
        Some(&key),
        settings_request(Some("secret-second")),
    )
    .await
    .unwrap();
    let current = client.government_settings().await.unwrap();
    assert_eq!(current, rotated);
    assert_eq!(
        client.government_token(&current, None).await.unwrap(),
        "token-3"
    );
    let requests =
        (0..12).map(|_| client.government_token(&current, Some("token-3")));
    assert!(futures_util::future::join_all(requests)
        .await
        .into_iter()
        .all(|token| token.unwrap() == "token-4"));
    assert_eq!(token_count.load(Ordering::SeqCst), 4);
    let (endpoint, inference_count, inference_task) = rejecting_server().await;
    let response = client
        .send_government(
            endpoint,
            Some(json!({})),
            Duration::from_secs(2),
            current,
        )
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(inference_count.load(Ordering::SeqCst), 2);
    assert_eq!(token_count.load(Ordering::SeqCst), 5);
    let (endpoint, stream_task) = interrupted_stream_server().await;
    let response = client
        .send_government(
            endpoint,
            Some(json!({"stream": true})),
            Duration::from_secs(2),
            rotated.clone(),
        )
        .await
        .unwrap();
    assert!(response.bytes().await.is_err());
    stream_task.await.unwrap();
    assert_eq!(token_count.load(Ordering::SeqCst), 5);
    let mut invalid = settings_request(Some("secret&first"));
    invalid.clear_client_secret = true;
    assert!(gov::save(&env.dbx, Some(&key), invalid).await.is_err());
    assert_eq!(gov::load(&env.dbx).await.unwrap(), rotated);
    let mut disabled = settings_request(None);
    disabled.enabled = false;
    disabled.clear_client_secret = true;
    let cleared = gov::save(&env.dbx, Some(&key), disabled).await.unwrap();
    assert!(cleared.client_secret_encrypted.is_none());
    assert!(client.government_settings().await.is_err());
    assert!(gov::save(&env.dbx, Some(&key), settings_request(None))
        .await
        .is_err());
    inference_task.abort();
    token_task.abort();
}

// Regression: https://github.com/echoua/echo/issues/3682
#[tokio::test]
#[serial]
async fn azure_preview_keeps_saved_credentials_and_active_token_isolated() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let mut disabled = settings_request(None);
    disabled.enabled = false;
    disabled.clear_client_secret = true;
    let disabled = gov::save(&env.dbx, Some(&key), disabled).await.unwrap();
    let mut draft = settings_request(Some("secret&first"));
    draft.enabled = false;
    let preview = gov::preview(&env.dbx, Some(&key), draft).await.unwrap();
    assert_eq!(preview.enabled, Some(true));
    assert_eq!(gov::load(&env.dbx).await.unwrap(), disabled);

    let saved =
        gov::save(&env.dbx, Some(&key), settings_request(Some("secret&first")))
            .await
            .unwrap();
    let reused = gov::preview(&env.dbx, Some(&key), settings_request(None))
        .await
        .unwrap();
    assert_eq!(
        reused.client_secret_encrypted,
        saved.client_secret_encrypted
    );
    let (endpoint, token_count, token_task) = token_server().await;
    let mut client =
        AiEngineClient::new(env.dbx.clone(), Some(key.clone())).unwrap();
    client.token_endpoint = Some(endpoint);
    assert_eq!(
        client.government_token(&saved, None).await.unwrap(),
        "token-1"
    );

    let mut draft = settings_request(Some("secret-second"));
    draft.scope = "api://draft-inference/.default".into();
    let draft = gov::preview(&env.dbx, Some(&key), draft).await.unwrap();
    let preview = client.preview(draft.clone());
    let (endpoint, inference_count, inference_task) = rejecting_server().await;
    let response = preview
        .send_government(
            endpoint,
            Some(json!({})),
            Duration::from_secs(2),
            draft.clone(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(inference_count.load(Ordering::SeqCst), 2);
    assert_eq!(token_count.load(Ordering::SeqCst), 3);
    assert_eq!(preview.government_settings().await.unwrap(), draft);
    assert_eq!(
        client.government_token(&saved, None).await.unwrap(),
        "token-1"
    );
    assert_eq!(token_count.load(Ordering::SeqCst), 3);
    assert_eq!(gov::load(&env.dbx).await.unwrap(), saved);
    inference_task.abort();
    token_task.abort();
}

// Regression: https://github.com/echoua/echo/issues/3682
#[test]
fn government_compatibility_preserves_legacy_and_tool_image_schema_payloads() {
    let payload = json!({
        "max_tokens": 1024, "temperature": 0, "stream": true,
        "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,test"}}]}],
        "tools": [{"type": "function", "function": {"name": "lookup"}}],
        "response_format": {"type": "json_schema"}
    });
    for name in [AI_AGENT_OPENAI_GPT_6_SOL, AI_AGENT_OPENAI_GPT_6_LUNA] {
        let mut request = payload.clone();
        adapt_government_request(name, &mut request);
        assert!(request.get("max_tokens").is_none());
        assert!(request.get("temperature").is_none());
        assert_eq!(request["max_completion_tokens"], 1024);
        assert_eq!(
            request["allowed_openai_params"],
            json!(["reasoning_effort"])
        );
        assert_eq!(request["reasoning_effort"], "none");
        for field in ["messages", "tools", "response_format", "stream"] {
            assert_eq!(request[field], payload[field]);
        }
    }
    for name in ["gemma4", "glm-5.2", "frontier-large"] {
        let mut request = payload.clone();
        adapt_government_request(name, &mut request);
        assert_eq!(request, payload);
    }
    for url in [
        "http://inference.ai.mod.gov.ua/v1",
        "https://inference.ai.mod.gov.ua:8443/v1",
        "https://inference.ai.mod.gov.ua/v1?x=1",
        "https://token@inference.ai.mod.gov.ua/v1",
        "https://inference.ai.mod.gov.ua.other/v1",
    ] {
        assert!(!is_government_url(url));
    }
    assert!(is_government_url(AI_GOV_UA_API_BASE));
}

#[tokio::test(start_paused = true)]
async fn issue_3913_government_cooldowns_are_model_scoped_and_survive_cancelled_waiters(
) {
    let client =
        AiEngineClient::new(DatabaseConnection::default(), None).unwrap();
    let cooldown = client.government_cooldown("gpt-6.1-sol").await;
    cooldown
        .observe(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            &reqwest::header::HeaderMap::new(),
        )
        .await
        .unwrap();
    let same = client.government_cooldown("gpt-6.1-sol").await;
    assert!(Arc::ptr_eq(&cooldown, &same));
    let other = client.government_cooldown("glm-5.3").await;
    let started = tokio::time::Instant::now();
    other.wait().await;
    assert_eq!(started.elapsed(), Duration::ZERO);
    let waiting = tokio::spawn(async move { same.wait().await });
    tokio::task::yield_now().await;
    waiting.abort();
    cooldown.wait().await;
    assert_eq!(started.elapsed(), Duration::from_secs(60));
}

const AI_PROVIDER_REQUESTS: &str = "echo.ai_provider.requests.count";
const AI_PROVIDER_RESPONSE_START: &str =
    "echo.ai_provider.response_start.duration";

fn recording_client() -> (
    AiEngineClient,
    crate::telemetry::Metrics,
    crate::telemetry::metrics::MetricsRecorder,
) {
    let config = crate::config::read_config(crate::types::Mode::Test).unwrap();
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&config);
    let client = AiEngineClient::new(DatabaseConnection::default(), None)
        .unwrap()
        .with_metrics(Some(metrics.clone()), "echo-test");
    (client, metrics, recorder)
}

fn metrics_test_engine(url: &str) -> ai_engine::Model {
    ai_engine::Model {
        id: uuid::Uuid::new_v4(),
        name: "Metrics test".to_string(),
        url: url.to_string(),
        token: None,
        model_name: "metrics-model".to_string(),
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
        enabled: true,
        callsign_enabled: false,
        ocr_enabled: false,
        ocr_request_profile: "openai_vision".to_string(),
        unhealthy: None,
        health_message: None,
        health_updated_at: None,
        health_updated_by_login_id: None,
    }
}

fn response_start_samples(
    recorder: &crate::telemetry::metrics::MetricsRecorder,
    outcome: &str,
) -> Option<u64> {
    recorder
        .find_with_attributes(
            AI_PROVIDER_RESPONSE_START,
            &[("outcome", outcome)],
        )
        .map(|record| match record.value {
            crate::telemetry::metrics::RecordedMetricValue::Histogram {
                count,
                ..
            } => count,
            value => panic!("unexpected response start value {value:?}"),
        })
}

async fn status_server(
    status_line: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http_body(&mut stream).await;
        let response = format!(
            "HTTP/1.1 {status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (url, task)
}

async fn rate_limit_government_model(
    client: &AiEngineClient,
    engine: &ai_engine::Model,
) {
    client
        .government_cooldown(&engine.model_name)
        .await
        .observe(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            &reqwest::header::HeaderMap::new(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn issue_4029_records_provider_outcomes_by_status() {
    for (status_line, outcome) in [
        ("200 OK", "ok"),
        ("400 Bad Request", "client_error"),
        ("429 Too Many Requests", "rate_limited"),
        ("500 Internal Server Error", "server_error"),
    ] {
        let (client, metrics, recorder) = recording_client();
        let (url, task) = status_server(status_line).await;
        client
            .send(
                &metrics_test_engine(&url),
                json!({"stream": true}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        task.await.unwrap();
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.counter_value(
                AI_PROVIDER_REQUESTS,
                &[
                    ("provider", "internal"),
                    ("model_name", "metrics-model"),
                    ("process", "echo-test"),
                    ("streaming", "true"),
                    ("outcome", outcome),
                ],
            ),
            Some(1),
            "{status_line}"
        );
        assert_eq!(response_start_samples(&recorder, outcome), Some(1));
    }
}

#[tokio::test]
async fn issue_4029_records_connect_failures() {
    let (client, metrics, recorder) = recording_client();
    client
        .send(
            &metrics_test_engine("http://127.0.0.1:1/v1"),
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.counter_value(
            AI_PROVIDER_REQUESTS,
            &[("streaming", "false"), ("outcome", "connect_error")],
        ),
        Some(1)
    );
    assert_eq!(response_start_samples(&recorder, "connect_error"), Some(1));
}

// A hung provider is cancelled by an outer timeout that drops the future. Those
// calls must stay in the latency data, not vanish from it.
#[tokio::test]
async fn issue_4029_outer_timeout_still_records_the_hung_call() {
    let (client, metrics, recorder) = recording_client();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let _connection = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let hung = tokio::time::timeout(
        Duration::from_millis(100),
        client.send(
            &metrics_test_engine(&url),
            json!({}),
            Duration::from_secs(30),
        ),
    )
    .await;
    assert!(hung.is_err());
    server.abort();
    metrics.force_flush_for_test();
    assert_eq!(
        recorder
            .counter_value(AI_PROVIDER_REQUESTS, &[("outcome", "cancelled")]),
        Some(1)
    );
    assert_eq!(response_start_samples(&recorder, "cancelled"), Some(1));
}

#[tokio::test(start_paused = true)]
async fn issue_4029_cooldown_wait_is_not_provider_time() {
    let (client, metrics, recorder) = recording_client();
    let engine = metrics_test_engine(AI_GOV_UA_API_BASE);
    rate_limit_government_model(&client, &engine).await;

    client
        .send(&engine, json!({}), Duration::from_secs(10))
        .await
        .unwrap_err();
    let dropped = tokio::time::timeout(
        Duration::from_secs(5),
        client.send(&engine, json!({}), Duration::from_secs(45)),
    )
    .await;
    assert!(dropped.is_err());

    metrics.force_flush_for_test();
    assert_eq!(
        recorder.counter_value(
            AI_PROVIDER_REQUESTS,
            &[("provider", "gov_ua"), ("outcome", "cooldown_expired")],
        ),
        Some(2)
    );
    assert_eq!(response_start_samples(&recorder, "cooldown_expired"), None);
}

// Disabled gateway settings fail after the cooldown ends, so the call never
// left Echo.
#[tokio::test(start_paused = true)]
async fn issue_4029_local_failure_has_no_provider_time() {
    let (client, metrics, recorder) = recording_client();
    let client = client.preview(ai_gov_ua_settings::Model {
        id: 1,
        enabled: Some(false),
        tenant_id: None,
        client_id: None,
        scope: None,
        client_secret_encrypted: None,
        updated_at: chrono::Utc::now().naive_utc(),
    });
    let engine = metrics_test_engine(AI_GOV_UA_API_BASE);
    rate_limit_government_model(&client, &engine).await;

    client
        .send(&engine, json!({}), Duration::from_secs(120))
        .await
        .unwrap_err();

    metrics.force_flush_for_test();
    assert_eq!(
        recorder
            .counter_value(AI_PROVIDER_REQUESTS, &[("outcome", "local_error")]),
        Some(1)
    );
    assert_eq!(response_start_samples(&recorder, "local_error"), None);
}

// A token that can't be sent as a header fails while building the request.
#[tokio::test]
async fn issue_4029_request_builder_failure_has_no_provider_time() {
    let (client, metrics, recorder) = recording_client();
    let engine = ai_engine::Model {
        token: Some("bad\ntoken".to_string()),
        ..metrics_test_engine("http://127.0.0.1:1/v1")
    };

    client
        .send(&engine, json!({}), Duration::from_secs(5))
        .await
        .unwrap_err();

    metrics.force_flush_for_test();
    assert_eq!(
        recorder
            .counter_value(AI_PROVIDER_REQUESTS, &[("outcome", "local_error")]),
        Some(1)
    );
    assert_eq!(response_start_samples(&recorder, "local_error"), None);
}
