#[cfg(test)]
pub mod test {
    // use crate::entities::user;
    use crate::config::AnalyticsConfig;
    use crate::types::Mode;
    use crate::{
        mk_analytics_conn_string, mk_conn_string, new_pg_pool_from_analytics,
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

    #[ctor]
    fn init_tests() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            init().await;
        });
    }
}
