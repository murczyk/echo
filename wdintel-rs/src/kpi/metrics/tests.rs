use super::*;
use crate::functest::tests::{cleanup_locked, mk_login};
use crate::telemetry::metrics::MetricsRecorder;
use crate::telemetry::Metrics;

// https://github.com/echoua/echo/issues/3826
#[tokio::test]
#[serial_test::serial]
async fn account_recency_uses_time_after_loading_accounts() -> anyhow::Result<()>
{
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let until = Utc::now() - chrono::Duration::minutes(1);
    let (metrics, recorder) = Metrics::recording(&env.config);
    collect_current(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    let baseline = recorder
        .gauge_f64_value(
            KPI_METRICS_ACCOUNT_RECENCY,
            &[("scope", "active"), ("recency", "recent")],
        )
        .unwrap();
    for last_active_at in [Utc::now(), Utc::now() + chrono::Duration::days(1)] {
        mk_login(
            &env.dbx,
            crate::entities::login::ActiveModel {
                last_active_at: sea_orm::Set(Some(last_active_at.naive_utc())),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
    }
    collect_current(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    assert_eq!(
        recorder.gauge_f64_value(
            KPI_METRICS_ACCOUNT_RECENCY,
            &[("scope", "active"), ("recency", "recent")]
        ),
        Some(baseline + 1.0)
    );
    assert_eq!(
        recorder.gauge_f64_value(
            KPI_METRICS_ACCOUNT_RECENCY,
            &[("scope", "active"), ("recency", "invalid")]
        ),
        Some(1.0)
    );
    Ok(())
}

// https://github.com/echoua/echo/issues/3826
#[tokio::test]
#[serial_test::serial]
async fn observation_exports_reconcile_windows_and_clear_failed_sources(
) -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let pool = observation_pool(&env).await.c(h!())?;
    let until =
        DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    seed_observations(&pool, &env.config.public_host, until)
        .await
        .c(h!())?;
    let mut env = env.as_ref().clone();
    env.greptimedb = Arc::new(std::sync::RwLock::new(Some(pool.clone())));
    let (metrics, recorder) = Metrics::recording(&env.config);
    collect(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    assert_observation_windows(&recorder);

    pool.get()
        .await
        .c(h!())?
        .batch_execute("truncate activity_details, activity_page_visit")
        .await
        .c(h!())?;
    collect(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    assert_unavailable_observations(&recorder);

    seed_observations(&pool, &env.config.public_host, until)
        .await
        .c(h!())?;
    pool.get()
        .await
        .c(h!())?
        .batch_execute("drop table activity_details")
        .await
        .c(h!())?;
    collect(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    for (_, window) in KPI_METRICS_PERIODS {
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_AVAILABLE,
                &[("source", "requests"), ("window", window)]
            ),
            Some(0.0)
        );
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_AVAILABLE,
                &[("source", "activity"), ("window", window)]
            ),
            Some(1.0)
        );
    }
    assert!(recorder.find(KPI_METRICS_API_RESPONSES).is_none());
    Ok(())
}

async fn observation_pool(
    env: &Env,
) -> anyhow::Result<deadpool_postgres::Pool> {
    let mut config = env.config.clone();
    config.greptime_host = config.pg_host.clone();
    config.greptime_port = config.pg_port;
    config.greptime_user = config.pg_user.clone();
    config.greptime_password = config.pg_password.clone();
    config.greptime_dbname = std::env::var("TEST_DB_NAME")
        .ok()
        .filter(|name| !name.is_empty())
        .or(config.pg_dbname.clone());
    let pool = crate::new_greptimedb_from_config(&config).await.c(h!())?;
    pool.resize(1);
    pool.get()
        .await
        .c(h!())?
        .batch_execute(
            r#"
        create temporary table activity_details (
            ts timestamp, request_id text, response_status integer,
            event_type text, request_hostname text, request_path text
        );
        create temporary table activity_page_visit (
            ts timestamp, username text, page text, public_host text
        );
        create domain pg_temp.string as text;
    "#,
        )
        .await
        .c(h!())?;
    Ok(pool)
}

async fn seed_observations(
    pool: &deadpool_postgres::Pool,
    host: &str,
    until: DateTime<Utc>,
) -> anyhow::Result<()> {
    let client = pool.get().await.c(h!())?;
    client.execute(r#"
        insert into activity_details
            (ts, request_id, response_status, event_type, request_hostname, request_path)
        select $1::timestamp - age, request_id, status, event, host, path
        from (values
            (interval '1 day', 'ok', 200, 'response', $2, '/api/test'),
            (interval '1 day', 'ok', 200, 'response', $2, '/api/test'),
            (interval '7 days', 'error', 500, 'error', $2, '/api/test'),
            (interval '30 days', 'client', 400, 'response', $2, '/api/test'),
            (interval '90 days', 'created', 201, 'response', $2, '/api/test'),
            (interval '91 days', 'old', 500, 'response', $2, '/api/test'),
            (interval '0 days', 'upper-bound', 500, 'response', $2, '/api/test'),
            (interval '1 day', 'other-host', 500, 'response', 'other-host', '/api/test'),
            (interval '1 day', 'other-path', 500, 'response', $2, '/assets/test'),
            (interval '1 day', 'request', 500, 'request', $2, '/api/test'),
            (interval '1 day', null, 500, 'response', $2, '/api/test'),
            (interval '1 day', 'invalid-status', 600, 'response', $2, '/api/test')
        ) as events(age, request_id, status, event, host, path)
    "#, &[&until.naive_utc(), &host]).await.c(h!())?;
    client.execute(r#"
        insert into activity_page_visit (ts, username, page, public_host)
        select $1::timestamp - age, username, page, host
        from (values
            (interval '7 days', '00000000-0000-0000-0000-000000000001', '/duty', $2),
            (interval '1 day', '00000000-0000-0000-0000-000000000001', '/analysis', $2),
            (interval '30 days', '00000000-0000-0000-0000-000000000002', '/duty', $2),
            (interval '90 days', '00000000-0000-0000-0000-000000000003', '/duty', $2),
            (interval '1 day', 'legacy-name', '/duty', $2),
            (interval '1 day', 'legacy-name', '/analysis', $2),
            (interval '1 day', null, '/duty', $2),
            (interval '0 days', '00000000-0000-0000-0000-000000000004', '/duty', $2),
            (interval '1 day', '00000000-0000-0000-0000-000000000005', '/duty', 'other-host')
        ) as events(age, username, page, host)
    "#, &[&until.naive_utc(), &host]).await.c(h!())?;
    Ok(())
}

fn assert_observation_windows(recorder: &MetricsRecorder) {
    for (window, accounts, errors) in
        [("7d", 1.0, 0.5), ("30d", 2.0, 2.0 / 3.0), ("90d", 3.0, 0.5)]
    {
        for (name, value) in [
            (KPI_METRICS_ACTIVITY, accounts),
            (KPI_METRICS_ACTIVITY_UNMAPPED, 2.0),
            (KPI_METRICS_API_ERROR_RATIO, errors),
        ] {
            assert_eq!(
                recorder.gauge_f64_value(name, &[("window", window)]),
                Some(value),
                "{name} {window}"
            );
        }
        for (status, count) in [
            ("200", Some(1.0)),
            ("500", Some(1.0)),
            ("400", (window != "7d").then_some(1.0)),
            ("201", (window == "90d").then_some(1.0)),
        ] {
            assert_eq!(
                recorder.gauge_f64_value(
                    KPI_METRICS_API_RESPONSES,
                    &[("window", window), ("status", status)]
                ),
                count
            );
        }
    }
}

fn assert_unavailable_observations(recorder: &MetricsRecorder) {
    for (_, window) in KPI_METRICS_PERIODS {
        for source in ["activity", "requests"] {
            assert_eq!(
                recorder.gauge_f64_value(
                    KPI_METRICS_AVAILABLE,
                    &[("source", source), ("window", window)]
                ),
                Some(0.0)
            );
        }
    }
    for name in [
        KPI_METRICS_ACTIVITY,
        KPI_METRICS_API_RESPONSES,
        KPI_METRICS_API_ERROR_RATIO,
    ] {
        assert!(recorder.find(name).is_none(), "{name}");
    }
}
