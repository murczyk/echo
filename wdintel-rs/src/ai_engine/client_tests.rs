use super::*;
use crate::ai_engine::types::SaveAiGovUaSettingsReq;
use crate::functest::tests::cleanup_locked;
use base64::Engine;
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(start_paused = true)]
async fn glm_cooldown_is_shared_across_engine_rows_and_respects_deadlines() {
    let client =
        AiEngineClient::new(DatabaseConnection::default(), None).unwrap();
    let engine = ai_engine::Model {
        id: uuid::Uuid::new_v4(),
        name: "Government GLM".to_string(),
        url: AI_GOV_UA_API_BASE.to_string(),
        token: None,
        model_name: AI_ENGINE_GLM_5_3_MODEL.to_string(),
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
        enabled: true,
        callsign_enabled: true,
        ocr_enabled: false,
        ocr_request_profile: "openai_vision".to_string(),
    };
    let other_engine = ai_engine::Model {
        id: uuid::Uuid::new_v4(),
        name: "Another government GLM".to_string(),
        ..engine.clone()
    };
    client
        .glm_cooldown
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
    client.glm_cooldown.wait().await;
    assert_eq!(started.elapsed(), Duration::from_secs(60));
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
