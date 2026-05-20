#[cfg(test)]
pub mod test {
    // use crate::entities::user;
    use crate::mk_conn_string;
    use crate::types::Mode;
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

    #[ctor]
    fn init_tests() {
        if std::env::var_os("WDINTEL_RS_INIT_TEST_DB").is_none() {
            return;
        }

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            init().await;
        });
    }
}
