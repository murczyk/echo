use super::*;
use actix_web::{web, App, HttpRequest, HttpServer};
use std::collections::VecDeque;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const SOURCE: &[u8] = b"owned-alpine-source\0\xff";
const CONVERTED: &[u8] = b"owned-converted-result";

#[derive(Clone, Copy)]
enum PollReply {
    Pending,
    Complete,
    Failed,
    Status(u16),
    InvalidJson,
    EmptyStatuses,
    WrongReceipt,
    DuplicateReceipt,
    OtherReceiptFirst,
}

struct ConverterState {
    replies: Mutex<VecDeque<PollReply>>,
    last_reply: PollReply,
    stalled_path: Option<&'static str>,
    uploads: Mutex<Vec<Vec<u8>>>,
    polls: AtomicUsize,
    downloads: AtomicUsize,
}

struct FakeConverter {
    url: String,
    state: web::Data<ConverterState>,
    handle: actix_web::dev::ServerHandle,
}

impl FakeConverter {
    fn start(
        replies: &[PollReply],
        stalled_path: Option<&'static str>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = web::Data::new(ConverterState {
            replies: Mutex::new(replies.iter().copied().collect()),
            last_reply: *replies.last().unwrap_or(&PollReply::Complete),
            stalled_path,
            uploads: Mutex::new(Vec::new()),
            polls: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
        });
        let shared = state.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(shared.clone())
                .default_service(web::to(converter_response))
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);
        Self { url, state, handle }
    }

    async fn convert(
        &self,
        timeout_seconds: u64,
    ) -> anyhow::Result<ConversionResult> {
        let upload = UploadData {
            hide_titles: true,
            file_bytes: SOURCE.to_vec(),
            field_name: Some("source".to_string()),
            file_name: Some("source.kml".to_string()),
            content_type: Some("application/octet-stream".to_string()),
            output_format: "kmz".to_string(),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            convert_file_with_deadline(
                &client,
                &self.url,
                &upload,
                timeout_seconds,
                Duration::from_millis(1),
            ),
        )
        .await
        .expect("conversion failed to enforce its own deadline")
    }
}

impl Drop for FakeConverter {
    fn drop(&mut self) {
        let handle = self.handle.clone();
        actix_web::rt::spawn(async move { handle.stop(false).await });
    }
}

async fn converter_response(
    request: HttpRequest,
    body: web::Bytes,
    state: web::Data<ConverterState>,
) -> HttpResponse {
    if state.stalled_path == Some(request.path()) {
        std::future::pending::<()>().await;
    }
    match request.path() {
        "/api/upload-task" => {
            state.uploads.lock().unwrap().push(body.to_vec());
            HttpResponse::Ok().json("owned-receipt")
        }
        "/api/task-status-batch" => {
            state.polls.fetch_add(1, Ordering::SeqCst);
            let reply = state
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(state.last_reply);
            match reply {
                PollReply::Status(status) => HttpResponse::build(
                    actix_web::http::StatusCode::from_u16(status).unwrap(),
                )
                .finish(),
                PollReply::InvalidJson => {
                    HttpResponse::Ok().body("invalid-json")
                }
                _ => {
                    let status = serde_json::json!({
                        "receipt": if matches!(reply, PollReply::WrongReceipt) {
                            "other-receipt"
                        } else { "owned-receipt" },
                        "started": true,
                        "completed": !matches!(reply, PollReply::Pending),
                        "is_ok": !matches!(reply, PollReply::Failed),
                        "geolocation_description": null
                    });
                    let statuses = match reply {
                        PollReply::EmptyStatuses => Vec::new(),
                        PollReply::DuplicateReceipt => {
                            vec![status.clone(), status]
                        }
                        PollReply::OtherReceiptFirst => {
                            let mut other = status.clone();
                            other["receipt"] =
                                serde_json::json!("other-receipt");
                            other["is_ok"] = serde_json::json!(false);
                            vec![other, status]
                        }
                        _ => vec![status],
                    };
                    HttpResponse::Ok()
                        .json(serde_json::json!({"statuses": statuses}))
                }
            }
        }
        "/api/download-task/owned-receipt" => {
            state.downloads.fetch_add(1, Ordering::SeqCst);
            HttpResponse::Ok()
                .insert_header((
                    "content-disposition",
                    "attachment; filename=converted.kmz",
                ))
                .insert_header((
                    "content-type",
                    crate::config::KMZ_CONTENT_TYPE,
                ))
                .body(CONVERTED)
        }
        _ => HttpResponse::NotFound().finish(),
    }
}

#[actix_web::test]
async fn transient_poll_failures_reset_after_pending_and_preserve_conversion_bytes(
) {
    let converter = FakeConverter::start(
        &[
            PollReply::Status(503),
            PollReply::Status(429),
            PollReply::Pending,
            PollReply::Status(503),
            PollReply::Status(408),
            PollReply::Pending,
            PollReply::OtherReceiptFirst,
        ],
        None,
    );
    let result = converter.convert(2).await.unwrap();
    assert_eq!(result.body.as_ref(), CONVERTED);
    assert_eq!(result.name.as_deref(), Some("converted.kmz"));
    assert_eq!(result.receipt, "owned-receipt");
    assert_eq!(converter.state.polls.load(Ordering::SeqCst), 7);
    assert_eq!(converter.state.downloads.load(Ordering::SeqCst), 1);
    let uploads = converter.state.uploads.lock().unwrap();
    assert_eq!(uploads.len(), 1);
    assert!(uploads[0]
        .windows(SOURCE.len())
        .any(|bytes| bytes == SOURCE));
    let form = String::from_utf8_lossy(&uploads[0]);
    assert!(form.contains("name=\"src_file\"; filename=\"source.kml\""));
    assert!(form.contains("name=\"hide_titles\"\r\n\r\n1"));
    assert!(form.contains("name=\"output_format\"\r\n\r\nkmz"));
}

#[actix_web::test]
async fn terminal_and_persistent_converter_errors_finish_without_download() {
    for (reply, expected_polls) in [
        (PollReply::Status(401), 1),
        (PollReply::Status(403), 1),
        (PollReply::Status(404), 1),
        (PollReply::InvalidJson, 1),
        (PollReply::EmptyStatuses, 1),
        (PollReply::WrongReceipt, 1),
        (PollReply::DuplicateReceipt, 1),
        (PollReply::Failed, 1),
        (
            PollReply::Status(503),
            crate::config::ALPINE_CONVERSION_MAX_CONSECUTIVE_POLL_FAILURES,
        ),
    ] {
        let converter = FakeConverter::start(&[reply], None);
        assert!(converter.convert(2).await.is_err());
        assert_eq!(
            converter.state.polls.load(Ordering::SeqCst),
            expected_polls
        );
        assert_eq!(converter.state.downloads.load(Ordering::SeqCst), 0);
    }
}

#[actix_web::test]
async fn overall_deadline_cancels_stalled_upload_poll_and_download() {
    for path in [
        "/api/upload-task",
        "/api/task-status-batch",
        "/api/download-task/owned-receipt",
    ] {
        let converter =
            FakeConverter::start(&[PollReply::Complete], Some(path));
        let error = converter
            .convert(1)
            .await
            .err()
            .expect("stalled conversion succeeded");
        assert!(format!("{error:#}").contains("overall deadline"));
    }
}

#[actix_web::test]
async fn invalid_overall_deadline_is_rejected_before_network_io() {
    let converter = FakeConverter::start(&[PollReply::Complete], None);
    for seconds in [
        0,
        crate::config::ALPINE_CONVERSION_MAX_TIMEOUT_SECONDS + 1,
        u64::MAX,
    ] {
        let error = converter
            .convert(seconds)
            .await
            .err()
            .expect("invalid deadline accepted");
        assert!(format!("{error:#}").contains("must be between"));
    }
    assert!(converter.state.uploads.lock().unwrap().is_empty());
}
