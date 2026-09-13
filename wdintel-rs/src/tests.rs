#[cfg(test)]
pub mod test {
    // use crate::entities::user;
    use crate::config::{
        AnalyticsConfig, PostgresRuntimeConfig, DEFAULT_PG_DBNAME,
        DEFAULT_PG_HOST, DEFAULT_PG_PASSWORD, DEFAULT_PG_USER,
    };
    use crate::types::Mode;
    use crate::{
        mk_analytics_conn_string, mk_conn_string, new_pg_pool_from_analytics,
        new_pg_runtime_pool_from_config, PgRuntimePoolRole,
    };
    use ctor::ctor;
    use echo_migration::*;
    use sea_orm::*;
    use sqlx::migrate::MigrateDatabase;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, Once};
    use tracing_subscriber::{
        layer::SubscriberExt, util::SubscriberInitExt, EnvFilter,
    };

    static INIT_LOGGING: Once = Once::new();
    static DB_INIT: AtomicBool = AtomicBool::new(false);
    static DB_INIT_MUTEX: Mutex<()> = Mutex::new(());
    const SKIP_DB_INIT_ENV: &str = "WDINTEL_SKIP_TEST_DB_INIT";

    pub fn init_logging() {
        INIT_LOGGING.call_once(|| {
            tracing_subscriber::registry()
                .with(EnvFilter::new(
                    std::env::var("RUST_LOG")
                        .unwrap_or_else(|_| "info,wdintel_rs=trace".into()),
                ))
                .with(tracing_subscriber::fmt::layer())
                .try_init()
                .ok();
        });
    }

    pub async fn init() {
        init_logging();

        if std::env::var_os(SKIP_DB_INIT_ENV).is_some() {
            return;
        }

        if DB_INIT.load(Ordering::Acquire) {
            return;
        }

        let config = {
            let _guard = DB_INIT_MUTEX.lock().unwrap();
            if DB_INIT.load(Ordering::Acquire) {
                return;
            }
            crate::config::read_config(Mode::Test).unwrap()
        };

        let conn_str = mk_conn_string(&config);

        if let Err(error) = sqlx::Postgres::create_database(&conn_str).await {
            let error_msg = format!("{error:?}");
            if error_msg.contains("42P04") {
                println!("test DB already exists, skipping...");
            } else {
                panic!("failed to create test DB: {error_msg}");
            }
        }

        let db = crate::new_pg_pool_from_config(&config).await.unwrap();

        Migrator::status(&db).await.unwrap();
        echo_im::run_migration(&db).await.unwrap();
        crate::migration::ensure_echo_gpu_uuid_v7_generator(&db)
            .await
            .unwrap();
        echo_gpu_client::run_migration(&db).await.unwrap();
        Migrator::install(&db).await.unwrap();
        Migrator::up(&db, None).await.unwrap();

        {
            let _guard = DB_INIT_MUTEX.lock().unwrap();
            DB_INIT.store(true, Ordering::Release);
        }

        // let m_user = user::Entity::find()
        //     .filter(user::Column::Username.eq(String::from("test")))
        //     .one(&db)
        //     .await;
        // if let Ok(Some(_)) = m_user {
        //     println!("User already exists");
        // } else {
        //     let hash = password_auth::generate_hash("test");
        //     let user = user::ActiveModel {
        //         username: Set(String::from("test")),
        //         password: Set(hash),
        //         ..Default::default()
        //     };
        //     let _ = user.save(&db).await.unwrap();
        // }
    }

    #[test]
    fn analytics_connection_string_encodes_credentials() {
        let analytics = AnalyticsConfig {
            pg_host: "echo-dev-clickhouse".to_string(),
            pg_port: Some(5433),
            pg_user: "echo@analytics".to_string(),
            pg_password: "secret:/?#[]@".to_string(),
            pg_dbname: "echo analytics".to_string(),
            connect_timeout_ms: None,
            query_timeout_ms: None,
            freshness_max_age_ms: None,
            retry_cooldown_ms: None,
        };

        assert_eq!(
            mk_analytics_conn_string(&analytics),
            "postgresql://echo%40analytics:secret%3A%2F%3F%23%5B%5D%40@echo-dev-clickhouse:5433/echo%20analytics"
        );
    }

    #[tokio::test]
    async fn analytics_pool_does_not_require_gateway_at_startup() {
        let analytics = AnalyticsConfig {
            pg_host: "127.0.0.1".to_string(),
            pg_port: Some(1),
            pg_user: "echo_analytics".to_string(),
            pg_password: "secret".to_string(),
            pg_dbname: "echo_analytics_gateway".to_string(),
            connect_timeout_ms: Some(1),
            query_timeout_ms: None,
            freshness_max_age_ms: None,
            retry_cooldown_ms: None,
        };

        assert!(new_pg_pool_from_analytics(&analytics).await.is_ok());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn analytics_pool_forces_custom_query_plans() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let pg_dbname = std::env::var("TEST_DB_NAME")
            .ok()
            .filter(|pg_dbname| !pg_dbname.is_empty())
            .or(config.pg_dbname)
            .unwrap_or_else(|| DEFAULT_PG_DBNAME.to_string());
        let analytics = AnalyticsConfig {
            pg_host: config
                .pg_host
                .unwrap_or_else(|| DEFAULT_PG_HOST.to_string()),
            pg_port: config.pg_port,
            pg_user: config
                .pg_user
                .unwrap_or_else(|| DEFAULT_PG_USER.to_string()),
            pg_password: config
                .pg_password
                .unwrap_or_else(|| DEFAULT_PG_PASSWORD.to_string()),
            pg_dbname,
            connect_timeout_ms: None,
            query_timeout_ms: None,
            freshness_max_age_ms: None,
            retry_cooldown_ms: None,
        };
        let analytics = new_pg_pool_from_analytics(&analytics).await.unwrap();

        assert_eq!(
            postgres_setting(&analytics, "plan_cache_mode").await,
            "force_custom_plan"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn runtime_pool_uses_guardrails_and_operator_pool_remains_uncapped() {
        let mut config = crate::config::read_config(Mode::Test).unwrap();
        config.postgres_runtime = Some(PostgresRuntimeConfig {
            statement_timeout_ms: 25,
            report_worker_statement_timeout_ms: 25,
            lock_timeout_ms: 15,
            idle_in_transaction_session_timeout_ms: 50,
        });

        let runtime =
            new_pg_runtime_pool_from_config(&config, PgRuntimePoolRole::Web)
                .await
                .unwrap();
        assert_eq!(
            postgres_setting(&runtime, "statement_timeout").await,
            "25ms"
        );
        assert_eq!(postgres_setting(&runtime, "lock_timeout").await, "15ms");
        assert_eq!(
            postgres_setting(&runtime, "idle_in_transaction_session_timeout",)
                .await,
            "50ms"
        );

        let error = runtime
            .execute_unprepared("select pg_sleep(2)")
            .await
            .unwrap_err();
        assert!(has_postgres_error_code(&error, "57014"));

        let operator = crate::new_pg_pool_from_config(&config).await.unwrap();
        operator
            .execute_unprepared("select pg_sleep(0.1)")
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn runtime_pool_exposes_application_name_in_pg_stat_activity() {
        let mut config = crate::config::read_config(Mode::Test).unwrap();
        config.postgres_runtime = Some(PostgresRuntimeConfig {
            statement_timeout_ms: 100,
            report_worker_statement_timeout_ms: 200,
            lock_timeout_ms: 50,
            idle_in_transaction_session_timeout_ms: 200,
        });

        let runtime = new_pg_runtime_pool_from_config(
            &config,
            PgRuntimePoolRole::ReportWorker,
        )
        .await
        .unwrap();
        let statement = Statement::from_string(
            DbBackend::Postgres,
            "select pg_backend_pid()",
        );
        let pid: i32 = runtime
            .query_one_raw(statement)
            .await
            .unwrap()
            .unwrap()
            .try_get_by_index(0)
            .unwrap();
        let operator = crate::new_pg_pool_from_config(&config).await.unwrap();
        let statement = Statement::from_string(
            DbBackend::Postgres,
            format!("select application_name from pg_stat_activity where pid = {pid}"),
        );
        let application_name: String = operator
            .query_one_raw(statement)
            .await
            .unwrap()
            .unwrap()
            .try_get_by_index(0)
            .unwrap();

        assert_eq!(application_name, "echo-report-worker");
        assert_eq!(
            postgres_setting(&runtime, "statement_timeout").await,
            "200ms"
        );
    }

    async fn postgres_setting(
        db: &DatabaseConnection,
        setting: &str,
    ) -> String {
        let statement = Statement::from_string(
            DbBackend::Postgres,
            format!("show {setting}"),
        );
        db.query_one_raw(statement)
            .await
            .unwrap()
            .unwrap()
            .try_get_by_index(0)
            .unwrap()
    }

    fn has_postgres_error_code(
        error: &(dyn std::error::Error + 'static),
        code: &str,
    ) -> bool {
        let mut source = Some(error);
        while let Some(error) = source {
            if let Some(
                DbErr::Conn(sea_orm::RuntimeErr::SqlxError(sqlx_error))
                | DbErr::Exec(sea_orm::RuntimeErr::SqlxError(sqlx_error))
                | DbErr::Query(sea_orm::RuntimeErr::SqlxError(sqlx_error)),
            ) = error.downcast_ref::<DbErr>()
            {
                if let sqlx::Error::Database(database_error) =
                    sqlx_error.as_ref()
                {
                    if database_error.code().as_deref() == Some(code) {
                        return true;
                    }
                }
            }
            source = error.source();
        }
        false
    }

    #[ctor]
    fn init_tests() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            init().await;
        });
    }
}
