use crate::entities::ai_engine;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

pub(crate) struct TestEngine {
    pub engine: ai_engine::Model,
    pub calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestEngine {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn engine(
    db: &DatabaseConnection,
    status: u16,
    content: &str,
    stall: bool,
) -> TestEngine {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let content = content.to_string();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) =
                    bytes.windows(4).position(|s| s == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| {
                            key.eq_ignore_ascii_case("content-length")
                        })
                        .unwrap()
                        .1
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            observed.fetch_add(1, Ordering::SeqCst);
            if stall {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            let body = if status == 200 {
                serde_json::json!({"choices":[{"message":{"content":content}}]})
                    .to_string()
            } else {
                content.to_string()
            };
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let engine = ai_engine::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(Uuid::new_v4().to_string()),
        url: Set(format!("http://{address}/v1")),
        model_name: Set("fixture".into()),
        enabled: Set(true),
        callsign_enabled: Set(true),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    TestEngine {
        engine,
        calls,
        task,
    }
}
