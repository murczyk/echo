use crate::entities::{ai_callsign_settings, ai_engine};
use crate::functest::tests::cleanup;
use crate::sigint::direct_submit::{
    bl::parse_signal_message, types::DirectSubmitParsePayload,
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, EntityTrait, IntoActiveModel, Set,
};
use serial_test::serial;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

struct Provider {
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    response: Arc<Mutex<(u16, String)>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn provider() -> (ai_engine::ActiveModel, Provider) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let response = Arc::new(Mutex::new((
        200,
        r#"{"callsigns":["ЯРУС","ФИПКА"]}"#.to_string(),
    )));
    let server_requests = requests.clone();
    let server_response = response.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                let Some(end) = bytes
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|p| p + 4)
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .filter_map(|s| s.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .unwrap()
                    .1
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() < end + length {
                    continue;
                }
                server_requests.lock().unwrap().push(
                    serde_json::from_slice(&bytes[end..end + length]).unwrap(),
                );
                break;
            }
            let (status, content) = server_response.lock().unwrap().clone();
            if status == 0 {
                std::future::pending::<()>().await;
            }
            let body = serde_json::json!({"choices": [{"message": {"content": content}}]}).to_string();
            let reply = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    let now = chrono::Utc::now().naive_utc();
    let engine = ai_engine::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(format!("direct-submit fixture {}", Uuid::new_v4())),
        url: Set(format!("http://{address}/v1")),
        model_name: Set("fixture".into()),
        enabled: Set(true),
        callsign_enabled: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    (
        engine,
        Provider {
            requests,
            response,
            task,
        },
    )
}

#[tokio::test]
#[serial]
async fn issue_3620_direct_parse_isolates_ai_and_preserves_results_on_failure()
{
    let env = cleanup().await.unwrap();
    let (engine, provider) = provider().await;
    let engine = engine.insert(&env.dbx).await.unwrap();
    let previous_settings = ai_callsign_settings::Entity::find_by_id(
        crate::config::AI_CALLSIGN_SETTINGS_ID,
    )
    .one(&env.dbx)
    .await
    .unwrap();
    env.dbx
        .execute_unprepared("delete from ai_callsign_settings")
        .await
        .unwrap();
    let settings = ai_callsign_settings::ActiveModel {
        worker_fallback_ai_engine_id: sea_orm::ActiveValue::Set(None),
        id: Set(crate::config::AI_CALLSIGN_SETTINGS_ID),
        prompt: Set("Extract callsigns for the UI fixture".into()),
        worker_enabled: Set(true),
        worker_ai_engine_id: Set(Some(engine.id)),
        updated_at: Set(chrono::Utc::now().naive_utc()),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let body = "01.04.2023_15:00 F=411,7500(МГЦ)\n49.12345, 37.12345\nID➡️:110(ЯРУС)\nID(CG)⬅️:50(СВЕТЛЫЙ)\nФипка, прием";
    let payload: DirectSubmitParsePayload =
        serde_json::from_value(serde_json::json!({"full_body":body})).unwrap();
    let login = Uuid::new_v4();
    let ordinary = parse_signal_message(&login, &env, payload.clone())
        .await
        .unwrap();
    assert!(ordinary.ai_callsign_warning.is_none());
    assert!(provider.requests.lock().unwrap().is_empty());
    let mut payload = payload;
    payload.include_ai_callsigns = false;
    assert_eq!(
        parse_signal_message(&login, &env, payload.clone())
            .await
            .unwrap(),
        ordinary
    );
    assert!(provider.requests.lock().unwrap().is_empty());
    payload.include_ai_callsigns = true;
    payload.signal_group_master_key = Some("inaccessible-fixture-group".into());
    assert!(parse_signal_message(&login, &env, payload.clone())
        .await
        .is_err());
    assert!(provider.requests.lock().unwrap().is_empty());
    payload.signal_group_master_key = None;
    let mut parsed = parse_signal_message(&login, &env, payload.clone())
        .await
        .unwrap();
    assert!(parsed.to.contains(&"фипка".to_string()));
    assert!(ordinary.to.iter().all(|c| parsed.to.contains(c)));
    assert_eq!(parsed.to.iter().filter(|c| c.as_str() == "ярус").count(), 1);
    parsed.to = ordinary.to.clone();
    assert_eq!(parsed, ordinary);
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["messages"][0]["content"], settings.prompt);
        assert_eq!(requests[0]["messages"][1]["content"], body);
    }
    let mut settings = settings.into_active_model();
    settings.worker_enabled = Set(false);
    let settings = settings.update(&env.dbx).await.unwrap();
    assert_eq!(
        parse_signal_message(&login, &env, payload.clone())
            .await
            .unwrap(),
        ordinary
    );
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let mut settings = settings.into_active_model();
    settings.worker_enabled = Set(true);
    settings.worker_ai_engine_id = Set(None);
    let settings = settings.update(&env.dbx).await.unwrap();
    let mut parsed = parse_signal_message(&login, &env, payload.clone())
        .await
        .unwrap();
    assert!(parsed.ai_callsign_warning.take().is_some());
    assert_eq!(parsed, ordinary);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let mut settings = settings.into_active_model();
    settings.worker_ai_engine_id = Set(Some(engine.id));
    settings.update(&env.dbx).await.unwrap();
    let mut engine = engine.into_active_model();
    engine.enabled = Set(false);
    let engine = engine.update(&env.dbx).await.unwrap();
    let mut parsed = parse_signal_message(&login, &env, payload.clone())
        .await
        .unwrap();
    assert!(parsed.ai_callsign_warning.take().is_some());
    assert_eq!(parsed, ordinary);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let mut engine = engine.into_active_model();
    engine.enabled = Set(true);
    let engine = engine.update(&env.dbx).await.unwrap();
    for (status, content) in
        [(200, "invalid JSON"), (503, "unavailable"), (0, "timeout")]
    {
        *provider.response.lock().unwrap() = (status, content.into());
        let mut parsed = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            parse_signal_message(&login, &env, payload.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(parsed.ai_callsign_warning.take().is_some());
        assert_eq!(parsed, ordinary);
    }
    assert_eq!(provider.requests.lock().unwrap().len(), 4);
    assert_eq!(
        crate::entities::ai_callsign_worker_job::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap()
            .len(),
        0
    );
    ai_callsign_settings::Entity::delete_by_id(
        crate::config::AI_CALLSIGN_SETTINGS_ID,
    )
    .exec(&env.dbx)
    .await
    .unwrap();
    if let Some(settings) = previous_settings {
        settings
            .into_active_model()
            .reset_all()
            .insert(&env.dbx)
            .await
            .unwrap();
    }
    ai_engine::Entity::delete_by_id(engine.id)
        .exec(&env.dbx)
        .await
        .unwrap();
}
