pub use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
pub use crate::h;
pub use crate::logging::LevelFilter;
pub(crate) use crate::logging::*;
use crate::palitra::worker::PalitraWorkerContext;
pub use anyhow::{anyhow, bail, Context};
pub use chrono::prelude::Utc;
pub use chrono::NaiveDateTime;
pub use chrono_tz::Europe::Kyiv;
use clap::ValueEnum;
pub use itertools::Itertools;
use milgeo_rs::MilGeo;
use rand::prelude::IndexedRandom;
pub use serde::{Deserialize, Serialize};
#[cfg(test)]
pub use serial_test::serial;
pub use std::collections::VecDeque;
pub use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
pub use std::hash::Hash;
pub use std::path::{Path, PathBuf};
pub use std::sync::Arc;
pub use std::sync::RwLock;
pub use tokio::task::JoinSet;
pub use uuid::Uuid;

/// Shorthand trait for anyhow-like `Context` allowing `.c(h!())` usage
pub trait ShortContext<T> {
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static;
}

impl<T, E> ShortContext<T> for Result<T, E>
where
    E: Into<anyhow::Error>,
{
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        let res: anyhow::Result<T> = self.map_err(Into::into);
        anyhow::Context::context(res, context)
    }
}

impl<T> ShortContext<T> for Option<T> {
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        anyhow::Context::context(self, context)
    }
}

// No separate impl for anyhow::Result<T> to avoid overlap with the generic impl

/// Error-only variant to add context to errors directly
pub trait ShortContextErr {
    fn c<C>(self, context: C) -> AppError
    where
        C: std::fmt::Display + Send + Sync + 'static;
}

impl ShortContextErr for anyhow::Error {
    fn c<C>(self, context: C) -> AppError
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        AppError::AnyhowError {
            source: self.context(context),
        }
    }
}

impl ShortContextErr for AppError {
    fn c<C>(self, context: C) -> AppError
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        match self {
            AppError::NotFound
            | AppError::Unauthenticated
            | AppError::Forbidden(_)
            | AppError::ForbiddenWithHeader { .. }
            | AppError::Form(_)
            | AppError::ServiceUnavailable { .. } => self,
            AppError::AnyhowError { source } => AppError::AnyhowError {
                source: source.context(context),
            },
            other => AppError::AnyhowError {
                source: anyhow!(other).context(context),
            },
        }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Debug)]
pub enum Mode {
    Live,
    Debug,
    Test,
}

#[derive(Clone)]
pub struct Env {
    pub mode: Mode,
    pub config: crate::config::Config,
    pub s3: Option<opendal::Operator>,
    pub s3_config: Option<crate::storage::S3Config>,
    pub dbx: sea_orm::DatabaseConnection,
    pub echo_gpu_client: Arc<echo_gpu_client::EchoGpuClient>,
    pub file_registry_db: FileRegistryDb,
    /// GreptimeDB connection via Postgresql driver
    pub greptimedb: Arc<RwLock<Option<deadpool_postgres::Pool>>>,
    pub rq: reqwest::Client,
    pub rq_goi_associations: reqwest::Client,
    pub mil_geo: MilGeo,
    pub redis: redis::aio::ConnectionManager,
    pub stats_redis: redis::aio::ConnectionManager,
    /// Used when you need to explicitly create a connection and block on it, like for streams.
    pub redisb: redis::Client,
    pub settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    pub version: String,
    pub callsigns_whitelist: HashSet<String>,
    pub replicas: Vec<ReplicaPool>,
    pub analytics: Option<AnalyticsPool>,
    pub tag_keyword_regex_cache: Arc<RwLock<TagKeywordRegexCache>>,
    pub session_activity_tx:
        Option<tokio::sync::mpsc::Sender<SessionActivityEvent>>,
    pub session_activity_rx: Arc<
        tokio::sync::Mutex<
            Option<tokio::sync::mpsc::Receiver<SessionActivityEvent>>,
        >,
    >,
    pub session_activity_dropped: Arc<std::sync::atomic::AtomicU64>,
    pub session_activity_enqueued: Arc<std::sync::atomic::AtomicU64>,
    pub palitra_worker_context: Arc<PalitraWorkerContext>,
    pub metrics: Option<crate::telemetry::Metrics>,
}

#[derive(Clone)]
pub struct AnalyticsPool {
    pub conn: sea_orm::DatabaseConnection,
    pub retry_after_unix_ms: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Debug)]
pub struct SessionActivityEvent {
    pub ts: NaiveDateTime,
    pub id: String,
    pub public_host: Option<String>,
    pub username: Option<String>,
    pub page: Option<String>,
    pub payload: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct TagKeywordRegexCache {
    pub tags_to_predict: HashMap<String, i64>,
    pub keywords_regex_per_tag: HashMap<i64, TagKeywordRegexCacheItem>,
}

#[derive(Clone)]
pub struct TagKeywordRegexCacheItem {
    pub regex_set_positive: regex::RegexSet,
    pub regex_set_negative: regex::RegexSet,
}

#[derive(Clone)]
pub struct ReplicaPool {
    pub conn: sea_orm::DatabaseConnection,
    pub label: String,
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Mode::Debug => "debug",
            Mode::Live => "live",
            Mode::Test => "test",
        };
        write!(f, "{s}")
    }
}

impl Env {
    pub fn greptime(&self) -> Option<deadpool_postgres::Pool> {
        let res = self.greptimedb.read();
        if let Ok(greptime) = res {
            if let Some(greptime) = &*greptime {
                return Some(greptime.clone());
            }
        }
        None
    }

    /// Returns a random replica connection if available, otherwise falls back to the primary DB connection.
    pub fn replica_with_label(
        &self,
    ) -> (sea_orm::DatabaseConnection, Option<String>) {
        if self.replicas.is_empty() {
            return (self.dbx.clone(), None);
        }
        match self.replicas.choose(&mut rand::rng()).cloned() {
            Some(pool) => (pool.conn.clone(), Some(pool.label.clone())),
            None => (self.dbx.clone(), None),
        }
    }

    pub fn replica(&self) -> sea_orm::DatabaseConnection {
        self.replica_with_label().0
    }

    pub async fn take_session_activity_rx(
        &self,
    ) -> Option<tokio::sync::mpsc::Receiver<SessionActivityEvent>> {
        let mut lock = self.session_activity_rx.lock().await;
        lock.take()
    }

    pub fn session_activity_payload_max_bytes(&self) -> usize {
        self.config.session_activity_payload_max_bytes.unwrap_or(
            crate::config::SESSION_ACTIVITY_PAYLOAD_MAX_BYTES_DEFAULT,
        )
    }

    pub fn session_activity_greptime_get_timeout_ms(&self) -> u64 {
        let timeout_ms = self.config.session_activity_greptime_get_timeout_ms;
        timeout_ms.unwrap_or(
            crate::config::SESSION_ACTIVITY_GREPTIME_GET_TIMEOUT_MS_DEFAULT,
        )
    }

    pub fn session_activity_greptime_query_timeout_ms(&self) -> u64 {
        let timeout_ms = self.config.session_activity_greptime_query_timeout_ms;
        timeout_ms.unwrap_or(
            crate::config::SESSION_ACTIVITY_GREPTIME_QUERY_TIMEOUT_MS_DEFAULT,
        )
    }
}

pub struct TopKCache<K: Eq + Hash + Clone, V> {
    cache: HashMap<K, V>,
    frequency: HashMap<K, u32>,
    capacity: usize,
}

impl<K: Eq + Hash + Clone, V> TopKCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        TopKCache {
            cache: HashMap::new(),
            frequency: HashMap::new(),
            capacity,
        }
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        let value = self.cache.get(key);
        if value.is_some() {
            let count = self.frequency.entry(key.clone()).or_insert(0);
            *count += 1;
        }
        value
    }

    pub fn put(&mut self, key: K, value: V) {
        // First, check if the result is in the cache

        // Increment the frequency for the new input
        let count = self.frequency.entry(key.clone()).or_insert(0);
        *count += 1;

        if self.cache.contains_key(&key) {
            return;
        }

        // Insert the new result into the cache
        self.cache.insert(key, value);

        // Maintain the cache size if it exceeds the capacity
        if self.cache.len() > self.capacity {
            // Find the least frequently used item
            let mut min_freq = u32::MAX;
            let mut lfu_key = None;

            for (key, freq) in self.frequency.iter() {
                if freq < &min_freq {
                    min_freq = *freq;
                    lfu_key = Some(key.clone());
                }
            }

            // Remove the least frequently used item from both maps
            if let Some(key_to_remove) = lfu_key {
                self.cache.remove(&key_to_remove);
                self.frequency.remove(&key_to_remove);
            }
        }
    }
}
