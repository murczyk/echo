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

#[actix_web::test]
async fn devices_download_rejects_truncated_kmz() {
    let archive = |kml: &[u8]| {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("doc.kml", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(kml).unwrap();
        writer.finish().unwrap().into_inner()
    };
    let valid = archive(
        b"<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document/></kml>",
    );
    for (body, accepted) in [
        (valid.clone(), true),
        (valid[..valid.len() - 12].to_vec(), false),
        (archive(b"garbage<kml/>"), false),
        (archive(b"<kml/>garbage"), false),
        (archive(b"<![CDATA[garbage]]><kml/>"), false),
        (archive(b"<kml/><![CDATA[garbage]]>"), false),
        (archive(b"&#32;<kml/>"), false),
        (archive(b"<kml a=\"1\" a=\"2\"/>"), false),
        (archive(b"<kml a=\"<\"/>"), false),
        (archive(b"<kml a=\"1\" a=\"2\"></kml>"), false),
        (archive(b"<kml a=\"<\"></kml>"), false),
        (archive(b"<kml><Document a=\"1\" a=\"2\"/></kml>"), false),
        (archive(b"<kml><Document a=\"<\"></Document></kml>"), false),
        (archive(b"<kml a=unquoted/>"), false),
        (archive(b"<kml a=\"&unknown;\"/>"), false),
        (archive(b"<kml xmlns=\"http://www.opengis.net/kml/2.2\" xmlns:g=\"urn:example\" g:a=\"&lt; &amp; &quot;\"><Document name=\"valid\"/></kml>"), true),
        (archive(b" \n<kml/>\r\n"), true),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let body = web::Bytes::from(body);
        let server = HttpServer::new(move || {
            let body = body.clone();
            App::new().default_service(web::to(move || {
                let body = body.clone();
                async move {
                    let chunks: Vec<_> = body
                        .chunks(8192)
                        .map(|chunk| {
                            Ok::<_, actix_web::Error>(
                                web::Bytes::copy_from_slice(chunk),
                            )
                        })
                        .collect();
                    HttpResponse::Ok()
                        .insert_header((
                            "content-disposition",
                            "attachment; filename=result.kmz",
                        ))
                        .streaming(futures_util::stream::iter(chunks))
                }
            }))
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = server.handle();
        actix_web::rt::spawn(server);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = download_device_kmz(&client, "owned-receipt", &host).await;
        handle.stop(false).await;
        assert_eq!(result.is_ok(), accepted, "Devices must bound actual response chunks and accept only a complete KMZ");
    }
}

#[actix_web::test]
async fn devices_download_rejects_actual_bytes_above_bound() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for false_length in [false, true] {
        let listener =
            tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let length = if false_length {
                "Content-Length: 1\r\n"
            } else {
                ""
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=result.kmz\r\nTransfer-Encoding: chunked\r\n{length}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
            let chunk = vec![b'x'; 8192];
            for _ in 0..3201 {
                if socket.write_all(b"2000\r\n").await.is_err() {
                    break;
                }
                if socket.write_all(&chunk).await.is_err() {
                    break;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    break;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        let result = download_device_kmz_limited(
            &reqwest::Client::new(),
            "owned",
            &host,
            25 * 1024 * 1024,
        )
        .await;
        server.await.unwrap();
        assert_eq!(
            result
                .unwrap_err()
                .downcast_ref::<DeviceConversionFailure>()
                .unwrap()
                .0,
            "result_too_large"
        );
    }
}
