use super::*;
use crate::devices::files::archive;
use sea_orm::{DbBackend, Statement};

#[actix_web::test]
#[serial_test::serial]
async fn archive_common_browse_and_member_content_recheck_current_access() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let source = fixture
        .file_with_metadata("private.zip", "application/zip", "zip")
        .await;
    crate::file_registry::test_support::publish_content(
        fixture.db(),
        &source,
        fixture.login.id,
    )
    .await;
    let archive = archive::test_support::publish(
        fixture.db(),
        fixture.device.id,
        source.id,
        1,
        ["secret.txt", "nested.zip"],
    )
    .await;
    let row=fixture.db().query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select r.id,c.object_key from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.origin_archive_id=$1 and r.name='secret.txt'",[archive.into()])).await.unwrap().unwrap();
    let member: Uuid = row.try_get("", "id").unwrap();
    let object: String = row.try_get("", "object_key").unwrap();
    fixture
        .runtime
        .storage
        .write(&object, vec![1])
        .await
        .unwrap();
    Arc::get_mut(&mut env).unwrap().s3 = Some(fixture.runtime.storage.clone());
    let session =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .service(archive::routes())
            .service(crate::devices::files::browse)
            .service(crate::devices::files::content::routes()),
    )
    .await;
    let owner: Cookie<'static> = cookie!(app, fixture.login.id);
    let content = format!(
        "/api/device/files/{}/{}/revisions/1/content",
        fixture.device.id, member
    );
    let browse = json!({"device_id":fixture.device.id,"parent_entry_id":source.id,"archive_revision":1});
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/files/browse")
            .cookie(owner.clone())
            .set_json(&browse)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["entries"].as_array().unwrap().len(), 2);
    assert_eq!(body["entries"][0]["revision"], 1);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&content)
            .cookie(owner.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body(response).await.as_ref(), &[1]);
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update login set roles='[]' where id=$1",
            [fixture.login.id.into()],
        ))
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/files/browse")
            .cookie(owner.clone())
            .set_json(&browse)
            .to_request(),
    )
    .await;
    assert!(matches!(
        response.status(),
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    ));
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&content)
            .cookie(owner)
            .to_request(),
    )
    .await;
    assert!(matches!(
        response.status(),
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    ));
}
