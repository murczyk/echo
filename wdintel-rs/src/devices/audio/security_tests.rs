use super::*;
#[cfg(debug_assertions)]
use crate::devices::upload_finalization;

#[cfg(debug_assertions)]
use crate::devices::upload_finalization::security_fault as fault;

#[cfg(debug_assertions)]
#[actix_web::test]
#[serial_test::serial]
async fn phase8_audio_publication_rechecks_current_upload_rights_after_verification(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let env = phase5_env(&env, directory.path(), memory_storage());
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    let account = crate::entities::login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    for (change, error_code, status) in [
        ("revoke_upload", "publication_forbidden", StatusCode::OK),
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
        ("archive_target", "publication_forbidden", StatusCode::OK),
    ] {
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            change,
            bytes.clone(),
        )
        .await;
        let job_id = phase5_enqueue(env.clone(), actor, &command).await;
        let claim = claim_audio(&env, job_id, false).await;
        let pause = fault::VerifiedPause::new(job_id);
        let mutation = async {
            pause.reached().await;
            match change {
                "revoke_upload" | "revoke_read" | "delete_actor" => {
                    let mut updated = account.clone().into_active_model();
                    match change {
                        "revoke_upload" => {
                            updated.roles = Set(json!(["CyberViewer"]))
                        }
                        "revoke_read" => updated.roles = Set(json!([])),
                        _ => updated.deleted = Set(true),
                    }
                    updated.update(&env.dbx).await.unwrap();
                }
                "disable_actor" => {
                    sqlx::query(
                        "update organism set enabled=false where id=$1",
                    )
                    .bind(account.organism_id.unwrap())
                    .execute(env.dbx.get_postgres_connection_pool())
                    .await
                    .unwrap();
                }
                "archive_target" => {
                    sqlx::query("update device set archived=true,archived_at=clock_timestamp() where id=$1")
                        .bind(device)
                        .execute(env.dbx.get_postgres_connection_pool())
                        .await
                        .unwrap();
                }
                _ => unreachable!(),
            }
            pause.release();
        };
        let (completed, ()) = tokio::join!(
            ingest::finalize_claim(&env, &env.device_audio, claim),
            mutation
        );
        completed.unwrap();
        let job = persisted_job(&env, job_id).await;
        assert_eq!(job.status, "failed", "{change}");
        assert_eq!(job.error_code.as_deref(), Some(error_code), "{change}");
        assert!(job.result.is_none());
        assert!(job.winning_attempt_id.is_none());
        assert!(device_audio::Entity::find_by_id(job.audio_id.unwrap())
            .one(env.device_audio.file_database().unwrap())
            .await
            .unwrap()
            .is_none());
        let response = upload_finalization::status_response(
            upload_finalization::get_snapshot(&env, job_id, actor).await,
        );
        assert_eq!(response.status(), status, "{change}");
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(!body.contains("object_key"));
        assert!(!body.contains("source_locator"));
        assert!(!body.contains(&command.upload_url));
        if status == StatusCode::OK {
            assert!(body.contains(error_code));
        }
        sqlx::query("update login set roles=$2,deleted=false where id=$1")
            .bind(actor)
            .bind(account.roles.clone())
            .execute(env.dbx.get_postgres_connection_pool())
            .await
            .unwrap();
        sqlx::query("update organism set enabled=true where id=$1")
            .bind(account.organism_id.unwrap())
            .execute(env.dbx.get_postgres_connection_pool())
            .await
            .unwrap();
        sqlx::query(
            "update device set archived=false,archived_at=null where id=$1",
        )
        .bind(device)
        .execute(env.dbx.get_postgres_connection_pool())
        .await
        .unwrap();
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_audio_quota_response_records_typed_capacity_without_changing_503(
) {
    use crate::telemetry::metrics::{Metrics, UPLOAD_FINALIZATION_EVENTS};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut env =
        (*phase5_env(&env, directory.path(), memory_storage())).clone();
    env.config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .audio_actor_jobs = 1;
    let (metrics, recorder) = Metrics::recording(&env.config);
    env.metrics = Some(metrics.clone());
    let env = Arc::new(env);
    let (actor, device) = enabled_audio_device(&env).await;
    let bytes = native_audio_bytes().await;
    for (index, expected) in [
        (0, StatusCode::ACCEPTED),
        (1, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let command = receive_command(
            &env.device_audio,
            actor,
            device,
            &format!("quota-{index}"),
            bytes.clone(),
        )
        .await;
        let mut request = receive_request(&command);
        request["async_finalization"] = json!(true);
        let (status, headers, body) =
            receive_json(env.clone(), actor, request).await;
        assert_eq!(status, expected, "{body}");
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "private, no-store");
        if index == 0 {
            let mut replay = receive_request(&command);
            replay["async_finalization"] = json!(true);
            let (status, _, _) = receive_json(env.clone(), actor, replay).await;
            assert_eq!(status, StatusCode::ACCEPTED);
        }
        if index == 1 {
            assert_eq!(headers.get(RETRY_AFTER).unwrap(), "60");
            assert_eq!(
                body,
                json!("Device audio is unavailable: async finalization admission is temporarily unavailable")
            );
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
                ("kind", "audio"),
                ("event", "admission"),
                ("outcome", outcome),
            ],
        )
    });
    assert_eq!(outcomes, [Some(1), Some(1), Some(1), None]);
}
