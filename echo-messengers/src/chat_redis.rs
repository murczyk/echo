use crate::config::{
    Config, CHAT_REDIS_PIPELINE_BUFFER_SIZE, CHAT_REDIS_RESPONSE_TIMEOUT_SECS,
};
use crate::error::ShortContext;
use crate::h;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::ConnectionLike;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct ChatRedis {
    connection: Arc<RwLock<Option<ConnectionManager>>>,
    cleanup_cursor: Arc<AtomicU64>,
}

impl ChatRedis {
    pub async fn connect(config: &Config) -> Self {
        let connection = match new_connection(config).await {
            Ok(connection) => Some(connection),
            Err(err) => {
                log::warn!(
                    "chat unread Redis is unavailable at startup; PostgreSQL functionality remains available: {err:#}"
                );
                None
            }
        };
        Self {
            connection: Arc::new(RwLock::new(connection)),
            cleanup_cursor: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn connection(&self) -> Option<ConnectionManager> {
        self.connection.read().await.clone()
    }

    pub async fn reconnect(&self, config: &Config) -> anyhow::Result<bool> {
        if self.connection().await.is_some() {
            return Ok(false);
        }
        let connection = new_connection(config).await.c(h!())?;
        *self.connection.write().await = Some(connection);
        Ok(true)
    }

    pub fn cleanup_cursor(&self) -> u64 {
        self.cleanup_cursor.load(Ordering::Relaxed)
    }

    pub fn set_cleanup_cursor(&self, cursor: u64) {
        self.cleanup_cursor.store(cursor, Ordering::Relaxed);
    }
}

async fn new_connection(config: &Config) -> anyhow::Result<ConnectionManager> {
    let redis_url =
        format!("redis://{}:{}/0", config.redis_host(), config.redis_port());
    let mut client = redis::Client::open(redis_url).c(h!())?;
    if !client.check_connection() {
        anyhow::bail!("Redis connection failed");
    }
    let manager_config = ConnectionManagerConfig::new()
        .set_pipeline_buffer_size(CHAT_REDIS_PIPELINE_BUFFER_SIZE)
        .set_response_timeout(Some(Duration::from_secs(
            CHAT_REDIS_RESPONSE_TIMEOUT_SECS,
        )));
    client
        .get_connection_manager_with_config(manager_config)
        .await
        .c(h!())
}
