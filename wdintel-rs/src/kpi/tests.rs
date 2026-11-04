use super::{configure, history, types::KpiPeriod};
use crate::entities::login;
use crate::functest::tests::{
    cleanup_locked, find_test_signal_group, mk_login, mk_sigint_important,
    mk_sigint_inbox_item,
};
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::web;
use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseBackend, Set, Statement};

// https://github.com/echoua/echo/issues/3826
#[test]
fn presets_tolerate_bounded_browser_clock_skew() {
    let until = Utc::now() + Duration::seconds(60);
    for days in [7, 30, 90] {
        assert!(KpiPeriod {
            since: (until - Duration::days(days)).timestamp_millis(),
            until: until.timestamp_millis(),
        }
        .bounds()
        .is_ok());
    }
    let until = Utc::now()
        + Duration::seconds(crate::config::KPI_MAX_CLOCK_SKEW_SECONDS + 60);
    assert!(KpiPeriod {
        since: (until - Duration::days(7)).timestamp_millis(),
        until: until.timestamp_millis(),
    }
    .bounds()
    .is_err());
}

// https://github.com/echoua/echo/issues/3826
#[tokio::test]
async fn retained_history_uses_half_open_periods_and_valid_duration_samples(
) -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let author = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set("kpi-history-author".into()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let until =
        DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    let since = until - Duration::days(7);
    let period = KpiPeriod {
        since: since.timestamp_millis(),
        until: until.timestamp_millis(),
    };
    env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres, r#"
        insert into report_history (report_kind, requested_by_login_id, request, created_at, status, retry_count, started_at, completed_at, log)
        values ('kpi', $1, '{}', $2, 'done', 3, $2, $2 + interval '10 seconds', '[]'),
            ('kpi', $1, '{}', $2 + interval '1 day', 'done', 0, $2 + interval '1 day', $2 + interval '1 day 30 seconds', '[]'),
            ('kpi', $1, '{}', $2 + interval '2 days', 'done', 0, $2 + interval '2 days', $2, '[]'),
            ('kpi', $1, '{}', $2, 'failed', 0, null, null, '[]'),
            ('kpi', $1, '{}', $3, 'done', 0, null, null, '[]')
    "#, [author.id.into(), since.naive_utc().into(), until.naive_utc().into()])).await.c(h!())?;
    seed_report_provenance(&env, author.id, since)
        .await
        .c(h!())?;
    let result = history::reports(&env, &period).await.c(h!())?;
    assert_eq!((result.total, result.done, result.failed), (7, 6, 1));
    assert_eq!(result.by_author.len(), 1);
    assert_eq!(result.by_author[0].count, 6);
    assert_eq!(result.by_kind[0].count, 6);
    assert_eq!(result.by_day.iter().map(|row| row.count).sum::<i64>(), 6);
    assert_eq!(
        (result.generation.samples, result.generation.excluded),
        (2, 4)
    );
    assert_eq!(result.generation.median_seconds, Some(20.0));
    assert_eq!(result.generation.p90_seconds, Some(28.0));
    let notifications = history::notifications(&env, &period).await.c(h!())?;
    assert_eq!(notifications.total, 0);
    assert_eq!(notifications.transport.median_seconds, None);
    seed_notification_deliveries(&env, author.id, since)
        .await
        .c(h!())?;
    let notifications = history::notifications(&env, &period).await.c(h!())?;
    assert_eq!(notifications.total, 3);
    assert_eq!(
        (
            notifications.transport.samples,
            notifications.transport.excluded
        ),
        (1, 1)
    );
    assert_eq!(notifications.transport.median_seconds, Some(10.0));
    assert_eq!(
        notifications
            .by_status
            .iter()
            .map(|row| row.count)
            .sum::<i64>(),
        3
    );
    assert_history_metrics(&env, until).await.c(h!())?;
    assert!(KpiPeriod {
        since: period.until,
        until: period.since
    }
    .bounds()
    .is_err());
    assert!(KpiPeriod {
        since: period.since,
        until: (since + Duration::days(91)).timestamp_millis()
    }
    .bounds()
    .is_err());
    Ok(())
}

async fn assert_history_metrics(
    env: &Env,
    until: DateTime<Utc>,
) -> anyhow::Result<()> {
    use crate::config::*;
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    super::metrics::collect(env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    for (name, labels, expected) in [
        (
            KPI_METRICS_REPORTS,
            vec![("window", "7d"), ("status", "done")],
            6.0,
        ),
        (
            KPI_METRICS_REPORTS,
            vec![("window", "7d"), ("status", "failed")],
            1.0,
        ),
        (
            KPI_METRICS_REPORTS,
            vec![("window", "all"), ("status", "done")],
            8.0,
        ),
        (
            KPI_METRICS_REPORT_DURATION,
            vec![("window", "7d"), ("statistic", "median")],
            20.0,
        ),
        (
            KPI_METRICS_REPORT_SAMPLES,
            vec![("window", "7d"), ("outcome", "excluded")],
            4.0,
        ),
        (
            KPI_METRICS_NOTIFICATIONS,
            vec![("window", "7d"), ("status", "sent")],
            2.0,
        ),
        (
            KPI_METRICS_NOTIFICATION_DURATION,
            vec![("window", "7d"), ("statistic", "median")],
            10.0,
        ),
        (
            KPI_METRICS_AVAILABLE,
            vec![("source", "activity"), ("window", "7d")],
            0.0,
        ),
        (
            KPI_METRICS_AVAILABLE,
            vec![("source", "requests"), ("window", "7d")],
            0.0,
        ),
    ] {
        assert_eq!(
            recorder.gauge_f64_value(name, &labels),
            Some(expected),
            "{name}"
        );
    }
    assert!(recorder.find(KPI_METRICS_ACTIVITY).is_none());
    assert!(recorder.find(KPI_METRICS_API_RESPONSES).is_none());
    Ok(())
}

// https://github.com/echoua/echo/issues/3826
#[tokio::test]
async fn report_metric_totals_survive_dashboard_author_limit(
) -> anyhow::Result<()> {
    use crate::config::*;
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let until =
        DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    let count = (KPI_HISTORY_MAX_GROUPS + 1) as i64;
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                with authors as (
                    insert into login (id, login, roles)
                    select gen_random_uuid(), 'kpi-limit-' || n, '[]'::jsonb
                    from generate_series(1, $1::bigint) n returning id
                )
                insert into report_history
                    (report_kind, requested_by_login_id, request, status, created_at)
                select 'kpi-limit', id, '{}', 'done', $2::timestamp - interval '1 day'
                from authors
            "#,
            [count.into(), until.naive_utc().into()],
        ))
        .await
        .c(h!())?;
    let period = KpiPeriod {
        since: (until - Duration::days(7)).timestamp_millis(),
        until: until.timestamp_millis(),
    };
    assert!(history::reports(&env, &period).await.is_err());
    let (metrics, recorder) = crate::telemetry::Metrics::recording(&env.config);
    super::metrics::collect(&env, &metrics.kpi, until).await;
    metrics.force_flush_for_test();
    for (_, window) in KPI_METRICS_PERIODS {
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_REPORTS,
                &[("window", window), ("status", "done")]
            ),
            Some(count as f64)
        );
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_AVAILABLE,
                &[("source", "reports"), ("window", window)]
            ),
            Some(1.0)
        );
    }
    Ok(())
}

async fn seed_report_provenance(
    env: &Env,
    author_id: uuid::Uuid,
    since: DateTime<Utc>,
) -> anyhow::Result<()> {
    env.dbx
        .execute_unprepared(
            r#"
        with task as (
            insert into bgtask (progress, loglines, running)
            values (100, '[]', false) returning id
        )
        update report_history set bgtask_id = task.id from task;
    "#,
        )
        .await
        .c(h!())?;
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
        insert into log_users_report_generation
            (id, login_id, report_query, report_path, created_at)
        values (42, $1, '{}', 'legacy', $2), (43, $1, '{}', 'unreconciled', $2);
    "#,
            [author_id.into(), since.naive_utc().into()],
        ))
        .await
        .c(h!())?;
    env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres, r#"
        insert into report_history (report_kind, requested_by_login_id, request, created_at,
            status, started_at, completed_at, bgtask_id, legacy_log_id, legacy_report_path)
        values ('kpi', $1, '{}', $2, 'done', $2, $2, null, null, null),
            ('kpi', $1, '{}', $2, 'done', $2, $2 + interval '300 seconds', null, null, 'archive'),
            ('kpi', $1, '{}', $2, 'done', $2, $2 + interval '500 seconds',
                (select max(id) from bgtask), 42, 'legacy'),
            ('kpi', $1, '{}', $2 - interval '1 millisecond', 'done', null, null, null, null, null);
    "#, [author_id.into(), since.naive_utc().into()])).await.c(h!())?;
    Ok(())
}

async fn sign_in(
    request: actix_web::HttpRequest,
    login: web::Path<String>,
) -> actix_web::HttpResponse {
    use actix_web::HttpMessage;
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    actix_web::HttpResponse::NoContent().finish()
}

#[actix_web::test]
async fn kpi_endpoints_require_admin_before_reading_any_source(
) -> anyhow::Result<()> {
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{cookie::Key, http::StatusCode, test, App};
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).c(h!())?)
            .await
            .c(h!())?;
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .route("/test/login/{login}", web::post().to(sign_in))
            .configure(configure),
    )
    .await;
    let regular = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Rer"])),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["Admin"])),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    for (login, expected) in [
        (regular.id, StatusCode::FORBIDDEN),
        (admin.id, StatusCode::BAD_REQUEST),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test/login/{login}"))
                .to_request(),
        )
        .await;
        let cookie = response.response().cookies().next().unwrap().into_owned();
        for path in ["reports", "notifications", "activity", "requests"] {
            let uri = format!("/api/kpi/{path}");
            let period = KpiPeriod { since: 1, until: 0 };
            let anonymous = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&uri)
                    .set_json(&period)
                    .to_request(),
            )
            .await;
            assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&uri)
                    .cookie(cookie.clone())
                    .set_json(&period)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), expected, "{uri}");
        }
    }
    Ok(())
}

async fn seed_notification_deliveries(
    env: &Env,
    author_id: uuid::Uuid,
    since: DateTime<Utc>,
) -> anyhow::Result<()> {
    let message = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .c(h!())?;
    let important = mk_sigint_important(
        &env.dbx,
        crate::entities::sigint_important::ActiveModel {
            signal_message_id: Set(message.id),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let group = find_test_signal_group(&env.dbx).await.c(h!())?;
    let event = uuid::Uuid::now_v7();
    env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "insert into notification_event (id, operation_id, actor_login_id, signal_message_id, sigint_important_id, group_master_key) values ($1,$2,$3,$4,$5,$6)",
        [event.into(), uuid::Uuid::now_v7().into(), author_id.into(), message.id.into(), important.id.into(), group.master_key.into()]
    )).await.c(h!())?;
    for (offset, status, seconds) in [
        (0, "sent", Some(10_i64)),
        (1, "sent", Some(-1)),
        (2, "failed", None),
        (7, "sent", Some(100)),
    ] {
        let recipient = mk_login(&env.dbx, Default::default()).await.c(h!())?;
        let receipt = uuid::Uuid::now_v7();
        env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "insert into notification_receipt (id,event_id,recipient_login_id) values ($1,$2,$3)",
            [receipt.into(), event.into(), recipient.id.into()]
        )).await.c(h!())?;
        env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "insert into messenger_alert_delivery (id,receipt_id,recipient_login_id,recipient_profile_id,message_url,status,created_at,sent_at) values ($1,$2,$3,'kpi-test','/test',$4,$5,$6)",
            [uuid::Uuid::now_v7().into(),receipt.into(),recipient.id.into(),status.into(),(since + Duration::days(offset)).naive_utc().into(),seconds.map(|seconds| (since + Duration::days(offset) + Duration::seconds(seconds)).naive_utc()).into()]
        )).await.c(h!())?;
    }
    Ok(())
}
