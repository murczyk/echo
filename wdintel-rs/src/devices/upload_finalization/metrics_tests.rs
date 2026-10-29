use std::time::Duration;

use sqlx::Row;
use uuid::Uuid;

use super::{admission, metrics, query, recovery, types::*, worker};
use crate::{
    functest::tests::cleanup_locked,
    telemetry::metrics::{
        Metrics, RecordedMetricValue, UPLOAD_FINALIZATION_CREDITS,
        UPLOAD_FINALIZATION_CREDIT_SATURATED, UPLOAD_FINALIZATION_DURATION,
        UPLOAD_FINALIZATION_EVENTS, UPLOAD_FINALIZATION_EXPORTER,
        UPLOAD_FINALIZATION_JOBS, UPLOAD_FINALIZATION_OLDEST_AGE,
        UPLOAD_FINALIZATION_RETAINED_BYTES,
    },
    types::DeviceUploadFinalizationSettings,
};

const TERMINAL_HISTORY_SQL: &str = r#"
insert into device_upload_finalization_job(
    id,kind,source_identity,created_by_login_id,device_id,audio_id,audio_name,
    audio_name_key,recording_started_at,upload_url,source_size_bytes,
    source_locator,pin_token,status,created_at,updated_at,finished_at,
    error_code,error_message,error_action,source_release_state,source_released_at,quota_released_at)
select gen_random_uuid(),'audio',device_id::text || '/' || tus_id::text,
    $2,device_id,gen_random_uuid(),name,convert_to(name,'UTF8'),
    '2020-01-01'::timestamptz,
    '/api/device/audio/' || device_id || '/uploads/' || tus_id || '.64',64,
    'metrics/history/' || ordinal,gen_random_uuid(),'failed',
    '2020-01-01'::timestamptz + ordinal * interval '1 second',clock_timestamp(),clock_timestamp(),
    'invalid_audio','Invalid audio','new_upload','released',clock_timestamp(),clock_timestamp()
from (select ordinal,gen_random_uuid() as device_id,gen_random_uuid() as tus_id,
    'history-' || ordinal as name from generate_series(1,$1::integer) as ordinal) history
"#;

async fn seed_terminal_history(db: &sea_orm::DatabaseConnection, count: i32) {
    sqlx::query(TERMINAL_HISTORY_SQL)
        .bind(count)
        .bind(Uuid::new_v4())
        .execute(db.get_postgres_connection_pool())
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn metrics_poll_does_not_scan_terminal_history() {
    assert_metrics_history_is_bounded(5_000).await;
}

#[tokio::test]
#[serial_test::serial]
#[ignore = "Production-scale SQL plan validation with one million retained jobs"]
async fn metrics_poll_with_a_million_terminal_jobs() {
    assert_metrics_history_is_bounded(1_000_000).await;
}

async fn assert_metrics_history_is_bounded(history: i32) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    seed_terminal_history(db, history).await;
    let command = metrics_command();
    let settings = DeviceUploadFinalizationSettings {
        enabled: true,
        ..Default::default()
    };
    admission::admit(db, &command, &settings).await.unwrap();
    sqlx::query("analyze device_upload_finalization_job")
        .execute(db.get_postgres_connection_pool())
        .await
        .unwrap();
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "explain (analyze,buffers,format json,timing off) {}",
        metrics::JOB_STATE_SQL
    )))
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    let plan: serde_json::Value = row.get(0);
    let mut pending = vec![&plan[0]["Plan"]];
    let mut scanned = 0.0;
    while let Some(node) = pending.pop() {
        if node["Relation Name"] == "device_upload_finalization_job" {
            scanned += (node["Actual Rows"].as_f64().unwrap()
                + node["Rows Removed by Filter"].as_f64().unwrap_or(0.0))
                * node["Actual Loops"].as_f64().unwrap();
        }
        if let Some(children) = node["Plans"].as_array() {
            pending.extend(children);
        }
    }
    assert!(
        scanned == 1.0,
        "metrics scanned terminal history: {scanned} rows; {plan}"
    );
    let (telemetry, recorder) = Metrics::recording(&env.config);
    let mut leader = metrics::elect(db).await.unwrap().unwrap();
    metrics::collect(&mut leader, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    println!("Metrics SQL plan with {history} terminal jobs: {plan}");
    for (state, count) in [("queued", 1), ("failed", history as u64)] {
        assert_eq!(
            recorder.gauge_value(
                UPLOAD_FINALIZATION_JOBS,
                &[("kind", "audio"), ("state", state)]
            ),
            Some(count)
        );
    }
    assert!(
        recorder
            .gauge_f64_value(
                UPLOAD_FINALIZATION_OLDEST_AGE,
                &[("kind", "audio"), ("state", "failed")]
            )
            .unwrap()
            > 365.0 * 24.0 * 3600.0
    );
}

#[tokio::test]
#[serial_test::serial]
async fn terminal_metrics_backfill_and_transitions_are_atomic() {
    use sea_orm_migration::MigratorTrait;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    seed_terminal_history(db, 2).await;
    let settings = DeviceUploadFinalizationSettings {
        enabled: true,
        ..Default::default()
    };
    let mut jobs = Vec::new();
    for _ in 0..2 {
        jobs.push(
            admission::admit(db, &metrics_command(), &settings)
                .await
                .unwrap()
                .job_id,
        );
    }
    let completed = admission::admit(db, &metrics_command(), &settings)
        .await
        .unwrap();
    sqlx::query(r#"
        update device_upload_finalization_job set status='completed',finished_at=clock_timestamp(),
            result=jsonb_build_object('version',1,'value',jsonb_build_object('audio',jsonb_build_object(
                'id',audio_id,'device_id',device_id,'name',audio_name,
                'recording_started_at',recording_started_at,'recording_ended_at',recording_started_at+interval '1 second',
                'duration_seconds',1.0,'processed',false,'processing_version',gen_random_uuid())))
        where id=$1
    "#).bind(completed.job_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let migrations = wdfiles_migration::Migrator::migrations();
    let position = migrations
        .iter()
        .position(|migration| {
            migration.name() == "m20261028_153759_finalization_terminal_metrics"
        })
        .unwrap();
    wdfiles_migration::Migrator::down(
        db,
        Some((migrations.len() - position) as u32),
    )
    .await
    .unwrap();
    wdfiles_migration::Migrator::up(db, None).await.unwrap();

    let pool = db.get_postgres_connection_pool();
    let aggregate = "select jobs from device_upload_finalization_terminal_metric where kind='audio' and status='failed'";
    assert_eq!(
        sqlx::query_scalar::<_, i64>(aggregate)
            .fetch_one(pool)
            .await
            .unwrap(),
        2
    );
    let failure = "update device_upload_finalization_job set status='failed',finished_at=clock_timestamp(),error_code='invalid_audio',error_message='Invalid audio',error_action='new_upload' where id=$1 and status='queued'";
    let mut transaction = pool.begin().await.unwrap();
    sqlx::query(failure)
        .bind(jobs[0])
        .execute(&mut *transaction)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(aggregate)
            .fetch_one(&mut *transaction)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(aggregate)
            .fetch_one(pool)
            .await
            .unwrap(),
        2
    );
    transaction.rollback().await.unwrap();
    let (first, second) = tokio::join!(
        sqlx::query(failure).bind(jobs[0]).execute(pool),
        sqlx::query(failure).bind(jobs[1]).execute(pool),
    );
    assert_eq!(first.unwrap().rows_affected(), 1);
    assert_eq!(second.unwrap().rows_affected(), 1);
    assert_eq!(
        sqlx::query(failure)
            .bind(jobs[0])
            .execute(pool)
            .await
            .unwrap()
            .rows_affected(),
        0
    );
    sqlx::query(
        "update device_upload_finalization_job set status=status where id=$1",
    )
    .bind(jobs[0])
    .execute(pool)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(aggregate)
            .fetch_one(pool)
            .await
            .unwrap(),
        4
    );
    seed_terminal_history(db, 1).await;
    let (telemetry, recorder) = Metrics::recording(&env.config);
    let mut leader = metrics::elect(db).await.unwrap().unwrap();
    metrics::collect(&mut leader, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_JOBS,
            &[("kind", "audio"), ("state", "failed")]
        ),
        Some(5)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_JOBS,
            &[("kind", "audio"), ("state", "queued")]
        ),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_JOBS,
            &[("kind", "audio"), ("state", "completed")]
        ),
        Some(1)
    );
    assert!(
        recorder
            .gauge_f64_value(
                UPLOAD_FINALIZATION_OLDEST_AGE,
                &[("kind", "audio"), ("state", "failed")]
            )
            .unwrap()
            > 365.0 * 24.0 * 3600.0
    );
}

#[tokio::test]
#[serial_test::serial]
async fn phase8_elected_metrics_follow_retry_credits_and_failover() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db.as_ref().unwrap().connection();
    let settings = DeviceUploadFinalizationSettings {
        enabled: true,
        audio_unresolved_writes: 1,
        ..Default::default()
    };
    let (telemetry, recorder) = Metrics::recording(&env.config);
    let command = metrics_command();
    let job = admission::admit(db, &command, &settings).await.unwrap();
    let mut leader = metrics::elect(db).await.unwrap().unwrap();
    assert!(metrics::elect(db).await.unwrap().is_none());
    metrics::collect(&mut leader, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    let queued = [("kind", "audio"), ("state", "queued")];
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_JOBS, &queued),
        Some(1)
    );
    assert!(
        recorder
            .gauge_f64_value(UPLOAD_FINALIZATION_OLDEST_AGE, &queued)
            .unwrap()
            >= 0.0
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_RETAINED_BYTES,
            &[("kind", "audio")]
        ),
        Some(64)
    );
    let claim = worker::claim_due(
        db,
        FinalizationKind::FinalizationAudioKind,
        Uuid::new_v4(),
        worker::ClaimLane::Work,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, job.job_id);
    let attempt = query::create_attempt(db, &claim, true).await.unwrap();
    let audio = PreparedAudio {
        media_type: "audio/wav".into(),
        duration_seconds: 1.0,
        recording_ended_at: "2026-10-14T08:00:01Z".parse().unwrap(),
    };
    assert!(query::prepare_attempt(
        db,
        &claim,
        attempt,
        64,
        &[42; 32],
        Some(&audio)
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(db, &claim, attempt, 1)
        .await
        .unwrap());
    assert!(query::record_write_resolution(
        db,
        &claim,
        attempt,
        WriteResolution::DefinitelyNotDispatched
    )
    .await
    .unwrap());
    assert!(recovery::schedule_retry(
        db,
        &claim,
        &FinalizationFailure::DependencyUnavailable,
        false,
        1
    )
    .await
    .unwrap());
    metrics::record_attempt(db, &telemetry, &claim, Duration::from_millis(20))
        .await
        .unwrap();
    metrics::collect(&mut leader, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_JOBS, &queued),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_f64_value(UPLOAD_FINALIZATION_OLDEST_AGE, &queued),
        Some(0.0)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_JOBS,
            &[("kind", "audio"), ("state", "outcome_unknown")]
        ),
        Some(1)
    );
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_CREDITS, &[("kind", "audio")]),
        Some(1)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_CREDIT_SATURATED,
            &[("kind", "audio")]
        ),
        Some(1)
    );
    assert_eq!(
        recorder.counter_value(
            UPLOAD_FINALIZATION_EVENTS,
            &[
                ("kind", "audio"),
                ("event", "retry"),
                ("outcome", "outcome_unknown")
            ]
        ),
        Some(1)
    );
    assert_eq!(
        recorder.counter_value(
            UPLOAD_FINALIZATION_EVENTS,
            &[
                ("kind", "audio"),
                ("event", "failure"),
                ("outcome", "storage_outcome_unknown")
            ]
        ),
        Some(1)
    );
    let duration = recorder
        .find_with_attributes(
            UPLOAD_FINALIZATION_DURATION,
            &[
                ("kind", "audio"),
                ("phase", "processing"),
                ("outcome", "outcome_unknown"),
            ],
        )
        .unwrap();
    assert!(
        matches!(duration.value, RecordedMetricValue::Histogram { count: 1, sum, .. } if (sum-0.02).abs()<0.0001)
    );
    assert_eq!(duration.attributes.len(), 3);
    assert!(!format!("{duration:?}").contains("private"));
    query::release_write_credit(db, attempt).await.unwrap();
    metrics::collect(&mut leader, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_CREDITS, &[("kind", "audio")]),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_CREDIT_SATURATED,
            &[("kind", "audio")]
        ),
        Some(0)
    );
    metrics::reset(&telemetry);
    drop(leader);
    // close_on_drop closes asynchronously; a successor must acquire without a pooled stale session lock.
    let mut successor = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(connection) = metrics::elect(db).await.unwrap() {
                break connection;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_EXPORTER, &[]),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_RETAINED_BYTES,
            &[("kind", "audio")]
        ),
        Some(0)
    );
    metrics::collect(&mut successor, &telemetry, &settings)
        .await
        .unwrap();
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_EXPORTER, &[]),
        Some(1)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_RETAINED_BYTES,
            &[("kind", "audio")]
        ),
        Some(64)
    );
    let pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
        .fetch_one(&mut *successor)
        .await
        .unwrap();
    let terminated: bool =
        sqlx::query_scalar("select pg_terminate_backend($1)")
            .bind(pid)
            .fetch_one(db.get_postgres_connection_pool())
            .await
            .unwrap();
    assert!(terminated);
    let mut leader = Some(successor);
    assert!(
        metrics::collect_elected(db, &mut leader, &telemetry, &settings)
            .await
            .is_err()
    );
    assert!(leader.is_none());
    telemetry.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(UPLOAD_FINALIZATION_EXPORTER, &[]),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            UPLOAD_FINALIZATION_JOBS,
            &[("kind", "audio"), ("state", "outcome_unknown")]
        ),
        Some(0)
    );
    let (successor_metrics, successor_recorder) =
        Metrics::recording(&env.config);
    metrics::collect_elected(db, &mut leader, &successor_metrics, &settings)
        .await
        .unwrap();
    assert!(leader.is_some());
    successor_metrics.force_flush_for_test();
    assert_eq!(
        successor_recorder.gauge_value(UPLOAD_FINALIZATION_EXPORTER, &[]),
        Some(1)
    );
    assert_eq!(
        successor_recorder.gauge_value(
            UPLOAD_FINALIZATION_RETAINED_BYTES,
            &[("kind", "audio")]
        ),
        Some(64)
    );
}

fn metrics_command() -> FinalizationCommand {
    FinalizationCommand {
        created_by_login_id: Uuid::new_v4(),
        device_id: Uuid::new_v4(),
        source_size_bytes: 64,
        source_locator: Some("private/source-do-not-export".into()),
        target: FinalizationTarget::Audio {
            tus_id: Uuid::new_v4(),
            audio_id: Uuid::new_v4(),
            name: "private-name-do-not-export".into(),
            recording_started_at: "2026-10-14T08:00:00Z".parse().unwrap(),
            pin_token: Uuid::new_v4(),
        },
    }
}
