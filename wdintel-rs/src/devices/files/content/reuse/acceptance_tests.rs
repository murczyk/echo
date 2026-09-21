use super::*;
use crate::devices::files::content::reuse::{CAPABILITY_PATH, REUSE_PATH};
use sea_orm::{DbBackend, Statement, TransactionTrait};
use sea_orm_migration::MigratorTrait;

fn reuse_path(file: &file_entry::Model, revision: i64) -> String {
    REUSE_PATH
        .replace("{device_id}", &file.device_id.to_string())
        .replace("{file_id}", &file.id.to_string())
        .replace("{revision}", &revision.to_string())
}

fn body(upload: &Upload) -> Value {
    json!({"source_upload_id":upload.id,"expected_size":upload.upload_length,
        "expected_sha256":digest_hex(upload.expected_sha256)})
}

fn digest_hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn publish(
    env: &Env,
    fixture: &Fixture,
    file: &file_entry::Model,
    bytes: &[u8],
) -> Upload {
    let upload = fixture.upload(file, bytes).await;
    let locked = fixture.seed_bytes(&upload, bytes).await;
    finalize(
        env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    upload
}

async fn next_revision(
    env: &Env,
    fixture: &Fixture,
    file: &file_entry::Model,
    revision: i64,
) {
    let result = crate::devices::files::sync::automatic(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &fixture.login,
        fixture.device.id,
        vec![crate::devices::files::types::RawSyncDeviceFileItem {
            absolute_path: file.absolute_path.clone().unwrap(),
            mime_type: file.mime_type.clone(),
            extension: file.extension.clone(),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            source_file_state: None,
        }],
    )
    .await
    .unwrap();
    assert!(
        matches!(&result.results[0], crate::devices::files::types::FileSyncResult::Accepted {revision:r,..} if *r == revision)
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn reuse_is_idempotent_after_later_metadata_and_preserves_original_complete(
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("reuse-immutable.bin").await;
    let upload = publish(&env, &fixture, &file, b"immutable bytes").await;
    let stored = fixture
        .runtime
        .storage
        .read(&upload.object_key)
        .await
        .unwrap()
        .to_vec();
    next_revision(&env, &fixture, &file, 2).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let request = || {
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(cookie.clone())
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request()
    };
    let (first, second) = tokio::join!(
        test::call_service(&app, request()),
        test::call_service(&app, request())
    );
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let receipt: Value = test::read_body_json(first).await;
    assert_eq!(receipt, test::read_body_json::<Value, _>(second).await);
    assert_eq!(
        receipt,
        json!({"status":"reused","device_id":file.device_id,"file_id":file.id,
        "revision":2,"source_upload_id":upload.id,"source_revision":1,"size":upload.upload_length,
        "sha256":digest_hex(upload.expected_sha256)})
    );
    let current = file_entry::Entity::find_by_id(file.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.content_path, Some(upload.object_key.clone()));
    let reused = file_content::Entity::find_by_id((file.id, 2))
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let original = file_content::Entity::find_by_id((file.id, 1))
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reused.upload_id, original.upload_id);
    assert_eq!(reused.object_key, original.object_key);
    assert_eq!(reused.is_encrypted, original.is_encrypted);
    assert!(original.is_encrypted);
    next_revision(&env, &fixture, &file, 3).await;
    let replay = test::call_service(&app, request()).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(receipt, test::read_body_json::<Value, _>(replay).await);
    let current = file_entry::Entity::find_by_id(file.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, Some(3));
    assert!(
        current.content_path.is_none(),
        "old receipt must not republish old revision"
    );
    let complete = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!(
                "{}/complete",
                super::super::resource_location(upload.id)
            ))
            .cookie(cookie.clone())
            .insert_header(("Tus-Resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(complete.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(complete).await["revision"],
        1
    );
    let newest = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 3))
            .cookie(cookie)
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request(),
    )
    .await;
    assert_eq!(newest.status(), StatusCode::OK);
    assert_eq!(
        fixture
            .runtime
            .storage
            .read(&upload.object_key)
            .await
            .unwrap()
            .to_vec(),
        stored
    );
    assert_eq!(
        file_content_upload::Entity::find()
            .all(fixture.db())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fixture.persisted(&upload).await.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Completed);
    let migration = wdfiles_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| {
            migration.name() == "m20260915_212032_reuse_verified_file_content"
        })
        .unwrap();
    let error = migration
        .down(&sea_orm_migration::SchemaManager::new(fixture.db()))
        .await
        .unwrap_err();
    assert!(
        format!("{error:?}").contains("cannot remove verified content reuse")
    );
    assert_eq!(
        repository::reconcile_publication(fixture.db(), upload.id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn reuse_authentication_digest_and_target_guards_fail_closed() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("reuse-guards.bin").await;
    let upload = publish(&env, &fixture, &file, b"verified").await;
    next_revision(&env, &fixture, &file, 2).await;
    let other = fixture.file("other-file.bin").await;
    let pending = fixture.upload(&other, b"verified").await;
    next_revision(&env, &fixture, &other, 2).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let anonymous = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(CAPABILITY_PATH)
            .to_request(),
    )
    .await;
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let capability = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(CAPABILITY_PATH)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(capability.status(), StatusCode::NO_CONTENT);
    assert_eq!(capability.headers().get("Echo-Content-Reuse").unwrap(), "1");
    let outsider_organism =
        mk_organism(&env.dbx, Default::default()).await.unwrap();
    let outsider = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("reuse-outsider-{}", Uuid::new_v4())),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            organism_id: Set(Some(outsider_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let outsider_cookie = cookie!(app, outsider.id);
    let denied = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(outsider_cookie)
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request(),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    let oversized = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(cookie.clone())
            .insert_header(("Tus-Resumable", "1.0.0"))
            .insert_header(("Content-Type", "application/json"))
            .set_payload(vec![b' '; 1025])
            .to_request(),
    )
    .await;
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    for (path, request, expected, code) in [
        (
            reuse_path(&file, 2),
            json!({"source_upload_id":upload.id,"expected_size":9,"expected_sha256":digest_hex(upload.expected_sha256)}),
            StatusCode::CONFLICT,
            "content_identity_mismatch",
        ),
        (
            reuse_path(&file, 2),
            json!({"source_upload_id":upload.id,"expected_size":upload.upload_length,"expected_sha256":"ab".repeat(32)}),
            StatusCode::CONFLICT,
            "content_identity_mismatch",
        ),
        (
            reuse_path(&other, 2),
            body(&upload),
            StatusCode::NOT_FOUND,
            "not_found",
        ),
        (
            reuse_path(&other, 2),
            body(&pending),
            StatusCode::CONFLICT,
            "content_not_verified",
        ),
        (
            reuse_path(&file, 1),
            body(&upload),
            StatusCode::CONFLICT,
            "invalid_source_revision",
        ),
        (
            reuse_path(&file, 3),
            body(&upload),
            StatusCode::CONFLICT,
            "revision_stale",
        ),
        (
            reuse_path(&file, 2),
            json!({"source_upload_id":upload.id,"expected_size":7,"expected_sha256":"AB".repeat(32)}),
            StatusCode::BAD_REQUEST,
            "invalid_reuse_request",
        ),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&path)
                .cookie(cookie.clone())
                .insert_header(("Tus-Resumable", "1.0.0"))
                .set_json(request)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), expected, "{code}");
        assert_eq!(
            test::read_body_json::<Value, _>(response).await["code"],
            code
        );
    }
    let current = file_entry::Entity::find_by_id(file.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert!(current.content_path.is_none());
    assert!(file_content::Entity::find_by_id((file.id, 2))
        .one(fixture.db())
        .await
        .unwrap()
        .is_none());
    let open = fixture.upload(&current, b"verified").await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(cookie.clone())
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await["code"],
        "upload_in_progress"
    );
    assert_eq!(fixture.persisted(&open).await.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Open);
    let mut revoked = fixture.login.clone().into_active_model();
    revoked.roles = Set(json!([]));
    revoked.update(&env.dbx).await.unwrap();
    let forbidden = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(CAPABILITY_PATH)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let forbidden = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(cookie)
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request(),
    )
    .await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
}

#[actix_web::test]
#[serial_test::serial]
async fn reuse_database_provenance_rejects_unverified_and_changed_encryption() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("reuse-provenance.bin").await;
    let upload = publish(&env, &fixture, &file, b"verified").await;
    next_revision(&env, &fixture, &file, 2).await;
    let tx = fixture.db().begin().await.unwrap();
    let forged=tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) select file_id,2,upload_id,object_key,source_size_bytes,source_sha256,not is_encrypted,clock_timestamp() from file_content where file_id=$1 and revision=1",
        [file.id.into()])).await.unwrap_err();
    assert!(format!("{forged}")
        .contains("reuse requires verified original content"));
    tx.rollback().await.unwrap();
    let other = fixture.file("unverified-provenance.bin").await;
    let unverified = fixture.upload(&other, b"unknown").await;
    next_revision(&env, &fixture, &other, 2).await;
    let tx = fixture.db().begin().await.unwrap();
    let forged=tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) select file_id,2,id,object_key,upload_length,expected_sha256,false,clock_timestamp() from file_content_upload where id=$1",
        [unverified.id.into()])).await.unwrap_err();
    assert!(format!("{forged}")
        .contains("reuse requires verified original content"));
    tx.rollback().await.unwrap();
    assert_eq!(
        repository::reconcile_publication(fixture.db(), upload.id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn reuse_empty_file_and_concurrent_metadata_do_not_publish_stale_content()
{
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("empty-reuse.bin").await;
    let upload = publish(&env, &fixture, &file, b"").await;
    next_revision(&env, &fixture, &file, 2).await;
    Arc::get_mut(&mut env).unwrap().device_file_content =
        Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let request = || {
        test::TestRequest::post()
            .uri(&reuse_path(&file, 2))
            .cookie(cookie.clone())
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request()
    };
    let (response, ()) = tokio::join!(
        test::call_service(&app, request()),
        next_revision(&env, &fixture, &file, 3)
    );
    assert!(matches!(
        response.status(),
        StatusCode::OK | StatusCode::CONFLICT
    ));
    let expected_status = response.status();
    let current = file_entry::Entity::find_by_id(file.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, Some(3));
    assert!(current.content_path.is_none());
    let replay = test::call_service(&app, request()).await;
    assert_eq!(replay.status(), expected_status);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&reuse_path(&file, 3))
            .cookie(cookie)
            .insert_header(("Tus-Resumable", "1.0.0"))
            .set_json(body(&upload))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let receipt: Value = test::read_body_json(response).await;
    assert_eq!(receipt["size"], 0);
    assert_eq!(receipt["sha256"], digest_hex(upload.expected_sha256));
    assert_eq!(
        file_content_upload::Entity::find()
            .all(fixture.db())
            .await
            .unwrap()
            .len(),
        1
    );
}
