use crate::storage;
use crate::types::*;
use anyhow::Result;
use chrono::Timelike;
use opendal::Operator;
use std::time::Duration;

pub const DEFAULT_PG_HOST: &str = "localhost";
pub const DEFAULT_PG_PORT: u16 = 5432;
pub const DEFAULT_PG_USER: &str = "wd";
pub const DEFAULT_PG_PASSWORD: &str = "fee_-_-_-FnoeKFBeebu87bf";
pub const DEFAULT_PG_DBNAME: &str = "wd";
pub const PGBACKREST_CONF_PATH: &str = "/etc/pgbackrest/pgbackrest.conf";
pub const PGBACKREST_CONF_INCLUDE_DIR: &str = "/etc/pgbackrest/conf.d";
pub const PGBACKREST_STANZA_CONF_PREFIX: &str = "pgbackrest-";
pub const PGBACKREST_STANZA_CONF_SUFFIX: &str = ".conf";
pub const PG_SLOW_STATEMENT_THRESHOLD_MS: u64 = 5_000;
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
pub const RQ_TIMEOUT_ALPINE_CONVERTER: u64 = 600;
pub const RQ_TIMEOUT_LAUNCH_SUBPROCESS: u64 = 60;
pub const SERVER_JSON_PAYLOAD_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Grace period before the first Signal login check after wdintel-rs start (ms)
pub const SIGNAL_LOGIN_INITIAL_SLEEP_MS: u64 = 2_000;
pub const COORDS_PER_FREQ_LIMIT: usize = 100;
pub const COORDS_PER_FREQ_PER_LOC_LIMIT: usize = 10;
pub const URL_NEED_VISIT_NOTIFICATION_MINS: i64 = 5;
pub const IDENTITY_DURATION_HOURS: u64 = 12;
pub const IDENTITY_SALT: &str = "IUBwdub783736#";
pub const ROLE_ADMIN: &str = "Admin";
pub const SIGINT_SIGNAL_TIMEOUT_MS: u64 = 1000;
pub const CLEANUP_REPORT_DAYS: u64 = 30;
pub const RER_REPORT_ERROR_CODE_HEADER_NAME: &str = "x-echo-error-code";
pub const RER_REPORT_PERMISSION_DENIED_ERROR_CODE: &str = "8125378";
pub const RER_DUTY_TEST_SOURCE_WINDOW_MINUTES_DEFAULT: i64 = 10;
pub const RER_DUTY_REPLAY_RECENT_WINDOW_MINUTES: i64 = 10;
// for xlsx import
pub const SIGNAL_DATASOURCE_ID: i64 = 1;
pub const SIGINT_SOURCE_RO_ID: i32 = 2;
pub const FEATURE_DESKTOP_YOUTUBE_KEYS: bool = true;
pub const DISCORD_WEBHOOK: &str = "https://discord.com/api/webhooks/1417084833384890398/7jgZyC1zpmrJVXzUwDz-OQV6_UwqxUUl9GHehVyV9-UwxQRZjMg9ZwYYNJGPcAmuiGRA";
pub const FEATURE_CALLSIGNS_ALG2: bool = false;
/// Safety limit: cut network-callsigns time window if too wide
pub const NETWORK_CALLSIGNS_MAX_WINDOW_DAYS: i64 = 60;
pub const SIGINT_CSV_UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
pub const SIGINT_NETWORK_LIST_DEFAULT_LIMIT: i64 = 100;
pub const SIGINT_NETWORK_LIST_MAX_LIMIT: u64 = 100;
pub const SIGINT_NETWORK_RELATION_MESSAGES_LIMIT_MAX: i64 = 50;
/// Ukraine boundaries WGS84
pub const LAT_MIN: f64 = 40.0;
pub const LAT_MAX: f64 = 60.0;
pub const LON_MIN: f64 = 20.0;
pub const LON_MAX: f64 = 50.0;
pub const MAX_FREQS_GROUPS_BY_DAY: u64 = 10;
pub const CORRELATED_FREQS_MAX_DAYS: i64 = 30;
pub const CLEANUP_NETWORKS_WORKER_SLEEP_DURATION: u64 = 3600;
pub const CLEANUP_NETWORKS_CUTOFF_TIME_DAYS: i64 = 10;
pub const MAX_AGE_MESSAGES_TO_UPDATE: i64 = 120;
pub const IMPORT_DIRECTION_FINDING_UUID: &str =
    "22b171e7-1c8a-469c-af68-79d7a06b99f4";
pub const REDIS_HOST: &str = "localhost";
pub const REDIS_PORT: u16 = 6379;
pub const MESSENGER_WORKER_LONG_SLEEP_MS: u64 = 5000;
pub const MESSENGER_WORKER_IDLE_SLEEP_MS: u64 = 100;
pub const MESSENGER_WORKER_BATCH_SIZE: u64 = 100;
pub const MESSENGER_UNLINKED_DISCORD_ALERT_TIMEOUT_SEC: u64 = 3;
pub const MESSENGER_PRIVATE_MESSAGE_DISCORD_ALERT_TIMEOUT_SEC: u64 = 3;
pub const MESSENGER_UNLINKED_DISCORD_ALERT_SUCCESS_COOLDOWN_SEC: u64 = 3600;
pub const MESSENGER_UNLINKED_DISCORD_ALERT_RETRY_DELAYS_SEC: [u64; 3] =
    [1, 5, 15];
pub const MESSENGER_UNLINKED_DATASOURCE_NOTIFICATION_STATE_REDIS_PREFIX: &str =
    "messenger:unlinked-datasource-notification-state";
pub const MESSENGER_UNLINKED_DATASOURCE_NOTIFICATION_STATE_TTL_SEC: u64 =
    24 * 60 * 60;
pub const MESSENGER_CLEANUP_OK_SLEEP_SEC: u64 = 600;
pub const MESSENGER_CLEANUP_ERR_SLEEP_SEC: u64 = 15;
pub const LONG_POLL_SLEEP_MS: u64 = 5000;
pub const NETWORK_INVALIDATION_BATCH_SIZE: u64 = 100; // actual limit in pg is around 25k, but it's better to do it in smaller batches
pub const NETWORK_INVALIDATION_TASK_FETCH_BATCH_SIZE: u64 = 1000;
pub const NETWORK_INVALIDATION_TASKS_FILTER_CHUNK: usize = 200;
pub const NETWORK_INVALIDATION_QUERY_MAX_PARAMS: usize = 60_000; // keep under PG 65_535 parameter cap
pub const NETWORK_INVALIDATION_DELETE_MAX_IDS: usize = 60_000; // keep under PG 65_535 parameter cap
pub const ONEOFF_CALCULATE_SIGNAL_MESSAGE_GROUPS_SLEEP_SEC: u64 = 10;
pub const ONEOFF_CALCULATE_SIGNAL_MESSAGR_GROUPS_BATCH_SIZE: u64 = 10000;
pub const ONEOFF_ETALONKA_REPORT_OUTPUT_DIR: &str = "/var/tmp";
pub const ONEOFF_REPROCESS_INBOX_METADATA_DEFAULT_DAYS: i64 = 60;
pub const WORKER_CALCULATE_GROUP_STATS_EVERY_MINUTES_NUM: i64 = 2;
pub const WORKER_CALCULATE_GROUP_STATS_SINCE_MINS: i64 = 60;
pub const WORKER_CALCULATE_GROUP_STATS_SLEEP_SEC: u64 = 10;
pub const GROUP_STATS_5MIN_TTL_DAYS: i64 = 14;
pub const GROUP_STATS_DAY_TTL_DAYS: i64 = 365;
/// Minimum time to keep a long-poll request open to accumulate events
pub const LONG_POLL_MIN_RESPONSE_TIME_MS: u64 = 500;
pub const REDIS_MAXLEN: usize = 1000;
pub const REDIS_SESSIONS_KEY: &str = "echo-sessions";
pub const SESSION_STREAM_LIFETIME_SEC: i64 = 180;
pub const SESSION_ACTIVITY_QUEUE_CAPACITY_DEFAULT: usize = 2048;
pub const SESSION_ACTIVITY_PAYLOAD_MAX_BYTES_DEFAULT: usize = 4096;
pub const SESSION_ACTIVITY_GREPTIME_GET_TIMEOUT_MS_DEFAULT: u64 = 2_000;
pub const SESSION_ACTIVITY_GREPTIME_QUERY_TIMEOUT_MS_DEFAULT: u64 = 5_000;
pub const INACTIVE_USERS_DEACTIVATE_DURATION_SEC: u64 = 3600;
pub const INACTIVE_USERS_DEACTIVATE_AFTER_DAYS: i64 = 30;
/// Default root prefix for encrypted messenger media stored on S3
pub const S3_MEDIA_ROOT_PREFIX: &str = "message-media";
pub const SIGNAL_CLIENT_DIR: &str = "/etc/echo/signal-cli-data";
pub const WHATSAPP_CLIENT_DIR: &str = "/etc/echo/whatsapp-cli-data";
pub const SIGNAL_UNIT_NAME: &str = "echo-signal-bot";
pub const WHATSAPP_UNIT_NAME: &str = "echo-whatsapp-bot";
pub const CLIENT_DATA_DIR_NAME: &str = "client_data";
pub const WHATSAPP_CLIENT_CONFIG: &str = "/etc/echo/config.toml";
pub const GENERATE_MESSAGE_UID_TILL_MAX_DAYS: i64 = 20;
pub const UNKNOWN_GROUP_MASTER_KEY: &str = "undefined_group";
pub const REDIS_MGS_ID_TTL: i32 = 3600;
// for xlsx import
pub const MESSENGER_WORKER_POOL_DEFAULT_CAPACITY: usize = 10;
/// Jun 1st 2024
pub const STATS_MIN_DATETIME_DAYS: i64 = 366;
pub const STATS_READ_FROM_TABLE_MINIMUM_MIN: i64 = 15;
pub const STATS_5MIN_MAX_NUM_DAYS: i64 = 2000; // FIXME change to 2
pub const FEATURE_GROUP_STATS_AGGREGATED_DEFAULT: bool = true;
pub const FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT: bool = true;
pub const FEATURE_ACCESS_LOG_DEFAULT: bool = false;
pub const ONEOFF_COUNT_BATCHES_SLEEP_MS: u64 = 200;
pub const ONEOFF_COUNT_BATCHES_SIZE: u64 = 10000;
pub const PALITRA_STORAGE_DIR_NAME: &str = "palitra_assets";
pub const PALITRA_KMZ_TOP_COLORS_LIMIT: usize = 20;
pub const PALITRA_POINTS_INSERT_BATCH_SIZE: usize = 10_000;
pub const PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE: usize = 5_000;
pub const PALITRA_POINT_FALLBACK_COLOR_HEX: &str = "#060606";
pub const PALITRA_DOWNLOAD_MAX_FILES: usize = 50;
pub const PALITRA_DOWNLOAD_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const PALITRA_DOWNLOAD_MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
pub const PALITRA_DELTA_DOWNLOAD_MAX_POINTS_PER_FILE: usize = 6_500;
/// Global limit when since_id_noninclusive and since_date_inclusive_ms is not set, safety measure
pub const RER_DUTY_MAX_DAYS: i64 = 3;
pub const RER_DUTY_SHORT_STATE_TTL_SEC: u64 = 60 * 24 * 60 * 60;
pub const RER_DUTY_SHORT_STATE_REDIS_KEY_PREFIX: &str = "rer-duty:filters:";
pub const RER_DUTY_SHORT_STATE_REDIS_HASH_KEY_PREFIX: &str =
    "rer-duty:filters:hash:";
pub const RER_IMPORTER_BOOKMARK_LIST_LIMIT: u64 = 100;
pub const RER_IMPORTER_IMPORTANT_LIST_LIMIT: u64 = 100;
pub const TAG_MINIMUM_CONFIDENCE: f64 = 0.8;
pub const TAG_MAXIMUM_CONFIDENCE: f64 = 1.0;
pub const SYSTEM_LOGIN_NAME: &str = "system";
pub const TAG_SUGGEST_WORKER_BATCH_SIZE: usize = 100;
pub const TAG_SUGGEST_WORKER_REGEX_CONFIDENCE: f64 = 0.8;

pub const MAX_FIX_WHATSAPP_SENDERS_MESSAGE_DAYS: i64 = 30;
pub const PALITRA_POINT_SEARCH_CACHE_TTL_SEC: u64 = 60;
pub const PALITRA_POINT_LABEL_SUGGEST_CACHE_TTL_SEC: u64 = 120;
pub const PALITRA_GOI_SYNC_JOB_KIND_UPLOAD: &str = "upload";
pub const PALITRA_GOI_SYNC_JOB_KIND_MOVE: &str = "move";
pub const PALITRA_GOI_SYNC_JOB_KIND_DELETE: &str = "delete";
pub const PALITRA_GOI_SYNC_WORKER_SLEEP_SEC: u64 = 5;
pub const PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC: u64 = 60;
pub const ORGANISM_GOI_SSH_PORT_DEFAULT: i32 = 22;
pub const ORGANISM_GOI_API_PORT_DEFAULT: i32 = 8088;
pub const ORGANISM_GOI_PATH_DEFAULT: &str = "/etc/goi/data/palettes";
pub const ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE: &str = "simple";
pub const ORGANISM_GOI_INTEGRATION_TYPE_FULL: &str = "full";
pub const ORGANISM_GOI_INTEGRATION_TYPE_DEFAULT: &str =
    ORGANISM_GOI_INTEGRATION_TYPE_FULL;
pub const ORGANISM_GOI_SSH_TIMEOUT_MS: u32 = 10_000;
pub const ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS: u32 = 900_000;
pub const ORGANISM_GOI_SSH_LIST_LIMIT: usize = 20;
pub const ORGANISM_GOI_FILE_LIST_LIMIT: usize = 50_000;
pub const ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS: u64 = 1_000;
pub const ORGANISM_GOI_API_TIMEOUT_SEC: u64 = 120;
pub const ORGANISM_GOI_ASSOCIATIONS_INSERT_BATCH_SIZE: usize = 1_000;
pub const ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_DEFAULT: u64 = 50;
pub const ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_MAX: u64 = 200;
pub const ORGANISM_GOI_KNOWLEDGE_UPSERT_BATCH_SIZE: usize = 1_000;
pub const ORGANISM_GOI_KNOWLEDGE_SYNC_INTERVAL_SEC: u64 = 60;
pub const ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS: i64 = 30;
pub const ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_DEFAULT: u64 = 50;
pub const ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_MAX: u64 = 200;
pub const ORGANISM_GOI_REPORT_PUSH_INTERVAL_SEC: u64 = 10 * 60;
pub const ORGANISM_GOI_PALITRA_FOLDER_SYNC_INTERVAL_SEC: u64 = 10 * 60;
pub const ORGANISM_KEYWORD_SET_MAX_SETS_PER_ORGANISM: usize = 50;
pub const ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET: usize = 1000;
pub const ORGANISM_KEYWORD_SET_MAX_WORD_LEN: usize = 64;
pub const ORGANISM_KEYWORD_SET_INFLECT_MAX_LEMMAS: usize = 20;
pub const NETWORK_INBOX_WORKER_DEFAULT_SLEEP: u64 = 30;
pub const NETWORK_INBOX_FRESH_WORKER_CUTOFF_DAYS: i64 = 40; // to ensure month reports are valid at all times
pub const NETWORK_INBOX_OLD_WORKER_CUTOFF_DAYS: i64 = 365;
pub const SIGINT_INBOX_NETWORK_CHECK_SLEEP_SECS: u64 = 2 * 60 * 60;
pub const WORKER_NIGHT_SHIFT_START_HOUR: u32 = 21;
pub const WORKER_NIGHT_SHIFT_END_HOUR: u32 = 7;
pub const WORKER_NIGHT_SHIFT_WAIT_BEFORE_START_SECS: u64 = 60;
pub const NETWORK_INBOX_OLD_WORKER_ACTIVE_REST_SECS: u64 = 2;
pub const SIGINT_INBOX_TUI_REFRESH_MS: u64 = 2000;
pub const SIGINT_INBOX_TUI_EVENT_POLL_MS: u64 = 250;
pub const SIGINT_INBOX_TUI_CHUNK_COUNT: usize = 10;
pub const SIGINT_INBOX_TUI_BUCKET_GAP: usize = 2;
pub const NETWORK_INBOX_OLD_WORKER_START_HOUR: u32 = 2;
pub const NETWORK_INBOX_OLD_WORKER_WAIT_BEFORE_START_SECS: u64 = 60;
pub const NETWORK_INBOX_OLD_WORKER_ACTIVE_WINDOW_SECS: u64 = 15;
pub const DEFAULT_STORE_PALITRA_IN_S3: bool = true;
pub const KMZ_CONTENT_TYPE: &str = "application/vnd.google-earth.kmz";
pub const ENCRYPTION_KEY_PLACEHOLDER: &str = "🔑";
pub const ENCRYPTION_KEY_DESCRIPTION_PLACEHOLDER: &str = "...";
pub const NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE: usize = 10;

pub const NETWORK_INVALIDATION_TASK_MAX_TASKS: u64 = 1_000_000;
pub const NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC: u64 = 600;
pub const NETWORK_INVALIDATION_TASK_TAG_OLD: &str = "old";
pub const NETWORK_INVALIDATION_TASK_TAG_RECENT: &str = "recent";
pub const NETWORK_INVALIDATION_TASK_TAG_UNASSIGNED: &str = "unassigned";

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
    pub cookie_session_secret: String,
    pub storage_dir: String,
    pub signal_api_phone: String,
    pub signal_import_group_name: String,
    pub signal_import_fiven_name: String,
    pub rer_duty_test_source_window_minutes: Option<i64>,
    pub static_path: String,
    pub executable_path: String,
    pub fill_comp_freq_worker: bool,
    pub disable_cleanup_networks_worker: Option<bool>,
    pub disable_unit_location_v2_worker: Option<bool>,
    pub disable_suggest_message_tags_worker: Option<bool>,
    pub backup_key_id: Option<String>,
    pub backup_key: Option<String>,
    /// Used for clustering in Babak report, 2km is the default
    pub cluster_radius: Option<f64>,
    pub feature_delta: Option<bool>,
    pub feature_analysis_map: Option<bool>,
    pub feature_access_log: Option<bool>,
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
    /// Enable secondary logs stream to Signoz from Vector (journald -> Signoz JSON receiver).
    pub signoz_logs_enabled: Option<bool>,
    /// Signoz JSON receiver endpoint, e.g. http://signoz-echo.eagle-atria.ts.net:8082.
    pub signoz_logs_endpoint: Option<String>,
    pub session_activity_queue_capacity: Option<usize>,
    pub session_activity_payload_max_bytes: Option<usize>,
    pub session_activity_greptime_get_timeout_ms: Option<u64>,
    pub session_activity_greptime_query_timeout_ms: Option<u64>,
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
    pub messenger_worker_pool_capacity: Option<usize>,
    pub feature_group_stats_aggregated: Option<bool>,
    pub feature_delete_uploaded_attachment: Option<bool>,
    pub feature_calculate_sigint_inbox_item_networks: Option<bool>,
    pub skip_discord_notifications: Option<bool>,
    pub s3_config: Option<S3Config>,
    pub store_palitra_in_s3: Option<bool>,
    pub alpine_converter_url: Option<String>,
    pub ai_models_config: Option<ModelsConfig>,
    pub network_invalidation_worker_night_shift_start_hour: Option<u32>,
    pub network_invalidation_worker_night_shift_end_hour: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct S3Config {
    /// S3-compatible access key (used for uploads, leave empty to disable)
    pub s3_access_key_id: String,
    /// S3-compatible secret key (used for uploads, leave empty to disable)
    pub s3_secret_access_key: String,
    /// S3 endpoint, e.g. https://s3.us-west-000.backblazeb2.com
    pub s3_endpoint: String,
    /// S3 region, e.g. us-west-000
    pub s3_region: String,
    /// Bucket where we store uploaded data
    pub s3_bucket: String,
    /// Base64-encoded key used for StrongBox encryption of uploaded blobs
    pub strongbox_key: String,
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

    pub fn rer_duty_test_source_window_minutes(&self) -> i64 {
        self.rer_duty_test_source_window_minutes
            .unwrap_or(RER_DUTY_TEST_SOURCE_WINDOW_MINUTES_DEFAULT)
            .max(1)
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ModelsConfig {
    pub s3_config: S3Config,
    pub prefix: String,
    pub worker: Option<bool>,
    pub directory: Option<String>,
}

pub fn mk_s3(config: &Config) -> Result<Option<Operator>> {
    if let Some(config) = &config.s3_config {
        let s3_config = storage::S3Config::from(config);
        let s3 = storage::build_s3_operator(&s3_config).c(h!())?;
        Ok(Some(s3))
    } else {
        Ok(None)
    }
}

pub fn mk_s3_config(config: &Config) -> Result<Option<storage::S3Config>> {
    if let Some(config) = &config.s3_config {
        let cfg = storage::S3Config::from(config);
        if !cfg.is_configured() {
            bail!("S3 config is not configured: {cfg:?}");
        }
        return Ok(Some(cfg));
    };
    Ok(None)
}

pub fn read_config(mode: Mode) -> Result<Config, AppError> {
    if let Ok(path) = std::env::var("ECHO_CONFIG_PATH") {
        info!("reading config from {path}...");
        return read_from_path(PathBuf::from(path));
    }
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

pub async fn wait_until_worker_shift_start(config: &Config) {
    loop {
        if check_is_worker_night_shift(config) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(
            WORKER_NIGHT_SHIFT_WAIT_BEFORE_START_SECS,
        ))
        .await;
    }
}

pub fn check_is_worker_night_shift(config: &Config) -> bool {
    let shift_start = config
        .network_invalidation_worker_night_shift_start_hour
        .unwrap_or(WORKER_NIGHT_SHIFT_START_HOUR);
    let shift_end = config
        .network_invalidation_worker_night_shift_end_hour
        .unwrap_or(WORKER_NIGHT_SHIFT_END_HOUR);
    let now = Utc::now().with_timezone(&get_tz());
    !(shift_end..shift_start).contains(&now.hour())
}
