use crate::storage;
use crate::types::*;
use anyhow::Result;
use chrono::Timelike;
use opendal::Operator;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_PG_HOST: &str = "localhost";
pub const DEFAULT_PG_PORT: u16 = 5432;
pub const DEFAULT_PG_USER: &str = "wd";
pub const DEFAULT_PG_PASSWORD: &str = "fee_-_-_-FnoeKFBeebu87bf";
pub const DEFAULT_PG_DBNAME: &str = "wd";
pub const DEFAULT_PG_WDFILE_DBNAME: &str = "wd_files";
pub const PG_POOL_DEFAULT_MAX_CONNECTIONS: u32 = 30;
pub const PG_POOL_BGWORKER_MAX_CONNECTIONS: u32 = 20;
pub const PG_WDFILE_POOL_MAX_CONNECTIONS: u32 = 10;
pub const PG_WDFILE_MIGRATION_POOL_MAX_CONNECTIONS: u32 = 1;
pub const FILE_REGISTRY_UNAVAILABLE_RETRY_AFTER_SECS: u64 = 60;
pub const PGBACKREST_CONF_PATH: &str = "/etc/pgbackrest/pgbackrest.conf";
pub const PGBACKREST_CONF_INCLUDE_DIR: &str = "/etc/pgbackrest/conf.d";
pub const PGBACKREST_STANZA_CONF_PREFIX: &str = "pgbackrest-";
pub const PGBACKREST_STANZA_CONF_SUFFIX: &str = ".conf";
pub const PG_SLOW_STATEMENT_THRESHOLD_MS: u64 = 5_000;
pub const ONEOFF_KILL_OLD_QUERIES_DEFAULT_MINUTES: u64 = 3;
pub const ONEOFF_KILL_OLD_QUERIES_QUERY_PREVIEW_CHARS: usize = 500;
pub const INBOX_ITEM_CALLSIGN_BACKFILL_BATCH_SIZE: u64 = 500;
pub const NLP_ADDR: &str = "http://127.0.0.1:5000";
pub const RQ_TIMEOUT: u64 = 10;
pub const AI_ENGINE_REQUEST_TIMEOUT_SEC: u64 = 300;
pub const AI_ENGINE_NAME_MAX_CHARS: usize = 255;
pub const AI_ENGINE_URL_MAX_CHARS: usize = 2048;
pub const AI_ENGINE_MODEL_NAME_MAX_CHARS: usize = 255;
pub const AI_ENGINE_TOKEN_MAX_CHARS: usize = 16_384;
pub const AI_ENGINE_ERROR_BODY_MAX_CHARS: usize = 2_000;
pub const AI_CHAT_PROMPT_MAX_CHARS: usize = 100_000;
pub const AI_CHAT_TITLE_MAX_CHARS: usize = 120;
pub const AI_CALLSIGN_SETTINGS_ID: i16 = 1;
pub const AI_CALLSIGN_PROMPT_MAX_CHARS: usize = 100_000;
pub const AI_CALLSIGN_MESSAGE_MAX_CHARS: usize = 100_000;
pub const AI_CALLSIGN_MAX_CALLSIGNS: usize = 500;
pub const AI_CALLSIGN_MAX_CHARS: usize = 255;
pub const AI_CALLSIGN_MAX_CONCURRENT_REQUESTS: usize = 4;
pub const AI_CALLSIGN_WORKER_IDLE_SLEEP_MS: u64 = 1_000;
pub const AI_CALLSIGN_WORKER_RETRY_BASE_SECS: i64 = 5;
pub const AI_CALLSIGN_WORKER_RETRY_MAX_SECS: i64 = 300;
pub const AI_CALLSIGN_WORKER_MAX_ATTEMPTS: i32 = 8;
pub const AI_CALLSIGN_WORKER_MAX_ERROR_CHARS: usize = 2_000;
pub const AI_CALLSIGN_DEFAULT_PROMPT: &str = r#"Знайди всі позивні у повідомленні користувача.
Поверни лише JSON-об'єкт у форматі {"callsigns":["ПОЗИВНИЙ"]}.
Не додавай пояснень. Якщо позивних немає, поверни {"callsigns":[]}."#;
pub const AI_CHAT_ROLE_SYSTEM: &str = "system";
pub const AI_CHAT_ROLE_USER: &str = "user";
pub const AI_CHAT_ROLE_ASSISTANT: &str = "assistant";
pub const ECHO_AUDIO_TRANSCRIPTION_CONCURRENCY: usize = 1;
pub const ECHO_AUDIO_TRANSCRIPTION_RETENTION_DAYS: i64 = 2;
pub const ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES: i64 = 104_857_600;
pub const ECHO_AUDIO_TRANSCRIPTION_CLEANUP_BATCH_SIZE: u64 = 100;
pub const ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE: u64 = 200;
pub const ECHO_AUDIO_TRANSCRIPTION_ACTIVE_SLEEP_MS: u64 = 100;
pub const ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS: u64 = 5_000;
pub const ECHO_AUDIO_TRANSCRIPTION_RETRY_BASE_SECS: u64 = 5;
pub const ECHO_AUDIO_TRANSCRIPTION_RETRY_MAX_SECS: u64 = 300;
pub const ECHO_AUDIO_TRANSCRIPTION_MAX_ATTEMPTS: i32 = 8;
pub const ECHO_AUDIO_TRANSCRIPTION_MAX_TOTAL_AGE_SECS: i64 = 86_400;
pub const ECHO_AUDIO_TRANSCRIPTION_MAX_ERROR_LEN: usize = 1_200;
pub const ECHO_AUDIO_TRANSCRIPTION_HEARTBEAT_SECS: u64 = 15;
pub const ECHO_AUDIO_TRANSCRIPTION_STALE_SECS: i64 = 120;
pub const ECHO_AUDIO_TRANSCRIPTION_SHUTDOWN_GRACE_SECS: u64 = 120;
pub const ECHO_AUDIO_TRANSCRIPTION_STATUS_LOG_INTERVAL_SECS: u64 = 60;
pub const ECHO_AUDIO_TRANSCRIPTION_BGWORKER_SERVICE: &str =
    "wdintel-rs-bgworker.service";
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
pub const API_INTEGRATION_IGGY_TEST_TIMEOUT_SEC: u64 = 10;
pub const API_INTEGRATION_IGGY_DEFAULT_STREAM: &str = "echo";
pub const API_INTEGRATION_IGGY_TOPIC_PARTITIONS_COUNT: u32 = 1;
pub const API_INTEGRATION_IGGY_WORKER_IDLE_SLEEP_SEC: u64 = 60;
pub const API_INTEGRATION_IGGY_WORKER_ACTIVE_SLEEP_MS: u64 = 100;
pub const API_INTEGRATION_IGGY_PUBLISH_RETRY_2_MS: u64 = 100;
pub const API_INTEGRATION_IGGY_PUBLISH_RETRY_3_MS: u64 = 1_000;
pub const API_INTEGRATION_IGGY_ANALYTICS_WINDOW_SEC: u64 = 60;
pub const RQ_TIMEOUT_ALPINE_CONVERTER: u64 = 600;
pub const RQ_TIMEOUT_LAUNCH_SUBPROCESS: u64 = 60;
pub const SERVER_JSON_PAYLOAD_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Grace period before the first Signal login check after wdintel-rs start (ms)
pub const SIGNAL_LOGIN_INITIAL_SLEEP_MS: u64 = 2_000;
pub const COORDS_PER_FREQ_LIMIT: usize = 100;
pub const COORDS_PER_FREQ_PER_LOC_LIMIT: usize = 10;
pub const SERVER_MONITORING_CACHE_TTL_SEC: u64 = 5;
pub const URL_NEED_VISIT_NOTIFICATION_MINS: i64 = 5;
pub const IDENTITY_DURATION_HOURS: u64 = 12;
pub const IDENTITY_SALT: &str = "IUBwdub783736#";
pub const ROLE_ADMIN: &str = "Admin";
pub const DEVICE_CUSTOM_FIELDS_MAX_COUNT: usize = 50;
pub const DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS: usize = 128;
pub const DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS: usize = 4096;
pub const DEVICE_NAME_MAX_CHARS: usize = 255;
pub const DEVICE_EXTERNAL_URL_MAX_CHARS: usize = 4096;
pub const DEVICE_LIST_DEFAULT_LIMIT: u64 = 100;
pub const DEVICE_LIST_MAX_LIMIT: u64 = 100;
pub const DEVICE_FILE_PAGE_DEFAULT_LIMIT: u64 = 100;
pub const DEVICE_FILE_PAGE_MAX_LIMIT: u64 = 100;
pub const DEVICE_FILE_SYNC_BATCH_MAX_COUNT: usize = 1_000;
pub const DEVICE_FILE_SUBTREE_COUNT_MAX_DIRECTORIES: usize = 100;
pub const DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS: usize = 3;
pub const DEVICE_FILE_SEARCH_FILTER_MAX_VALUES: usize = 50;
pub const DEVICE_FILE_SEARCH_NAME_QUERY_MIN_CHARS: usize = 3;
pub const DEVICE_FILE_SEARCH_NAME_QUERY_MAX_CHARS: usize = 255;
pub const DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS: usize = 16_384;
pub const DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES: usize = 65_536;
pub const DEVICE_FILE_PATH_COMPONENT_MAX_COUNT: usize = 256;
pub const DEVICE_FILE_PATH_COMPONENT_MAX_CHARS: usize = 1_024;
pub const DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS: usize = 16_384;
pub const DEVICE_FILE_MIME_TYPE_MAX_CHARS: usize = 255;
pub const DEVICE_FILE_EXTENSION_MAX_CHARS: usize = 255;
pub const DEVICE_FILE_CURSOR_MAX_BYTES: usize = 4096;
pub const SIGINT_SIGNAL_TIMEOUT_MS: u64 = 1000;
/// MESSAGE_ATTACHMENT_LIMIT_SYNC: keep this upload limit synchronized with
/// `RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES`, frontend
/// `MAX_MESSAGE_ATTACHMENTS` in `useMessageUppy.ts`, and
/// `RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES` in `MessageCardMedia.tsx`.
pub const SIGINT_MESSAGE_MAX_ATTACHMENTS: usize = 20;
/// MESSAGE_ATTACHMENT_LIMIT_SYNC: keep this archive-download limit synchronized
/// with `SIGINT_MESSAGE_MAX_ATTACHMENTS`, frontend
/// `MAX_MESSAGE_ATTACHMENTS` in `useMessageUppy.ts`, and
/// `RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES` in `MessageCardMedia.tsx`.
pub const RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES: usize = 20;
/// Keep synchronized with
/// `wdintel-web/src/ts/react/routes/shared/message-card/MessageCardMedia.tsx:RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES`.
pub const RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
pub const CLEANUP_REPORT_DAYS: u64 = 30;
pub const RER_REPORT_ERROR_CODE_HEADER_NAME: &str = "x-echo-error-code";
pub const RER_REPORT_PERMISSION_DENIED_ERROR_CODE: &str = "8125378";
pub const REPORT_HISTORY_IN_PROGRESS_TIMEOUT_SECS: u64 = 60 * 60;
pub const REPORT_HISTORY_ETALONKA_IN_PROGRESS_TIMEOUT_SECS: u64 = 3 * 60 * 60;
pub const REPORT_HISTORY_TIMEOUT_WORKER_SLEEP_SECS: u64 = 60;
pub const REPORT_HISTORY_DISCORD_ALERT_TIMEOUT_SEC: u64 = 3;
pub const REPORT_HISTORY_ETALONKA_WORKER_COUNT: usize = 2;
pub const REPORT_HISTORY_GLOBAL_WORKER_COUNT: usize = 4;
pub const ETALONKA_GEO_SCREENSHOT_CONCURRENCY: usize = 2;
pub const XLSX_WORKSHEET_ROW_MAX: usize = 1_048_576;
pub const RER_INTERCEPTION_REPORT_HEADER_ROWS_NUM: usize = 1;
pub const RER_REPORT_CHUNKING_HOURS_DEFAULT: i64 = 24;
pub const RER_REPORT_CHUNKING_HOURS_MIN: i64 = 1;
pub const RER_REPORT_CHUNKING_HOURS_MAX: i64 = i32::MAX as i64;
pub const RER_REPORT_CHUNKS_MAX: usize = 10_000;
pub const RER_CALLSIGN_QUERY_PARAM_CHUNK_SIZE: usize = 30_000;
pub const RER_REPORT_ENRICHMENT_ID_BATCH_SIZE: usize = 20_000;
pub const RER_BABAK_CANDIDATE_PAGE_SIZE: u64 = 5_000;
pub const RER_BABAK_ENRICHMENT_BATCH_SIZE: usize = 5_000;
pub const RER_MOUSE_REPORT_MESSAGE_MAX: usize = 10_000;
pub const RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE: &str =
    "mouse_report_message_limit";
pub const RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX: usize = 10_000;
pub const RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE: &str =
    "summary_table_report_message_limit";
pub const RER_SUMMARY_TABLE_UNKNOWN_LOCALITY: &str = "Невідомо";
pub const REPORT_HISTORY_LIST_LIMIT: u64 = 200;
pub const RER_DUTY_TEST_REPLAY_SOURCE_MAX: i64 = 10_000;
pub const RER_DUTY_TEST_REPLAY_INTERVAL_SEC_MAX: i64 = 31_536_000;
pub const RER_DUTY_TEST_REPLAY_COMMENT: &str = "[duplicate]";
pub const RER_DUTY_TEST_REPLAY_CLEANUP_BATCH_SIZE: u64 = 500;
pub const RER_DUTY_TEST_REPLAY_ADVISORY_LOCK_KEY: i64 = 7_312_025_041;
pub const RER_DUTY_TEST_REPLAY_IDLE_SLEEP_SEC: u64 = 1;
pub const RER_DUTY_TEST_REPLAY_DISABLED_SLEEP_SEC: u64 = 5;
pub const RER_DUTY_TEST_REPLAY_ERROR_SLEEP_SEC: u64 = 15;
// for xlsx import
pub const SIGNAL_DATASOURCE_ID: i64 = 1;
pub const SIGINT_SOURCE_RO_ID: i32 = 2;
pub const FEATURE_DESKTOP_YOUTUBE_KEYS: bool = true;
pub const DISCORD_WEBHOOK_INFRA: &str = "https://discord.com/api/webhooks/1417084833384890398/7jgZyC1zpmrJVXzUwDz-OQV6_UwqxUUl9GHehVyV9-UwxQRZjMg9ZwYYNJGPcAmuiGRA";
pub const DISCORD_WEBHOOK_ALERT: &str = "https://discord.com/api/webhooks/1417520789720141864/W6VARE0qARyP6XKdTs1mwh8zpO8nDosI-fHCAhn-6UtW0PyXx_M5890M3WAc7a76s_Nm";
pub const FEATURE_CALLSIGNS_ALG2: bool = false;
/// Safety limit: cut network-callsigns time window if too wide
pub const NETWORK_CALLSIGNS_MAX_WINDOW_DAYS: i64 = 60;
pub const SIGINT_CSV_UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
pub const SIGINT_NETWORK_LIST_DEFAULT_LIMIT: i64 = 100;
pub const SIGINT_NETWORK_LIST_MAX_LIMIT: u64 = 100;
pub const SIGINT_NETWORK_RELATION_MESSAGES_LIMIT_MAX: i64 = 50;
pub const SIGINT_NETWORK_FIND_LIVE_RETURN_LIMIT: usize = 10;
pub const SIGINT_NETWORK_FIND_LIVE_QUERY_LIMIT: u64 = 250;
pub const SIGINT_UNIT_AUTO_CYBER_NETWORK_NAME: &str = "💻";
/// Ukraine boundaries WGS84
pub const LAT_MIN: f64 = 40.0;
pub const LAT_MAX: f64 = 60.0;
pub const LON_MIN: f64 = 20.0;
pub const LON_MAX: f64 = 50.0;
pub const MAX_FREQS_GROUPS_BY_DAY: u64 = 10;
pub const CORRELATED_FREQS_MAX_DAYS: i64 = 30;
pub const ANALYSIS_CALLSIGN_FREQUENCY_MATCH_LIMIT: u64 = 200;
pub const ANALYSIS_CALLSIGN_GRAPH_MAX_DAYS: i64 = 31;
pub const ANALYSIS_CALLSIGN_GRAPH_MESSAGE_LIMIT: u64 = 100_000;
pub const ANALYSIS_CALLSIGN_GRAPH_NODE_LIMIT: usize = 5_000;
pub const ANALYSIS_CALLSIGN_GRAPH_EDGE_LIMIT: usize = 20_000;
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
pub const ECHO_IM_SYNC_RECOVERY_BATCH_SIZE: u64 = 10;
pub const ECHO_IM_SYNC_RECOVERY_SCAN_BATCH_SIZE: u64 = 100;
pub const ECHO_IM_SYNC_RECOVERY_LAG_MINUTES: i64 = 10;
pub const ECHO_IM_SYNC_RECOVERY_IDLE_SLEEP_SEC: i64 = 60;
pub const DATASOURCE_GROUP_LAST_SYNC_TOUCH_MINUTES: i64 = 60;
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
pub const MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR: &str = "/tmp";
pub const MESSENGER_MEDIA_CACHE_DIR_NAME: &str = "messenger_media_cache";
pub const MESSENGER_MEDIA_CACHE_PREFLIGHT_HEADER: &str =
    "x-echo-media-cache-preflight";
pub const MESSENGER_MEDIA_CACHE_MIN_FILE_SIZE_BYTES: i64 = 10 * 1024 * 1024;
pub const MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES: i64 =
    100 * 1024 * 1024;
pub const MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_FILE_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "mpeg", "mpg", "wmv", "flv",
    "f4v", "3gp", "3g2", "m2ts", "ogv", "vob", "asf",
];
pub const MESSENGER_MEDIA_AMBIGUOUS_VIDEO_FILE_EXTENSIONS: &[&str] =
    &["ts", "mts"];
pub const MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_CONTENT_TYPES: &[&str] = &[
    "video/mp4",
    "application/mp4",
    "video/x-m4v",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "application/x-matroska",
    "video/x-msvideo",
    "video/avi",
    "video/msvideo",
    "video/vnd.avi",
    "video/mpeg",
    "video/x-ms-wmv",
    "video/x-ms-asf",
    "video/x-flv",
    "video/x-f4v",
    "video/3gpp",
    "video/3gpp2",
    "video/mp2t",
    "video/vnd.dlna.mpeg-tts",
    "video/ogg",
    "video/dvd",
    "video/x-ms-vob",
];
pub const MESSENGER_MEDIA_CONTENT_TYPE_PROBE_SIZE_BYTES: usize = 16 * 1024;
pub const MESSENGER_MEDIA_MPEG_TS_PROBE_MIN_PACKETS: usize = 4;
pub const MESSENGER_MEDIA_MPEG_TS_PACKET_LAYOUTS: &[(usize, usize)] =
    &[(0, 188), (4, 192), (0, 204)];
pub const MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES: usize =
    8 * 1024 * 1024;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_SIZE_BYTES: u64 =
    2 * 1024 * 1024 * 1024;
pub const MESSENGER_MEDIA_MIGRATION_WHOLE_OBJECT_DECRYPT_MAX_SIZE_BYTES: u64 =
    5 * 1024 * 1024 * 1024;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_CONCURRENT_OPERATIONS:
    usize = 2;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_CONCURRENT_SMALL_OPERATIONS:
    usize = 16;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_SEMAPHORE_MIN_SIZE_BYTES: u64 =
    10 * 1024 * 1024;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_SMALL_QUEUE_TIMEOUT_SECS: u64 =
    5;
pub const MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_BUSY_RETRY_AFTER_SECS: u64 = 2;
pub const MESSENGER_MEDIA_CACHE_MAX_CONCURRENT_POPULATIONS: usize = 1;
pub const MESSENGER_MEDIA_CACHE_BUSY_RETRY_AFTER_SECS: u64 = 2;
pub const MESSENGER_MEDIA_CACHE_RETRYABLE_FAILURE_TTL_SECS: u64 = 10;
pub const MESSENGER_MEDIA_CACHE_FAILURE_TTL_SECS: u64 = 5 * 60;
pub const MESSENGER_MEDIA_CACHE_MAX_TRACKED_FAILURES: usize = 1_024;
pub const MESSENGER_MEDIA_CACHE_MAX_TOTAL_SIZE_BYTES: u64 =
    20 * 1024 * 1024 * 1024;
pub const MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS: u64 = 30 * 60;
pub const MESSENGER_MEDIA_PLAINTEXT_MIGRATION_ENCRYPTED_OBJECT_GRACE_SECS: i64 =
    2 * MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS as i64;
pub const MESSENGER_MEDIA_PLAINTEXT_MIGRATION_MARKER_CONTENT: &[u8] = b"1";
pub const MESSENGER_MEDIA_CACHE_TTL_SECS: u64 = 24 * 60 * 60;
pub const MESSENGER_MEDIA_CACHE_TEMP_TTL_SECS: u64 = 2 * 60 * 60;
pub const MESSENGER_MEDIA_CACHE_CLEANUP_INTERVAL_SECS: u64 = 15 * 60;
pub const MESSENGER_MEDIA_CACHE_DIR_MODE: u32 = 0o700;
pub const MESSENGER_MEDIA_CACHE_FILE_MODE: u32 = 0o600;
pub const MESSENGER_MEDIA_THUMBNAIL_DIR_NAME: &str = "thumbnails";
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_DIR_NAME: &str = "thumbnail_sources";
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_BUDGET_LOCK_FILE_NAME: &str =
    ".source-budget.lock";
pub const MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX: &str = ".jpg";
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX: &str = ".source";
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_FILE_SUFFIX: &str =
    ".source-ref";
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_FILE_SIZE_BYTES: u64 =
    16 * 1024;
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_TOTAL_SIZE_BYTES: u64 =
    16 * 1024 * 1024;
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_COUNT: usize = 512;
pub const MESSENGER_MEDIA_THUMBNAIL_WORKER_SCAN_INTERVAL_SECS: u64 = 5;
pub const MESSENGER_MEDIA_THUMBNAIL_ORPHAN_CLEANUP_INTERVAL_SECS: u64 = 15 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_ORPHAN_QUERY_BATCH_SIZE: usize = 1_000;
pub const MESSENGER_MEDIA_THUMBNAIL_MAX_TOTAL_SIZE_BYTES: u64 =
    2 * 1024 * 1024 * 1024;
pub const MESSENGER_MEDIA_THUMBNAIL_FFMPEG_TIMEOUT_SECS: u64 = 120;
pub const MESSENGER_MEDIA_THUMBNAIL_TEMP_TTL_SECS: u64 = 2 * 60 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_ORPHAN_SOURCE_TTL_SECS: u64 = 2 * 60 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_TTL_SECS: u64 = 24 * 60 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES: u64 =
    20 * 1024 * 1024 * 1024;
pub const MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT: usize = 1_024;
pub const MESSENGER_MEDIA_THUMBNAIL_MAX_RETRY_ATTEMPTS: u32 = 8;
pub const MESSENGER_MEDIA_THUMBNAIL_RETRY_INITIAL_SECS: u64 = 5;
pub const MESSENGER_MEDIA_THUMBNAIL_RETRY_MAX_SECS: u64 = 30 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_CONCURRENT_TASKS: usize = 1;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA: usize = 1_024;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS: u32 = 4;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_SECS: u64 =
    30 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_INITIAL_SECS: u64 = 5 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_MAX_SECS: u64 = 2 * 60 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_RECOVERY_TERMINAL_TTL_SECS: u64 =
    24 * 60 * 60;
pub const MESSENGER_MEDIA_THUMBNAIL_MAX_CONCURRENT_GENERATIONS: usize = 1;
pub const MESSENGER_MEDIA_THUMBNAIL_DIR_MODE: u32 = 0o700;
pub const MESSENGER_MEDIA_THUMBNAIL_FILE_MODE: u32 = 0o600;
pub const MESSENGER_MEDIA_THUMBNAIL_FFMPEG_BIN: &str = "ffmpeg";
pub const MESSENGER_MEDIA_THUMBNAIL_FFMPEG_FILTER: &str =
    "scale=640:-2:force_original_aspect_ratio=decrease,thumbnail=60";
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
pub const GROUP_STATS_REDIS_DB_DEFAULT: u8 = 1;
pub const GROUP_STATS_REDIS_KEY_PREFIX: &str = "echo:group-stats:v3";
pub const GROUP_STATS_REDIS_NETWORK_COMPLETE_FIELD: &str = "__complete";
pub const GROUP_STATS_REDIS_DETAIL_5MIN_TTL_DAYS: i64 = 16;
pub const GROUP_STATS_REDIS_GROUP_5MIN_TTL_DAYS: i64 = 91;
pub const GROUP_STATS_REDIS_DAY_TTL_DAYS: i64 = 367;
pub const GROUP_STATS_REDIS_ZSTD_LEVEL: i32 = 3;
pub const GROUP_STATS_REDIS_FINE_BUCKET_MAX_DAYS: i64 = 2;
pub const GROUP_STATS_REDIS_REPAIR_LOCK_TTL_SECS: u64 = 120;
pub const GROUP_STATS_REDIS_REPAIR_WAIT_TIMEOUT_SECS: u64 = 30;
pub const GROUP_STATS_REDIS_REPAIR_WAIT_INTERVAL_MS: u64 = 100;
pub const INBOX_COUNT_INDEXED_MAX_DAYS: i64 = 7;
pub const INBOX_COUNT_SINGLEFLIGHT_SUCCESS_TTL_MS: u64 = 5_000;
pub const INBOX_COUNT_SINGLEFLIGHT_STALE_SECS: u64 = 60;
pub const INBOX_COUNT_SINGLEFLIGHT_MAX_ENTRIES: usize = 2_048;
pub const GROUP_STATS_5MIN_TTL_DAYS: i64 = 14;
pub const GROUP_STATS_DAY_TTL_DAYS: i64 = 365;
pub const GROUP_STATS_RECALCULATION_TASK_STALE_MINUTES: i64 = 120;
pub const GROUP_STATS_RECALCULATION_TASK_CHUNK_DAYS: i64 = 1;
/// Minimum time to keep a long-poll request open to accumulate events
pub const LONG_POLL_MIN_RESPONSE_TIME_MS: u64 = 500;
pub const REDIS_MAXLEN: usize = 1000;
pub const REDIS_SESSIONS_KEY: &str = "echo-sessions";
pub const SESSION_STREAM_LIFETIME_SEC: i64 = 180;
pub const EVENT_STREAM_ORIGIN_HEADER: &str = "x-echo-event-origin";
pub const EVENT_STREAM_ORIGIN_MAX_BYTES: usize = 128;
pub const IDENTITY_SESSION_USER_ID_KEY: &str = "actix_identity.user_id";
pub const SESSION_ACTIVITY_QUEUE_CAPACITY_DEFAULT: usize = 2048;
pub const SESSION_ACTIVITY_PAYLOAD_MAX_BYTES_DEFAULT: usize = 4096;
pub const SESSION_ACTIVITY_GREPTIME_BATCH_SIZE: usize = 100;
pub const SESSION_ACTIVITY_GREPTIME_BATCH_MAX_SPAN_MS: i64 = 1_000;
pub const SESSION_ACTIVITY_GREPTIME_GET_TIMEOUT_MS_DEFAULT: u64 = 2_000;
pub const SESSION_ACTIVITY_GREPTIME_QUERY_TIMEOUT_MS_DEFAULT: u64 = 5_000;
pub const INACTIVE_USERS_DEACTIVATE_DURATION_SEC: u64 = 3600;
pub const INACTIVE_USERS_DEACTIVATE_AFTER_DAYS: i64 = 30;
/// Default root prefix for encrypted messenger media stored on S3
pub const S3_MEDIA_ROOT_PREFIX: &str = "message-media";
pub const SIGINT_UNIT_ATTACHMENT_MAX_FILE_BYTES: usize = 50 * 1024 * 1024;
pub const SIGINT_UNIT_ATTACHMENT_MAX_ENCRYPTED_BYTES: u64 = 51 * 1024 * 1024;
pub const SIGINT_UNIT_ATTACHMENT_DOWNLOAD_TIMEOUT_SECS: u64 = 60;
pub const SIGINT_UNIT_ATTACHMENT_MAX_FILENAME_CHARS: usize = 255;
pub const SIGINT_UNIT_ATTACHMENT_MAX_SHORT_DESCRIPTION_CHARS: usize = 500;
pub const SIGINT_UNIT_ATTACHMENT_MAX_FULL_DESCRIPTION_CHARS: usize = 20_000;
pub const SIGINT_UNIT_ATTACHMENT_MAX_AORS: usize = 100;
pub const SIGINT_UNIT_ATTACHMENT_MAX_METADATA_FIELD_BYTES: usize = 80 * 1024;
pub const SIGNAL_CLIENT_DIR: &str = "/etc/echo/signal-cli-data";
pub const WHATSAPP_CLIENT_DIR: &str = "/etc/echo/whatsapp-cli-data";
pub const SIGNAL_UNIT_NAME: &str = "echo-signal-bot";
pub const WHATSAPP_UNIT_NAME: &str = "echo-whatsapp-bot";
pub const MESSENGER_SYSTEM_SERVICE_NAME_MAX_LEN: usize = 50;
pub const MESSENGER_SYSTEM_SERVICE_NAME_CANDIDATE_LIMIT: usize = 1_000;
pub const CLIENT_DATA_DIR_NAME: &str = "client_data";
pub const WHATSAPP_CLIENT_CONFIG: &str = "/etc/echo/config.toml";
pub const GENERATE_MESSAGE_UID_TILL_MAX_DAYS: i64 = 20;
pub const UNKNOWN_GROUP_MASTER_KEY: &str = "undefined_group";
pub const OPERATOR_INBOX_WORKER_LOOKBACK_HOURS: i64 = 3;
pub const REDIS_MGS_ID_TTL: i32 = 3600;
pub const SIGNOZ_METRICS_EXPORT_INTERVAL_SECS: u64 = 60;
pub const SIGNOZ_METRICS_SERVICE_NAME: &str = "wdintel-rs";
pub const SIGNOZ_METRICS_SERVICE_NAMESPACE: &str = "echo";
// for xlsx import
pub const MESSENGER_WORKER_POOL_DEFAULT_CAPACITY: usize = 10;
/// Jun 1st 2024
pub const STATS_MIN_DATETIME_DAYS: i64 = 366;
pub const STATS_READ_FROM_TABLE_MINIMUM_MIN: i64 = 15;
pub const FEATURE_GROUP_STATS_AGGREGATED_DEFAULT: bool = true;
pub const FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT: bool = true;
pub const FEATURE_ACCESS_LOG_DEFAULT: bool = false;
pub const FEATURE_SIGINT_COMMENT_PARSING_DEFAULT: bool = false;
pub const FEATURE_SIGINT_COMMENT_PARSING_ENV: &str =
    "ECHO_FEATURE_SIGINT_COMMENT_PARSING";
pub const SIGINT_COMMENT_LEGACY_BLACKLIST_TEXT: &str = "Службовий радіообмін";
pub const DEVICE_NAME_SEARCH_LIMIT: u64 = 20;
pub const SETTLEMENTS_LEGACY_FILE: &str = "settlements.json";
pub const SETTLEMENTS_REGIONS_DIR: &str = "settlements_json";
pub const SETTLEMENTS_REGION_FILE_EXTENSION: &str = "json";
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
pub const RER_INBOX_PARSED_DATETIME_MAX_FUTURE_HOURS: i64 = 24;
pub const RER_DUTY_SHORT_STATE_TTL_SEC: u64 = 60 * 24 * 60 * 60;
pub const RER_DUTY_SHORT_STATE_REDIS_KEY_PREFIX: &str = "rer-duty:filters:";
pub const RER_DUTY_SHORT_STATE_REDIS_HASH_KEY_PREFIX: &str =
    "rer-duty:filters:hash:";
pub const RER_IMPORTER_BOOKMARK_LIST_LIMIT: u64 = 100;
pub const RER_IMPORTER_IMPORTANT_LIST_LIMIT: u64 = 100;
pub const RER_REPORT_OTHER_TAG_LABEL: &str = "інше";
pub const TAG_MINIMUM_CONFIDENCE: f64 = 0.7;
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
pub const PALITRA_GOI_RECONCILE_INTERVAL_SEC: u64 = 300;
pub const PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC: u64 = 60;
pub const PALITRA_CONVERSION_WORKER_SLEEP_SEC: u64 = 5;
pub const PALITRA_CONVERSION_JOB_STALE_PROCESSING_SEC: u64 = 30 * 60;
pub const PALITRA_CONVERSION_JOB_TIMEOUT_SEC: u64 = 30 * 60;
pub const PALITRA_CONVERSION_STATUS_READY: &str = "ready";
pub const PALITRA_CONVERSION_STATUS_PROCESSING: &str = "processing";
pub const PALITRA_CONVERSION_STATUS_ERROR: &str = "error";
pub const PALITRA_CONVERSION_JOB_STATUS_PENDING: &str = "pending";
pub const PALITRA_CONVERSION_JOB_STATUS_PROCESSING: &str = "processing";
pub const PALITRA_CONVERSION_JOB_STATUS_DONE: &str = "done";
pub const PALITRA_CONVERSION_JOB_STATUS_ERROR: &str = "error";
pub const PALITRA_GOI_SYNC_DIRECTION_ECHO: &str = "echo";
pub const PALITRA_GOI_SYNC_DIRECTION_GOI: &str = "goi";
pub const PALITRA_GOI_REMOTE_STATUS_PRESENT: &str = "present";
pub const PALITRA_GOI_REMOTE_STATUS_MISSING: &str = "missing";
pub const PALITRA_GOI_REMOTE_STATUS_ERROR: &str = "error";
pub const PALITRA_ALLOWED_UPLOAD_EXTENSIONS: &[&str] = &[
    "kmz", "kml", "gpx", "trk", "ldk", "geojson", "rte", "wpt", "are",
];
pub const PALITRA_DIRECT_PARSE_EXTENSIONS: &[&str] = &["kmz", "kml"];
// PGD conversion exists upstream, but it is not stable enough yet, so Echo
// does not permit PGD uploads for palitras for now.
pub const PALITRA_BLOCKED_UNSTABLE_UPLOAD_EXTENSIONS: &[&str] = &["pgd"];
pub const ORGANISM_GOI_SSH_PORT_DEFAULT: i32 = 22;
pub const ORGANISM_GOI_API_PORT_DEFAULT: i32 = 8088;
pub const ORGANISM_GOI_PATH_DEFAULT: &str = "/etc/goi/data/palettes";
pub const ORGANISM_GOI_PALETTES_DIR_NAME: &str = "palettes";
pub const ORGANISM_GOI_CATEGORIES_FILE_NAME: &str = "categories.json";
pub const ORGANISM_GOI_CATEGORIES_UPLOAD_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ORGANISM_GOI_CATEGORIES_JSON_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ORGANISM_GOI_INTEGRATION_TYPE_SIMPLE: &str = "simple";
pub const ORGANISM_GOI_INTEGRATION_TYPE_FULL: &str = "full";
pub const ORGANISM_GOI_INTEGRATION_TYPE_DEFAULT: &str =
    ORGANISM_GOI_INTEGRATION_TYPE_FULL;
pub const ORGANISM_GOI_SSH_TIMEOUT_MS: u32 = 10_000;
pub const ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS: u32 = 900_000;
pub const ORGANISM_GOI_SSH_LIST_LIMIT: usize = 20;
pub const ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS: u64 = 1_000;
pub const ORGANISM_GOI_SYNC_WORKER_COUNT: usize = 4;
pub const ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE: u64 = 100;
pub const ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE: u64 = 1_000;
pub const ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS: i64 = 24;
pub const ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT: u64 = 10;
pub const ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX: usize = 13;
pub const ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS: usize = 20;
pub const ORGANISM_GOI_MESSAGE_UID_SOURCE_DATE_TOLERANCE_MINUTES: i64 = 5;
pub const ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC: u64 = 60;
pub const ORGANISM_GOI_API_TIMEOUT_SEC: u64 = 120;
pub const ORGANISM_GOI_ASSOCIATIONS_INSERT_BATCH_SIZE: usize = 1_000;
pub const ORGANISM_GOI_ASSOCIATIONS_SYNC_INTERVAL_SEC: u64 = 60;
pub const ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_DEFAULT: u64 = 50;
pub const ORGANISM_GOI_ASSOCIATIONS_PAGE_LIMIT_MAX: u64 = 200;
pub const ORGANISM_GOI_KNOWLEDGE_PRUNE_BATCH_SIZE: u64 = 10_000;
pub const ORGANISM_GOI_KNOWLEDGE_UPSERT_BATCH_SIZE: usize = 1_000;
pub const ORGANISM_GOI_KNOWLEDGE_SYNC_INTERVAL_SEC: u64 = 60;
pub const ORGANISM_GOI_KNOWLEDGE_SYNC_FAILURE_BACKOFF_SEC: u64 = 10 * 60;
pub const ORGANISM_GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS: i64 = 30;
pub const ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_DEFAULT: u64 = 50;
pub const ORGANISM_GOI_KNOWLEDGE_PAGE_LIMIT_MAX: u64 = 200;
pub const ORGANISM_GOI_REPORT_PUSH_INTERVAL_SEC: u64 = 10 * 60;
pub const ORGANISM_GOI_REPORT_XLSX_CREATION_DATE: (u16, u8, u8) = (2026, 1, 1);
pub const ORGANISM_GOI_PALITRA_FOLDER_SYNC_INTERVAL_SEC: u64 = 10 * 60;
pub const ONEOFF_GOI_KNOWLEDGE_DELETE_BATCH_SIZE_DEFAULT: u64 = 1_000;
pub const ONEOFF_GOI_KNOWLEDGE_DELETE_SLEEP_MS_DEFAULT: u64 = 100;
pub const ORGANISM_KEYWORD_SET_MAX_SETS_PER_ORGANISM: usize = 50;
pub const ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET: usize = 1000;
pub const ORGANISM_KEYWORD_SET_MAX_WORD_LEN: usize = 64;
pub const ORGANISM_KEYWORD_SET_INFLECT_MAX_LEMMAS: usize = 20;
pub const NETWORK_INBOX_WORKER_DEFAULT_SLEEP: u64 = 30;
pub const NETWORK_INBOX_FRESH_WORKER_CUTOFF_DAYS: i64 = 40; // to ensure month reports are valid at all times
pub const NETWORK_INBOX_OLD_WORKER_CUTOFF_DAYS: i64 = 365;
pub const UNIT_TAG_RECALC_HISTORY_DAYS: i64 = 40;
pub const UNIT_TAG_QUEUE_WORKER_SLEEP_SECS: u64 = 5;
pub const UNIT_TAG_QUEUE_WORKER_BATCH_SIZE: u64 = 100;
pub const SIGINT_INBOX_NETWORK_CHECK_SLEEP_SECS: u64 = 2 * 60 * 60;
pub const SIGINT_INBOX_NETWORK_CHECK_BATCH_SIZE: u64 = 500;
pub const SIGINT_INBOX_NETWORK_CHECK_MISMATCH_LOG_LIMIT: usize = 10;
pub const WORKER_NIGHT_SHIFT_START_HOUR: u32 = 21;
pub const WORKER_NIGHT_SHIFT_END_HOUR: u32 = 7;
pub const WORKER_NIGHT_SHIFT_WAIT_BEFORE_START_SECS: u64 = 60;
pub const NETWORK_INBOX_OLD_WORKER_ACTIVE_REST_SECS: u64 = 2;
pub const SIGINT_INBOX_TUI_REFRESH_MS: u64 = 2000;
pub const SIGINT_INBOX_TUI_EVENT_POLL_MS: u64 = 250;
pub const ORBIT_TUI_EVENT_POLL_MS: u64 = 250;
pub const ORBIT_STALE_GRACE_SECONDS: i64 = 5;
pub const ORBIT_IMPORT_ADVISORY_LOCK_KEY: i64 =
    i64::from_be_bytes(*b"ORBITIMP");
pub const ORBIT_IMPORT_STORAGE_PREFIX: &str = "orbit-import";
pub const ORBIT_IMPORT_UNITS_FILE_NAME: &str = "orbit_units.parquet";
pub const ORBIT_IMPORT_GROUPING_OF_FORCES_FILE_NAME: &str =
    "orbit_grouping_of_forces.parquet";
pub const ORBIT_IMPORT_COMBAT_UNIT_TYPE_FILE_NAME: &str =
    "orbit_combat_unit_type.parquet";
pub const ORBIT_IMPORT_UNIT_ECHELON_FILE_NAME: &str =
    "orbit_unit_echelon.parquet";
pub const ORBIT_MATCHING_SIGINT_NAME_BLACKLIST: &[&str] =
    &["ТерО", "ТрО", "(ат)"];
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
pub const ANALYTICS_CONNECT_TIMEOUT_MS_DEFAULT: u64 = 5_000;
pub const ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT: u64 = 30_000;
pub const ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT: u64 = 90_000;
pub const ANALYTICS_RETRY_COOLDOWN_MS_DEFAULT: u64 = 30_000;
pub const ANALYTICS_HEALTH_LOG_INTERVAL_SECS: u64 = 60;
pub const ANALYTICS_SOURCE_CONFIG_PATH: &str = "/etc/echo-peerdb/source.env";
pub const ANALYTICS_SOURCE_EXCLUSIONS_PATH: &str =
    "/etc/echo-peerdb/tables-exclude.txt";
pub const ANALYTICS_PACKAGED_EXCLUSIONS_PATH: &str =
    "/opt/echo-peerdb/env/tables-exclude.txt";
pub const ANALYTICS_LOCAL_EXCLUSIONS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../deploy/clickhouse/env/tables-exclude.txt"
);
pub const ANALYTICS_TABLE_RECONCILE_SERVICE: &str =
    "echo-peerdb-table-reconcile.service";

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
    pub file_registry: Option<FileRegistryConfig>,
    pub cookie_session_secret: String,
    pub storage_dir: String,
    pub signal_api_phone: String,
    pub signal_import_group_name: String,
    pub signal_import_fiven_name: String,
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
    pub group_stats_redis_db: Option<u8>,
    pub greptime_host: Option<String>,
    pub greptime_port: Option<u16>,
    pub greptime_user: Option<String>,
    pub greptime_password: Option<String>,
    pub greptime_dbname: Option<String>,
    /// Enable secondary logs stream to Signoz from Vector (journald -> Signoz JSON receiver).
    pub signoz_logs_enabled: Option<bool>,
    /// Signoz JSON receiver endpoint, e.g. http://signoz-echo.eagle-atria.ts.net:8082.
    pub signoz_logs_endpoint: Option<String>,
    /// Enable device metrics export to Signoz over OTLP gRPC.
    pub signoz_metrics_enabled: Option<bool>,
    /// Signoz OTLP gRPC endpoint, e.g. http://signoz-echo.eagle-atria.ts.net:4317.
    pub signoz_metrics_endpoint: Option<String>,
    pub session_activity_queue_capacity: Option<usize>,
    pub session_activity_payload_max_bytes: Option<usize>,
    pub session_activity_greptime_get_timeout_ms: Option<u64>,
    pub session_activity_greptime_query_timeout_ms: Option<u64>,
    pub feature_tmp_in_memory: Option<bool>,
    pub feature_strict_networks: Option<bool>,
    pub feature_my_admin_groups_edit: Option<bool>,
    pub is_slave: Option<bool>,
    pub disable_inactive_users_worker: Option<bool>,
    pub replicas: Option<Vec<ReplicaConfig>>,
    pub analytics: Option<AnalyticsConfig>,
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
pub struct FileRegistryConfig {
    pub pg_host: Option<String>,
    pub pg_port: Option<u16>,
    pub pg_user: Option<String>,
    pub pg_password: Option<String>,
    pub pg_dbname: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct AnalyticsConfig {
    pub pg_host: String,
    pub pg_port: Option<u16>,
    pub pg_user: String,
    pub pg_password: String,
    pub pg_dbname: String,
    pub connect_timeout_ms: Option<u64>,
    pub query_timeout_ms: Option<u64>,
    pub freshness_max_age_ms: Option<u64>,
    pub retry_cooldown_ms: Option<u64>,
}

impl AnalyticsConfig {
    pub fn connect_timeout_ms(&self) -> u64 {
        self.connect_timeout_ms
            .unwrap_or(ANALYTICS_CONNECT_TIMEOUT_MS_DEFAULT)
    }

    pub fn query_timeout_ms(&self) -> u64 {
        self.query_timeout_ms
            .unwrap_or(ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT)
    }

    pub fn freshness_max_age_ms(&self) -> u64 {
        self.freshness_max_age_ms
            .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT)
    }

    pub fn retry_cooldown_ms(&self) -> u64 {
        self.retry_cooldown_ms
            .unwrap_or(ANALYTICS_RETRY_COOLDOWN_MS_DEFAULT)
    }
}

impl Config {
    pub fn group_stats_redis_db(&self) -> u8 {
        self.group_stats_redis_db
            .unwrap_or(GROUP_STATS_REDIS_DB_DEFAULT)
    }

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
    let old = vec![SETTLEMENTS_LEGACY_FILE.to_string()];
    let settlement_paths = match m_settlement_path {
        // old settlements.json logic (all in one file)
        None => old,
        Some(v) => {
            if v.trim().is_empty() {
                old
            } else {
                v.split(',')
                    .map(|s| {
                        format!(
                            "{SETTLEMENTS_REGIONS_DIR}/{}.{SETTLEMENTS_REGION_FILE_EXTENSION}",
                            s.trim()
                        )
                    })
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
    let config = std::fs::read_to_string(&path).with_context(|| {
        format!("failed to read configuration file {}", path.display())
    })?;
    let (config, unused_keys) = deserialize_config(&config).context(h!())?;
    warn_about_unused_config_keys(&path, &unused_keys);
    Ok(config)
}

fn deserialize_config<'de, T>(
    config: &'de str,
) -> std::result::Result<(T, Vec<String>), toml::de::Error>
where
    T: Deserialize<'de>,
{
    let mut unused_keys = Vec::new();
    let deserializer = toml::Deserializer::parse(config)?;
    let config = serde_ignored::deserialize(deserializer, |path| {
        unused_keys.push(path.to_string())
    })?;
    unused_keys.sort();
    unused_keys.dedup();
    Ok((config, unused_keys))
}

fn warn_about_unused_config_keys(path: &Path, unused_keys: &[String]) {
    if unused_keys.is_empty() {
        return;
    }
    warn!("{}", unused_config_warning(path, unused_keys));
}

fn unused_config_warning(path: &Path, unused_keys: &[String]) -> String {
    let keys = unused_keys
        .iter()
        .map(|key| format!("  - {key}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\n\
================================================================================\n\
WARNING: UNUSED CONFIG KEYS IN {}\n\
{}\n\
These keys are not used anymore. Remove them from config.toml. Their settings were either removed or migrated to the database.\n\
================================================================================",
        path.display(),
        keys,
    )
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

#[cfg(test)]
mod config_tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct TestConfig {
        active: String,
        nested: TestNestedConfig,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct TestNestedConfig {
        parsed: bool,
    }

    #[test]
    fn deserialize_config_reports_unused_keys() {
        let input = r#"
active = "yes"
removed = 1

[nested]
parsed = true
migrated = "database"
"#;

        let (config, unused_keys) =
            deserialize_config::<TestConfig>(input).unwrap();

        assert_eq!(config.active, "yes");
        assert!(config.nested.parsed);
        assert_eq!(unused_keys, ["nested.migrated", "removed"]);
    }

    #[test]
    fn unused_config_warning_is_prominent_and_actionable() {
        let warning = unused_config_warning(
            Path::new("/etc/echo/config.toml"),
            &["removed".to_string()],
        );

        assert!(warning.contains("WARNING: UNUSED CONFIG KEYS"));
        assert!(warning.contains("  - removed"));
        assert!(warning.contains("removed or migrated to the database"));
    }

    #[test]
    fn missing_config_error_includes_its_path() {
        let path = PathBuf::from(format!(
            "/tmp/missing-echo-config-{}.toml",
            Uuid::new_v4()
        ));
        let error = read_from_path::<TestConfig>(path.clone()).unwrap_err();

        assert!(format!("{error:?}").contains(&path.display().to_string()));
    }

    #[test]
    fn analytics_config_uses_bounded_default_timeouts() {
        let analytics: AnalyticsConfig = toml::from_str(
            r#"
pg_host = "echo-dev-clickhouse"
pg_user = "echo_analytics"
pg_password = "secret"
pg_dbname = "echo_analytics_gateway"
"#,
        )
        .unwrap();

        assert_eq!(analytics.pg_port, None);
        assert_eq!(
            analytics.connect_timeout_ms(),
            ANALYTICS_CONNECT_TIMEOUT_MS_DEFAULT
        );
        assert_eq!(
            analytics.query_timeout_ms(),
            ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT
        );
        assert_eq!(
            analytics.freshness_max_age_ms(),
            ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT
        );
        assert_eq!(
            analytics.retry_cooldown_ms(),
            ANALYTICS_RETRY_COOLDOWN_MS_DEFAULT
        );
    }

    #[test]
    #[serial_test::serial]
    fn file_registry_database_config_is_nested_and_uses_test_override() {
        let configured: Config = toml::from_str(
            r#"
public_host = ""
cookie_session_secret = ""
storage_dir = ""
signal_api_phone = ""
signal_import_group_name = ""
signal_import_fiven_name = ""
static_path = ""
executable_path = ""
fill_comp_freq_worker = false

[file_registry]
pg_host = "file-host"
pg_port = 5433
pg_user = "file-user"
pg_password = "file-password"
pg_dbname = "file-db"
"#,
        )
        .unwrap();
        let file_registry = configured.file_registry.as_ref().unwrap();
        assert_eq!(file_registry.pg_host.as_deref(), Some("file-host"));
        assert_eq!(file_registry.pg_port, Some(5433));
        assert_eq!(file_registry.pg_user.as_deref(), Some("file-user"));
        assert_eq!(file_registry.pg_password.as_deref(), Some("file-password"));
        assert_eq!(file_registry.pg_dbname.as_deref(), Some("file-db"));
        assert_eq!(
            crate::mk_wdfile_conn_string(file_registry, Mode::Debug),
            "postgresql://file-user:file-password@file-host:5433/file-db"
        );

        let absent: Config = toml::from_str(
            r#"
public_host = ""
cookie_session_secret = ""
storage_dir = ""
signal_api_phone = ""
signal_import_group_name = ""
signal_import_fiven_name = ""
static_path = ""
executable_path = ""
fill_comp_freq_worker = false
"#,
        )
        .unwrap();
        assert_eq!(absent.file_registry, None);

        let defaults: Config = toml::from_str(
            r#"
public_host = ""
cookie_session_secret = ""
storage_dir = ""
signal_api_phone = ""
signal_import_group_name = ""
signal_import_fiven_name = ""
static_path = ""
executable_path = ""
fill_comp_freq_worker = false

[file_registry]
"#,
        )
        .unwrap();
        let defaults = defaults.file_registry.as_ref().unwrap();
        let expected_default =
            "postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd_files";
        assert_eq!(
            crate::mk_wdfile_conn_string(defaults, Mode::Debug),
            expected_default
        );

        let previous = std::env::var_os("TEST_WDFILE_DB_NAME");
        std::env::set_var(
            "TEST_WDFILE_DB_NAME",
            "temporary-file-registry-database",
        );
        let test_conn_string =
            crate::mk_wdfile_conn_string(defaults, Mode::Test);
        match previous {
            Some(value) => {
                std::env::set_var("TEST_WDFILE_DB_NAME", value);
            }
            None => {
                std::env::remove_var("TEST_WDFILE_DB_NAME");
            }
        }

        assert_eq!(
            crate::mk_wdfile_conn_string(defaults, Mode::Live),
            expected_default
        );
        assert_eq!(
            test_conn_string,
            "postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/temporary-file-registry-database"
        );
    }
}
