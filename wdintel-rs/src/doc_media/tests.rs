use super::*;
use actix_web::{body::to_bytes, test, App};

fn fixture(local: &Path, remote: &Path) -> DocMedia {
    let storage = Operator::new(
        opendal::services::Fs::default().root(remote.to_str().unwrap()),
    )
    .unwrap()
    .finish();
    DocMedia {
        root: local.to_owned(),
        storage: Some(storage),
        locks: (0..DOC_MEDIA_LOCK_SLOTS).map(|_| Mutex::new(())).collect(),
        downloads: Arc::new(Semaphore::new(DOC_MEDIA_MAX_CONCURRENT_DOWNLOADS)),
    }
}

#[actix_web::test]
async fn issue_3938_cached_media_and_b2_only_ranges_use_separate_sources() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let runtime = fixture(local.path(), remote.path());
    let path = "docs/releases/2026-10-29/media/ланцюжки.mp4";
    let key = format!("doc-media/{path}");
    runtime
        .storage()
        .unwrap()
        .write(&key, b"original".as_slice())
        .await
        .unwrap();
    let request = test::TestRequest::default().to_http_request();
    let (first, second) = tokio::join!(
        runtime.serve(&request, path, false),
        runtime.serve(&request, path, false),
    );
    for response in [first.unwrap(), second.unwrap()] {
        assert_eq!(
            to_bytes(response.into_body()).await.unwrap(),
            b"original".as_slice()
        );
    }
    runtime
        .storage()
        .unwrap()
        .write(&key, b"replacement".as_slice())
        .await
        .unwrap();
    let request = test::TestRequest::default()
        .insert_header((header::RANGE, "bytes=2-5"))
        .to_http_request();
    let response = runtime.serve(&request, path, true).await.unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes 2-5/11"
    );
    assert_eq!(
        to_bytes(response.into_body()).await.unwrap(),
        b"plac".as_slice()
    );
    assert_eq!(
        tokio::fs::read(local.path().join(path)).await.unwrap(),
        b"original"
    );
    let request = test::TestRequest::default()
        .method(Method::HEAD)
        .to_http_request();
    let response = runtime.serve(&request, path, true).await.unwrap();
    assert_eq!(
        response.headers().get(header::CONTENT_LENGTH).unwrap(),
        "11"
    );
    assert!(to_bytes(response.into_body()).await.unwrap().is_empty());
    let request = test::TestRequest::default()
        .insert_header((header::RANGE, "bytes=100-"))
        .to_http_request();
    assert_eq!(
        runtime.serve(&request, path, true).await.unwrap().status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    runtime.storage().unwrap().delete(&key).await.unwrap();
    let request = test::TestRequest::default().to_http_request();
    assert!(matches!(
        AppError::from(runtime.serve(&request, path, true).await.unwrap_err()),
        AppError::NotFound
    ));
    assert!(runtime.serve(&request, path, false).await.is_ok());
}

#[actix_web::test]
async fn issue_3938_document_media_rejects_traversal_and_symlinks() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let runtime = fixture(local.path(), remote.path());
    let request = test::TestRequest::default().to_http_request();
    for path in [
        "/etc/passwd",
        "docs/static/../secret.png",
        "docs/static/%2e%2e/secret.png",
        "docs/static/secret.txt",
        "docs/static/secret\\file.png",
    ] {
        assert!(runtime.serve(&request, path, false).await.is_err());
    }
    std::fs::create_dir_all(local.path().join("docs")).unwrap();
    std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        local.path().join("docs/static"),
    )
    .unwrap();
    assert!(matches!(
        AppError::from(
            runtime
                .serve(&request, "docs/static/secret.png", false)
                .await
                .unwrap_err()
        ),
        AppError::NotFound
    ));
    assert!(outside.path().join("secret.png").exists());
}

#[actix_web::test]
#[serial_test::serial]
async fn issue_3938_authenticated_endpoint_decodes_paths_and_obeys_the_active_setting(
) {
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{cookie::Key, HttpMessage};
    use sea_orm::{ActiveModelTrait, Set};

    async fn login(
        request: HttpRequest,
        id: web::Path<uuid::Uuid>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), id.to_string()).unwrap();
        HttpResponse::Ok().finish()
    }

    let (base, _guard) =
        crate::functest::tests::cleanup_locked().await.unwrap();
    let actor = crate::functest::tests::mk_login(
        &base.dbx,
        crate::entities::login::ActiveModel {
            roles: Set(serde_json::json!(["Basic"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let runtime = fixture(local.path(), remote.path());
    runtime
        .storage()
        .unwrap()
        .write(
            "doc-media/docs/static/image space.png",
            b"original".as_slice(),
        )
        .await
        .unwrap();
    let mut env = (*base).clone();
    env.doc_media = Arc::new(runtime);
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route("/test-login/{id}", web::post().to(login))
            .service(super::serve),
    )
    .await;
    let uri = "/doc-media/docs/static/image%20space%2Epng";
    for method in [Method::GET, Method::HEAD] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method)
                .uri(uri)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            DOC_MEDIA_CACHE_CONTROL
        );
        assert!(!local.path().join("docs").exists());
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test-login/{}", actor.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(uri)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body(response).await, b"original".as_slice());
    assert_eq!(
        tokio::fs::read(local.path().join("docs/static/image space.png"))
            .await
            .unwrap(),
        b"original"
    );
    crate::entities::system_settings::ActiveModel {
        doc_media_serve_from_b2: Set(Some(true)),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    env.doc_media
        .storage()
        .unwrap()
        .write(
            "doc-media/docs/static/image space.png",
            b"replacement".as_slice(),
        )
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(uri)
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body(response).await, b"replacement".as_slice());
    assert_eq!(
        tokio::fs::read(local.path().join("docs/static/image space.png"))
            .await
            .unwrap(),
        b"original"
    );
}
