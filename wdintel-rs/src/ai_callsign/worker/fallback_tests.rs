// Regression coverage for https://github.com/echoua/echo/issues/3888.
use super::*;
use crate::ai_callsign::feedback::sql;
use crate::ai_worker::test_support::engine;
use crate::functest::tests::{cleanup_locked, mk_sigint_inbox_item};
use std::sync::atomic::Ordering;
use tracing_subscriber::util::SubscriberInitExt;

#[tokio::test]
#[serial_test::serial]
async fn oversized_primary_responses_are_bounded_in_fallback_logs_3888() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let response = format!(
        "{}PRIVATE_RESPONSE_TAIL",
        "ж".repeat(crate::config::AI_WORKER_MAX_ERROR_CHARS + 100)
    );
    let primary = engine(&env.dbx, 200, &response, false).await;
    let fallback = engine(&env.dbx, 200, r#"{"callsigns":[]}"#, false).await;
    crate::ai_callsign::save_worker_settings(
        &env.dbx,
        true,
        Some(primary.engine.id),
        Some(Some(fallback.engine.id)),
    )
    .await
    .unwrap();
    let item = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .unwrap();
    enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
        .await
        .unwrap();
    let output = tempfile::NamedTempFile::new().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing_subscriber::filter::LevelFilter::WARN)
        .without_time()
        .with_ansi(false)
        .with_writer(output.reopen().unwrap())
        .finish();
    let _capture = subscriber.set_default();
    let mut redis = env.redis.clone();
    assert!(
        process_next(&env.ai_engine_client, &env.dbx, &env.rq, &mut redis,)
            .await
            .unwrap()
    );
    let output = std::fs::read_to_string(output.path()).unwrap();
    assert!(output.contains("AI worker primary failed; using fallback"));
    assert!(output.contains('ж'));
    assert!(!output.contains("PRIVATE_RESPONSE_TAIL"));
    assert!(
        output.matches('ж').count() <= crate::config::AI_WORKER_MAX_ERROR_CHARS
    );
    assert_eq!(fallback.calls.load(Ordering::SeqCst), 1);
    assert!(ai_callsign_worker_job::Entity::find_by_id(item.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn fallback_recovers_http_invalid_json_and_deadline_without_losing_empty_success_progress(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    for (status, content, stall, expected_fallbacks) in [
        (200, r#"{"callsigns":[]}"#, false, 0),
        (401, "primary denied", false, 1),
        (200, "invalid JSON", false, 1),
        (200, "", true, 1),
    ] {
        let primary = engine(&env.dbx, status, content, stall).await;
        let fallback =
            engine(&env.dbx, 200, r#"{"callsigns":[]}"#, false).await;
        let item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        env.dbx.execute_raw(sql("update signal_message set body='— На приёме.',created_at='2026-10-01 00:00:00' where id=$1",vec![item.id.into()])).await.unwrap();
        env.dbx.execute_raw(sql("insert into ai_callsign_settings(id,prompt,worker_enabled,worker_ai_engine_id,worker_fallback_ai_engine_id) values(1,'',true,$1,$2) on conflict(id) do update set worker_enabled=true,worker_ai_engine_id=$1,worker_fallback_ai_engine_id=$2",vec![primary.engine.id.into(),fallback.engine.id.into()])).await.unwrap();
        enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
            .await
            .unwrap();
        let mut redis = env.redis.clone();
        assert!(tokio::time::timeout(
            Duration::from_secs(25),
            process_next(&env.ai_engine_client, &env.dbx, &env.rq, &mut redis)
        )
        .await
        .unwrap()
        .unwrap());
        assert!(ai_callsign_worker_job::Entity::find_by_id(item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let monitoring =
            crate::ai_worker::monitoring::load(&env.dbx).await.unwrap();
        assert!(monitoring.callsign.last_completed_at_ms.is_some());
        assert_eq!(
            monitoring.callsign.latest_processed_entry_created_at_ms,
            Some(
                chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis()
            )
        );
        assert_eq!(primary.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fallback.calls.load(Ordering::SeqCst), expected_fallbacks);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn failed_fallback_preserves_queue_and_error_without_advancing_success() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let primary = engine(&env.dbx, 401, "primary denied", false).await;
    let fallback = engine(&env.dbx, 503, "fallback unavailable", false).await;
    let item = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .unwrap();
    env.dbx
        .execute_raw(sql(
            "update signal_message set body='— На приёме.' where id=$1",
            vec![item.id.into()],
        ))
        .await
        .unwrap();
    env.dbx.execute_raw(sql("insert into ai_callsign_settings(id,prompt,worker_enabled,worker_ai_engine_id,worker_fallback_ai_engine_id) values(1,'',true,$1,$2) on conflict(id) do update set worker_enabled=true,worker_ai_engine_id=$1,worker_fallback_ai_engine_id=$2",vec![primary.engine.id.into(),fallback.engine.id.into()])).await.unwrap();
    enqueue_if_enabled(&env.dbx, item.id, item.id_uuid)
        .await
        .unwrap();
    let mut redis = env.redis.clone();
    assert!(
        process_next(&env.ai_engine_client, &env.dbx, &env.rq, &mut redis)
            .await
            .unwrap()
    );
    let job = ai_callsign_worker_job::Entity::find_by_id(item.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.attempts, 1);
    let error = job.last_error.unwrap();
    assert!(error.contains("primary denied"), "{error}");
    assert!(error.contains("fallback unavailable"), "{error}");
    let monitoring =
        crate::ai_worker::monitoring::load(&env.dbx).await.unwrap();
    assert!(monitoring.callsign.last_completed_at_ms.is_none());
    assert!(monitoring
        .callsign
        .latest_processed_entry_created_at_ms
        .is_none());
    assert!(monitoring.callsign.last_error_at_ms.is_some());
    assert!(monitoring.callsign.oldest_pending_created_at_ms.is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn progress_is_transactional_and_fallback_selection_is_distinct_and_preserved(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let primary = engine(&env.dbx, 200, r#"{"callsigns":[]}"#, false).await;
    let fallback = engine(&env.dbx, 200, r#"{"callsigns":[]}"#, false).await;
    assert!(crate::ai_callsign::save_worker_settings(
        &env.dbx,
        true,
        Some(primary.engine.id),
        Some(Some(primary.engine.id))
    )
    .await
    .is_err());
    crate::ai_callsign::save_worker_settings(
        &env.dbx,
        true,
        Some(primary.engine.id),
        Some(Some(fallback.engine.id)),
    )
    .await
    .unwrap();
    let settings = crate::ai_callsign::save_worker_settings(
        &env.dbx,
        true,
        Some(primary.engine.id),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        settings.worker_fallback_ai_engine_id,
        Some(fallback.engine.id)
    );
    let settings =
        crate::ai_callsign::save_worker_settings(&env.dbx, false, None, None)
            .await
            .unwrap();
    assert!(!settings.worker_enabled);
    assert_eq!(settings.worker_ai_engine_id, None);
    assert_eq!(
        settings.worker_fallback_ai_engine_id,
        Some(fallback.engine.id)
    );
    assert!(crate::ai_callsign::save_worker_settings(
        &env.dbx, true, None, None
    )
    .await
    .is_err());
    let item = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .unwrap();
    let transaction = env.dbx.begin().await.unwrap();
    for worker in ["callsign", "settlement", "position"] {
        crate::ai_worker::record_success(&transaction, worker, item.id)
            .await
            .unwrap();
    }
    transaction.rollback().await.unwrap();
    let monitoring =
        crate::ai_worker::monitoring::load(&env.dbx).await.unwrap();
    assert!(monitoring.callsign.last_completed_at_ms.is_none());
    assert!(monitoring.settlement.last_completed_at_ms.is_none());
    assert!(monitoring.position.last_completed_at_ms.is_none());
}
