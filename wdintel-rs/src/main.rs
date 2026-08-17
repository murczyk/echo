#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]
#![allow(clippy::borrow_interior_mutable_const)]
#![allow(clippy::ptr_arg)]
use crate::users::ensure_rer_role_by_id;

use crate::config::*;
use crate::types::*;
use anyhow::Context;
use clap::Parser;
use redis::aio::ConnectionManager;
use redis::ConnectionLike;
use rustls::crypto::ring;
use std::sync::atomic::{AtomicU32, AtomicU8, AtomicUsize, Ordering};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

pub mod ai_agent;
pub mod ai_callsign;
pub mod ai_engine;
mod alpine;
pub mod api_integrations;
pub mod atak;
pub mod aws;
pub mod backup;
pub mod config;
pub mod datasource;
pub mod delta;
pub mod devices;
pub mod elm;
pub mod entities;
pub mod error;
pub mod event_stream;
pub mod file_registry;
pub mod functest;
pub mod icons;
pub mod iggy;
pub mod importer;
pub mod inbox;
mod install;
pub mod kml;
pub mod kv;
mod location;
pub mod log_api;
pub mod logging;
pub mod media_summary;
pub mod message_queue;
pub mod messenger;
pub mod migration;
pub mod ml;
pub mod nlp;
pub mod ocr;
pub mod oneoff;
pub mod operator;
pub mod orbit;
pub mod organism;
pub mod palitra;
pub mod report_history;
pub mod rer_importer;
pub mod secret;
pub mod server;
pub mod session;
pub mod sigint;
mod stats;
pub mod storage;
pub mod system_settings;
pub mod tags;
pub mod telemetry;
pub mod terminal;
pub mod tests;
pub mod transcriber;
pub mod ts;
pub mod types;
pub mod unit;
pub mod user_settings;
pub mod users;
pub mod utils;

#[macro_export]
macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

static RUNTIME_THREAD_INDEX: AtomicUsize = AtomicUsize::new(0);
static PG_POOL_MAX_CONNECTIONS: AtomicU32 =
    AtomicU32::new(PG_POOL_DEFAULT_MAX_CONNECTIONS);
static PG_RUNTIME_POOL_ROLE: AtomicU8 = AtomicU8::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PgRuntimePoolRole {
    Web,
    Bgworker,
    ReportWorker,
}

impl PgRuntimePoolRole {
    fn application_name(self) -> &'static str {
        match self {
            Self::Web => "echo-web",
            Self::Bgworker => "echo-bgworker",
            Self::ReportWorker => "echo-report-worker",
        }
    }

    fn max_connections(self) -> u32 {
        match self {
            Self::Web => PG_POOL_DEFAULT_MAX_CONNECTIONS,
            Self::Bgworker | Self::ReportWorker => {
                PG_POOL_BGWORKER_MAX_CONNECTIONS
            }
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Web => 1,
            Self::Bgworker => 2,
            Self::ReportWorker => 3,
        }
    }

    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Web),
            2 => Some(Self::Bgworker),
            3 => Some(Self::ReportWorker),
            _ => None,
        }
    }
}

pub fn use_pg_runtime_pool(role: PgRuntimePoolRole) {
    PG_POOL_MAX_CONNECTIONS.store(role.max_connections(), Ordering::Relaxed);
    PG_RUNTIME_POOL_ROLE.store(role.as_u8(), Ordering::Relaxed);
}

fn pg_pool_max_connections() -> u32 {
    PG_POOL_MAX_CONNECTIONS.load(Ordering::Relaxed)
}

fn pg_runtime_pool_role() -> Option<PgRuntimePoolRole> {
    PgRuntimePoolRole::from_u8(PG_RUNTIME_POOL_ROLE.load(Ordering::Relaxed))
}

pub async fn renew_tailscale_cert(
    mode: Mode,
    force: Option<bool>,
) -> Result<(), AppError> {
    let config = read_config(mode)?;
    let domain = config.public_host.clone();
    let force_flag = force.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        echo_install_utils::tailscale::RenewCert::new()
            .domain(domain)
            .app_name("echo")
            .cert_name("echo")
            .force(force_flag)
            .run()
            .context(h!())
    })
    .await
    .context(h!())?
    .context(h!())?;
    Ok(())
}

pub async fn oneoff_compare_rer_counts(
    mode: Mode,
    ps: CompareRerCountsPs,
) -> Result<(), AppError> {
    let env = server::new_env(mode).await.c(h!())?;
    let payload_raw = tokio::fs::read_to_string(&ps.request_path)
        .await
        .context(h!())?;
    let req_body: rer_importer::types::AnalysisStatsReq =
        serde_json::from_str(&payload_raw).context(h!())?;

    for login in ps.logins.iter() {
        let login_id = users::login_id_by_name(&env.dbx, login).await?;
        ensure_rer_role_by_id(&env.dbx, &login_id).await.c(h!())?;
        let master_keys =
            messenger::group::get_identity_sigint_groups(&env.dbx, &login_id)
                .await
                .context(h!())?;
        let req_json = actix_web::web::Json(req_body.clone());
        let (count_overall, count_selected) =
            rer_importer::analysis::stats::fetch_counts_for_login(
                &req_json,
                &login_id,
                env.as_ref(),
                master_keys,
            )
            .await
            .context(h!())?;
        println!(
            "login={login} count_overall={count_overall} count_selected={count_selected}"
        );
    }

    Ok(())
}

#[derive(clap::Parser, Debug)]
pub struct ServerPs {
    #[arg(long, action)]
    pub no_bgworker: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffKmzToGeojsonPs {
    pub from_kml: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffFixKmzPs {
    pub kmz: String,
    pub res: String,
    #[arg(long, value_enum)]
    pub hide_titles: bool,
}

#[derive(clap::Parser, Debug)]
pub struct RestreamerPs {
    #[arg(long, value_enum)]
    pub noauto: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffDeltaCsvToKmzPs {
    #[arg(long, value_enum)]
    pub path: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReprocessCallsignTokensPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReprocessCallsignsPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffBackfillInboxNetworksPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: Option<String>,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: Option<String>,
}

#[derive(clap::Parser, Debug)]
#[command(
    after_help = "Example:\n  wdintel-rs --mode=live oneoff-backfill-inbox-network-units-tui --start 2026-07-01"
)]
pub struct OneoffBackfillInboxNetworkUnitsTuiPs {
    /// Start date (inclusive). Format: `YYYY-MM-DD`.
    #[arg(long, value_name = "YYYY-MM-DD")]
    pub start: String,
    /// Page size for each DB fetch.
    #[arg(long)]
    pub limit: Option<u64>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReprocessInboxMetadataPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long)]
    pub since_ts: Option<String>,
    /// End datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long)]
    pub till_ts: Option<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffBackfillInboxUnitLinksPs {
    /// Start datetime in UTC (inclusive). Example: `2026-07-10T12:00:00`
    #[arg(long)]
    pub start_ts: Option<String>,
    /// End datetime in UTC (non-inclusive). Example: `2026-08-10T12:00:00`
    #[arg(long)]
    pub till_ts: Option<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReprocessUnitNamesPs {
    /// Start datetime in UTC (inclusive). Example: `2026-07-16T05:45:00Z`
    #[arg(long)]
    pub since_ts: Option<String>,
    /// Only reprocess messages whose datasource group corresponds to this signal_group.master_key.
    #[arg(long)]
    pub only_group_master_key: Option<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReviewParsedSigintCommentsPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long)]
    pub since_ts: Option<String>,
    /// Page size for each DB fetch.
    #[arg(long)]
    pub limit: Option<u64>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffAuditMissingEchoImMessagesPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long)]
    pub since_ts: Option<String>,
    /// End datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long)]
    pub till_ts: Option<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffReprocessInboxPostsPs {
    /// Start day (inclusive). Format: `YYYY-MM-DD`.
    #[arg(long)]
    pub start_day: String,
    /// Do not persist updates.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffRadioPerDayPerAbonentPs {
    pub input: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffExportSigintCommentsPs {
    #[arg(long)]
    pub organisms: Vec<String>,
    #[arg(long)]
    pub from: String,
    #[arg(long)]
    pub to: String,
    #[arg(long)]
    pub output: String,
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, Eq, PartialEq)]
pub enum OneoffExportCommentedMessagesKind {
    EchoComments,
    GoiAssociations,
    MappedGoiAssociation,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffExportCommentedMessagesPs {
    /// Start datetime in UTC (inclusive). Example: `2026-07-15T00:00:00`
    #[arg(long)]
    pub since_ts: String,
    /// End datetime in UTC (non-inclusive). Example: `2026-08-05T00:00:00`
    #[arg(long)]
    pub till_ts: String,
    #[arg(long, value_enum)]
    pub kind: Option<OneoffExportCommentedMessagesKind>,
    #[arg(long)]
    pub output: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffImportSigintCommentsPs {
    #[arg(long)]
    pub input: String,
    #[arg(long)]
    pub organism_login_mapping: Option<String>,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub excluded_organisms: Vec<String>,
    #[arg(long)]
    pub excluded_logins: Vec<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffTagMessagesReportPs {
    /// Start date (inclusive). Format: `YYYY-MM-DD`.
    #[arg(long)]
    pub start: String,
    /// End date (inclusive). Format: `YYYY-MM-DD`.
    #[arg(long)]
    pub end: String,
    /// Output CSV file path.
    #[arg(long)]
    pub output: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffEtalonkaReportNetworksFromRerAnalysisPs {
    /// Start date (inclusive). Format: `YYYY-MM-DD`.
    #[arg(long)]
    pub start: String,
    /// End date (non-inclusive). Format: `YYYY-MM-DD`.
    #[arg(long)]
    pub end: String,
    /// Filter by AOR names (repeat the flag for multiple).
    #[arg(long = "only-aor")]
    pub only_aor: Vec<String>,
    /// Login used for access and filters.
    #[arg(long, default_value = SYSTEM_LOGIN_NAME)]
    pub login: String,
}

#[derive(clap::Parser, Debug)]
#[command(
    name = "OneoffReprocessSearchIndex",
    about = "Updates the full-text search index"
)]
pub struct OneoffReprocessSearchIndexPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long)]
    pub start: Option<String>,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long)]
    pub end: Option<String>,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffRegisterUserPs {
    #[arg(long, value_enum)]
    pub login: String,
    #[arg(long, value_enum)]
    pub password: String,
    /// One of: Admin, Full, Rer, Bpla
    #[arg(long, value_enum)]
    pub role: String,
    #[arg(long, value_enum)]
    pub sigint_zone: i64,
    #[arg(long, value_enum)]
    pub organism_id: Option<i64>,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffRegisterDeltaUserPs {
    #[arg(long, value_enum)]
    pub login: String,
    /// One of: Admin, Full, Rer, Bpla
    #[arg(long, value_enum)]
    pub role: String,
    #[arg(long, value_enum)]
    pub sigint_zone: i64,
    #[arg(long, value_enum)]
    pub organism_id: Option<i64>,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffRerCsvImportPs {
    pub input: String,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffFillCompFreqPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffSigintImportMousePs {
    pub input: String,
    pub signal_group_id: String,
    pub signal_sender_uuid: String,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffReprocessCoordsPs {
    pub days: Option<i64>,
    #[arg(long)]
    pub start: Option<String>,
    #[arg(long)]
    pub end: Option<String>,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffBatchUskToWgsPs {
    pub input: String,
}

/// Export units to JSON
#[derive(clap::Parser, Debug, Clone)]
pub struct ExportUnitPs {
    #[arg(long, value_enum)]
    pub name: Option<String>,
    #[arg(long, value_enum)]
    pub company: Option<String>,
    #[arg(long, value_enum)]
    pub division: Option<String>,
    #[arg(long, value_enum)]
    pub army: Option<String>,
    #[arg(long, value_enum)]
    pub regiment: Option<String>,
    #[arg(long, value_enum)]
    pub battalion: Option<String>,
    #[arg(long, value_enum)]
    pub dest_path: Option<String>,
}

/// Export callsigns from JSON
#[derive(clap::Parser, Debug, Clone)]
pub struct ImportUnitPs {
    #[arg(long, value_enum)]
    pub src_path: Option<String>,
    #[arg(long, value_enum)]
    pub upsert: bool,
    /// name column in sigint_origin table
    #[arg(long, value_enum)]
    pub origin: String,
}

/// Export callsigns from JSON
#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffInstallPs {
    #[arg(long, value_enum)]
    pub interactive: bool,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffMergeNetworksPs {
    #[arg(long)]
    pub network_id_from: i64,
    #[arg(long)]
    pub network_id_to: i64,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffImportEtalonDataPs {
    #[arg(long, value_enum)]
    pub path: String,
    /// name column in sigint_origin table
    #[arg(long, value_enum)]
    pub origin: String,
    #[arg(long, action)]
    pub autocommit: Option<bool>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffExportEtalonDataPs {
    #[arg(long, value_enum)]
    pub destination_path: String,
    #[arg(long, value_enum)]
    pub only_sigint_unit_id: Option<i64>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffImportDataSourcePs {
    #[arg(long, value_enum)]
    pub source_path: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffExportDataSourcePs {
    #[arg(long, value_enum)]
    pub destination_path: String,
    #[arg(long, value_enum)]
    pub datasource_id: i64,
    #[arg(long, value_enum)]
    pub since_epoch_ms: Option<i64>,
    #[arg(long, value_enum)]
    pub till_epoch_ms: Option<i64>,
}

#[derive(clap::Parser, Debug)]
pub struct RenewTailscaleCertPs {
    #[arg(long, value_enum)]
    pub force: Option<bool>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffAssignMessageIdsPs {
    #[arg(long, value_enum)]
    pub dry_run: Option<bool>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffBackfillGoiAssociationMessageUidsPs {
    /// Earliest GOI association source timestamp (inclusive). Example: `2026-06-15T00:00:00Z`
    #[arg(long)]
    pub since_ts: Option<String>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffDeleteDeletedGoiKnowledgePs {
    #[arg(long)]
    pub integration_id: Option<i64>,
    #[arg(
        long,
        default_value_t = ONEOFF_GOI_KNOWLEDGE_DELETE_BATCH_SIZE_DEFAULT
    )]
    pub batch_size: u64,
    #[arg(
        long,
        default_value_t = ONEOFF_GOI_KNOWLEDGE_DELETE_SLEEP_MS_DEFAULT
    )]
    pub sleep_ms: u64,
    /// Delete rows. Without this flag, only report matching rows.
    #[arg(long, action)]
    pub execute: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffPrintOrganismGroupsPs {
    #[arg(long, value_enum)]
    pub organism_name: String,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffFixAreasOfResponsibilityPs {
    /// Force overwriting all networks even if they have aor set
    #[arg(long, default_value = "false")]
    pub force_all_networks: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffGetNetworksActivityStatsPs {
    #[arg(long, value_enum)]
    pub login: String,
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct CompareRerCountsPs {
    /// Logins to evaluate (defaults to ziggy accounts)
    #[arg(long = "login", value_delimiter = ',', num_args = 1.., default_values = ["ziggy", "ziggy-3ovmbr"])]
    pub logins: Vec<String>,
    /// Path to a JSON file containing AnalysisStatsReq payload
    #[arg(long)]
    pub request_path: String,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffFixEchoimGroupsPs {
    #[arg(long, default_value = "false")]
    pub noninteractive: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffCalculateStatsPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long)]
    pub start: Option<String>,
    /// End datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long)]
    pub end: Option<String>,
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HistoricStatsKind {
    /// Group counts and detailed facets.
    General,
    /// Linked-unit ID counts.
    UnitId,
    /// Network, network-frequency, and network-callsign counts.
    Network,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffCalculateHistoricStatsPs {
    /// Oldest local calendar day to refresh, given as a local datetime.
    /// Example: `2025-08-15T00:00:00`.
    /// Defaults to the statistics retention window.
    #[arg(long)]
    pub start: Option<String>,
    /// UTC timestamp whose local calendar day is the oldest to refresh.
    /// Example: `2025-08-15T00:00:00`.
    #[arg(long, conflicts_with = "start")]
    pub start_ts: Option<String>,
    /// Recalculate only these statistics families (comma-separated).
    /// By default, all statistics families are recalculated.
    #[arg(long, value_enum, value_delimiter = ',')]
    pub only: Vec<HistoricStatsKind>,
    #[arg(long, default_value = "false")]
    pub force: bool,
    #[arg(long, default_value = "false")]
    pub skip_5min: bool,
    #[arg(long, default_value = "false")]
    pub skip_day: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffSuggestInboxMessageTagsPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
    #[arg(long)]
    pub batch_size: Option<usize>,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffHighlightInboxMessagePalitraPs {
    /// Start datetime (inclusive). Example: `2023-04-17T00:00:00`
    #[arg(long, value_enum)]
    pub start: String,
    /// Start datetime (non-inclusive). Example: `2023-04-18T00:00:00`
    #[arg(long, value_enum)]
    pub end: String,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffImportCallsignsCsvPs {
    #[arg(long)]
    pub input: String,
    #[arg(long, action)]
    pub dry_run: bool,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffImportSignalsCallsignsCsvPs {
    #[arg(long)]
    pub signals: Option<String>,
    #[arg(long)]
    pub callsigns: Option<String>,
    #[arg(long, action)]
    pub dry_run: bool,
    #[arg(long)]
    pub unit_mapping: Option<String>,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffRestartEchoPs {
    #[arg(long, action)]
    pub restart_postgres: Option<bool>,
    #[arg(long, action)]
    pub restart_messengers: Option<bool>,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffKillOldQueriesPs {
    /// Cancel active application queries older than this many minutes.
    #[arg(
        long,
        default_value_t = ONEOFF_KILL_OLD_QUERIES_DEFAULT_MINUTES,
        value_parser = clap::value_parser!(u64).range(1..)
    )]
    pub minutes: u64,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffMigrateModulationToEncryptionPs {
    /// Print what would be done without committing changes.
    #[arg(long, default_value = "false")]
    pub dry_run: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffMigrateLargeMediaToPlaintextPs {
    /// Show eligible media count and bytes without changing B2 or the database.
    #[arg(long, action)]
    pub dry_run: bool,
}

#[derive(clap::Args, Debug)]
pub struct OneoffExportLocalAiAgentProfilePs {
    #[arg(long)]
    pub output: std::path::PathBuf,
}

#[derive(clap::Args, Debug)]
pub struct OneoffImportLocalAiAgentProfilePs {
    #[arg(long)]
    pub input: std::path::PathBuf,
}

#[derive(clap::Args, Debug)]
pub struct OneoffDiscardCopiedAiAgentRuntimePs {
    #[arg(long)]
    pub clear_control_plane: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffBackfillAudioTranscriberPs {
    #[arg(long)]
    pub since_ts: String,
    #[arg(long, action)]
    pub dry_run: bool,
    #[arg(long, action)]
    pub yes: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffReprocessAudioTranscriberPs {
    #[arg(long)]
    pub source_id: Uuid,
    #[arg(long)]
    pub requester: String,
    #[arg(long)]
    pub reason: String,
    #[arg(long, action)]
    pub yes: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub struct BackupPs {
    /// Skip the configured sleep_before_backup_mins delay.
    #[arg(long, action)]
    pub nowait: bool,
}

#[derive(clap::Parser, Debug)]
pub struct ImportTuiPs {
    #[arg(long, value_enum)]
    pub path: String,
}

#[derive(clap::Args, Debug, Clone)]
pub struct OneoffPrepareOrbitImportPs {
    #[arg(long)]
    pub path: std::path::PathBuf,
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffMergeDatasourceGroupPs {
    #[arg(long)]
    pub target_group_key: String,
    #[arg(long, action)]
    pub dry_run: bool,
}

#[derive(clap::Subcommand, Debug)]
#[command(author, version, about, long_about = None)]
enum Cmd {
    Server(ServerPs),
    Bgworker,
    ReportWorker,
    GenElm,
    GenTs,
    #[command(visible_alias = "migration")]
    Migrate,
    OneoffCreateFileRegistryDatabase,
    NetworkInvalidationTui,
    /// Prepare a normalized ORBIT Parquet snapshot from a JSON export.
    OneoffPrepareOrbitImport(OneoffPrepareOrbitImportPs),
    /// Import ORBIT units from the latest snapshot in an interactive TUI.
    TuiImportOrbitUnits,
    /// Create inactive SIGINT units for every unlinked ORBIT unit.
    OneoffImportUnlinkedOrbitUnits,
    TuiImportUnit(ImportTuiPs),
    TuiImportNetwork(ImportTuiPs),
    OneoffImportNetworkDetails(ImportTuiPs),
    TuiMergeUnit,
    TuiMergeNetwork,
    TuiMergeNetworkFreq,
    ExportUnit(ExportUnitPs),
    ImportUnit(ImportUnitPs),
    RenewTailscaleCert(RenewTailscaleCertPs),
    Backup(BackupPs),
    /// Restarts all active echo-im whatsapp units.
    RestartWhatsappUnits,
    OneoffSigintImportMouse(OneoffSigintImportMousePs),
    OneoffTestKml,
    OneoffTestXmlLib,
    OneoffPrintDescriptionIconTitle,
    OneoffTerminalPdfExtract,
    OneoffTestOpencv,
    OneoffParseHtml,
    OneoffTestFullCirclePdf,
    OneoffKmzToGeojson(OneoffKmzToGeojsonPs),
    OneoffRadioByFreq,
    OneoffRadioPerDayPerAbonent(OneoffRadioPerDayPerAbonentPs),
    OneoffFixKmz(OneoffFixKmzPs),
    OneoffDeltaCsvToKmz(OneoffDeltaCsvToKmzPs),
    OneoffReprocessCallsigns(OneoffReprocessCallsignsPs),
    OneoffReprocessCallsignTokens(OneoffReprocessCallsignTokensPs),
    OneoffExportSigintComments(OneoffExportSigintCommentsPs),
    OneoffExportCommentedMessages(OneoffExportCommentedMessagesPs),
    OneoffImportSigintComments(OneoffImportSigintCommentsPs),
    OneoffReviewParsedSigintComments(OneoffReviewParsedSigintCommentsPs),
    OneoffTagMessagesReport(OneoffTagMessagesReportPs),
    OneoffEtalonkaReportNetworksFromRerAnalysis(
        OneoffEtalonkaReportNetworksFromRerAnalysisPs,
    ),
    OneoffGenDatasetCallsigns,
    OneoffReprocessCoords(OneoffReprocessCoordsPs),
    OneoffReprocessUnitNames(OneoffReprocessUnitNamesPs),
    OneoffReprocessSearchIndex(OneoffReprocessSearchIndexPs),
    OneoffNominalizeFreq,
    OneoffRoundFreq,
    OneoffRegisterUser(OneoffRegisterUserPs),
    OneoffRegisterDeltaUser(OneoffRegisterDeltaUserPs),
    OneoffRerCsvImport(OneoffRerCsvImportPs),
    OneoffFillCompFreq(OneoffFillCompFreqPs),
    OneoffBatchUskToWgs(OneoffBatchUskToWgsPs),
    OneoffTestLoggingError,
    OneoffMergeAllNetworks,
    OneoffEnsureTagsOrdering,
    OneoffMergeTwoNetworks(OneoffMergeNetworksPs),
    OneoffInstall(OneoffInstallPs),
    OneoffReprocessUnitsSearchIndex,
    OneoffImportEtalonData(OneoffImportEtalonDataPs),
    OneoffExportEtalonData(OneoffExportEtalonDataPs),
    OneoffBackupVaultSecretsToBitwarden,
    OneoffRestoreVaultSecretsFromBitwarden,
    OneoffImportDataSource(OneoffImportDataSourcePs),
    OneoffExportDataSource(OneoffExportDataSourcePs),
    OneoffFixAreasOfResponsibility(OneoffFixAreasOfResponsibilityPs),
    OneoffPrintOrganismGroups(OneoffPrintOrganismGroupsPs),
    OneoffAssignMessageIds(OneoffAssignMessageIdsPs),
    OneoffBackfillGoiAssociationMessageUids(
        OneoffBackfillGoiAssociationMessageUidsPs,
    ),
    OneoffDeleteDeletedGoiKnowledge(OneoffDeleteDeletedGoiKnowledgePs),
    OneoffGetNetworksActivityStats(OneoffGetNetworksActivityStatsPs),
    OneoffCompareRerCounts(CompareRerCountsPs),
    OneoffPopulateSignalMessageGroupIds,
    OneoffFixEchoimGroups(OneoffFixEchoimGroupsPs),
    OneoffUnlinkReserveGroupDupes,
    OneoffCalculateStats(OneoffCalculateStatsPs),
    /// Refreshes historical Redis group statistics through the present.
    OneoffCalculateHistoricStats(OneoffCalculateHistoricStatsPs),
    OneoffDisableIm,
    OneoffDisableImAndGoi,
    OneoffFixNetworkCallsigns,
    OneoffCountGroupBatches,
    OneoffGenerateStrongboxKey,
    OneoffFillSigintInboxItemTags,
    OneoffSuggestInboxMessageTags(OneoffSuggestInboxMessageTagsPs),
    OneoffHighlightInboxMessagePalitra(OneoffHighlightInboxMessagePalitraPs),
    OneoffBackupPalitras,
    OneoffImportSignalsCallsignsCsv(OneoffImportSignalsCallsignsCsvPs),
    OneoffFixWhatsappSenders,
    OneoffBackfillInboxNetworks(OneoffBackfillInboxNetworksPs),
    OneoffBackfillSigintInboxItemDatetimeNeo,
    OneoffBackfillInboxUnitLinks(OneoffBackfillInboxUnitLinksPs),
    OneoffBackfillInboxNetworkUnitsTui(OneoffBackfillInboxNetworkUnitsTuiPs),
    OneoffBackfillPalitraPointLexemes,
    OneoffReprocessInboxMetadata(OneoffReprocessInboxMetadataPs),
    OneoffAuditMissingEchoImMessages(OneoffAuditMissingEchoImMessagesPs),
    OneoffReprocessInboxPosts(OneoffReprocessInboxPostsPs),
    OneoffRestartEcho(OneoffRestartEchoPs),
    OneoffKillOldQueries(OneoffKillOldQueriesPs),
    OneoffRefreshAiModels,
    OneoffExportLocalAiAgentProfile(OneoffExportLocalAiAgentProfilePs),
    OneoffImportLocalAiAgentProfile(OneoffImportLocalAiAgentProfilePs),
    OneoffDiscardCopiedAiAgentRuntime(OneoffDiscardCopiedAiAgentRuntimePs),
    OneoffMigrateModulationToEncryption(OneoffMigrateModulationToEncryptionPs),
    OneoffMigrateLargeMediaToPlaintext(OneoffMigrateLargeMediaToPlaintextPs),
    OneoffBackfillAudioTranscriber(OneoffBackfillAudioTranscriberPs),
    OneoffRequeueAudioTranscriber(OneoffReprocessAudioTranscriberPs),
    OneoffRetranscribeAudioTranscriber(OneoffReprocessAudioTranscriberPs),
    OneoffMergeDatasourceGroup(OneoffMergeDatasourceGroupPs),
    OneoffCompactDatasourceGroup,
    OneoffEnsureApiIntegrationIggyTopics,
}

#[derive(clap::Parser, Debug)]
struct Arg {
    #[arg(long)]
    #[arg(value_enum)]
    mode: Mode,
    #[command(subcommand)]
    action: Cmd,
}

pub async fn new_pg_pool_from_mode(
    mode: Mode,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    let config = read_config(mode).context(h!())?;
    new_pg_pool_from_config(&config).await
}

pub async fn new_pg_pool_from_config(
    config: &Config,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    let conn_string = mk_conn_string(config);
    new_pg_pool_from_conn_string_with_runtime_config(
        conn_string,
        pg_pool_max_connections(),
        config.postgres_runtime.as_ref(),
        pg_runtime_pool_role(),
    )
    .await
}

#[cfg(test)]
pub(crate) async fn new_pg_runtime_pool_from_config(
    config: &Config,
    role: PgRuntimePoolRole,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    new_pg_pool_from_conn_string_with_runtime_config(
        mk_conn_string(config),
        pg_pool_max_connections(),
        config.postgres_runtime.as_ref(),
        Some(role),
    )
    .await
}

pub async fn new_pg_pool_from_replica(
    config: &Config,
    replica: &ReplicaConfig,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    let conn_string = mk_replica_conn_string(config, replica);
    new_pg_pool_from_conn_string_with_runtime_config(
        conn_string,
        pg_pool_max_connections(),
        config.postgres_runtime.as_ref(),
        pg_runtime_pool_role(),
    )
    .await
}

pub async fn new_pg_pool_from_analytics(
    analytics: &AnalyticsConfig,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    let conn_string = mk_analytics_conn_string(analytics);
    new_pg_pool_from_conn_string_with_timeout(
        conn_string,
        Some(core::time::Duration::from_millis(
            analytics.connect_timeout_ms(),
        )),
        true,
    )
    .await
}

async fn new_pg_pool_from_conn_string_with_runtime_config(
    conn_string: String,
    max_connections: u32,
    postgres_runtime: Option<&PostgresRuntimeConfig>,
    role: Option<PgRuntimePoolRole>,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    Ok(new_pg_pool_from_conn_string_with_options(
        conn_string,
        max_connections,
        None,
        false,
        pg_runtime_pool_options(postgres_runtime, role),
    )
    .await
    .c(h!())?)
}

async fn new_pg_pool_from_conn_string_with_timeout(
    conn_string: String,
    connect_timeout: Option<core::time::Duration>,
    connect_lazy: bool,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    Ok(new_pg_pool_from_conn_string_with_options(
        conn_string,
        pg_pool_max_connections(),
        connect_timeout,
        connect_lazy,
        None,
    )
    .await
    .c(h!())?)
}

pub(crate) async fn new_pg_pool_from_conn_string_with_max_connections(
    conn_string: String,
    max_connections: u32,
) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr> {
    new_pg_pool_from_conn_string_with_options(
        conn_string,
        max_connections,
        None,
        false,
        None,
    )
    .await
}

pub(crate) async fn new_pg_runtime_pool_from_conn_string_with_max_connections(
    conn_string: String,
    max_connections: u32,
    config: &Config,
) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr> {
    new_pg_pool_from_conn_string_with_options(
        conn_string,
        max_connections,
        None,
        false,
        pg_runtime_pool_options(
            config.postgres_runtime.as_ref(),
            pg_runtime_pool_role(),
        ),
    )
    .await
}

async fn new_pg_pool_from_conn_string_with_options(
    conn_string: String,
    max_connections: u32,
    connect_timeout: Option<core::time::Duration>,
    connect_lazy: bool,
    runtime: Option<PgRuntimePoolOptions>,
) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr> {
    let mut opt = sea_orm::ConnectOptions::new(conn_string);
    opt.max_connections(max_connections)
        .min_connections(0)
        .idle_timeout(core::time::Duration::from_secs(30))
        .sqlx_logging(true)
        .sqlx_logging_level(LevelFilter::Debug)
        .sqlx_slow_statements_logging_settings(
            LevelFilter::Off,
            core::time::Duration::from_millis(PG_SLOW_STATEMENT_THRESHOLD_MS),
        );
    if let Some(connect_timeout) = connect_timeout {
        opt.connect_timeout(connect_timeout)
            .acquire_timeout(connect_timeout);
    }
    opt.connect_lazy(connect_lazy);

    if let Some(runtime) = runtime {
        opt.set_application_name(runtime.application_name);
        opt.map_sqlx_postgres_opts(move |options| {
            options.options([
                ("statement_timeout", runtime.statement_timeout_ms),
                ("lock_timeout", runtime.lock_timeout_ms),
                (
                    "idle_in_transaction_session_timeout",
                    runtime.idle_in_transaction_session_timeout_ms,
                ),
            ])
        });
    }

    sea_orm::Database::connect(opt).await
}

#[derive(Clone, Copy)]
struct PgRuntimePoolOptions {
    application_name: &'static str,
    statement_timeout_ms: u64,
    lock_timeout_ms: u64,
    idle_in_transaction_session_timeout_ms: u64,
}

fn pg_runtime_pool_options(
    postgres_runtime: Option<&PostgresRuntimeConfig>,
    role: Option<PgRuntimePoolRole>,
) -> Option<PgRuntimePoolOptions> {
    let postgres_runtime = postgres_runtime?;
    let role = role?;
    let statement_timeout_ms = match role {
        PgRuntimePoolRole::ReportWorker => {
            postgres_runtime.report_worker_statement_timeout_ms
        }
        PgRuntimePoolRole::Web | PgRuntimePoolRole::Bgworker => {
            postgres_runtime.statement_timeout_ms
        }
    };
    Some(PgRuntimePoolOptions {
        application_name: role.application_name(),
        statement_timeout_ms,
        lock_timeout_ms: postgres_runtime.lock_timeout_ms,
        idle_in_transaction_session_timeout_ms: postgres_runtime
            .idle_in_transaction_session_timeout_ms,
    })
}

/// Connect to GreptimeDB similar to Postgresql, except that it's ok to fail, the dependency is optional
pub async fn new_greptimedb_from_config(
    config: &Config,
) -> Result<deadpool_postgres::Pool, AppError> {
    let mut dp_config: deadpool_postgres::Config =
        deadpool_postgres::Config::new();
    dp_config.host = config.greptime_host.clone();
    dp_config.port = config.greptime_port;
    dp_config.user = config.greptime_user.clone();
    dp_config.password = config.greptime_password.clone();
    dp_config.dbname = config.greptime_dbname.clone();

    let pool = dp_config
        .create_pool(
            Some(deadpool_postgres::Runtime::Tokio1),
            tokio_postgres::NoTls,
        )
        .context(h!())?;

    Ok(pool)
}

fn mk_conn_string(config: &Config) -> String {
    let pg_host = config
        .pg_host
        .clone()
        .unwrap_or(DEFAULT_PG_HOST.to_string());
    let pg_port = config.pg_port.unwrap_or(DEFAULT_PG_PORT);
    let pg_user = config
        .pg_user
        .clone()
        .unwrap_or(DEFAULT_PG_USER.to_string());
    let pg_password = config
        .pg_password
        .clone()
        .unwrap_or(DEFAULT_PG_PASSWORD.to_string());
    let mut pg_dbname = config
        .pg_dbname
        .clone()
        .unwrap_or(DEFAULT_PG_DBNAME.to_string());

    // Override database name for tests if TEST_DB_NAME environment variable is set
    if let Ok(test_db_name) = std::env::var("TEST_DB_NAME") {
        if !test_db_name.is_empty() {
            pg_dbname = test_db_name;
        }
    }

    let conn_string = format!(
        "postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_dbname}",
    );
    conn_string
}

fn wdfile_connection_parts(
    config: &FileRegistryConfig,
    mode: Mode,
) -> (String, u16, String, String, String) {
    let pg_host = config
        .pg_host
        .clone()
        .unwrap_or_else(|| DEFAULT_PG_HOST.to_string());
    let pg_port = config.pg_port.unwrap_or(DEFAULT_PG_PORT);
    let pg_user = config
        .pg_user
        .clone()
        .unwrap_or_else(|| DEFAULT_PG_USER.to_string());
    let pg_password = config
        .pg_password
        .clone()
        .unwrap_or_else(|| DEFAULT_PG_PASSWORD.to_string());
    let mut pg_dbname = config
        .pg_dbname
        .clone()
        .unwrap_or_else(|| DEFAULT_PG_WDFILE_DBNAME.to_string());

    if mode == Mode::Test {
        if let Ok(test_db_name) = std::env::var("TEST_WDFILE_DB_NAME") {
            if !test_db_name.is_empty() {
                pg_dbname = test_db_name;
            }
        }
    }

    (pg_host, pg_port, pg_user, pg_password, pg_dbname)
}

fn mk_wdfile_conn_string(config: &FileRegistryConfig, mode: Mode) -> String {
    let (pg_host, pg_port, pg_user, pg_password, pg_dbname) =
        wdfile_connection_parts(config, mode);
    format!(
        "postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_dbname}"
    )
}

fn mk_replica_conn_string(config: &Config, replica: &ReplicaConfig) -> String {
    let pg_host = replica
        .pg_host
        .clone()
        .or_else(|| config.pg_host.clone())
        .unwrap_or_else(|| DEFAULT_PG_HOST.to_string());
    let pg_port = replica
        .pg_port
        .or(config.pg_port)
        .unwrap_or(DEFAULT_PG_PORT);
    let pg_user = replica
        .pg_user
        .clone()
        .or_else(|| config.pg_user.clone())
        .unwrap_or_else(|| DEFAULT_PG_USER.to_string());
    let pg_password = replica
        .pg_password
        .clone()
        .or_else(|| config.pg_password.clone())
        .unwrap_or_else(|| DEFAULT_PG_PASSWORD.to_string());
    let mut pg_dbname = replica
        .pg_dbname
        .clone()
        .or_else(|| config.pg_dbname.clone())
        .unwrap_or_else(|| DEFAULT_PG_DBNAME.to_string());

    if let Ok(test_db_name) = std::env::var("TEST_DB_NAME") {
        if !test_db_name.is_empty() {
            pg_dbname = test_db_name;
        }
    }

    format!(
        "postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_dbname}",
    )
}

fn mk_analytics_conn_string(analytics: &AnalyticsConfig) -> String {
    let pg_port = analytics.pg_port.unwrap_or(DEFAULT_PG_PORT);
    let pg_host = &analytics.pg_host;
    let pg_user = urlencoding::encode(&analytics.pg_user);
    let pg_password = urlencoding::encode(&analytics.pg_password);
    let pg_dbname = urlencoding::encode(&analytics.pg_dbname);

    format!(
        "postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_dbname}",
    )
}

pub fn redis_conn_string(config: &Config) -> anyhow::Result<String> {
    redis_conn_string_for_db(config, 0)
}

pub fn redis_conn_string_for_db(
    config: &Config,
    database: u8,
) -> anyhow::Result<String> {
    let host = match &config.redis_host {
        Some(host) => host.clone(),
        None => REDIS_HOST.to_string(),
    };
    let port = match &config.redis_port {
        Some(port) => *port,
        None => REDIS_PORT,
    };
    let redis_url = format!("redis://{host}:{port}/{database}");
    Ok(redis_url)
}

pub async fn new_redis(config: &Config) -> anyhow::Result<ConnectionManager> {
    new_redis_for_db(config, 0).await
}

pub async fn new_redis_for_db(
    config: &Config,
    database: u8,
) -> anyhow::Result<ConnectionManager> {
    let redis_url = redis_conn_string_for_db(config, database).context(h!())?;
    let mut redis_cli = redis::Client::open(redis_url).context(h!())?;
    let is_ok = redis_cli.check_connection();
    if !is_ok {
        bail!("Redis connection failed");
    }
    let conn_manager =
        redis_cli.get_connection_manager().await.context(h!())?;
    Ok(conn_manager)
}

pub async fn new_redisb(config: &Config) -> anyhow::Result<redis::Client> {
    let redis_url = redis_conn_string(config).context(h!())?;
    let mut redis_cli = redis::Client::open(redis_url).context(h!())?;
    let is_ok = redis_cli.check_connection();
    if !is_ok {
        bail!("Redis connection failed");
    }
    Ok(redis_cli)
}

fn main() -> Result<(), AppError> {
    ring::default_provider()
        .install_default()
        .expect("failed to install default rustls ring provider");

    env_logger::try_init_from_env(
        env_logger::Env::new()
            .default_filter_or("info,wdintel_rs=debug,sqlx::query=off"),
    )
    .ok();

    let rust_log =
        std::env::var("RUST_LOG").unwrap_or_else(|_| "<unset>".to_string());
    info!(
        "logger initialized; RUST_LOG={}; trace_enabled={} debug_enabled={} info_enabled={}",
        rust_log,
        log_enabled!(Level::Trace),
        log_enabled!(Level::Debug),
        log_enabled!(Level::Info)
    );
    trace!("logger trace probe: hello from wdintel-rs startup");
    debug!("logger debug probe: hello from wdintel-rs startup");
    info!("logger info probe: hello from wdintel-rs startup");

    let args = Arg::parse();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name_fn(|| {
            let id = RUNTIME_THREAD_INDEX.fetch_add(1, Ordering::Relaxed);
            format!("echo-rt-{id}")
        })
        .build()
        .expect("failed to build tokio runtime");

    let cancel_token = CancellationToken::new();
    runtime.block_on(async_main(args, cancel_token.clone(), runtime.handle()))
}

async fn async_main(
    args: Arg,
    token: CancellationToken,
    shutdown_handle: &Handle,
) -> Result<(), AppError> {
    let mode = args.mode;
    let action = args.action;

    utils::worker_watch::spawn_metrics_logger();

    match action {
        Cmd::Server(ps) => {
            server::main_server(mode, ps, token, shutdown_handle.clone()).await
        }
        Cmd::Bgworker => {
            server::main_bgworker(mode, token, shutdown_handle.clone()).await
        }
        Cmd::ReportWorker => {
            server::main_report_worker(mode, token, shutdown_handle.clone())
                .await
        }
        Cmd::OneoffEnsureTagsOrdering => {
            tags::ordering::oneoff_ensure_tags_ordering(mode).await
        }
        Cmd::OneoffTestKml => kml::main_test_kml(mode),
        Cmd::OneoffTestXmlLib => atak::main_test_xml_lib(mode),
        Cmd::GenElm => elm::main_gen_elm(),
        Cmd::GenTs => ts::main_gen_ts(),
        Cmd::OneoffPrintDescriptionIconTitle => {
            kml::oneoff_print_description_icon_title(mode)
        }
        Cmd::OneoffTerminalPdfExtract => {
            terminal::oneoff_terminal_pdf_extract()
        }
        Cmd::OneoffTestOpencv => terminal::oneoff_test_opencv(),
        Cmd::OneoffParseHtml => terminal::oneoff_parse_html(),
        Cmd::OneoffTestFullCirclePdf => {
            terminal::oneoff_test_full_circle().await
        }
        Cmd::OneoffKmzToGeojson(ps) => delta::oneoff_kmz_to_geojson(&ps),
        Cmd::OneoffRadioByFreq => kml::oneoff_radio_by_freq().await,
        Cmd::OneoffRadioPerDayPerAbonent(ps) => {
            kml::oneoff_radio_per_day_per_abonent_main(mode, &ps, None, None)
                .await
                .map(|_| ())
        }
        Cmd::OneoffFixKmz(ps) => kml::oneoff_fix_kml_main(mode, &ps).await,
        Cmd::Migrate => migration::run_migration_1(mode).await,
        Cmd::OneoffCreateFileRegistryDatabase => {
            file_registry::provisioning::oneoff_create_database(mode).await
        }
        Cmd::RenewTailscaleCert(ps) => {
            renew_tailscale_cert(mode, ps.force).await
        }
        Cmd::Backup(ps) => backup::backup(mode, ps.nowait).await,
        Cmd::RestartWhatsappUnits => {
            messenger::ops::restart_whatsapp_units(mode).await
        }
        Cmd::OneoffSigintImportMouse(ps) => {
            sigint::oneoff_sigint_import_mouse(mode, &ps).await
        }
        Cmd::OneoffReprocessCoords(ps) => {
            sigint::oneoff_reprocess_coords(mode, &ps).await
        }
        Cmd::OneoffReprocessUnitNames(ps) => {
            rer_importer::oneoff_reprocess_unit_names(mode, &ps).await
        }
        Cmd::OneoffReprocessSearchIndex(ps) => {
            rer_importer::search::oneoff_reprocess_search_index(mode, &ps).await
        }
        Cmd::OneoffDeltaCsvToKmz(ps) => {
            let _ = delta::csv::csv_to_kmz(mode, &ps).unwrap();
            Ok(())
        }
        Cmd::OneoffReprocessCallsignTokens(ps) => {
            rer_importer::callsigns::oneoff_reprocess_callsign_tokens(mode, &ps)
                .await
        }
        Cmd::OneoffReprocessCallsigns(ps) => {
            rer_importer::callsigns::oneoff_reprocess_callsigns(mode, &ps).await
        }
        Cmd::OneoffExportSigintComments(ps) => {
            sigint::comments::oneoff_export_sigint_comments(mode, &ps).await
        }
        Cmd::OneoffExportCommentedMessages(ps) => {
            sigint::comments::oneoff_export_commented_messages(mode, &ps)
                .await
        }
        Cmd::OneoffImportSigintComments(ps) => {
            sigint::comments::oneoff_import_sigint_comments(mode, &ps).await
        }
        Cmd::OneoffReviewParsedSigintComments(ps) => {
            sigint::comment_review_tui::run_comment_review_tui(mode, &ps).await
        }
        Cmd::OneoffTagMessagesReport(ps) => {
            sigint::oneoff::oneoff_tag_messages_report(mode, &ps).await
        }
        Cmd::OneoffEtalonkaReportNetworksFromRerAnalysis(ps) => {
            sigint::oneoff::oneoff_etalonka_report_networks_from_rer_analysis(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffGenDatasetCallsigns => {
            ml::oneoff_gen_dataset_callsigns(mode).await
        }
        Cmd::OneoffNominalizeFreq => {
            rer_importer::oneoff_nominalize_freq(mode).await
        }
        Cmd::OneoffRoundFreq => rer_importer::oneoff_round_freq(mode).await,
        Cmd::OneoffRegisterUser(ps) => {
            users::oneoff_register_user(mode, &ps).await
        }
        Cmd::OneoffRegisterDeltaUser(ps) => {
            users::oneoff_register_delta_user(mode, &ps).await
        }
        Cmd::OneoffRerCsvImport(ps) => {
            rer_importer::import_csv::oneoff_rer_csv_import(mode, &ps).await
        }
        Cmd::OneoffFillCompFreq(ps) => {
            rer_importer::reports::oneoff_fill_comp_freq(mode, &ps).await
        }
        Cmd::OneoffBatchUskToWgs(ps) => {
            oneoff::oneoff_batch_usk_to_wgs(mode, &ps).unwrap();
            Ok(())
        }
        Cmd::OneoffTestLoggingError => {
            oneoff::oneoff_test_logging_error_macro(mode)
        }
        Cmd::ExportUnit(ps) => rer_importer::unit::export_unit(mode, &ps).await,
        Cmd::ImportUnit(ps) => rer_importer::unit::import_unit(mode, &ps).await,
        Cmd::OneoffMergeAllNetworks => {
            sigint::network::oneoff::oneoff_merge_all_possible_networks(mode)
                .await
        }
        Cmd::OneoffMergeTwoNetworks(ps) => {
            sigint::network::oneoff::oneoff_merge_two_networks(mode, &ps).await
        }
        Cmd::OneoffInstall(ps) => install::mount_tmp(&ps)
            .await
            .map_err(|e| AppError::AnyhowError { source: e }),
        Cmd::OneoffReprocessUnitsSearchIndex => {
            sigint::unit::oneoff_reprocess_units_search_index(mode).await
        }
        Cmd::OneoffExportEtalonData(ps) => {
            sigint::import::oneoff_export_etalon_data(mode, ps.destination_path, ps.only_sigint_unit_id)
                .await
        }
        Cmd::OneoffImportEtalonData(ps) => {
            sigint::import::oneoff_import_etalon_data(
                mode,
                ps.path,
                ps.origin,
                ps.autocommit.unwrap_or(false),
            )
            .await
        }
        Cmd::OneoffBackupVaultSecretsToBitwarden => {
            secret::oneoff_backup_vault_secrets_to_bitwarden(mode).await
        }
        Cmd::OneoffRestoreVaultSecretsFromBitwarden => {
            secret::oneoff_restore_vault_secrets_from_bitwarden(mode).await
        }
        Cmd::OneoffImportDataSource(ps) => {
            datasource::importer::oneoff_import_datasource(mode, ps).await
        }
        Cmd::OneoffExportDataSource(ps) => {
            datasource::importer::oneoff_export_datasource(mode, ps).await
        }
        Cmd::OneoffFixAreasOfResponsibility(ps) => {
            oneoff::oneoff_fix_areas_of_responsibility(
                mode,
                ps.force_all_networks,
            )
            .await
        }
        Cmd::OneoffPrintOrganismGroups(ps) => {
            organism::oneoff::oneoff_print_organism_groups(mode, &ps).await
        }
        Cmd::OneoffAssignMessageIds(ps) => {
            messenger::id::oneoff_assign_message_ids(
                mode,
                ps.dry_run.unwrap_or(true),
            )
            .await
        }
        Cmd::OneoffBackfillGoiAssociationMessageUids(ps) => {
            organism::goi::message_uid::oneoff_backfill_goi_association_message_uids(
                mode,
                ps.since_ts.as_deref(),
            )
            .await
        }
        Cmd::OneoffDeleteDeletedGoiKnowledge(ps) => {
            organism::oneoff::oneoff_delete_deleted_goi_knowledge(mode, &ps)
                .await
        }
        Cmd::OneoffGetNetworksActivityStats(ps) => {
            sigint::network::oneoff::oneoff_network_activity_stat(mode, &ps)
                .await
        }
        Cmd::OneoffCompareRerCounts(ps) => {
            oneoff_compare_rer_counts(mode, ps).await
        }
        Cmd::OneoffPopulateSignalMessageGroupIds => {
            messenger::group::oneoff::oneoff_populate_signal_message_group_ids(
                mode,
            )
            .await
        }
        Cmd::OneoffFixEchoimGroups(ps) => {
            messenger::group::oneoff::oneoff_fix_echoim_groups(
                mode,
                !ps.noninteractive,
            )
            .await
        }
        Cmd::OneoffUnlinkReserveGroupDupes => {
            messenger::group::oneoff::oneoff_unlink_reserve_group_dupes(mode)
                .await
        }
        Cmd::OneoffCalculateStats(ps) => {
            stats::oneoff_calculate_stats(mode, &ps).await
        }
        Cmd::OneoffCalculateHistoricStats(ps) => {
            stats::oneoff_calculate_historic_stats(mode, ps).await
        }
        Cmd::OneoffDisableIm => datasource::oneoff_disable_im(mode).await,
        Cmd::OneoffDisableImAndGoi => {
            datasource::oneoff_disable_im_and_goi(mode).await
        }
        Cmd::OneoffFixNetworkCallsigns => crate::sigint::callsign::oneoff::oneoff_fix_network_callsigns(mode).await,
        Cmd::OneoffCountGroupBatches => {
            stats::oneoff_count_group_batches(mode).await
        }
        Cmd::OneoffGenerateStrongboxKey => {
            let key = storage::generate_strongbox_key_b64();
            println!("{key}");
            Ok(())
        }
        Cmd::OneoffFillSigintInboxItemTags => {
            sigint::oneoff::oneoff_fill_sigint_inbox_item_tags(mode).await
        }
        Cmd::OneoffSuggestInboxMessageTags(ps) => {
            sigint::oneoff::oneoff_suggest_inbox_message_tags(mode, &ps).await
        }
        Cmd::OneoffImportSignalsCallsignsCsv(ps) => {
            sigint::signal::oneoff::oneoff_import_signals_callsigns_csv(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffFixWhatsappSenders => {
            messenger::oneoff::oneoff_fix_whatsapp_senders(mode).await
        }
        Cmd::OneoffBackfillInboxNetworks(ps) => {
            sigint::network::etalon_calc::oneoff::oneoff_backfill_inbox_networks(mode, ps)
                .await
        }
        Cmd::OneoffBackfillInboxNetworkUnitsTui(ps) => {
            sigint::network::inbox_backfill_tui::run_inbox_network_unit_backfill_tui(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffBackfillSigintInboxItemDatetimeNeo => {
            inbox::datetime::oneoff_backfill(mode).await
        }
        Cmd::OneoffBackfillInboxUnitLinks(ps) => {
            sigint::oneoff::oneoff_backfill_inbox_unit_links(mode, &ps).await
        }
        Cmd::OneoffReprocessInboxMetadata(ps) => {
            rer_importer::inbox::metadata::oneoff::oneoff_reprocess_inbox_metadata(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffAuditMissingEchoImMessages(ps) => {
            messenger::worker::recovery::oneoff_audit_missing_echo_im_messages(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffBackfillPalitraPointLexemes => {
            palitra::oneoff::oneoff_backfill_palitra_point_lexemes(mode)
                .await
        }
        Cmd::OneoffReprocessInboxPosts(ps) => {
            rer_importer::oneoff_reprocess_inbox_posts(mode, &ps).await
        }
        Cmd::NetworkInvalidationTui => {
           sigint::network::etalon_calc::tui::run_network_invalidation_tui(mode).await
        }
        Cmd::OneoffPrepareOrbitImport(ps) => {
            Ok(orbit::prepare_import_snapshot(mode, ps.path)
                .await
                .c(h!())?)
        }
        Cmd::TuiImportOrbitUnits => orbit::run_import_tui(mode).await,
        Cmd::OneoffImportUnlinkedOrbitUnits => {
            sigint::unit::orbit::oneoff_import_unlinked_orbit_units(mode).await
        }
        Cmd::OneoffRestartEcho(ps) => {
            oneoff::oneoff_restart_echo(mode, &ps).await
        }
        Cmd::OneoffKillOldQueries(ps) => {
            oneoff::oneoff_kill_old_queries(mode, &ps).await
        }
        Cmd::TuiImportUnit(ps) => {
            sigint::import::tui::run_import_unit_tui(mode, ps).await
        }
        Cmd::TuiImportNetwork(ps) => {
            sigint::import::tui::run_import_network_tui(mode, ps).await
        }
        Cmd::OneoffImportNetworkDetails(ps) => {
            sigint::import::tui::oneoff_import_network_details(mode, ps).await
        }
        Cmd::TuiMergeUnit => {
            sigint::import::tui::run_merge_unit_tui(mode).await
        }
        Cmd::TuiMergeNetwork => {
            sigint::import::tui::run_merge_network_tui(mode).await
        }
        Cmd::TuiMergeNetworkFreq => {
            sigint::import::tui::run_merge_network_freq_tui(mode).await
        },
        Cmd::OneoffHighlightInboxMessagePalitra(ps) => {
            palitra::oneoff::oneoff_highlight_inbox_message_palitra_points(mode, &ps).await
        },
        Cmd::OneoffBackupPalitras => {
            palitra::oneoff::oneoff_backup_palitras(mode).await
        }
        Cmd::OneoffRefreshAiModels => tags::worker::oneoff_refresh_models(mode).await,
        Cmd::OneoffExportLocalAiAgentProfile(ps) => {
            ai_agent::profile::export(mode, &ps.output).await
        }
        Cmd::OneoffImportLocalAiAgentProfile(ps) => {
            ai_agent::profile::import(mode, &ps.input).await
        }
        Cmd::OneoffDiscardCopiedAiAgentRuntime(ps) => {
            ai_agent::profile::discard_runtime(mode, ps.clear_control_plane).await
        }
        Cmd::OneoffMigrateModulationToEncryption(ps) => {
            sigint::network::oneoff::oneoff_migrate_modulation_to_encryption(
                mode, ps.dry_run,
            )
            .await
        },
        Cmd::OneoffMigrateLargeMediaToPlaintext(ps) => {
            messenger::oneoff::oneoff_migrate_large_media_to_plaintext(
                mode, ps.dry_run,
            )
            .await
        },
        Cmd::OneoffBackfillAudioTranscriber(ps) => {
            transcriber::backfill::run(mode, ps).await
        }
        Cmd::OneoffRequeueAudioTranscriber(ps) => {
            transcriber::backfill::requeue_terminal(mode, ps).await
        }
        Cmd::OneoffRetranscribeAudioTranscriber(ps) => {
            transcriber::backfill::retranscribe_completed(mode, ps).await
        }
        Cmd::OneoffMergeDatasourceGroup(ps) => {
            operator::oneoff::oneoff_merge_datasource_group(mode, ps).await
        }
        Cmd::OneoffCompactDatasourceGroup => {
            operator::oneoff::oneoff_compact_datasource_group(mode).await
        }
        Cmd::OneoffEnsureApiIntegrationIggyTopics => {
            api_integrations::oneoff_ensure_iggy_topics(mode).await
        }
    }
}
