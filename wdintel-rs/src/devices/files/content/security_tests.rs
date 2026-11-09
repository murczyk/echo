use super::*;
#[cfg(debug_assertions)]
use crate::devices::upload_finalization;

#[cfg(debug_assertions)]
use crate::devices::upload_finalization::security_fault as fault;

#[cfg(debug_assertions)]
#[actix_web::test]
#[serial_test::serial]
async fn phase8_file_publication_rechecks_authority_and_revision_after_verification(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    for (change, error_code, status) in [
        (
            "revoke_read",
            "publication_forbidden",
            StatusCode::NOT_FOUND,
        ),
        (
            "delete_actor",
            "publication_forbidden",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "disable_actor",
            "publication_forbidden",
            StatusCode::UNAUTHORIZED,
        ),
        ("change_revision", "target_revision_changed", StatusCode::OK),
        (
            "authorization_unavailable",
            "storage_outcome_unknown",
            StatusCode::OK,
        ),
    ] {
        let file = fixture.file(change).await;
        let upload = fixture.upload(&file, b"private retained source").await;
        drop(
            fixture
                .seed_bytes(&upload, b"private retained source")
                .await,
        );
        let job_id = admit_file_source(&fixture, &upload).await;
        let claim = claim_file_job(&fixture, job_id).await;
        let mut execution_env = (*env).clone();
        if change == "authorization_unavailable" {
            execution_env.dbx =
                sea_orm::Database::connect(crate::mk_conn_string(&env.config))
                    .await
                    .unwrap();
        }
        let pause = fault::VerifiedPause::new(job_id);
        let mutation = async {
            pause.reached().await;
            match change {
                "revoke_read" | "delete_actor" => {
                    let mut actor = fixture.login.clone().into_active_model();
                    if change == "revoke_read" {
                        actor.roles = Set(json!([]));
                    } else {
                        actor.deleted = Set(true);
                    }
                    actor.update(&env.dbx).await.unwrap();
                }
                "authorization_unavailable" => {
                    execution_env.dbx.clone().close().await.unwrap();
                }
                "disable_actor" => {
                    sqlx::query(
                        "update organism set enabled=false where id=$1",
                    )
                    .bind(fixture.login.organism_id.unwrap())
                    .execute(env.dbx.get_postgres_connection_pool())
                    .await
                    .unwrap();
                }
                "change_revision" => {
                    let revision =
                        file_revision::Entity::find_by_id((file.id, 1))
                            .one(fixture.db())
                            .await
                            .unwrap()
                            .unwrap();
                    let mut revision = revision.into_active_model();
                    revision.revision = Set(2);
                    revision.source_sequence = Set(Some(100));
                    revision.insert(fixture.db()).await.unwrap();
                    let mut entry = file.clone().into_active_model();
                    entry.revision = Set(Some(2));
                    entry.update(fixture.db()).await.unwrap();
                }
                _ => unreachable!(),
            }
            pause.release();
        };
        let (completed, ()) = tokio::join!(
            finalizer::finalize_claim(&execution_env, &fixture.runtime, claim),
            mutation
        );
        completed.unwrap();
        let job = persisted_file_job(&fixture, job_id).await;
        assert_eq!(
            job.status,
            if change == "authorization_unavailable" {
                "outcome_unknown"
            } else {
                "failed"
            },
            "{change}"
        );
        if change == "authorization_unavailable" {
            assert_eq!(job.source_release_state, "held");
            assert!(job.source_released_at.is_none());
            assert!(job.quota_released_at.is_none());
            assert_finalization_source_unpublished(
                &fixture,
                &upload,
                b"private retained source",
            )
            .await;
        }
        assert_eq!(job.error_code.as_deref(), Some(error_code), "{change}");
        assert!(job.result.is_none());
        assert!(job.winning_attempt_id.is_none());
        assert!(file_content::Entity::find_by_id((file.id, 1))
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
        assert!(file_content_upload_object::Entity::find_by_id(upload.id)
            .one(fixture.db())
            .await
            .unwrap()
            .is_none());
        let response = upload_finalization::status_response(
            upload_finalization::get_snapshot(&env, job_id, fixture.login.id)
                .await,
        );
        assert_eq!(response.status(), status, "{change}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(!body.contains("object_key"));
        assert!(!body.contains("source_locator"));
        if status == StatusCode::OK {
            assert!(body.contains(error_code));
        }
        sqlx::query("update login set roles=$2,deleted=false where id=$1")
            .bind(fixture.login.id)
            .bind(fixture.login.roles.clone())
            .execute(env.dbx.get_postgres_connection_pool())
            .await
            .unwrap();
        sqlx::query("update organism set enabled=true where id=$1")
            .bind(fixture.login.organism_id.unwrap())
            .execute(env.dbx.get_postgres_connection_pool())
            .await
            .unwrap();
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_file_quota_response_records_typed_capacity_without_changing_503(
) {
    use crate::telemetry::metrics::{Metrics, UPLOAD_FINALIZATION_EVENTS};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut env = (*async_file_env(&env, &fixture, true)).clone();
    let settings = env.config.device_upload_finalization.as_mut().unwrap();
    settings.file_actor_jobs = 1;
    let (metrics, recorder) = Metrics::recording(&env.config);
    env.metrics = Some(metrics.clone());
    let env = Arc::new(env);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for (index, expected) in [
        (0, StatusCode::ACCEPTED),
        (1, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let file = fixture.file(&format!("quota-{index}")).await;
        let upload = fixture.upload(&file, b"quota source").await;
        drop(fixture.seed_bytes(&upload, b"quota source").await);
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!(
                    "/api/device/file-content-uploads/{}/complete",
                    upload.id
                ))
                .cookie(cookie.clone())
                .insert_header(("Tus-Resumable", "1.0.0"))
                .set_json(json!({"async_finalization": true}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), expected);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        if index == 0 {
            let replay = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!(
                        "/api/device/file-content-uploads/{}/complete",
                        upload.id
                    ))
                    .cookie(cookie.clone())
                    .insert_header(("Tus-Resumable", "1.0.0"))
                    .set_json(json!({"async_finalization": true}))
                    .to_request(),
            )
            .await;
            assert_eq!(replay.status(), StatusCode::ACCEPTED);
        }
        if index == 1 {
            assert_eq!(
                response.headers().get(header::RETRY_AFTER).unwrap(),
                "1"
            );
            let body: Value = test::read_body_json(response).await;
            assert_eq!(body, json!({"code": "finalization_unavailable"}));
            assert!(fixture
                .persisted(&upload)
                .await
                .finalization_job_id
                .is_none());
        }
    }
    metrics.force_flush_for_test();
    let outcomes = [
        "accepted",
        "replayed",
        "capacity_unavailable",
        "unavailable",
    ]
    .map(|outcome| {
        recorder.counter_value(
            UPLOAD_FINALIZATION_EVENTS,
            &[
                ("kind", "file"),
                ("event", "admission"),
                ("outcome", outcome),
            ],
        )
    });
    assert_eq!(outcomes, [Some(1), Some(1), Some(1), None]);
}
