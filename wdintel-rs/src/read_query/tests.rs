use super::*;
use sea_orm::TransactionTrait;

async fn test_pool(env: &crate::types::Env, size: u32) -> DatabaseConnection {
    crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_conn_string(&env.config),
        size,
    )
    .await
    .unwrap()
}

async fn active(db: &DatabaseConnection, pid: i32) -> bool {
    db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND wait_event='PgSleep') AS active", [pid.into()]))
        .await.unwrap().unwrap().try_get("", "active").unwrap()
}

async fn assert_cancelled_read(transaction: bool) {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let db = test_pool(&env, 1).await;
    let pid: i32 = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT pg_backend_pid() AS pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let reader = db.clone();
    let running = tokio::spawn(async move {
        scope(
            uuid::Uuid::new_v4().to_string(),
            vec![pool_identity(&reader)],
            async {
                let statement = Statement::from_string(
                    DbBackend::Postgres,
                    format!(
                        "SELECT pg_sleep(30) {ANALYSIS_SOURCE_SEARCH_SQL_HINT}"
                    ),
                );
                if transaction {
                    let read = begin(&reader).await.unwrap();
                    read.query_one_raw(statement).await.unwrap();
                    read.commit().await.unwrap();
                } else {
                    connection(&reader).query_one_raw(statement).await.unwrap();
                }
            },
        )
        .await;
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !active(&env.dbx, pid).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let observer = env.dbx.clone();
    let unrelated = tokio::spawn(async move {
        observer
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "SELECT pg_sleep(0.2), 42 AS value",
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i32>("", "value")
            .unwrap()
    });
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), async {
        while active(&env.dbx, pid).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let next = db
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "SELECT pg_sleep(0.1),7 AS value",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.try_get::<i32>("", "value").unwrap(), 7);
    })
    .await
    .unwrap();
    assert_eq!(unrelated.await.unwrap(), 42);
    db.close().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn cancelled_source_query_releases_pool_without_cancelling_other_work_3780(
) {
    assert_cancelled_read(false).await;
}

#[tokio::test]
#[serial_test::serial]
async fn cancelled_source_page_transaction_releases_pool_3780() {
    assert_cancelled_read(true).await;
}

#[tokio::test]
#[serial_test::serial]
async fn scoped_source_settings_and_failures_do_not_leak_into_reused_pool_3780()
{
    let env = crate::functest::tests::cleanup().await.unwrap();
    let db = test_pool(&env, 1).await;
    let baseline: String = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT current_setting('jit') AS jit",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "jit")
        .unwrap();
    let row = scope(uuid::Uuid::new_v4().to_string(), vec![pool_identity(&db)], async {
        connection(&db).query_one_raw(Statement::from_string(DbBackend::Postgres, format!("SELECT current_setting('jit') AS jit {ANALYSIS_SOURCE_SEARCH_SQL_HINT}"))).await.unwrap().unwrap()
    }).await;
    assert_eq!(row.try_get::<String>("", "jit").unwrap(), "off");
    let failed = scope(
        uuid::Uuid::new_v4().to_string(),
        vec![pool_identity(&db)],
        async {
            connection(&db)
                .query_one_raw(Statement::from_string(
                    DbBackend::Postgres,
                    format!("SELECT 1/0 {ANALYSIS_SOURCE_SEARCH_SQL_HINT}"),
                ))
                .await
        },
    )
    .await;
    assert!(failed.is_err());
    let next = tokio::time::timeout(
        Duration::from_secs(3),
        db.query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT current_setting('jit') AS jit,42 AS value",
        )),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(next.try_get::<String>("", "jit").unwrap(), baseline);
    assert_eq!(next.try_get::<i32>("", "value").unwrap(), 42);
    db.close().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn source_read_admission_keeps_capacity_for_another_login_3780() {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let db = test_pool(&env, 4).await;
    let lock = uuid::Uuid::new_v4().as_u128() as i64;
    let blocker = env.dbx.begin().await.unwrap();
    blocker
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_xact_lock($1)",
            [lock.into()],
        ))
        .await
        .unwrap();
    let login = uuid::Uuid::new_v4();
    let marker = format!("3780_fair_{}", uuid::Uuid::new_v4().simple());
    let mut readers = Vec::new();
    for _ in 0..3 {
        let reader = db.clone();
        let statement = Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("SELECT pg_advisory_xact_lock_shared($1) /* {marker} */"),
            [lock.into()],
        );
        readers.push(tokio::spawn(async move {
            scope(
                uuid::Uuid::new_v4().to_string(),
                vec![pool_identity(&reader)],
                async {
                    set_login(login);
                    connection(&reader).query_one_raw(statement).await.unwrap();
                },
            )
            .await;
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row = env.dbx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "SELECT count(*) AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE $1", [format!("%{marker}%").into()]))
                .await.unwrap().unwrap();
            if row.try_get::<i64>("", "count").unwrap()==2 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let other = scope(
        uuid::Uuid::new_v4().to_string(),
        vec![pool_identity(&db)],
        async {
            set_login(uuid::Uuid::new_v4());
            connection(&db)
                .query_one_raw(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT 42 AS value",
                ))
                .await
                .unwrap()
                .unwrap()
        },
    );
    let row = tokio::time::timeout(Duration::from_secs(3), other)
        .await
        .unwrap();
    assert_eq!(row.try_get::<i32>("", "value").unwrap(), 42);
    assert!(readers.iter().all(|reader| !reader.is_finished()));
    blocker.rollback().await.unwrap();
    for reader in readers {
        reader.await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
// #4222: id-bounded reads (a message opened by id, candidate hydration) skip
// the slots too, so they cannot wait behind the login's heavy stats reads.
async fn bounded_reads_skip_source_admission_3978_4222() {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let db = test_pool(&env, 4).await;
    let lock = uuid::Uuid::new_v4().as_u128() as i64;
    let blocker = env.dbx.begin().await.unwrap();
    blocker
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_xact_lock($1)",
            [lock.into()],
        ))
        .await
        .unwrap();
    let login = uuid::Uuid::new_v4();
    let marker = format!("3978_tail_{}", uuid::Uuid::new_v4().simple());
    let mut readers = Vec::new();
    for _ in 0..ANALYSIS_SOURCE_READ_MAX_PER_LOGIN {
        let reader = db.clone();
        let statement = Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("SELECT pg_advisory_xact_lock_shared($1) /* {marker} */"),
            [lock.into()],
        );
        readers.push(tokio::spawn(async move {
            scope(
                uuid::Uuid::new_v4().to_string(),
                vec![pool_identity(&reader)],
                async {
                    set_login(login);
                    connection(&reader).query_one_raw(statement).await.unwrap();
                },
            )
            .await;
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row = env.dbx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "SELECT count(*) AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE $1", [format!("%{marker}%").into()]))
                .await.unwrap().unwrap();
            if row.try_get::<i64>("", "count").unwrap() as usize == ANALYSIS_SOURCE_READ_MAX_PER_LOGIN { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let select =
        || Statement::from_string(DbBackend::Postgres, "SELECT 42 AS value");
    let (admitted, tail, id_bounded) = scope(
        uuid::Uuid::new_v4().to_string(),
        vec![pool_identity(&db)],
        async {
            set_login(login);
            let admitted = tokio::time::timeout(
                Duration::from_millis(500),
                connection(&db).query_one_raw(select()),
            )
            .await;
            let tail = tokio::time::timeout(
                Duration::from_secs(3),
                fresh_tail_connection(&db).query_one_raw(select()),
            )
            .await;
            let id_bounded = tokio::time::timeout(
                Duration::from_secs(3),
                id_bounded_connection(&db).query_one_raw(select()),
            )
            .await;
            (admitted.is_err(), tail, id_bounded)
        },
    )
    .await;
    assert!(admitted, "an ordinary read must wait for the login's slots");
    for row in [tail, id_bounded] {
        let row = row.unwrap().unwrap().unwrap();
        assert_eq!(row.try_get::<i32>("", "value").unwrap(), 42);
    }
    assert!(readers.iter().all(|reader| !reader.is_finished()));
    blocker.rollback().await.unwrap();
    for reader in readers {
        reader.await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn search_statement_budget_does_not_leak_to_ordinary_reads_3780() {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let mut config = env.config.clone();
    config.postgres_runtime = Some(PostgresRuntimeConfig {
        statement_timeout_ms: 20,
        search_statement_timeout_ms: 200,
        search_http_timeout_ms: 1_000,
        report_worker_statement_timeout_ms: 20,
        lock_timeout_ms: 15,
        idle_in_transaction_session_timeout_ms: 1_000,
    });
    let db = crate::new_pg_runtime_pool_from_config(
        &config,
        crate::PgRuntimePoolRole::Web,
    )
    .await
    .unwrap();
    scope(
        "search-budget-3780".into(),
        vec![pool_identity(&db)],
        async {
            configure_search_timeouts(SearchTimeouts {
                statement_ms: 200,
                http_ms: 1_000,
            });
            set_search(&Some("needle".into()));
            connection(&db)
                .query_one_raw(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT pg_sleep(0.05)",
                ))
                .await
                .unwrap();
        },
    )
    .await;
    let setting = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT current_setting('statement_timeout') AS timeout",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "timeout")
        .unwrap();
    assert_eq!(setting, "20ms");
    scope(
        "ordinary-budget-3780".into(),
        vec![pool_identity(&db)],
        async {
            let error = connection(&db)
                .query_one_raw(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT pg_sleep(0.05)",
                ))
                .await
                .unwrap_err();
            assert!(is_statement_timeout(&anyhow::Error::new(error)));
        },
    )
    .await;
}

#[tokio::test]
#[serial_test::serial]
async fn historical_counts_leave_read_capacity_for_pages_3780() {
    let env = crate::functest::tests::cleanup().await.unwrap();
    let db = test_pool(&env, 4).await;
    let login = uuid::Uuid::new_v4();
    let available = SOURCE_READS.available_permits();
    let mut counts = Vec::new();
    for _ in 0..ANALYSIS_SOURCE_COUNT_MAX_PER_LOGIN {
        let reader = db.clone();
        counts.push(tokio::spawn(async move {
            scope(
                "count-lane-3780".into(),
                vec![pool_identity(&reader)],
                async {
                    set_count_request();
                    set_login(login);
                    set_search(&Some("needle".into()));
                    let _operation = acquire_count_operation().await.unwrap();
                    connection(&reader)
                        .query_one_raw(Statement::from_string(
                            DbBackend::Postgres,
                            "SELECT pg_sleep(30) /* count_lane_3780 */",
                        ))
                        .await
                },
            )
            .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let active = env.dbx.query_one_raw(Statement::from_string(DbBackend::Postgres,
                "SELECT COUNT(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query LIKE 'SELECT pg_sleep(30) /* count_lane_3780 */%'",
            )).await.unwrap().unwrap().try_get::<i64>("", "count").unwrap();
            if active == ANALYSIS_SOURCE_COUNT_MAX_PER_LOGIN as i64 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    scope(
        "queued-count-3780".into(),
        vec![pool_identity(&db)],
        async {
            set_login(login);
            set_count_request();
            set_search(&Some("needle".into()));
            assert!(tokio::time::timeout(
                Duration::from_millis(20),
                acquire_count_operation()
            )
            .await
            .is_err());
        },
    )
    .await;
    for search_count in [false, true] {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            scope("other-read-3780".into(), vec![pool_identity(&db)], async {
                set_login(if search_count {
                    uuid::Uuid::new_v4()
                } else {
                    login
                });
                set_search(&Some("needle".into()));
                if search_count {
                    set_count_request();
                }
                let _operation = if search_count {
                    Some(acquire_count_operation().await.unwrap())
                } else {
                    None
                };
                connection(&db)
                    .query_one_raw(Statement::from_string(
                        DbBackend::Postgres,
                        "SELECT 42::bigint AS value",
                    ))
                    .await
                    .unwrap()
                    .unwrap()
                    .try_get::<i64>("", "value")
                    .unwrap()
            }),
        )
        .await
        .unwrap();
        assert_eq!(result, 42);
    }
    for count in counts {
        count.abort();
        let _ = count.await;
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while SOURCE_READS.available_permits() != available {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

fn is_statement_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        let Some(DbErr::Query(RuntimeErr::SqlxError(error))) = error.downcast_ref::<DbErr>() else {
            return false;
        };
        matches!(error.as_ref(), sqlx::Error::Database(error)
            if error.code().as_deref() == Some("57014") && error.message().contains("statement timeout"))
    })
}
