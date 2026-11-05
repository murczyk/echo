use super::*;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};

// https://github.com/echoua/echo/issues/4034
#[test]
fn unavailable_expired_and_removed_sources_do_not_reexport_healthy_values() {
    let config = crate::config::read_config(crate::types::Mode::Test).unwrap();
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&config);
    let now = Utc::now().timestamp_millis();
    let labels = [KeyValue::new("mountpoint", "/")];
    let mut snapshot = Snapshot::default();
    snapshot.integer(OPERATIONAL_METRICS_ROOT_BYTES, 0, &labels);
    metrics.operational.publish("filesystem", now, Ok(snapshot));
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_ROOT_BYTES, &[]),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_AVAILABLE, &[]),
        Some(1)
    );
    metrics.operational.publish(
        "filesystem",
        now + 1,
        Err(anyhow::anyhow!("filesystem unavailable")),
    );
    metrics.force_flush_for_test();
    assert!(recorder.find(OPERATIONAL_METRICS_ROOT_BYTES).is_none());
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_AVAILABLE, &[]),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_f64_value(OPERATIONAL_METRICS_UPDATED_AT, &[]),
        Some(now as f64 / 1_000.0)
    );
    let mut snapshot = Snapshot::default();
    snapshot.integer(OPERATIONAL_METRICS_ROOT_BYTES, 123, &labels);
    metrics.operational.publish("filesystem", now, Ok(snapshot));
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_ROOT_BYTES, &[]),
        Some(123)
    );
    let mut snapshot = Snapshot::default();
    snapshot.integer(OPERATIONAL_METRICS_ROOT_BYTES, 123, &labels);
    metrics.operational.publish(
        "filesystem",
        now - (OPERATIONAL_METRICS_MAX_AGE_SECS * 1_000) as i64,
        Ok(snapshot),
    );
    metrics.force_flush_for_test();
    assert!(recorder.find(OPERATIONAL_METRICS_ROOT_BYTES).is_none());
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_AVAILABLE, &[]),
        Some(0)
    );
    metrics
        .operational
        .publish("filesystem", now, Ok(Snapshot::default()));
    metrics.force_flush_for_test();
    assert!(recorder.find(OPERATIONAL_METRICS_ROOT_BYTES).is_none());
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_AVAILABLE, &[]),
        Some(1)
    );
}

async fn seed_account(
    db: &DatabaseConnection,
    now: chrono::DateTime<Utc>,
) -> anyhow::Result<(i32, i64)> {
    let row = db.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres, r#"
        with a as (
            insert into echo_account (source, phone_number, is_linked, created_at, linked_at, synced_at)
            values ('signal', $2, true, $1, $1, $1) returning id
        ), c as (
            insert into echo_client (name, created_at, deleted)
            values ($2, $1, false) returning id
        ), l as (
            insert into echo_client_lock (account_id, client_id, created_at, remove_requested)
            select a.id, c.id, $1, false from a, c returning id
        ) select a.id as account_id, l.id as lock_id from a, l
    "#, [now.naive_utc().into(), uuid::Uuid::new_v4().simple().to_string()[..20].to_owned().into()])).await.c(h!())?.c(h!())?;
    let account_id: i32 = row.try_get("", "account_id").c(h!())?;
    let lock_id: i32 = row.try_get("", "lock_id").c(h!())?;
    let datasource = crate::functest::tests::mk_datasource(
        db,
        crate::entities::datasource::ActiveModel {
            kind: sea_orm::Set("signal".to_string()),
            echo_client_lock_id: sea_orm::Set(Some(i64::from(lock_id))),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    Ok((account_id, datasource.id))
}

async fn update_account(
    db: &DatabaseConnection,
    account_id: i32,
    sql: &str,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [account_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

// https://github.com/echoua/echo/issues/4034
#[tokio::test]
#[serial_test::serial]
async fn datasource_freshness_matches_monitoring_and_tracks_account_lifecycle(
) -> anyhow::Result<()> {
    let (env, _guard) =
        crate::functest::tests::cleanup_locked().await.c(h!())?;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    let now = Utc::now();
    let (account_id, datasource_id) =
        seed_account(&env.dbx, now).await.c(h!())?;
    let datasource_id = datasource_id.to_string();
    let account_id_label = account_id.to_string();
    let labels = [("datasource_id", datasource_id.as_str())];
    for (sql, expected_age) in [
        (
            r#"update echo_account set synced_at = null where id = $1"#,
            7.0 * 86_400.0,
        ),
        (
            r#"update echo_account set synced_at = linked_at - interval '1 hour', is_linked = false where id = $1"#,
            600.0,
        ),
        (
            r#"update echo_account set synced_at = linked_at - interval '1 hour', is_linked = true where id = $1"#,
            3_600.0,
        ),
        (
            r#"insert into echo_inbox_message (account_id, body, created_at, updated_at, seen, deleted)
            select id, 'not a metric label', linked_at - interval '1 day', linked_at, false, false from echo_account where id = $1"#,
            3_600.0,
        ),
        (
            r#"insert into echo_inbox_message (account_id, body, created_at, updated_at, seen, deleted)
            select id, 'not a metric label', linked_at + interval '1 second', linked_at, false, false from echo_account where id = $1"#,
            0.0,
        ),
        (
            r#"update echo_account set linked_at = linked_at + interval '1 hour' where id = $1"#,
            3_600.0,
        ),
    ] {
        update_account(&env.dbx, account_id, sql).await.c(h!())?;
        collect::collect(&env, &metrics.operational, now).await;
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_f64_value(OPERATIONAL_METRICS_ACTIVITY_AGE, &labels),
            Some(expected_age)
        );
        let monitoring = echo_im::collect_monitoring_data_at(&env.dbx, now)
            .await
            .c(h!())?;
        let selected = monitoring
            .iter()
            .find(|row| row.account_id == account_id)
            .unwrap()
            .activity_at_ms();
        assert_eq!(
            expected_age,
            now.timestamp_millis().saturating_sub(selected).max(0) as f64
                / 1_000.0
        );
    }
    update_account(
        &env.dbx,
        account_id,
        r#"update echo_account set is_linked = false where id = $1"#,
    )
    .await
    .c(h!())?;
    collect::collect(&env, &metrics.operational, now).await;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_ACCOUNT_LINKED, &labels),
        Some(0)
    );
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"update datasource set status = 'paused' where id = $1"#,
            [datasource_id.parse::<i64>().c(h!())?.into()],
        ))
        .await
        .c(h!())?;
    collect::collect(&env, &metrics.operational, now).await;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_ACCOUNT_ACTIVE, &labels),
        Some(0)
    );
    let mut failed_env = env.as_ref().clone();
    failed_env.dbx = DatabaseConnection::default();
    collect::collect(&failed_env, &metrics.operational, now).await;
    metrics.force_flush_for_test();
    assert!(recorder.find(OPERATIONAL_METRICS_ACCOUNT_LINKED).is_none());
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_AVAILABLE,
            &[("source", "accounts")]
        ),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_AVAILABLE,
            &[("source", "filesystem")]
        ),
        Some(1)
    );
    collect::collect(&env, &metrics.operational, now).await;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(OPERATIONAL_METRICS_ACCOUNT_LINKED, &labels),
        Some(0)
    );
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"update datasource set deleted = true where id = $1"#,
            [datasource_id.parse::<i64>().c(h!())?.into()],
        ))
        .await
        .c(h!())?;
    collect::collect(&env, &metrics.operational, now).await;
    metrics.force_flush_for_test();
    assert!(recorder
        .find_with_attributes(OPERATIONAL_METRICS_ACTIVITY_AGE, &labels)
        .is_none());
    assert!(recorder
        .find_with_attributes(OPERATIONAL_METRICS_DATASOURCE_ACTIVE, &labels)
        .is_none());
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_ACCOUNT_ACTIVE,
            &[("account_id", account_id_label.as_str())]
        ),
        Some(0)
    );
    let account = recorder
        .find_with_attributes(
            OPERATIONAL_METRICS_ACCOUNT_LINKED,
            &[("account_id", account_id_label.as_str())],
        )
        .unwrap();
    assert!(!account.attributes.contains_key("datasource_id"));
    assert!(account.attributes.keys().all(|key| [
        "source",
        "messenger",
        "account_id",
        "client_id"
    ]
    .contains(&key.as_str())));
    Ok(())
}

#[derive(Debug)]
struct Collector(tokio::sync::mpsc::UnboundedSender<opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest>);

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsService for Collector {
    async fn export(
        &self,
        request: tonic::Request<opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest>,
    ) -> Result<tonic::Response<opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse>, tonic::Status> {
        self.0.send(request.into_inner()).unwrap();
        Ok(tonic::Response::new(opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse::default()))
    }
}

// https://github.com/echoua/echo/issues/4034
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn operational_otlp_export_uses_existing_config_and_filters_sensitive_attributes(
) {
    use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsServiceServer;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let server = tokio::spawn(
        tonic::transport::Server::builder().serve_with_incoming_shutdown(
            MetricsServiceServer::new(Collector(sender)),
            tokio_stream::wrappers::TcpListenerStream::new(listener),
            cancel.clone().cancelled_owned(),
        ),
    );
    let mut config =
        crate::config::read_config(crate::types::Mode::Test).unwrap();
    config.signoz_metrics_enabled = Some(true);
    config.signoz_metrics_endpoint = Some("http://[invalid]".to_string());
    assert!(crate::telemetry::Metrics::from_config(&config).is_none());
    config.signoz_metrics_endpoint = Some(endpoint);
    let metrics = crate::telemetry::Metrics::from_config(&config).unwrap();
    let mut snapshot = Snapshot::default();
    snapshot.integer(
        OPERATIONAL_METRICS_ROOT_BYTES,
        42,
        &[
            KeyValue::new("mountpoint", "/"),
            KeyValue::new("phone_number", "not-exported-phone"),
            KeyValue::new("credentials", "not-exported-credentials"),
        ],
    );
    metrics.operational.publish(
        "filesystem",
        Utc::now().timestamp_millis(),
        Ok(snapshot),
    );
    SignalObserver {
        metrics: metrics.clone(),
        client_id: Some(23),
        account_id: Some("7".to_string()),
        datasource_id: 41,
    }
    .record(SignalError {
        operation: SignalOperation::Receive,
        account_id: Some(7),
        kind: SignalErrorKind::Timeout,
    });
    metrics.force_flush_for_test();
    let request = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    let payload = format!("{request:?}");
    assert!(!payload.contains("not-exported"));
    let names = request
        .resource_metrics
        .iter()
        .flat_map(|resource| &resource.scope_metrics)
        .flat_map(|scope| &scope.metrics)
        .map(|metric| metric.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&OPERATIONAL_METRICS_ROOT_BYTES));
    assert!(names.contains(&OPERATIONAL_METRICS_AVAILABLE));
    assert!(names.contains(&OPERATIONAL_METRICS_REPORT_TIMEOUTS));
    assert!(names.contains(&OPERATIONAL_METRICS_ERRORS));
    assert!(payload.contains("client_id"));
    assert!(payload.contains("account_id"));
    assert!(payload.contains("datasource_id"));
    metrics.shutdown();
    cancel.cancel();
    server.await.unwrap().unwrap();
}

// https://github.com/echoua/echo/issues/4034
#[tokio::test]
#[serial_test::serial]
async fn operational_collection_cancels_blocked_queries_and_times_out_sources(
) -> anyhow::Result<()> {
    let (env, _guard) =
        crate::functest::tests::cleanup_locked().await.c(h!())?;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    let mut env = env.as_ref().clone();
    env.metrics = Some(metrics.clone());
    let lock = env.dbx.begin().await.c(h!())?;
    lock.execute_unprepared("LOCK TABLE echo_account IN ACCESS EXCLUSIVE MODE")
        .await
        .c(h!())?;
    let env = Arc::new(env);
    let cancel = CancellationToken::new();
    let worker = tokio::spawn(run(env.clone(), cancel.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            metrics.force_flush_for_test();
            if recorder.find(OPERATIONAL_METRICS_ROOT_BYTES).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .c(h!())?;
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .c(h!())?
        .c(h!())?;
    tokio::time::timeout(
        Duration::from_secs(OPERATIONAL_METRICS_TIMEOUT_SECS + 5),
        collect::collect(&env, &metrics.operational, Utc::now()),
    )
    .await
    .c(h!())?;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_AVAILABLE,
            &[("source", "accounts")]
        ),
        Some(0)
    );
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_AVAILABLE,
            &[("source", "filesystem")]
        ),
        Some(1)
    );
    lock.rollback().await.c(h!())?;
    collect::collect(&env, &metrics.operational, Utc::now()).await;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_value(
            OPERATIONAL_METRICS_AVAILABLE,
            &[("source", "accounts")]
        ),
        Some(1)
    );
    Ok(())
}
