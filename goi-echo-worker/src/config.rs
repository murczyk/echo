use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

pub const DEFAULT_CONFIG_PATH: &str = "/etc/goi-echo-worker/config.toml";
pub const DEFAULT_PG_HOST: &str = "127.0.0.1";
pub const DEFAULT_PG_PORT: u16 = 5432;
pub const DEFAULT_PG_USER: &str = "goi";
pub const DEFAULT_PG_DBNAME: &str = "goi";
pub const DEFAULT_ASSOCIATIONS_XLSX_PATH: &str =
    "/etc/goi/data/xlsx/associations.xlsx";
pub const DEFAULT_KNOWLEDGE_XLSX_PATH: &str =
    "/etc/goi/data/xlsx/knowledge.xlsx";
pub const DEFAULT_FREQUENCIES_XLSX_PATH: &str =
    "/etc/goi/data/xlsx/frequencies.xlsx";
pub const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
pub const DEFAULT_LISTEN_PORT: u16 = 8088;
pub const DEFAULT_POLL_SLEEP_MS: u64 = 1_000;
pub const GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS: i64 = 30;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub pg_host: Option<String>,
    pub pg_port: Option<u16>,
    pub pg_user: Option<String>,
    pub pg_password: Option<String>,
    pub pg_dbname: Option<String>,
    pub api_login: String,
    pub api_password: String,
    pub associations_xlsx_path: Option<String>,
    pub knowledge_xlsx_path: Option<String>,
    pub frequencies_xlsx_path: Option<String>,
    pub listen_host: Option<String>,
    pub listen_port: Option<u16>,
    pub poll_sleep_ms: Option<u64>,
}

impl Config {
    pub fn pg_host(&self) -> &str {
        self.pg_host.as_deref().unwrap_or(DEFAULT_PG_HOST)
    }

    pub fn pg_port(&self) -> u16 {
        self.pg_port.unwrap_or(DEFAULT_PG_PORT)
    }

    pub fn pg_user(&self) -> &str {
        self.pg_user.as_deref().unwrap_or(DEFAULT_PG_USER)
    }

    pub fn pg_password(&self) -> &str {
        self.pg_password.as_deref().unwrap_or("")
    }

    pub fn pg_dbname(&self) -> &str {
        self.pg_dbname.as_deref().unwrap_or(DEFAULT_PG_DBNAME)
    }

    pub fn associations_xlsx_path(&self) -> &str {
        self.associations_xlsx_path
            .as_deref()
            .unwrap_or(DEFAULT_ASSOCIATIONS_XLSX_PATH)
    }

    pub fn knowledge_xlsx_path(&self) -> &str {
        self.knowledge_xlsx_path
            .as_deref()
            .unwrap_or(DEFAULT_KNOWLEDGE_XLSX_PATH)
    }

    pub fn frequencies_xlsx_path(&self) -> &str {
        self.frequencies_xlsx_path
            .as_deref()
            .unwrap_or(DEFAULT_FREQUENCIES_XLSX_PATH)
    }

    pub fn listen_host(&self) -> &str {
        self.listen_host.as_deref().unwrap_or(DEFAULT_LISTEN_HOST)
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.unwrap_or(DEFAULT_LISTEN_PORT)
    }

    pub fn poll_sleep_ms(&self) -> u64 {
        self.poll_sleep_ms.unwrap_or(DEFAULT_POLL_SLEEP_MS)
    }
}

pub fn read_config() -> Result<Config> {
    if let Ok(path) = std::env::var("GOI_ECHO_WORKER_CONFIG_PATH") {
        return read_from_path(PathBuf::from(path));
    }
    let live_path = PathBuf::from(DEFAULT_CONFIG_PATH);
    if live_path.exists() {
        return read_from_path(live_path);
    }
    read_from_path(PathBuf::from_iter([
        env!("CARGO_MANIFEST_DIR"),
        "config.toml.example",
    ]))
}

pub fn read_from_path(path: PathBuf) -> Result<Config> {
    let config = std::fs::read_to_string(&path)
        .with_context(|| path.display().to_string())?;
    toml::from_str::<Config>(&config).context("parsing TOML")
}
