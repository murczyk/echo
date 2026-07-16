use crate::config::Config;
use crate::error::ShortContext;
use crate::h;
use anyhow::Result;
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use std::time::Duration;

pub async fn connect(config: &Config) -> Result<DatabaseConnection> {
    let mut options = ConnectOptions::new(connection_string(config));
    options
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(60))
        .sqlx_logging(false);
    Database::connect(options).await.c(h!())
}

fn connection_string(config: &Config) -> String {
    format!(
        "postgres://{}:{}@{}:{}/{}",
        config.pg_user(),
        config.pg_password(),
        config.pg_host(),
        config.pg_port(),
        config.pg_dbname(),
    )
}
