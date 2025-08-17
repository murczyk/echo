pub use crate::error::AppError;
pub use crate::h;
pub use anyhow::{anyhow, bail, Context};
pub use chrono::NaiveDateTime;
use clap::ValueEnum;
pub use itertools::Itertools;
pub use log::*;
use milgeo_rs::MilGeo;
pub use serde::{Deserialize, Serialize};
#[cfg(test)]
pub use serial_test::serial;
pub use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
pub use std::hash::Hash;
pub use std::path::{Path, PathBuf};
pub use std::sync::Arc;
pub use std::sync::RwLock;
pub use uuid::Uuid;

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
    pub b2_store: opendal::Operator,
    pub dbx: sea_orm::DatabaseConnection,
    /// GreptimeDB connection via Postgresql driver
    pub greptimedb: Arc<RwLock<Option<deadpool_postgres::Pool>>>,
    pub rq: reqwest::Client,
    pub mil_geo: MilGeo,
    pub redis: redis::aio::ConnectionManager,
    /// Used when you need to explicitly create a connection and block on it, like for streams.
    pub redisb: redis::Client,
    pub settlements: Arc<RwLock<crate::location::SettlementsData>>,
    pub version: String,
    pub callsigns_whitelist: HashSet<String>,
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
