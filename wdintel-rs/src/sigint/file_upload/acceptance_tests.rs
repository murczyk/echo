use super::tus::{CompletedUploadWriteResult, TusHandler, TusUploadMetadata};
use super::{effective_tus_method, fallback, TUS_PATH_BASE};
use crate::error::AppError;
use actix_multipart::Multipart;
use actix_web::http::{header, Method, StatusCode};
use actix_web::{
    test::TestRequest, web, FromRequest, HttpResponse, ResponseError,
};
use base64::Engine;
use futures_util::{stream, StreamExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

struct Fixture {
    directory: tempfile::TempDir,
    handler: TusHandler,
    login: Uuid,
}

struct PromotionPause {
    file_id: Uuid,
    started: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

static PROMOTION_PAUSE: std::sync::Mutex<Option<PromotionPause>> =
    std::sync::Mutex::new(None);

pub(super) fn pause_promotion_for_test(file_id: Uuid) {
    let pause = {
        let mut pause = PROMOTION_PAUSE.lock().unwrap();
        if pause.as_ref().is_some_and(|pause| pause.file_id == file_id) {
            pause.take()
        } else {
            None
        }
    };
    if let Some(pause) = pause {
        pause.started.send(()).unwrap();
        pause
            .release
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let handler = TusHandler::new(
            directory.path().display().to_string(),
            TUS_PATH_BASE,
        );
        Self {
            directory,
            handler,
            login: Uuid::new_v4(),
        }
    }

    async fn create(&self, length: u64) -> String {
        let response = request(
            &self.handler,
            self.login,
            Method::POST,
            None,
            &[("upload-length", &length.to_string())],
            b"",
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        response
            .headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    fn path(&self, state: &str, location: &str) -> PathBuf {
        self.directory
            .path()
            .join("file_upload_tus")
            .join(state)
            .join(
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(self.login.as_bytes()),
            )
            .join(location.rsplit('/').next().unwrap())
    }
}

async fn request(
    handler: &TusHandler,
    login: Uuid,
    method: Method,
    location: Option<&str>,
    headers: &[(&str, &str)],
    bytes: &[u8],
) -> HttpResponse {
    let mut request = TestRequest::default()
        .method(method)
        .insert_header(("tus-resumable", "1.0.0"));
    for (name, value) in headers {
        request = request.insert_header((*name, *value));
    }
    let (request, mut payload) =
        request.set_payload(bytes.to_vec()).to_http_parts();
    let payload = web::Payload::from_request(&request, &mut payload)
        .await
        .unwrap();
    let method = effective_tus_method(
        request.method(),
        request.headers(),
        location.is_some(),
    );
    handler
        .handle_request(
            &login,
            &method,
            request.headers(),
            location.map(|location| {
                location.rsplit('/').next().unwrap().to_string()
            }),
            payload,
        )
        .await
        .unwrap_or_else(|error| error.error_response())
}

async fn patch(
    fixture: &Fixture,
    location: &str,
    offset: u64,
    bytes: &[u8],
) -> HttpResponse {
    request(
        &fixture.handler,
        fixture.login,
        Method::PATCH,
        Some(location),
        &[
            ("content-type", "application/offset+octet-stream"),
            ("upload-offset", &offset.to_string()),
        ],
        bytes,
    )
    .await
}

fn offset(response: &HttpResponse) -> u64 {
    response
        .headers()
        .get("upload-offset")
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

fn regular_files(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .flat_map(|entry| {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "locks") {
                Vec::new()
            } else if path.is_dir() {
                regular_files(&path)
            } else {
                vec![path]
            }
        })
        .collect()
}

#[actix_web::test]
async fn busy_head_retains_upload_for_resumption_after_lock_release() {
    let fixture = Fixture::new();
    let location = fixture.create(6).await;
    assert_eq!(
        patch(&fixture, &location, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
    let file_id = Uuid::parse_str(
        location
            .rsplit('/')
            .next()
            .unwrap()
            .split('.')
            .next()
            .unwrap(),
    )
    .unwrap();
    let lock = super::lifecycle::UploadLock::acquire(
        &fixture.handler.upload_dir,
        file_id,
    )
    .await
    .unwrap();
    for (method, status) in [
        (Method::HEAD, StatusCode::LOCKED),
        (Method::PATCH, StatusCode::SERVICE_UNAVAILABLE),
        (Method::DELETE, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let response = request(
            &fixture.handler,
            fixture.login,
            method,
            Some(&location),
            &[
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "3"),
            ],
            b"def",
        )
        .await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store"
        );
        assert!(!response.headers().contains_key("upload-offset"));
    }
    assert_eq!(
        request(
            &fixture.handler,
            Uuid::new_v4(),
            Method::HEAD,
            Some(&location),
            &[],
            b"",
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        std::fs::read(fixture.path("pending", &location)).unwrap(),
        b"abc"
    );
    drop(lock);
    let response = request(
        &fixture.handler,
        fixture.login,
        Method::HEAD,
        Some(&location),
        &[],
        b"",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(offset(&response), 3);
    assert_eq!(
        patch(&fixture, &location, 3, b"def").await.status(),
        StatusCode::NO_CONTENT
    );
    let uploads = fixture
        .handler
        .resolve_completed_uploads(
            &fixture.login,
            std::slice::from_ref(&location),
        )
        .await
        .unwrap();
    assert_eq!(uploads.len(), 1);
    assert_eq!(std::fs::read(&uploads[0].path).unwrap(), b"abcdef");
}

#[actix_web::test]
async fn busy_admission_remains_service_unavailable_with_retry_headers() {
    let fixture = Fixture::new();
    let _lock = super::lifecycle::admission_lock(&fixture.handler.upload_dir)
        .await
        .unwrap();
    let response = request(
        &fixture.handler,
        fixture.login,
        Method::POST,
        None,
        &[("upload-length", "3")],
        b"",
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn cancelled_promotion_keeps_readers_locked_until_metadata_is_published()
{
    let fixture = Fixture::new();
    let location = fixture.create(3).await;
    let pending = fixture.path("pending", &location);
    std::fs::write(
        pending.with_extension("3.json"),
        br#"{"filename":"cancelled.bin"}"#,
    )
    .unwrap();
    let file_id = Uuid::parse_str(
        location
            .rsplit('/')
            .next()
            .unwrap()
            .split('.')
            .next()
            .unwrap(),
    )
    .unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    *PROMOTION_PAUSE.lock().unwrap() = Some(PromotionPause {
        file_id,
        started: started_tx,
        release: release_rx,
    });
    let handler = fixture.handler.clone();
    let login = fixture.login;
    let upload_url = location.clone();
    let request = actix_web::rt::spawn(async move {
        request(
            &handler,
            login,
            Method::PATCH,
            Some(&upload_url),
            &[
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "0"),
            ],
            b"abc",
        )
        .await
    });
    started_rx.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let completed = fixture.path("completed", &location);
    assert!(completed.is_file());
    assert!(!completed.with_extension("3.json").exists());
    let handler = fixture.handler.clone();
    let mut reader = actix_web::rt::spawn(async move {
        handler.open_completed_url(&login, &location).await
    });
    let blocked =
        tokio::time::timeout(std::time::Duration::from_millis(30), &mut reader)
            .await
            .is_err();
    release_tx.send(()).unwrap();
    assert!(blocked, "completed reader observed a promotion before its metadata was published");
    let upload = reader.await.unwrap().unwrap().unwrap();
    assert_eq!(upload.metadata.filename.as_deref(), Some("cancelled.bin"));
    assert_eq!(std::fs::read(upload.file_path).unwrap(), b"abc");
    assert!(!pending.parent().unwrap().exists());
}

#[actix_web::test]
async fn tus_and_fallback_lifecycle_remove_empty_login_directories() {
    let fixture = Fixture::new();
    let location = fixture.create(3).await;
    let pending = fixture.path("pending", &location);
    assert_eq!(
        patch(&fixture, &location, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
    assert!(!pending.parent().unwrap().exists());
    let completed = fixture.path("completed", &location);
    assert_eq!(std::fs::read(&completed).unwrap(), b"abc");
    assert_eq!(
        request(
            &fixture.handler,
            fixture.login,
            Method::DELETE,
            Some(&location),
            &[],
            b""
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!completed.parent().unwrap().exists());

    let response = fallback_request(
        &fixture,
        multipart_body(&[("file", "source.bin", b"xyz")]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = actix_web::body::to_bytes(response.into_body())
        .await
        .unwrap();
    let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let location = response["upload_url"].as_str().unwrap().to_string();
    assert!(!fixture
        .path("pending", &location)
        .parent()
        .unwrap()
        .exists());
    let media = fixture
        .handler
        .resolve_completed_uploads(
            &fixture.login,
            std::slice::from_ref(&location),
        )
        .await
        .unwrap();
    crate::messenger::media::delete_uploaded_attachment_files(&media).await;
    assert!(!fixture
        .path("completed", &location)
        .parent()
        .unwrap()
        .exists());
    let next = fixture.create(3).await;
    assert_eq!(
        patch(&fixture, &next, 0, b"new").await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        std::fs::read(fixture.path("completed", &next)).unwrap(),
        b"new"
    );
}

#[actix_web::test]
async fn chunked_upload_survives_handler_restart_and_resolves_exact_media_bytes(
) {
    let fixture = Fixture::new();
    let name = "перехоплення.bin";
    let metadata = format!(
        "filename {},filetype {}",
        base64::engine::general_purpose::STANDARD.encode(name),
        base64::engine::general_purpose::STANDARD
            .encode("application/octet-stream")
    );
    let response = request(
        &fixture.handler,
        fixture.login,
        Method::POST,
        None,
        &[("upload-length", "9"), ("upload-metadata", &metadata)],
        b"",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(offset(&patch(&fixture, location, 0, b"first").await), 5);
    let restarted = TusHandler::new(
        fixture.directory.path().display().to_string(),
        TUS_PATH_BASE,
    );
    let response = request(
        &restarted,
        fixture.login,
        Method::HEAD,
        Some(location),
        &[],
        b"",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(offset(&response), 5);
    assert_eq!(offset(&patch(&fixture, location, 5, b"last").await), 9);
    let upload = restarted
        .open_completed_url(&fixture.login, location)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(&upload.file_path).unwrap(), b"firstlast");
    assert_eq!(upload.metadata.filename.as_deref(), Some(name));
    let media = restarted
        .resolve_completed_uploads(&fixture.login, &[location.to_string()])
        .await
        .unwrap();
    assert_eq!(media.len(), 1);
    assert_eq!(media[0].name.as_deref(), Some(name));
    assert_eq!(
        media[0].content_type.as_deref(),
        Some("application/octet-stream")
    );
    assert!(!fixture.path("pending", location).exists());
    assert_eq!(
        offset(
            &request(
                &restarted,
                fixture.login,
                Method::HEAD,
                Some(location),
                &[],
                b""
            )
            .await
        ),
        9
    );
}

#[actix_web::test]
async fn unknown_upload_urls_do_not_create_lock_files() {
    let fixture = Fixture::new();
    for method in [Method::HEAD, Method::PATCH, Method::DELETE, Method::POST] {
        let location = format!("{TUS_PATH_BASE}/{}.3", Uuid::new_v4());
        let response = request(
            &fixture.handler,
            fixture.login,
            method,
            Some(&location),
            &[
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "0"),
            ],
            b"abc",
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(fixture
            .handler
            .open_completed_url(&fixture.login, &location)
            .await
            .unwrap()
            .is_none());
    }
    assert!(!fixture.handler.upload_dir.exists());
}

#[actix_web::test]
async fn unowned_uploads_do_not_create_lock_files() {
    let fixture = Fixture::new();
    let intruder = Uuid::new_v4();
    for state in ["pending", "completed"] {
        let location = format!("{TUS_PATH_BASE}/{}.3", Uuid::new_v4());
        let path = fixture.path(state, &location);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"abc").unwrap();
        for method in [Method::HEAD, Method::PATCH, Method::DELETE] {
            let response = request(
                &fixture.handler,
                intruder,
                method,
                Some(&location),
                &[
                    ("content-type", "application/offset+octet-stream"),
                    ("upload-offset", "0"),
                ],
                b"xyz",
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        assert!(fixture
            .handler
            .open_completed_url(&intruder, &location)
            .await
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read(path).unwrap(), b"abc");
    }
    assert!(!fixture.handler.upload_dir.join("locks").exists());
}

#[actix_web::test]
async fn pending_and_completed_uploads_cannot_be_read_modified_or_deleted_by_another_login(
) {
    let fixture = Fixture::new();
    let location = fixture.create(3).await;
    let intruder = Uuid::new_v4();
    for complete in [false, true] {
        if complete {
            assert_eq!(
                patch(&fixture, &location, 0, b"abc").await.status(),
                StatusCode::NO_CONTENT
            );
        }
        for method in [Method::HEAD, Method::PATCH, Method::DELETE] {
            let response = request(
                &fixture.handler,
                intruder,
                method.clone(),
                Some(&location),
                &[
                    ("content-type", "application/offset+octet-stream"),
                    ("upload-offset", "0"),
                ],
                b"xyz",
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{method}, completed={complete}"
            );
        }
        assert!(fixture
            .handler
            .resolve_completed_uploads(
                &intruder,
                std::slice::from_ref(&location)
            )
            .await
            .is_err());
    }
    assert_eq!(
        std::fs::read(fixture.path("completed", &location)).unwrap(),
        b"abc"
    );
}

#[actix_web::test]
async fn invalid_patch_protocol_and_offsets_preserve_spool_bytes() {
    let fixture = Fixture::new();
    let location = fixture.create(8).await;
    assert_eq!(
        patch(&fixture, &location, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
    let cases = [
        (
            "0.2.0",
            "application/offset+octet-stream",
            "3",
            StatusCode::PRECONDITION_FAILED,
        ),
        (
            "1.0.0",
            "application/octet-stream",
            "3",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "-1",
            StatusCode::BAD_REQUEST,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "abc",
            StatusCode::BAD_REQUEST,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "18446744073709551616",
            StatusCode::BAD_REQUEST,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "2",
            StatusCode::CONFLICT,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "4",
            StatusCode::CONFLICT,
        ),
        (
            "1.0.0",
            "application/offset+octet-stream",
            "9",
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ];
    for (version, content_type, upload_offset, expected) in cases {
        let response = request(
            &fixture.handler,
            fixture.login,
            Method::PATCH,
            Some(&location),
            &[
                ("tus-resumable", version),
                ("content-type", content_type),
                ("upload-offset", upload_offset),
            ],
            b"x",
        )
        .await;
        assert_eq!(
            response.status(),
            expected,
            "version={version}, type={content_type}, offset={upload_offset}"
        );
        assert_eq!(
            std::fs::read(fixture.path("pending", &location)).unwrap(),
            b"abc"
        );
    }
    let response = request(
        &fixture.handler,
        fixture.login,
        Method::PATCH,
        Some(&location),
        &[("content-type", "application/offset+octet-stream")],
        b"x",
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(offset(&patch(&fixture, &location, 3, b"defgh").await), 8);
}

#[actix_web::test]
async fn oversized_patch_keeps_original_offset_and_supports_retry() {
    let fixture = Fixture::new();
    let location = fixture.create(4).await;
    assert_eq!(offset(&patch(&fixture, &location, 0, b"ab").await), 2);
    assert_eq!(
        patch(&fixture, &location, 2, b"cde").await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let head = request(
        &fixture.handler,
        fixture.login,
        Method::HEAD,
        Some(&location),
        &[],
        b"",
    )
    .await;
    assert_eq!(offset(&head), 2);
    assert_eq!(
        std::fs::read(fixture.path("pending", &location)).unwrap(),
        b"ab"
    );
    assert_eq!(offset(&patch(&fixture, &location, 2, b"cd").await), 4);
}

#[actix_web::test]
async fn empty_patch_and_post_override_preserve_legacy_resumable_contract() {
    let fixture = Fixture::new();
    let location = fixture.create(3).await;
    assert_eq!(offset(&patch(&fixture, &location, 0, b"").await), 0);
    let response = request(
        &fixture.handler,
        fixture.login,
        Method::POST,
        Some(&location),
        &[
            ("x-http-method-override", "PATCH"),
            ("content-type", "application/offset+octet-stream"),
            ("upload-offset", "0"),
        ],
        b"abc",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(offset(&response), 3);
    assert_eq!(
        patch(&fixture, &location, 3, b"").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            Some(&location),
            &[("x-http-method-override", "DELETE")],
            b""
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(fixture.path("completed", &location).is_file());
}

#[actix_web::test]
async fn deletion_removes_pending_and_completed_payload_and_metadata() {
    for complete in [false, true] {
        let fixture = Fixture::new();
        let response = request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            None,
            &[
                ("upload-length", "3"),
                ("upload-metadata", "filename YS5iaW4="),
            ],
            b"",
        )
        .await;
        let location = response
            .headers()
            .get("location")
            .unwrap()
            .to_str()
            .unwrap();
        if complete {
            assert_eq!(
                patch(&fixture, location, 0, b"abc").await.status(),
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(regular_files(fixture.directory.path()).len(), 2);
        assert_eq!(
            request(
                &fixture.handler,
                fixture.login,
                Method::DELETE,
                Some(location),
                &[],
                b""
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert!(regular_files(fixture.directory.path()).is_empty());
        assert_eq!(
            request(
                &fixture.handler,
                fixture.login,
                Method::DELETE,
                Some(location),
                &[],
                b""
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[actix_web::test]
async fn invalid_create_lengths_and_versions_do_not_reserve_files() {
    let fixture = Fixture::new();
    for (length, expected) in [
        ("0", StatusCode::BAD_REQUEST),
        (
            &(crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES + 1).to_string(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        assert_eq!(
            request(
                &fixture.handler,
                fixture.login,
                Method::POST,
                None,
                &[("upload-length", length)],
                b""
            )
            .await
            .status(),
            expected
        );
    }
    assert_eq!(
        request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            None,
            &[],
            b""
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            None,
            &[("upload-length", "3"), ("tus-resumable", "0.2.0")],
            b""
        )
        .await
        .status(),
        StatusCode::PRECONDITION_FAILED
    );
    assert!(regular_files(fixture.directory.path()).is_empty());
}

fn multipart_body(fields: &[(&str, &str, &[u8])]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, filename, bytes) in fields {
        body.extend_from_slice(format!("--echo-upload-audit\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"--echo-upload-audit--\r\n");
    body
}

async fn fallback_request(fixture: &Fixture, body: Vec<u8>) -> HttpResponse {
    let (request, payload) = TestRequest::post()
        .insert_header((
            "content-type",
            "multipart/form-data; boundary=echo-upload-audit",
        ))
        .set_payload(body)
        .to_http_parts();
    fallback::upload(
        fixture.handler.clone(),
        &fixture.login,
        request.headers(),
        Multipart::new(request.headers(), payload),
    )
    .await
    .unwrap_or_else(|error| error.error_response())
}

#[actix_web::test]
async fn multipart_fallback_preserves_binary_bytes_and_tus_media_compatibility()
{
    let fixture = Fixture::new();
    let bytes = b"\0\xff\r\n--echo-upload-audiX-nearly\0\x80";
    let response = fallback_request(
        &fixture,
        multipart_body(&[("file", "report.bin", bytes)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = actix_web::body::to_bytes(response.into_body())
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let location = json["upload_url"].as_str().unwrap();
    let upload = fixture
        .handler
        .open_completed_url(&fixture.login, location)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(upload.file_path).unwrap(), bytes);
    assert_eq!(upload.metadata.filename.as_deref(), Some("report.bin"));
    assert_eq!(
        offset(
            &request(
                &fixture.handler,
                fixture.login,
                Method::HEAD,
                Some(location),
                &[],
                b""
            )
            .await
        ),
        bytes.len() as u64
    );
}

#[actix_web::test]
async fn multipart_fallback_rejects_missing_empty_wrong_and_duplicate_fields_without_orphans(
) {
    for fields in [
        vec![("file", "empty.bin", b"".as_slice())],
        vec![("wrong", "report.bin", b"abc".as_slice())],
        vec![
            ("file", "first.bin", b"abc".as_slice()),
            ("file", "second.bin", b"def".as_slice()),
        ],
        vec![
            ("file", "first.bin", b"abc".as_slice()),
            ("unexpected", "meta", b"meta".as_slice()),
        ],
    ] {
        let fixture = Fixture::new();
        assert_eq!(
            fallback_request(&fixture, multipart_body(&fields))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert!(
            regular_files(fixture.directory.path()).is_empty(),
            "fields={fields:?}"
        );
    }
}

#[actix_web::test]
async fn new_uploads_leave_legacy_history_to_the_cleanup_worker() {
    let fixture = Fixture::new();
    let root = fixture.directory.path().join("file_upload_tus");
    let history = root.join("completed").join("legacy-empty-login");
    std::fs::create_dir_all(&history).unwrap();
    let location = fixture.create(3).await;
    assert!(history.is_dir());
    let response = fallback_request(
        &fixture,
        multipart_body(&[("file", "report.bin", b"abc")]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(history.is_dir());
    fixture.handler.cleanup_expired().await.unwrap();
    assert!(!history.exists());
    assert!(fixture.path("pending", &location).is_file());
    assert_eq!(
        patch(&fixture, &location, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
}

#[actix_web::test]
async fn failed_fallback_stream_cleans_partial_spool() {
    let fixture = Fixture::new();
    let result = fixture
        .handler
        .create_completed_upload(
            &fixture.login,
            TusUploadMetadata::default(),
            stream::iter([
                Ok(web::Bytes::from_static(b"partial")),
                Err(AppError::AnyhowError {
                    source: anyhow::anyhow!("injected disconnect"),
                }),
            ]),
        )
        .await;
    assert!(result.is_err());
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn incomplete_external_and_excess_attachment_urls_are_rejected() {
    let fixture = Fixture::new();
    let location = fixture.create(3).await;
    for urls in [
        vec![location],
        vec!["https://untrusted.invalid/api/sigint/file-upload/tus/file".to_string()],
        vec!["/api/device/file-content-uploads/00000000-0000-0000-0000-000000000000".to_string()],
        vec!["/api/sigint/file-upload/tus/../../outside".to_string()],
        vec!["invalid".to_string(); crate::config::SIGINT_MESSAGE_MAX_ATTACHMENTS + 1],
    ] {
        assert!(fixture.handler.resolve_completed_uploads(&fixture.login, &urls).await.is_err());
    }
}

#[actix_web::test]
async fn bounded_multipart_import_reader_rejects_limit_plus_one_and_accepts_exact_limit(
) {
    for (bytes, allowed) in
        [(b"abcd".as_slice(), true), (b"abcde".as_slice(), false)]
    {
        let (request, payload) = TestRequest::post()
            .insert_header((
                "content-type",
                "multipart/form-data; boundary=echo-upload-audit",
            ))
            .set_payload(multipart_body(&[("file", "battle-line.kml", bytes)]))
            .to_http_parts();
        let mut multipart = Multipart::new(request.headers(), payload);
        let result =
            crate::utils::multipart::extract_limited(&mut multipart, 4).await;
        assert_eq!(result.is_ok(), allowed);
        if let Ok((_, actual)) = result {
            assert_eq!(actual, bytes);
        }
    }
}

#[actix_web::test]
async fn audit_malformed_create_length_returns_server_error() {
    let fixture = Fixture::new();
    for length in ["-1", "abc", "18446744073709551616"] {
        let response = request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            None,
            &[("upload-length", length)],
            b"",
        )
        .await;
        eprintln!(
            "AUDIT_FINDING legacy invalid Upload-Length={length:?} returns {}",
            response.status()
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn audit_missing_completed_upload_returns_infrastructure_error() {
    let fixture = Fixture::new();
    let location = format!("{TUS_PATH_BASE}/{}.3", Uuid::new_v4());
    let result = fixture
        .handler
        .open_completed_url(&fixture.login, &location)
        .await;
    assert!(
        matches!(result, Ok(None)),
        "missing completed upload returned an infrastructure error"
    );
}

#[actix_web::test]
async fn audit_empty_multipart_fallback_must_return_client_error() {
    let fixture = Fixture::new();
    let response = fallback_request(&fixture, multipart_body(&[])).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn duplicate_completed_urls_resolve_twice_and_cleanup_is_idempotent() {
    let fixture = Fixture::new();
    let result = fixture
        .handler
        .create_completed_upload(
            &fixture.login,
            TusUploadMetadata::default(),
            stream::iter([Ok(web::Bytes::from_static(b"abc"))]),
        )
        .await
        .unwrap();
    let CompletedUploadWriteResult::Stored { upload_url, .. } = result else {
        panic!("expected stored upload");
    };
    let media = fixture
        .handler
        .resolve_completed_uploads(
            &fixture.login,
            &[upload_url.clone(), upload_url],
        )
        .await
        .unwrap();
    assert_eq!(media.len(), 2);
    assert_eq!(media[0].path, media[1].path);
    for attachment in &media {
        assert_eq!(std::fs::read(&attachment.path).unwrap(), b"abc");
    }
    crate::messenger::media::delete_uploaded_attachment_files(&media).await;
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn audit_consumed_upload_cleanup_must_remove_metadata_sidecar() {
    let fixture = Fixture::new();
    let result = fixture
        .handler
        .create_completed_upload(
            &fixture.login,
            TusUploadMetadata {
                filename: Some("source.bin".to_string()),
                ..Default::default()
            },
            stream::iter([Ok(web::Bytes::from_static(b"abc"))]),
        )
        .await
        .unwrap();
    let CompletedUploadWriteResult::Stored { upload_url, .. } = result else {
        panic!("expected stored upload");
    };
    let media = fixture
        .handler
        .resolve_completed_uploads(&fixture.login, &[upload_url])
        .await
        .unwrap();
    assert_eq!(regular_files(fixture.directory.path()).len(), 2);
    crate::messenger::media::delete_uploaded_attachment_files(&media).await;
    let remaining = regular_files(fixture.directory.path());
    assert!(
        remaining.is_empty(),
        "consumed upload left files: {remaining:?}"
    );
}

#[actix_web::test]
async fn interrupted_patch_can_resume_from_persisted_bytes() {
    let fixture = Fixture::new();
    let location = fixture.create(4).await;
    let request = TestRequest::patch()
        .insert_header(("tus-resumable", "1.0.0"))
        .insert_header(("content-type", "application/offset+octet-stream"))
        .insert_header(("upload-offset", "0"))
        .to_http_request();
    let chunks = stream::iter([
        Ok(web::Bytes::from_static(b"ab")),
        Err(actix_web::error::PayloadError::Incomplete(None)),
    ])
    .boxed_local();
    let mut payload = actix_web::dev::Payload::from(chunks);
    let payload = web::Payload::from_request(&request, &mut payload)
        .await
        .unwrap();
    let result = fixture
        .handler
        .handle_request(
            &fixture.login,
            &Method::PATCH,
            request.headers(),
            Some(location.rsplit('/').next().unwrap().to_string()),
            payload,
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(fixture.path("pending", &location)).unwrap(),
        b"ab"
    );
    assert_eq!(offset(&patch(&fixture, &location, 2, b"cd").await), 4);
    assert_eq!(
        std::fs::read(fixture.path("completed", &location)).unwrap(),
        b"abcd"
    );
}

#[actix_web::test]
async fn audit_concurrent_same_offset_patch_must_have_one_winner() {
    let fixture = Fixture::new();
    let location = fixture.create(6).await;
    let request = TestRequest::patch()
        .insert_header(("tus-resumable", "1.0.0"))
        .insert_header(("content-type", "application/offset+octet-stream"))
        .insert_header(("upload-offset", "0"))
        .to_http_request();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let chunks = stream::once(async move {
        entered_tx.send(()).unwrap();
        release_rx.await.unwrap();
        Ok(web::Bytes::from_static(b"xyz"))
    })
    .boxed_local();
    let mut payload = actix_web::dev::Payload::from(chunks);
    let payload = web::Payload::from_request(&request, &mut payload)
        .await
        .unwrap();
    let first = fixture.handler.handle_request(
        &fixture.login,
        &Method::PATCH,
        request.headers(),
        Some(location.rsplit('/').next().unwrap().to_string()),
        payload,
    );
    let second = async {
        entered_rx.await.unwrap();
        let (response, ()) =
            futures_util::join!(patch(&fixture, &location, 0, b"abc"), async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                release_tx.send(()).unwrap();
            });
        response
    };
    let (first, second) = futures_util::join!(first, second);
    let statuses = [first.unwrap().status(), second.status()];
    eprintln!("AUDIT_FINDING concurrent legacy PATCH statuses={statuses:?}, stored={:?}",
        regular_files(fixture.directory.path()).iter().map(|path| std::fs::read(path).unwrap()).collect::<Vec<_>>());
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
}

#[actix_web::test]
async fn expired_pending_rejects_head_and_patch_and_cleans_both_artifacts() {
    for method in [Method::HEAD, Method::PATCH] {
        let mut fixture = Fixture::new();
        let location = fixture.create(3).await;
        fixture.handler.config.pending_expires_in = std::time::Duration::ZERO;
        let response = request(
            &fixture.handler,
            fixture.login,
            method,
            Some(&location),
            &[
                ("content-type", "application/offset+octet-stream"),
                ("upload-offset", "0"),
            ],
            b"abc",
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(regular_files(fixture.directory.path()).is_empty());
    }
}

#[actix_web::test]
async fn expired_completed_upload_is_not_resolved_and_is_removed() {
    let mut fixture = Fixture::new();
    let location = fixture.create(3).await;
    assert_eq!(
        patch(&fixture, &location, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
    fixture.handler.config.completed_expires_in = std::time::Duration::ZERO;
    assert!(fixture
        .handler
        .open_completed_url(&fixture.login, &location)
        .await
        .unwrap()
        .is_none());
    assert!(regular_files(fixture.directory.path()).is_empty());
}

#[actix_web::test]
async fn concurrent_creation_preserves_independent_uploads() {
    let fixture = Fixture::new();
    let count = 2 * crate::config::SIGINT_MESSAGE_MAX_ATTACHMENTS;
    let requests = (0..count).map(|_| {
        request(
            &fixture.handler,
            fixture.login,
            Method::POST,
            None,
            &[("upload-length", "1")],
            b"",
        )
    });
    let responses = futures_util::future::join_all(requests).await;
    let created = responses
        .iter()
        .filter(|response| response.status() == StatusCode::CREATED)
        .collect::<Vec<_>>();
    assert_eq!(created.len(), count);
    let location = created[0]
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(
        request(
            &fixture.handler,
            fixture.login,
            Method::DELETE,
            Some(location),
            &[],
            b""
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    fixture.create(1).await;
    let other = Uuid::new_v4();
    assert_eq!(
        request(
            &fixture.handler,
            other,
            Method::POST,
            None,
            &[("upload-length", "1")],
            b""
        )
        .await
        .status(),
        StatusCode::CREATED
    );
}

#[actix_web::test]
async fn failed_tus_uploads_allow_every_attachment_to_complete_through_fallback(
) {
    let fixture = Fixture::new();
    let count = crate::config::SIGINT_MESSAGE_MAX_ATTACHMENTS;
    for _ in 0..count {
        let location = fixture
            .create(crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES)
            .await;
        assert_eq!(
            patch(&fixture, &location, 1, b"abc").await.status(),
            StatusCode::CONFLICT
        );
    }
    let mut locations = Vec::new();
    for _ in 0..count {
        let response = fallback_request(
            &fixture,
            multipart_body(&[("file", "report.bin", b"abc")]),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        let upload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        locations.push(upload["upload_url"].as_str().unwrap().to_string());
    }
    let uploads = fixture
        .handler
        .resolve_completed_uploads(&fixture.login, &locations)
        .await
        .unwrap();
    assert_eq!(uploads.len(), count);
    for upload in uploads {
        assert_eq!(std::fs::read(upload.path).unwrap(), b"abc");
    }
}

#[actix_web::test]
async fn multiple_large_attachments_remain_resumable_without_an_aggregate_login_limit(
) {
    let fixture = Fixture::new();
    let length = 3 * 1024 * 1024 * 1024 / 2;
    for _ in 0..3 {
        let location = fixture.create(length).await;
        assert_eq!(
            std::fs::metadata(fixture.path("pending", &location))
                .unwrap()
                .len(),
            0
        );
        let response = request(
            &fixture.handler,
            fixture.login,
            Method::HEAD,
            Some(&location),
            &[],
            b"",
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(offset(&response), 0);
        assert_eq!(
            response
                .headers()
                .get("upload-length")
                .unwrap()
                .to_str()
                .unwrap(),
            length.to_string()
        );
    }
}

#[actix_web::test]
async fn cleanup_removes_abandoned_sources_and_orphan_metadata_but_skips_busy_upload(
) {
    let fixture = Fixture::new();
    let busy = fixture.create(3).await;
    let expired = fixture.create(3).await;
    let completed = fixture.create(3).await;
    assert_eq!(
        patch(&fixture, &completed, 0, b"abc").await.status(),
        StatusCode::NO_CONTENT
    );
    let busy_id = Uuid::parse_str(
        busy.rsplit('/').next().unwrap().split('.').next().unwrap(),
    )
    .unwrap();
    let _lock = super::lifecycle::UploadLock::acquire(
        &fixture.handler.upload_dir,
        busy_id,
    )
    .await
    .unwrap();
    let orphan = fixture.path("pending", &format!("{}.1.json", Uuid::new_v4()));
    std::fs::write(&orphan, b"{}").unwrap();
    let fallback =
        fixture.path("pending", &format!(".{}.10.fallback", Uuid::new_v4()));
    std::fs::write(&fallback, b"partial").unwrap();
    super::lifecycle::cleanup(
        &fixture.handler.upload_dir,
        std::time::Duration::ZERO,
        std::time::Duration::ZERO,
    )
    .await
    .unwrap();
    assert!(fixture.path("pending", &busy).exists());
    drop(_lock);
    super::lifecycle::cleanup(
        &fixture.handler.upload_dir,
        std::time::Duration::ZERO,
        std::time::Duration::ZERO,
    )
    .await
    .unwrap();
    assert!(!fixture.path("pending", &expired).exists());
    assert!(!fixture.path("completed", &completed).exists());
    assert!(!orphan.exists());
    assert!(!fallback.exists());
}

#[actix_web::test]
async fn cleanup_worker_scans_on_startup_and_stops_on_cancellation() {
    let fixture = Fixture::new();
    let pending = fixture.create(3).await;
    let orphan = fixture.path("pending", &format!("{}.1.json", Uuid::new_v4()));
    std::fs::write(&orphan, b"{}").unwrap();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let worker = tokio::spawn(super::run_cleanup_nofail(
        fixture.directory.path().display().to_string(),
        cancellation.clone(),
    ));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while orphan.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup worker did not remove orphan metadata on startup");
    assert!(fixture.path("pending", &pending).exists());
    cancellation.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(2), worker)
        .await
        .expect("cleanup worker did not stop")
        .unwrap();
}

#[actix_web::test]
async fn nonregular_patch_source_and_metadata_fail_without_blocking() {
    use std::os::unix::ffi::OsStrExt;
    for sidecar in [false, true] {
        let fixture = Fixture::new();
        let location = fixture.create(3).await;
        if sidecar {
            assert_eq!(
                patch(&fixture, &location, 0, b"abc").await.status(),
                StatusCode::NO_CONTENT
            );
        }
        let path = fixture
            .path(if sidecar { "completed" } else { "pending" }, &location);
        let path = if sidecar {
            PathBuf::from(format!("{}.json", path.display()))
        } else {
            path
        };
        std::fs::remove_file(&path).unwrap();
        let c_path =
            std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            if sidecar {
                assert!(fixture
                    .handler
                    .open_completed_url(&fixture.login, &location)
                    .await
                    .is_err());
            } else {
                assert_eq!(
                    patch(&fixture, &location, 0, b"abc").await.status(),
                    StatusCode::NOT_FOUND
                );
            }
        })
        .await
        .expect("FIFO operation blocked the worker");
    }
}

#[actix_web::test]
async fn known_length_parallel_fallbacks_reserve_body_bound_instead_of_maximum()
{
    let fixture = Fixture::new();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
    let responses = futures_util::future::join_all((0..4).map(|_| {
        let barrier = barrier.clone();
        let handler = fixture.handler.clone();
        let login = fixture.login;
        async move {
            let body = multipart_body(&[("file", "source.bin", b"abc")]);
            let end = body.len() - b"\r\n--echo-upload-audit--\r\n".len();
            let prefix = web::Bytes::copy_from_slice(&body[..end]);
            let suffix = web::Bytes::copy_from_slice(&body[end..]);
            let request = TestRequest::post()
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=echo-upload-audit",
                ))
                .insert_header(("content-length", body.len().to_string()))
                .to_http_request();
            let chunks = stream::once(async {
                Ok::<_, actix_web::error::PayloadError>(prefix)
            })
            .chain(stream::once(async move {
                barrier.wait().await;
                Ok(suffix)
            }))
            .boxed_local();
            fallback::upload(
                handler,
                &login,
                request.headers(),
                Multipart::new(request.headers(), chunks),
            )
            .await
            .unwrap_or_else(|error| error.error_response())
        }
    }));
    let responses = tokio::time::timeout(std::time::Duration::from_secs(5), responses)
        .await.expect("small fallback reservations exhausted capacity before all streams started");
    assert!(responses
        .iter()
        .all(|response| response.status() == StatusCode::CREATED));
}

#[actix_web::test]
async fn fallback_rejects_source_larger_than_declared_body_reservation() {
    let fixture = Fixture::new();
    let (request, payload) = TestRequest::post()
        .insert_header((
            "content-type",
            "multipart/form-data; boundary=echo-upload-audit",
        ))
        .set_payload(multipart_body(&[("file", "source.bin", b"abc")]))
        .insert_header(("content-length", "2"))
        .to_http_parts();
    assert_eq!(request.headers().get("content-length").unwrap(), "2");
    let response = fallback::upload(
        fixture.handler.clone(),
        &fixture.login,
        request.headers(),
        Multipart::new(request.headers(), payload),
    )
    .await
    .unwrap_or_else(|error| error.error_response());
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(regular_files(fixture.directory.path()).is_empty());
}

async fn wait_for_upload_state(predicate: impl Fn() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("upload did not reach the expected filesystem state");
}

#[actix_web::test]
async fn cancelled_fallback_stream_removes_pending_file() {
    let fixture = Fixture::new();
    let handler = fixture.handler.clone();
    let login = fixture.login;
    let upload = actix_web::rt::spawn(async move {
        handler
            .create_completed_upload(
                &login,
                TusUploadMetadata::default(),
                stream::iter([Ok(web::Bytes::from_static(b"partial"))])
                    .chain(stream::pending()),
            )
            .await
    });
    wait_for_upload_state(|| {
        regular_files(fixture.directory.path()).iter().any(|path| {
            path.extension()
                .is_some_and(|extension| extension == "fallback")
                && std::fs::metadata(path)
                    .is_ok_and(|metadata| metadata.len() == 7)
        })
    })
    .await;
    upload.abort();
    assert!(upload.await.unwrap_err().is_cancelled());
    wait_for_upload_state(|| {
        regular_files(fixture.directory.path()).is_empty()
    })
    .await;

    let first = fixture
        .create(crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES)
        .await;
    let second = fixture
        .create(crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES)
        .await;
    for location in [first, second] {
        assert_eq!(
            request(
                &fixture.handler,
                fixture.login,
                Method::DELETE,
                Some(&location),
                &[],
                b""
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
}

#[actix_web::test]
async fn cancelled_fallback_with_incomplete_trailing_field_never_promotes_source(
) {
    let fixture = Fixture::new();
    let handler = fixture.handler.clone();
    let login = fixture.login;
    let (waiting, awaited) = tokio::sync::oneshot::channel();
    let upload = actix_web::rt::spawn(async move {
        let request = TestRequest::post()
            .insert_header((
                "content-type",
                "multipart/form-data; boundary=echo-upload-audit",
            ))
            .to_http_request();
        let prefix = web::Bytes::from_static(b"--echo-upload-audit\r\nContent-Disposition: form-data; name=\"file\"; filename=\"source.bin\"\r\n\r\nabc\r\n--echo-upload-audit\r\nContent-Disposition: form-data; name=\"second\"\r\n");
        let chunks =
            stream::iter([Ok::<_, actix_web::error::PayloadError>(prefix)])
                .chain(stream::once(async move {
                    let _ = waiting.send(());
                    futures_util::future::pending().await
                }))
                .boxed_local();
        fallback::upload(
            handler,
            &login,
            request.headers(),
            Multipart::new(request.headers(), chunks),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), awaited)
        .await
        .unwrap()
        .unwrap();
    wait_for_upload_state(|| {
        regular_files(fixture.directory.path()).iter().any(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| metadata.len() == 3)
        })
    })
    .await;
    assert!(
        regular_files(&fixture.handler.upload_dir.join("completed")).is_empty()
    );
    upload.abort();
    assert!(upload.await.unwrap_err().is_cancelled());
    wait_for_upload_state(|| {
        regular_files(fixture.directory.path()).is_empty()
    })
    .await;
}
