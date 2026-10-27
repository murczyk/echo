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
