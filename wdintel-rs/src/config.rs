use crate::types::*;
use anyhow::Result;

pub const DEFAULT_PG_HOST: &str = "localhost";
pub const DEFAULT_PG_PORT: u16 = 5432;
pub const DEFAULT_PG_USER: &str = "wd";
pub const DEFAULT_PG_PASSWORD: &str = "fee_-_-_-FnoeKFBeebu87bf";
pub const DEFAULT_PG_DBNAME: &str = "wd";
pub const NLP_ADDR: &str = "http://127.0.0.1:5000";
pub const RQ_TIMEOUT: u64 = 10;
// pub const CALLSIGNS_SEEN_LATELY_PERIOD_DAYS: i64 = 1;
pub const CALLSIGNS_MAX_LEN: usize = 20;
pub const CALLSIGNS_MAX_LINES: usize = 10;
/// Limit how many top lines are scanned when extracting post from text
pub const POSTS_MAX_LINES: usize = 8;
pub const CALLSIGNS_TO_VISUALISE: usize = 40;
pub const SIGNAL_CLIENT_ADDR: &str = "http://localhost:8083";
pub const SIGNAL_CLIENT_PORT: i32 = 8083;
pub const SIGNAL_MAX_MESSAGES: usize = 40;
pub const RQ_TIMEOUT_SIGNAL_API: u64 = 600;
pub const RQ_TIMEOUT_LAUNCH_SUBPROCESS: u64 = 60;
pub const COORDS_PER_FREQ_LIMIT: usize = 100;
pub const COORDS_PER_FREQ_PER_LOC_LIMIT: usize = 10;
pub const B2_AWS_PROFILE_NAME: &str = "my-creds";
pub const URL_NEED_VISIT_NOTIFICATION_MINS: i64 = 5;
pub const IDENTITY_DURATION_HOURS: u64 = 12;
pub const IDENTITY_SALT: &str = "IUBwdub783736#";
pub const ROLE_ADMIN: &str = "Admin";
pub const SIGINT_SIGNAL_TIMEOUT_MS: u64 = 1000;
pub const CLEANUP_REPORT_DAYS: u64 = 30;
// for xlsx import
pub const SIGNAL_DATASOURCE_ID: i64 = 1;
pub const FEATURE_DESKTOP_YOUTUBE_KEYS: bool = true;
pub const DISCORD_WEBHOOK: &str = "https://discord.com/api/webhooks/1417084833384890398/7jgZyC1zpmrJVXzUwDz-OQV6_UwqxUUl9GHehVyV9-UwxQRZjMg9ZwYYNJGPcAmuiGRA";
pub const FEATURE_CALLSIGNS_ALG2: bool = false;
/// Safety limit: cut network-callsigns time window if too wide
pub const NETWORK_CALLSIGNS_MAX_WINDOW_DAYS: i64 = 60;
/// Ukraine boundaries WGS84
pub const LAT_MIN: f64 = 40.0;
pub const LAT_MAX: f64 = 60.0;
pub const LON_MIN: f64 = 20.0;
pub const LON_MAX: f64 = 50.0;
pub const MAX_FREQS_GROUPS_BY_DAY: u64 = 10;
pub const CORRELATED_FREQS_MAX_DAYS: i64 = 30;
pub const CLEANUP_NETWORKS_WORKER_SLEEP_DURATION: u64 = 3600;
pub const CLEANUP_NETWORKS_CUTOFF_TIME_DAYS: i64 = 7;
pub const MAX_AGE_MESSAGES_TO_UPDATE: i64 = 120;
pub const IMPORT_DIRECTION_FINDING_UUID: &str =
    "22b171e7-1c8a-469c-af68-79d7a06b99f4";
pub const REDIS_HOST: &str = "localhost";
pub const REDIS_PORT: u16 = 6379;
pub const LONG_POLL_SLEEP_MS: u64 = 5000;
/// Minimum time to keep a long-poll request open to accumulate events
pub const LONG_POLL_MIN_RESPONSE_TIME_MS: u64 = 500;
pub const REDIS_MAXLEN: usize = 1000;
pub const REDIS_SESSIONS_KEY: &str = "echo-sessions";
pub const SESSION_STREAM_LIFETIME_SEC: i64 = 180;
pub const INACTIVE_USERS_DEACTIVATE_DURATION_SEC: u64 = 3600;
pub const INACTIVE_USERS_DEACTIVATE_AFTER_DAYS: i64 = 30;
pub const SIGNAL_CLIENT_DIR: &str = "/etc/echo/signal-cli-data";
pub const WHATSAPP_CLIENT_DIR: &str = "/etc/echo/whatsapp-cli-data";
pub const SIGNAL_UNIT_NAME: &str = "echo-signal-bot";
pub const WHATSAPP_UNIT_NAME: &str = "echo-whatsapp-bot";
pub const CLIENT_DATA_DIR_NAME: &str = "client_data";
pub const WHATSAPP_CLIENT_CONFIG: &str = "/etc/echo/config.toml";
pub const GENERATE_MESSAGE_UID_TILL_MAX_DAYS: i64 = 20;
pub const UNKNOWN_GROUP_MASTER_KEY: &str = "undefined_group";

/// Dynamic config that's different on different deployments
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Config {
    pub vault_config: Option<VaultConfig>,
    pub public_host: String,
    pub pg_host: Option<String>,
    pub pg_port: Option<u16>,
    pub pg_user: Option<String>,
    pub pg_password: Option<String>,
    pub pg_dbname: Option<String>,
    /// Used for importer image-upload logic etc. Leave empty if not needed.
    pub b2_aws_access_key_id: String,
    pub b2_aws_secret_access_key: String,
    // pub b2_aws_profile_name: String,
    pub b2_s3: String,
    pub b2_s3_region: String,
    pub cookie_session_secret: String,
    pub storage_dir: String,
    pub signal_api_phone: String,
    pub whatsapp_api_phone: String,
    pub signal_import_group_name: String,
    pub signal_import_fiven_name: String,
    pub static_path: String,
    pub executable_path: String,
    pub fill_comp_freq_worker: bool,
    pub disable_cleanup_networks_worker: Option<bool>,
    pub disable_unit_location_v2_worker: Option<bool>,
    pub backup_key_id: Option<String>,
    pub backup_key: Option<String>,
    /// Used for clustering in Babak report, 2km is the default
    pub cluster_radius: Option<f64>,
    pub feature_delta: Option<bool>,
    pub feature_analysis_map: Option<bool>,
    pub settlements_sources: Option<String>,
    secret_config: Option<SecretConfig>,
    pub sleep_before_backup_mins: Option<u64>,
    pub redis_host: Option<String>,
    pub redis_port: Option<u16>,
    pub greptime_host: Option<String>,
    pub greptime_port: Option<u16>,
    pub greptime_user: Option<String>,
    pub greptime_password: Option<String>,
    pub greptime_dbname: Option<String>,
    pub feature_tmp_in_memory: Option<bool>,
    pub feature_strict_networks: Option<bool>,
    pub is_slave: Option<bool>,
    pub disable_inactive_users_worker: Option<bool>,
    pub replicas: Option<Vec<ReplicaConfig>>,
    /// A unique identifier for the server.
    ///
    /// This is an arbitrary integer value in the range **1-16**.
    /// It must be unique across all running servers to avoid conflicts.
    /// Please double-check in Bitwarden that your value does not conflict with values in other live servers.
    pub server_id: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ReplicaConfig {
    pub pg_host: Option<String>,
    pub pg_port: Option<u16>,
    pub pg_user: Option<String>,
    pub pg_password: Option<String>,
    pub pg_dbname: Option<String>,
}

impl Config {
    pub fn secret_config(&self) -> Option<SecretConfig> {
        match &self.secret_config {
            Some(config) => Some(config.clone()),
            None => crate::secret::SECRET.get().cloned(),
        }
    }

    pub fn settlement_paths(&self) -> Result<Vec<String>> {
        get_settlement_paths(self.settlements_sources.clone())
    }
}

pub fn get_settlement_paths(
    m_settlement_path: Option<String>,
) -> Result<Vec<String>> {
    let old = vec!["settlements.json".to_string()];
    let settlement_paths = match m_settlement_path {
        // old settlements.json logic (all in one file)
        None => old,
        Some(v) => {
            if v.trim().is_empty() {
                old
            } else {
                v.split(',')
                    .map(|s| format!("settlements_json/{}.json", s.trim()))
                    .collect()
            }
        }
    };

    Ok(settlement_paths)
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SecretConfig {
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: String,
    pub scope: String,
    pub claims_json: String,
    pub auth_url: String,
    pub redirect_url: String,
    pub delta_api_url: String,
    pub user_agent: String,
    pub userinfo_endpoint: String,
    pub redirect_url_echoua: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct VaultConfig {
    pub url: String,
    pub server: String,
    pub login: String,
    pub password: String,
}

pub fn read_config(mode: Mode) -> Result<Config, AppError> {
    let folder = get_deploy_folder(mode).context(h!())?;
    let path = match mode {
        Mode::Live => folder.join("config.toml"),
        Mode::Test => folder.join("config-test.toml"),
        Mode::Debug => {
            let mut path = folder.join("config.toml");
            if !path.exists() {
                path = folder.join("config-debug.toml");
            }
            path
        }
    };
    read_from_path(path)
}

pub fn read_from_path<T>(path: PathBuf) -> Result<T, AppError>
where
    T: for<'a> Deserialize<'a>,
{
    let config = std::fs::read_to_string(path)?;
    let config: T = toml::from_str(&config).context(h!())?;
    Ok(config)
}

pub fn m_unit_to_unidenfitied(unit: Option<String>) -> String {
    let res = unit.unwrap_or("Не визначено".to_string());
    if res.is_empty() {
        return "Не визначено".to_string();
    }
    res
}

pub fn location_contain_empty(xs: &[String]) -> bool {
    xs.iter()
        .any(|s| s.as_str() == "Не визначено" || s.is_empty())
}

pub fn location_is_empty(s: &str) -> bool {
    let t = s.trim();
    t == "--Не визначено--" || t.is_empty()
}

pub fn m_location_to_unidenfitied(location: Option<String>) -> String {
    let res = location.unwrap_or("--Не визначено--".to_string());
    if res.is_empty() {
        return "--Не визначено--".to_string();
    }
    res
}

pub fn get_deploy_folder(mode: Mode) -> Result<PathBuf, AppError> {
    let path = match mode {
        Mode::Live => PathBuf::from("/etc/echo"),
        _ => {
            let man = std::env!("CARGO_MANIFEST_DIR");
            PathBuf::from_iter([man, "..", "deploy"])
        }
    };
    Ok(path)
}

pub fn get_data_folder(mode: Mode) -> Result<PathBuf, AppError> {
    let path = match mode {
        Mode::Live => PathBuf::from("/etc/echo"),
        _ => PathBuf::from(std::env!("CARGO_MANIFEST_DIR")).join("data"),
    };
    Ok(path)
}

pub fn get_assets_folder(config: &Config) -> String {
    let path = PathBuf::from(&config.storage_dir).join("kmz_assets");
    std::fs::create_dir_all(&path)
        .context(path.display().to_string())
        .context(h!())
        .unwrap();
    path.into_os_string().into_string().unwrap()
}

pub fn get_assets_url() -> &'static str {
    "/api/assets"
}

pub fn get_colors() -> Vec<String> {
    vec![
        "#ae24d0".to_string(),
        "#882ee7".to_string(),
        "#6160ec".to_string(),
        "#4a8fe9".to_string(),
        "#56b9da".to_string(),
        "#67dac6".to_string(),
        "#74eba1".to_string(),
        "#8df27a".to_string(),
        "#c6dc46".to_string(),
        "#d8bf3f".to_string(),
        "#e46d65".to_string(),
        "#db4092".to_string(),
        "#cd40c0".to_string(),
        "#ff0000".to_string(),
        "#00ff00".to_string(),
        "#0000ff".to_string(),
    ]
}

pub fn signal_api_attachment_path(
    _config: &Config,
) -> Result<PathBuf, AppError> {
    Ok("/etc/echo/signal-cli/attachments".into())
}

pub fn all_restreamers() -> Vec<String> {
    vec!["restreamer01".to_string()]
}

pub fn get_tz() -> chrono_tz::Tz {
    chrono_tz::Europe::Kyiv
}

pub fn get_cleanup_networks_worker_sleep_duration() -> std::time::Duration {
    std::time::Duration::from_secs(3600)
}
