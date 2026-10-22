use super::*;
use actix_web::{
    http::Method, http::StatusCode, web, App, HttpRequest, HttpResponse,
    HttpServer,
};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::sync::Mutex;

struct TopicServer {
    client: IggyClient,
    requests: web::Data<Mutex<Vec<(Method, String, Value)>>>,
    replies: web::Data<Mutex<VecDeque<(StatusCode, Value)>>>,
    handle: actix_web::dev::ServerHandle,
}

impl TopicServer {
    async fn start(replies: Vec<(StatusCode, Value)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let connection = format!(
            "iggy+http://test:secret@{}",
            listener.local_addr().unwrap()
        );
        let requests = web::Data::new(Mutex::new(Vec::new()));
        let replies = web::Data::new(Mutex::new(VecDeque::from(replies)));
        let server_requests = requests.clone();
        let server_replies = replies.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(server_requests.clone())
                .app_data(server_replies.clone())
                .default_service(web::to(topic_response))
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);
        let client = IggyClient::from_connection_string(&connection).unwrap();
        client.login_user("test", "secret").await.unwrap();
        requests.lock().unwrap().clear();
        Self {
            client,
            requests,
            replies,
            handle,
        }
    }

    async fn finish(self) -> Vec<(Method, String, Value)> {
        self.handle.stop(true).await;
        assert!(self.replies.lock().unwrap().is_empty());
        self.requests.lock().unwrap().clone()
    }
}

async fn topic_response(
    request: HttpRequest,
    body: web::Bytes,
    requests: web::Data<Mutex<Vec<(Method, String, Value)>>>,
    replies: web::Data<Mutex<VecDeque<(StatusCode, Value)>>>,
) -> HttpResponse {
    if request.path() == "/users/login" {
        return HttpResponse::Ok().json(json!({
            "user_id": 1,
            "access_token": { "token": "test-token", "expiry": 4102444800u64 }
        }));
    }
    requests.lock().unwrap().push((
        request.method().clone(),
        request.path().to_string(),
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    ));
    let (status, body) = replies.lock().unwrap().pop_front().unwrap_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        json!("unexpected request"),
    ));
    HttpResponse::build(status).json(body)
}

fn existing_topic() -> Value {
    json!({
        "id": 7, "created_at": 1, "name": "inbox", "size": 1024,
        "message_expiry": u64::MAX, "compression_algorithm": "gzip",
        "max_topic_size": 1073741824u64, "replication_factor": 3,
        "messages_count": 10, "partitions_count": 2, "partitions": []
    })
}

#[actix_web::test]
async fn retention_3835_preserves_existing_settings_and_is_idempotent() {
    let topic = existing_topic();
    let mut retained_topic = topic.clone();
    retained_topic["message_expiry"] = json!(2592000000000u64);
    let server = TopicServer::start(vec![
        (StatusCode::OK, topic.clone()),
        (StatusCode::OK, Value::Null),
        (StatusCode::OK, retained_topic),
    ])
    .await;
    ensure_topic(&server.client, "events", "inbox")
        .await
        .unwrap();
    ensure_topic(&server.client, "events", "inbox")
        .await
        .unwrap();
    let requests = server.finish().await;
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].0, Method::GET);
    assert_eq!(requests[1].0, Method::PUT);
    assert_eq!(requests[1].1, "/streams/events/topics/7");
    assert_eq!(
        requests[1].2,
        json!({
            "name": topic["name"],
            "compression_algorithm": topic["compression_algorithm"],
            "replication_factor": topic["replication_factor"],
            "max_topic_size": topic["max_topic_size"],
            "message_expiry": 2592000000000u64,
        })
    );
    assert_eq!(requests[2].0, Method::GET);
}

#[actix_web::test]
async fn retention_3835_reconciles_concurrent_creation_after_http_conflict() {
    let server = TopicServer::start(vec![
        (StatusCode::NOT_FOUND, Value::Null),
        (StatusCode::CONFLICT, json!("topic already exists")),
        (StatusCode::OK, existing_topic()),
        (StatusCode::OK, Value::Null),
    ])
    .await;
    ensure_topic(&server.client, "events", "inbox")
        .await
        .unwrap();
    let requests = server.finish().await;
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[1].0, Method::POST);
    assert_eq!(requests[1].2["message_expiry"], 2592000000000u64);
    assert_eq!(requests[3].0, Method::PUT);
    assert_eq!(requests[3].2["replication_factor"], 3);
    assert_eq!(requests[3].2["message_expiry"], 2592000000000u64);
}

#[actix_web::test]
async fn retention_3835_creates_configured_topics_without_user_changes() {
    let stream = json!({
        "id": 1, "created_at": 1, "name": "events", "size": 0,
        "messages_count": 0, "topics_count": 0, "topics": []
    });
    let mut topic = existing_topic();
    topic["message_expiry"] = json!(2592000000000u64);
    let server = TopicServer::start(vec![
        (StatusCode::OK, stream.clone()),
        (StatusCode::NOT_FOUND, Value::Null),
        (StatusCode::CREATED, topic.clone()),
        (StatusCode::OK, stream),
        (StatusCode::NOT_FOUND, Value::Null),
        (StatusCode::CREATED, topic),
    ])
    .await;
    ensure_topics_with_client(&server.client, &["events/inbox", "analytics"])
        .await
        .unwrap();
    let requests = server.finish().await;
    assert_eq!(requests.len(), 6);
    for (index, path, name) in [
        (2, "/streams/events/topics", "inbox"),
        (5, "/streams/echo/topics", "analytics"),
    ] {
        assert_eq!(requests[index].0, Method::POST);
        assert_eq!(requests[index].1, path);
        assert_eq!(requests[index].2["name"], name);
        assert_eq!(requests[index].2["message_expiry"], 2592000000000u64);
    }
    assert!(requests
        .iter()
        .all(|(_, path, _)| path.starts_with("/streams/")));
}

#[actix_web::test]
async fn retention_3835_does_not_hide_create_or_update_failures() {
    let server = TopicServer::start(vec![
        (StatusCode::NOT_FOUND, Value::Null),
        (StatusCode::FORBIDDEN, Value::Null),
        (StatusCode::NOT_FOUND, Value::Null),
        (StatusCode::OK, existing_topic()),
        (StatusCode::FORBIDDEN, Value::Null),
    ])
    .await;
    for _ in 0..2 {
        let err = ensure_topic(&server.client, "events", "inbox")
            .await
            .unwrap_err();
        assert!(matches!(
            err.downcast_ref::<IggyError>(),
            Some(IggyError::Unauthorized)
        ));
        assert!(err.chain().count() > 1);
    }
    server.finish().await;
}
