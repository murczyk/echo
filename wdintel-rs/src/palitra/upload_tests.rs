use super::*;
use actix_web::{
    http::StatusCode, test::TestRequest, FromRequest, ResponseError,
};
use opendal::{services::Memory, Operator};
use std::io::Cursor;
use strong_box::{StaticStrongBox, StrongBox};

const VALID_KML: &[u8] = br#"<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>30,50,0 31,50,0 32,51,0</coordinates></LineString></Placemark></Document></kml>"#;

async fn fixture() -> (Env, uuid::Uuid) {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let mut env = env.as_ref().clone();
    let config = crate::config::S3Config {
        s3_access_key_id: "test".into(),
        s3_secret_access_key: "test".into(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: "palitra-upload-test".into(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    };
    env.s3_config = Some(crate::storage::S3Config::from(&config));
    env.config.s3_config = Some(config);
    env.config.store_palitra_in_s3 = Some(true);
    env.s3 = Some(Operator::new(Memory::default()).unwrap().finish());
    let login = crate::users::system_login_id(&env.dbx).await.unwrap();
    (env, login)
}

fn payload(
    name: &str,
    filename: &str,
    bytes: &[u8],
) -> CreatePalitraMultipartPayload {
    CreatePalitraMultipartPayload {
        name: name.to_string(),
        color_hex: Some("#ff0000".into()),
        access_type: "by-logins".into(),
        access_values: String::new(),
        filename: filename.into(),
        file_data: Bytes::copy_from_slice(bytes),
        content_type: None,
        extension: filename.rsplit('.').next().unwrap().into(),
    }
}

fn access(login: uuid::Uuid) -> PalitraAccess {
    PalitraAccess::ByLogins {
        logins: vec![login.to_string()],
    }
}

fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

async fn object_keys(env: &Env) -> Vec<String> {
    let mut keys = env
        .s3
        .as_ref()
        .unwrap()
        .list_with("/")
        .recursive(true)
        .await
        .unwrap()
        .into_iter()
        .filter(|entry| entry.metadata().is_file())
        .map(|entry| entry.path().to_string())
        .collect_vec();
    keys.sort();
    keys
}

async fn state(env: &Env, name: &str) -> serde_json::Value {
    let rows = env.dbx.query_all_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT jsonb_build_object('palitra', to_jsonb(p), 'geometry', coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM palitra_geometry g WHERE g.palitra_id=p.id), '[]'::jsonb), 'points', coalesce((SELECT jsonb_agg(to_jsonb(pt) ORDER BY pt.id) FROM palitra_point pt JOIN palitra_geometry g ON g.id=pt.palitra_geometry_id WHERE g.palitra_id=p.id), '[]'::jsonb), 'conversion', coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM palitra_conversion_job j WHERE j.palitra_id=p.id), '[]'::jsonb), 'goi', coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM palitra_goi_sync_job j WHERE j.palitra_id=p.id), '[]'::jsonb)) AS value FROM palitra p WHERE p.name=$1 ORDER BY p.id",
        [name.into()])).await.unwrap();
    serde_json::Value::Array(
        rows.into_iter()
            .map(|row| row.try_get("", "value").unwrap())
            .collect(),
    )
}

#[serial_test::serial]
#[tokio::test]
async fn invalid_create_variants_preserve_database_and_storage() {
    let (env, login) = fixture().await;
    let name = format!("upload-invalid-{}", uuid::Uuid::new_v4());
    let before = state(&env, &name).await;
    let variants = [
        CreateUploadMode::SingleGeometry,
        CreateUploadMode::SeparatePalitras,
        CreateUploadMode::GroupedGeometries,
    ];
    let malformed = b"not a valid document";
    let empty_archive = archive(&[("readme.txt", b"no geometry")]);
    let partially_broken_archive =
        archive(&[("valid.kml", VALID_KML), ("broken.kml", malformed)]);
    for mode in variants {
        for (filename, bytes) in [
            ("broken.kml", malformed.as_slice()),
            ("broken.kmz", malformed.as_slice()),
            ("empty.kmz", empty_archive.as_slice()),
            ("partial.kmz", partially_broken_archive.as_slice()),
        ] {
            let error = create_uploaded_palitra(
                &env,
                login,
                payload(&name, filename, bytes),
                access(login),
                mode,
            )
            .await
            .unwrap_err();
            assert_eq!(
                AppError::from(error).error_response().status(),
                StatusCode::BAD_REQUEST,
                "{filename}"
            );
            assert_eq!(state(&env, &name).await, before);
            assert!(object_keys(&env).await.is_empty());
        }
    }
}

#[serial_test::serial]
#[tokio::test]
async fn create_variants_and_replacement_commit_source_geometry_and_jobs_together(
) {
    let (env, login) = fixture().await;
    let kmz = archive(&[("nested/DOC.KML", VALID_KML)]);
    for mode in [
        CreateUploadMode::SingleGeometry,
        CreateUploadMode::SeparatePalitras,
        CreateUploadMode::GroupedGeometries,
    ] {
        for (filename, bytes) in
            [("source.kml", VALID_KML), ("source.kmz", kmz.as_slice())]
        {
            let name = format!("upload-valid-{}", uuid::Uuid::new_v4());
            let created = create_uploaded_palitra(
                &env,
                login,
                payload(&name, filename, bytes),
                access(login),
                mode,
            )
            .await
            .unwrap();
            let palitra = palitra::Entity::find_by_id(created.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                palitra.conversion_status,
                PALITRA_CONVERSION_STATUS_READY
            );
            let geometry = palitra_geometry::Entity::find()
                .filter(palitra_geometry::Column::PalitraId.eq(created.id))
                .filter(palitra_geometry::Column::Deleted.eq(false))
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(geometry.len(), 1);
            let shape = env.dbx.query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT ST_AsGeoJSON(COALESCE(line_string, multi_line_string))::jsonb AS shape FROM palitra_geometry WHERE id=$1",
                [geometry[0].id.into()],
            )).await.unwrap().unwrap().try_get::<serde_json::Value>("", "shape").unwrap();
            let coordinates = serde_json::json!([[30, 50], [31, 50], [32, 51]]);
            match shape["type"].as_str().unwrap() {
                "LineString" => assert_eq!(shape["coordinates"], coordinates),
                "MultiLineString" => assert_eq!(
                    shape["coordinates"],
                    serde_json::json!([coordinates])
                ),
                shape => panic!("unexpected geometry type: {shape}"),
            }
            let source_key = palitra.s3_id.as_ref().unwrap();
            let encrypted = env
                .s3
                .as_ref()
                .unwrap()
                .read(&env.s3_config.as_ref().unwrap().prefixed_key(source_key))
                .await
                .unwrap()
                .to_vec();
            let storage = env.s3_config.as_ref().unwrap();
            let key = crate::storage::key_from_b64(
                &env.config.s3_config.as_ref().unwrap().strongbox_key,
            )
            .unwrap();
            let strongbox = StaticStrongBox::new(key.clone(), vec![key]);
            let aad = format!(
                "{}/{}",
                storage.bucket,
                storage.prefixed_key(source_key)
            );
            assert_eq!(
                strongbox.decrypt(&encrypted, aad.as_bytes()).unwrap(),
                bytes
            );
            assert_eq!(
                palitra_goi_sync_job::Entity::find()
                    .filter(
                        palitra_goi_sync_job::Column::PalitraId.eq(created.id)
                    )
                    .count(&env.dbx)
                    .await
                    .unwrap(),
                1
            );
            let before = state(&env, &name).await;
            let keys = object_keys(&env).await;
            let error = replace_existing_palitra_with_direct_file(
                &env,
                &palitra,
                "broken.kmz".into(),
                "kmz".into(),
                b"invalid".to_vec(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                AppError::from(error).error_response().status(),
                StatusCode::BAD_REQUEST
            );
            assert_eq!(state(&env, &name).await, before);
            assert_eq!(object_keys(&env).await, keys);
            replace_existing_palitra_with_direct_file(
                &env,
                &palitra,
                "replace.kmz".into(),
                "kmz".into(),
                kmz.clone(),
            )
            .await
            .unwrap();
            let replaced = palitra::Entity::find_by_id(created.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_ne!(replaced.s3_id, palitra.s3_id);
            assert_eq!(object_keys(&env).await.len(), keys.len() + 1);
        }
    }
}

#[serial_test::serial]
#[tokio::test]
async fn database_write_failure_rolls_back_create_and_replacement_and_removes_only_new_source(
) {
    let (env, login) = fixture().await;
    let name = format!("upload-rollback-{}", uuid::Uuid::new_v4());
    let existing = create_uploaded_palitra(
        &env,
        login,
        payload(&name, "source.kml", VALID_KML),
        access(login),
        CreateUploadMode::SingleGeometry,
    )
    .await
    .unwrap();
    let palitra = palitra::Entity::find_by_id(existing.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let baseline = state(&env, &name).await;
    let keys = object_keys(&env).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let trigger = format!("palitra_upload_test_{suffix}");
    env.dbx.execute_unprepared(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = '{name}' AND NEW.s3_id IS NOT NULL THEN RAISE EXCEPTION 'injected upload write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE UPDATE ON palitra FOR EACH ROW EXECUTE FUNCTION {trigger}();")).await.unwrap();
    let mut failures = Vec::new();
    for mode in [
        CreateUploadMode::SingleGeometry,
        CreateUploadMode::SeparatePalitras,
        CreateUploadMode::GroupedGeometries,
    ] {
        failures.push(
            create_uploaded_palitra(
                &env,
                login,
                payload(&name, "retry.kml", VALID_KML),
                access(login),
                mode,
            )
            .await
            .is_err(),
        );
    }
    failures.push(
        replace_existing_palitra_with_direct_file(
            &env,
            &palitra,
            "replacement.kml".into(),
            "kml".into(),
            VALID_KML.to_vec(),
        )
        .await
        .is_err(),
    );
    let after = state(&env, &name).await;
    let remaining_keys = object_keys(&env).await;
    env.dbx
        .execute_unprepared(&format!(
            "DROP TRIGGER {trigger} ON palitra; DROP FUNCTION {trigger}();"
        ))
        .await
        .unwrap();
    assert!(failures.into_iter().all(|failed| failed));
    assert_eq!(after, baseline);
    assert_eq!(remaining_keys, keys);
    replace_existing_palitra_with_direct_file(
        &env,
        &palitra,
        "retry.kml".into(),
        "kml".into(),
        VALID_KML.to_vec(),
    )
    .await
    .unwrap();
    assert_eq!(object_keys(&env).await.len(), keys.len() + 1);
}

async fn multipart(fields: &[(&str, &[u8])]) -> Multipart {
    let mut body = Vec::new();
    for (name, data) in fields {
        body.extend_from_slice(format!("--audit\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"--audit--\r\n");
    let (request, mut payload) = TestRequest::post()
        .insert_header(("content-type", "multipart/form-data; boundary=audit"))
        .set_payload(body)
        .to_http_parts();
    Multipart::from_request(&request, &mut payload)
        .await
        .unwrap()
}

#[tokio::test]
async fn malformed_multipart_rejects_missing_duplicate_oversize_and_invalid_utf8_fields(
) {
    let too_long = vec![b'x'; crate::config::MULTIPART_TEXT_MAX_BYTES + 1];
    for fields in [
        vec![],
        vec![("name", b"one".as_slice()), ("name", b"two".as_slice())],
        vec![("name", &[0xff])],
        vec![("name", too_long.as_slice())],
    ] {
        let mut multipart = multipart(&fields).await;
        let error = parse_create_palitra_multipart(&mut multipart)
            .await
            .err()
            .unwrap();
        assert_eq!(error.error_response().status(), StatusCode::BAD_REQUEST);
    }
}

#[serial_test::serial]
#[tokio::test]
async fn cancellation_before_publication_preserves_existing_palitra_and_removes_new_source(
) {
    let (env, login) = fixture().await;
    let name = format!("upload-cancel-{}", uuid::Uuid::new_v4());
    let created = create_uploaded_palitra(
        &env,
        login,
        payload(&name, "source.kml", VALID_KML),
        access(login),
        CreateUploadMode::SingleGeometry,
    )
    .await
    .unwrap();
    let palitra = palitra::Entity::find_by_id(created.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let before = state(&env, &name).await;
    let keys = object_keys(&env).await;
    let blocker = env.dbx.begin().await.unwrap();
    palitra::Entity::find_by_id(created.id)
        .lock_exclusive()
        .one(&blocker)
        .await
        .unwrap();
    let blocker_pid: i32 = blocker
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT pg_backend_pid() AS pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let replacement_env = env.clone();
    let replacement = tokio::spawn(async move {
        replace_existing_palitra_with_direct_file(
            &replacement_env,
            &palitra,
            "replacement.kml".into(),
            "kml".into(),
            VALID_KML.to_vec(),
        )
        .await
    });
    let wait_for_lock = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = env.dbx.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting", [blocker_pid.into()]))
                .await.unwrap().unwrap().try_get("", "waiting").unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await;
    replacement.abort();
    let _ = replacement.await;
    blocker.rollback().await.unwrap();
    assert!(
        wait_for_lock.is_ok(),
        "replacement did not reach publication lock"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while object_keys(&env).await != keys {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(state(&env, &name).await, before);
}

#[serial_test::serial]
#[tokio::test]
async fn unknown_palitra_commit_retains_source_but_precommit_failure_cleans_it()
{
    let (env, _) = fixture().await;
    for commit_error in [false, true] {
        let key = crate::messenger::media::store_asset(
            &env,
            Bytes::from_static(VALID_KML),
            Some("commit.kml"),
            Some("application/vnd.google-earth.kml+xml"),
        )
        .await
        .unwrap();
        let remote = env.s3_config.as_ref().unwrap().prefixed_key(&key);
        let before = env.s3.as_ref().unwrap().read(&remote).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let source = UploadedPalitraSource::new(&env, Some(key.clone()));
        let result = if commit_error {
            let pid: i32 = txn
                .query_one_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    "SELECT pg_backend_pid() AS pid",
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get("", "pid")
                .unwrap();
            let terminated: bool = env
                .dbx
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT pg_terminate_backend($1, 5000) AS terminated",
                    [pid.into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get("", "terminated")
                .unwrap();
            assert!(terminated);
            Ok(())
        } else {
            Err(anyhow::anyhow!("publication failed before COMMIT"))
        };
        assert!(finish_palitra_upload(txn, source, result).await.is_err());
        assert_eq!(
            palitra::Entity::find()
                .filter(palitra::Column::S3Id.eq(&key))
                .count(&env.dbx)
                .await
                .unwrap(),
            0,
        );
        if commit_error {
            assert_eq!(
                env.s3
                    .as_ref()
                    .unwrap()
                    .read(&remote)
                    .await
                    .unwrap()
                    .to_bytes(),
                before.to_bytes(),
            );
        } else {
            assert!(!env.s3.as_ref().unwrap().exists(&remote).await.unwrap());
        }
    }
}

#[serial_test::serial]
#[actix_web::test]
async fn missing_palitra_upload_and_conversion_routes_return_not_found_after_authorization(
) {
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{cookie::Key, test, web, App, HttpMessage, HttpRequest};

    async fn sign_in(
        request: HttpRequest,
        login: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }

    let (env, _) = fixture().await;
    let organism = crate::functest::tests::mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login = crate::functest::tests::mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("palitra-upload-{}", uuid::Uuid::new_v4())),
            organism_id: Set(Some(organism.id)),
            roles: Set(serde_json::json!(["Admin", "Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(upload_palitra_points)
            .service(retry_palitra_conversion)
            .service(retry_goi_source_conversion),
    )
    .await;
    let response = test::call_service(
        &app,
        TestRequest::post()
            .uri(&format!("/test/login/{}", login.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    for route in [
        "upload-points",
        "retry-conversion",
        "retry-goi-source-conversion",
    ] {
        let uri = format!("/api/palitra/{route}/{}", i64::MAX);
        let response = test::call_service(
            &app,
            TestRequest::post()
                .uri(&uri)
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=audit",
                ))
                .set_payload("--audit--\r\n")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{route}");
        let response = test::call_service(
            &app,
            TestRequest::post()
                .uri(&uri)
                .cookie(cookie.clone())
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=audit",
                ))
                .set_payload("--audit--\r\n")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
    }
    assert!(object_keys(&env).await.is_empty());
}

#[actix_web::test]
async fn truncated_multipart_ending_in_crlf_returns_client_error_within_idle_deadline(
) {
    for body in [
        "--audit\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\ntruncated\r\n",
        "--audit\r\nContent-Disposition: form-data; name=\"name\"\r\n",
    ] {
        let (request, payload) = TestRequest::post()
            .insert_header(("content-type", "multipart/form-data; boundary=audit"))
            .set_payload(body).to_http_parts();
        let mut payload = Multipart::new(request.headers(), payload);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1),
            parse_create_palitra_multipart_with_timeout(&mut payload, std::time::Duration::from_millis(25))).await;
        let error = result.expect("truncated multipart reader exceeded its idle deadline").err().expect("truncated multipart must fail");
        assert_eq!(error.error_response().status(), StatusCode::BAD_REQUEST);
    }
}
