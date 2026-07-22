use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

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
pub const DEFAULT_CATEGORIES_PATH: &str = "/etc/goi/data/categories.json";
pub const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
pub const DEFAULT_LISTEN_PORT: u16 = 8088;
pub const DEFAULT_POLL_SLEEP_MS: u64 = 1_000;
pub const API_FILE_BODY_MAX_BYTES: usize = 100 * 1024 * 1024;
pub const PALETTE_FILE_LIST_LIMIT: usize = 50_000;
pub const SYNC_LOCK_LIVE_TTL_SECS: i64 = 300;
pub const SYNC_LOCK_ADVISORY_KEY: i64 = 1_096_138_319;
pub const GOI_ASSOCIATIONS_INSERT_BATCH_SIZE: usize = 20_000;
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
    pub palettes_path: Option<String>,
    pub categories_path: Option<String>,
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

    pub fn preferred_knowledge_xlsx_path(&self) -> PathBuf {
        preferred_readonly_xlsx_path(self.knowledge_xlsx_path())
    }

    pub fn frequencies_xlsx_path(&self) -> &str {
        self.frequencies_xlsx_path
            .as_deref()
            .unwrap_or(DEFAULT_FREQUENCIES_XLSX_PATH)
    }

    pub fn preferred_frequencies_xlsx_path(&self) -> PathBuf {
        preferred_readonly_xlsx_path(self.frequencies_xlsx_path())
    }

    pub fn palettes_path(&self) -> Result<&str> {
        self.palettes_path
            .as_deref()
            .context("palettes_path is missing; rerun GOI worker setup")
    }

    pub fn categories_path(&self) -> &str {
        self.categories_path
            .as_deref()
            .unwrap_or(DEFAULT_CATEGORIES_PATH)
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

fn preferred_readonly_xlsx_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    let readonly_path = readonly_xlsx_path(&path);
    if readonly_path.is_file() {
        readonly_path
    } else {
        path
    }
}

fn readonly_xlsx_path(path: &Path) -> PathBuf {
    let Some(file_name) =
        path.file_name().and_then(|file_name| file_name.to_str())
    else {
        return path.to_path_buf();
    };
    if file_name.ends_with("-readonly.xlsx") {
        return path.to_path_buf();
    }
    let Some(file_name) = file_name.strip_suffix(".xlsx") else {
        return path.to_path_buf();
    };
    path.with_file_name(format!("{file_name}-readonly.xlsx"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn legacy_config_requires_explicit_palettes_path() {
        let config = toml::from_str::<Config>(
            r#"
api_login = "login"
api_password = "password"
"#,
        )
        .expect("legacy config");

        assert_eq!(
            config.palettes_path().unwrap_err().to_string(),
            "palettes_path is missing; rerun GOI worker setup"
        );
    }

    #[test]
    fn preferred_readonly_xlsx_path_uses_readonly_sibling_when_present() {
        let dir = temp_dir("goi-readonly-xlsx");
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("frequencies.xlsx");
        let readonly_path = dir.join("frequencies-readonly.xlsx");
        fs::write(&path, b"regular").expect("write regular file");

        assert_eq!(
            preferred_readonly_xlsx_path(path.to_str().expect("utf8 path")),
            path
        );

        fs::write(&readonly_path, b"readonly").expect("write readonly file");

        assert_eq!(
            preferred_readonly_xlsx_path(path.to_str().expect("utf8 path")),
            readonly_path
        );

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn readonly_xlsx_path_does_not_double_suffix() {
        let path = PathBuf::from("/etc/goi/data/xlsx/knowledge-readonly.xlsx");

        assert_eq!(readonly_xlsx_path(&path), path);
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("{prefix}-{}-{suffix}", std::process::id()))
    }
}
