use crate::error::ShortContext;
use crate::h;
use anyhow::Result;
use serde::Deserialize;
use std::path::PathBuf;

pub const DEFAULT_CONFIG_PATH: &str = "/etc/echo-messengers/config.toml";
pub const ECHO_MESSENGERS_JSON_PAYLOAD_MAX_BYTES: usize = 1024 * 1024 * 1024;
pub const AUTOMATION_SEND_LOG_RETENTION_DAYS: i64 = 30;
pub const AUTOMATION_MAP_SCREENSHOT_WIDTH: u32 = 800;
pub const AUTOMATION_MAP_SCREENSHOT_HEIGHT: u32 = 600;
pub const AUTOMATION_MAP_SCREENSHOT_MAX_ZOOM: u8 = 14;
pub const AUTOMATION_MAP_SCREENSHOT_PADDING: f64 = 20.0;
pub const AUTOMATION_MAP_SCREENSHOT_TILE_SIZE: u32 = 256;
pub const AUTOMATION_MAP_SCREENSHOT_MARKER_RADIUS: i32 = 13;
pub const AUTOMATION_MAP_SCREENSHOT_MARKER_WEIGHT: i32 = 3;
pub const AUTOMATION_MAP_SCREENSHOT_REQUEST_TIMEOUT_SECS: u64 = 15;
pub const AUTOMATION_MAP_SCREENSHOT_LABEL_TIMEOUT_MILLIS: u64 = 2_000;
pub const AUTOMATION_MAP_SCREENSHOT_LABEL_RETRY_SECS: u64 = 60;
pub const AUTOMATION_MAP_SCREENSHOT_BASE_TILE_URL: &str =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
pub const AUTOMATION_MAP_SCREENSHOT_LABEL_TILE_URL: &str =
    "https://mt0.google.com/vt/lyrs=h&hl=uk&x={x}&y={y}&z={z}";
pub const AUTOMATION_MAP_SCREENSHOT_MARKER_COLOR: [u8; 4] = [252, 239, 18, 255];
pub const AUTOMATION_MAP_SCREENSHOT_WARNING_PREFIX: &str =
    "coordinate screenshot is unavailable:";
pub const AUTOMATION_BROKEN_INTEGRATION_ERROR: &str =
    "Інтеграцію змінено. Переналаштуйте акаунти та групи автоматизації.";
pub const AUTOMATION_OPERATION_LOCK_ID_BASE: i64 = i64::MIN;
pub const AUTOMATION_WORKER_SLEEP_MILLIS: u64 = 5_000;
pub const ECHO_MESSENGERS_ADVISORY_LOCK_RETRY_MILLIS: u64 = 25;
pub const MESSENGER_FULL_SYNC_WORKER_SLEEP_MILLIS: u64 = 60_000;
pub const MESSENGER_SIGNAL_OUTBOX_WORKER_SLEEP_MILLIS: u64 = 1_000;
pub const MESSENGER_INTEGRATION_UNIQUENESS_LOCK_ID: i64 = 4_563_686_943;
pub const MESSENGER_INTEGRATION_OPERATION_LOCK_NAMESPACE: i32 = 1_162_033_231;
pub const MESSENGER_INTEGRATION_CLIENT_DATA_BACKUP_SUFFIX: &str =
    ".relink-backup";
pub const MESSENGER_INTEGRATION_RELINK_STATE_PREFIX: &str = "relink:";
pub const CHAT_WORKER_SLEEP_MILLIS: u64 = 2_000;
pub const CHAT_REDIS_RECONNECT_SLEEP_MILLIS: u64 = 10_000;
pub const CHAT_REDIS_PIPELINE_BUFFER_SIZE: usize = 128;
pub const CHAT_REDIS_RESPONSE_TIMEOUT_SECS: u64 = 5;
pub const CHAT_UNREAD_KEY_TTL_DAYS: u64 = 35;
pub const CHAT_WEBHOOK_REQUEST_TIMEOUT_SECS: u64 = 15;
pub const CHAT_WEBHOOK_WORKER_SLEEP_MILLIS: u64 = 2_000;
pub const CHAT_WEBHOOK_MAX_ATTEMPTS: i32 = 8;
pub const CHAT_WEBHOOK_BATCH_SIZE: usize = 50;
pub const CHAT_WEBHOOK_CLEANUP_BATCH_SIZE: i32 = 5_000;
pub const CHAT_WEBHOOK_HISTORY_RETENTION_DAYS: i32 = 30;
pub const CHAT_MESSAGE_PAGE_SIZE: i64 = 50;
pub const CHAT_LIST_PAGE_SIZE: i64 = 100;
pub const CHAT_ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;
pub const CHAT_ATTACHMENT_MAX_COUNT: usize = 10;
pub const CHAT_ATTACHMENTS_TOTAL_MAX_BYTES: usize = 100 * 1024 * 1024;
const DEFAULT_PG_HOST: &str = "localhost";
const DEFAULT_PG_PORT: u16 = 5432;
const DEFAULT_PG_USER: &str = "wd";
const DEFAULT_PG_PASSWORD: &str = "fee_-_-_-FnoeKFBeebu87bf";
const DEFAULT_PG_DBNAME: &str = "wd";
const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
const DEFAULT_LISTEN_PORT: u16 = 4010;
const DEFAULT_REDIS_HOST: &str = "localhost";
const DEFAULT_REDIS_PORT: u16 = 6379;
const DEFAULT_CHAT_STORAGE_DIR: &str =
    "/var/lib/echo-messengers/chat-attachments";
const DEFAULT_SIGNAL_CLIENT_DIR: &str = "/etc/echo/signal-cli-data";
const DEFAULT_WHATSAPP_CLIENT_DIR: &str = "/etc/echo/whatsapp-cli-data";
const DEFAULT_WHATSAPP_CLIENT_CONFIG: &str = "/etc/echo-messengers/config.toml";
const DEFAULT_SIGNAL_UNIT_NAME: &str = "echo-signal-bot";
const DEFAULT_WHATSAPP_UNIT_NAME: &str = "echo-whatsapp-bot";
const DEFAULT_CLIENT_DATA_DIR_NAME: &str = "client_data";

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub pg_host: Option<String>,
    pub pg_port: Option<u16>,
    pub pg_user: Option<String>,
    pub pg_password: Option<String>,
    pub pg_dbname: Option<String>,
    pub listen_host: Option<String>,
    pub listen_port: Option<u16>,
    pub redis_host: Option<String>,
    pub redis_port: Option<u16>,
    pub chat_storage_dir: Option<String>,
    pub public_base_url: Option<String>,
    pub signal_client_dir: Option<String>,
    pub whatsapp_client_dir: Option<String>,
    pub whatsapp_client_config: Option<String>,
    pub signal_unit_name: Option<String>,
    pub whatsapp_unit_name: Option<String>,
    pub client_data_dir_name: Option<String>,
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
        self.pg_password.as_deref().unwrap_or(DEFAULT_PG_PASSWORD)
    }

    pub fn pg_dbname(&self) -> &str {
        self.pg_dbname.as_deref().unwrap_or(DEFAULT_PG_DBNAME)
    }

    pub fn listen_host(&self) -> &str {
        self.listen_host.as_deref().unwrap_or(DEFAULT_LISTEN_HOST)
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.unwrap_or(DEFAULT_LISTEN_PORT)
    }

    pub fn redis_host(&self) -> &str {
        self.redis_host.as_deref().unwrap_or(DEFAULT_REDIS_HOST)
    }

    pub fn redis_port(&self) -> u16 {
        self.redis_port.unwrap_or(DEFAULT_REDIS_PORT)
    }

    pub fn chat_storage_dir(&self) -> &str {
        self.chat_storage_dir
            .as_deref()
            .unwrap_or(DEFAULT_CHAT_STORAGE_DIR)
    }

    pub fn public_base_url(&self) -> Option<&str> {
        self.public_base_url.as_deref()
    }

    pub fn signal_client_dir(&self) -> &str {
        self.signal_client_dir
            .as_deref()
            .unwrap_or(DEFAULT_SIGNAL_CLIENT_DIR)
    }

    pub fn whatsapp_client_dir(&self) -> &str {
        self.whatsapp_client_dir
            .as_deref()
            .unwrap_or(DEFAULT_WHATSAPP_CLIENT_DIR)
    }

    pub fn whatsapp_client_config(&self) -> &str {
        self.whatsapp_client_config
            .as_deref()
            .unwrap_or(DEFAULT_WHATSAPP_CLIENT_CONFIG)
    }

    pub fn signal_unit_name(&self) -> &str {
        self.signal_unit_name
            .as_deref()
            .unwrap_or(DEFAULT_SIGNAL_UNIT_NAME)
    }

    pub fn whatsapp_unit_name(&self) -> &str {
        self.whatsapp_unit_name
            .as_deref()
            .unwrap_or(DEFAULT_WHATSAPP_UNIT_NAME)
    }

    pub fn client_data_dir_name(&self) -> &str {
        self.client_data_dir_name
            .as_deref()
            .unwrap_or(DEFAULT_CLIENT_DATA_DIR_NAME)
    }
}

pub fn read_config() -> Result<Config> {
    if let Ok(path) = std::env::var("ECHO_MESSENGERS_CONFIG_PATH") {
        return read_from_path(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("ECHO_SWAPP_CONFIG_PATH") {
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

fn read_from_path(path: PathBuf) -> Result<Config> {
    let config = std::fs::read_to_string(&path).c(format!(
        "{}: {}",
        h!(),
        path.display()
    ))?;
    toml::from_str::<Config>(&config).c(h!())
}
