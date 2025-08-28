#![feature(error_generic_member_access)]
#![feature(once_cell_try_insert)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]
#![allow(clippy::borrow_interior_mutable_const)]
#![allow(clippy::ptr_arg)]

use crate::config::*;
use crate::types::*;
use clap::Parser;
use redis::aio::ConnectionManager;
use redis::ConnectionLike;
use rustls::crypto::ring;

pub mod atak;
pub mod aws;
pub mod backup;
pub mod config;
pub mod datasource;
pub mod delta;
pub mod elm;
pub mod entities;
pub mod error;
pub mod event_stream;
pub mod functest;
pub mod icons;
pub mod importer;
mod install;
pub mod kml;
pub mod kv;
mod location;
pub mod log_api;
pub mod messenger;
pub mod migration;
pub mod ml;
pub mod nlp;
pub mod oneoff;
pub mod operator;
pub mod organism;
pub mod rer_importer;
pub mod secret;
pub mod server;
pub mod session;
pub mod sigint;
pub mod tags;
pub mod terminal;
pub mod tests;
pub mod types;
pub mod unit;
pub mod users;
pub mod utils;
pub mod whatsapp;
pub mod zip;

#[macro_export]
macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

pub async fn renew_tailscale_cert(
    mode: Mode,
    force: Option<bool>,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    echo_install_utils::tailscale::renew_cert(
        &config.public_host,
        "echo",
        "echo",
        force,
    )
    .await
    .context(h!())?;
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
pub struct OneoffRadioPerDayPerAbonentPs {
    pub input: String,
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
}

#[derive(clap::Parser, Debug, Clone)]
pub struct OneoffBatchUskToWgsPs {
    pub input: String,
}

/// Export units to JSON
#[derive(clap::Parser, Debug, Clone)]
pub struct ExportUnitPs {
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
}

/// Export callsigns from JSON
#[derive(clap::Parser, Debug, Clone)]
pub struct ImportUnitPs {
    #[arg(long, value_enum)]
    pub upsert: bool,
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
    #[arg(long, value_enum)]
    #[arg(long, value_enum)]
    pub origin: String,
    #[arg(long, action)]
    pub autocommit: Option<bool>,
}

#[derive(clap::Parser, Debug)]
pub struct OneoffExportEtalonDataPs {
    #[arg(long, value_enum)]
    pub destination_path: String,
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

#[derive(clap::Subcommand, Debug)]
#[command(author, version, about, long_about = None)]
enum Cmd {
    Server(ServerPs),
    GenElm,
    SigintWorker,
    Migration,
    ExportUnit(ExportUnitPs),
    ImportUnit(ImportUnitPs),
    RenewTailscaleCert(RenewTailscaleCertPs),
    Backup,
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
    OneoffGenDatasetCallsigns,
    OneoffReprocessCoords(OneoffReprocessCoordsPs),
    OneoffReprocessUnitNames,
    OneoffReprocessSearchIndex(OneoffReprocessSearchIndexPs),
    OneoffNominalizeFreq,
    OneoffRoundFreq,
    OneoffRegisterUser(OneoffRegisterUserPs),
    OneoffRegisterDeltaUser(OneoffRegisterDeltaUserPs),
    OneoffRerCsvImport(OneoffRerCsvImportPs),
    OneoffFillCompFreq(OneoffFillCompFreqPs),
    OneoffBatchUskToWgs(OneoffBatchUskToWgsPs),
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
    OneoffGetNetworksActivityStats(OneoffGetNetworksActivityStatsPs),
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
    let config = config::read_config(mode).context(h!())?;
    new_pg_pool_from_config(&config).await
}

pub async fn new_pg_pool_from_config(
    config: &Config,
) -> Result<sea_orm::DatabaseConnection, AppError> {
    let conn_string = mk_conn_string(config);
    let mut opt = sea_orm::ConnectOptions::new(conn_string);
    opt.max_connections(30)
        .min_connections(0)
        .idle_timeout(core::time::Duration::from_secs(30))
        .sqlx_logging(true)
        .sqlx_logging_level(log::LevelFilter::Debug)
        .sqlx_slow_statements_logging_settings(
            log::LevelFilter::Warn,
            core::time::Duration::from_millis(1000),
        );

    let db = sea_orm::Database::connect(opt).await?;
    Ok(db)
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

pub fn redis_conn_string(config: &Config) -> anyhow::Result<String> {
    let host = match &config.redis_host {
        Some(host) => host.clone(),
        None => REDIS_HOST.to_string(),
    };
    let port = match &config.redis_port {
        Some(port) => *port,
        None => REDIS_PORT,
    };
    let redis_url = format!("redis://{host}:{port}/");
    Ok(redis_url)
}

pub async fn new_redis(config: &Config) -> anyhow::Result<ConnectionManager> {
    let redis_url = redis_conn_string(config).context(h!())?;
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

#[tokio::main]
async fn main() -> Result<(), AppError> {
    // Install the default rustls crypto provider (ring) for the process
    ring::default_provider()
        .install_default()
        .expect("failed to install default rustls ring provider");
    let args = Arg::parse();
    let mode = args.mode;

    env_logger::try_init_from_env(
        env_logger::Env::new().default_filter_or("info,wdintel_rs=debug"),
    )
    .ok(); // Ignore the error if logger is already initialized

    match args.action {
        Cmd::Server(ps) => {
            let _: () = crate::server::main_server(mode, ps).await.unwrap();
            Ok(())
        }
        Cmd::OneoffEnsureTagsOrdering => {
            crate::tags::ordering::oneoff_ensure_tags_ordering(mode).await
        }
        Cmd::OneoffTestKml => crate::kml::main_test_kml(mode),
        Cmd::OneoffTestXmlLib => crate::atak::main_test_xml_lib(mode),
        Cmd::GenElm => crate::elm::main_gen_elm(),
        Cmd::OneoffPrintDescriptionIconTitle => {
            crate::kml::oneoff_print_description_icon_title(mode)
        }
        Cmd::OneoffTerminalPdfExtract => {
            crate::terminal::oneoff_terminal_pdf_extract()
        }
        Cmd::OneoffTestOpencv => crate::terminal::oneoff_test_opencv(),
        Cmd::OneoffParseHtml => crate::terminal::oneoff_parse_html(),
        Cmd::OneoffTestFullCirclePdf => {
            crate::terminal::oneoff_test_full_circle().await
        }
        Cmd::OneoffKmzToGeojson(ps) => crate::delta::oneoff_kmz_to_geojson(&ps),
        Cmd::OneoffRadioByFreq => crate::kml::oneoff_radio_by_freq().await,
        Cmd::OneoffRadioPerDayPerAbonent(ps) => {
            crate::kml::oneoff_radio_per_day_per_abonent_main(
                mode, &ps, None, None,
            )
            .await
        }
        Cmd::OneoffFixKmz(ps) => {
            crate::kml::oneoff_fix_kml_main(mode, &ps).await
        }
        Cmd::SigintWorker => crate::sigint::worker::sigint_worker(mode).await,
        Cmd::Migration => crate::migration::run_migration(mode).await,
        Cmd::RenewTailscaleCert(ps) => {
            renew_tailscale_cert(mode, ps.force).await
        }
        Cmd::Backup => crate::backup::backup(mode).await,
        Cmd::OneoffSigintImportMouse(ps) => {
            crate::sigint::oneoff_sigint_import_mouse(mode, &ps).await
        }
        Cmd::OneoffReprocessCoords(ps) => {
            crate::sigint::oneoff_reprocess_coords(mode, &ps).await
        }
        Cmd::OneoffReprocessUnitNames => {
            crate::rer_importer::oneoff_reprocess_unit_names(mode).await
        }
        Cmd::OneoffReprocessSearchIndex(ps) => {
            crate::rer_importer::search::oneoff_reprocess_search_index(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffDeltaCsvToKmz(ps) => {
            let _ = crate::delta::csv::csv_to_kmz(mode, &ps).unwrap();
            Ok(())
        }
        Cmd::OneoffReprocessCallsignTokens(ps) => {
            crate::rer_importer::callsigns::oneoff_reprocess_callsign_tokens(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffReprocessCallsigns(ps) => {
            crate::rer_importer::callsigns::oneoff_reprocess_callsigns(
                mode, &ps,
            )
            .await
        }
        Cmd::OneoffGenDatasetCallsigns => {
            crate::ml::oneoff_gen_dataset_callsigns(mode).await
        }
        Cmd::OneoffNominalizeFreq => {
            crate::rer_importer::oneoff_nominalize_freq(mode).await
        }
        Cmd::OneoffRoundFreq => {
            crate::rer_importer::oneoff_round_freq(mode).await
        }
        Cmd::OneoffRegisterUser(ps) => {
            crate::users::oneoff_register_user(mode, &ps).await
        }
        Cmd::OneoffRegisterDeltaUser(ps) => {
            crate::users::oneoff_register_delta_user(mode, &ps).await
        }
        Cmd::OneoffRerCsvImport(ps) => {
            crate::rer_importer::import_csv::oneoff_rer_csv_import(mode, &ps)
                .await
        }
        Cmd::OneoffFillCompFreq(ps) => {
            crate::rer_importer::reports::oneoff_fill_comp_freq(mode, &ps).await
        }
        Cmd::OneoffBatchUskToWgs(ps) => {
            oneoff::oneoff_batch_usk_to_wgs(mode, &ps).unwrap();
            Ok(())
        }
        Cmd::ExportUnit(ps) => {
            crate::rer_importer::unit::export_unit(mode, &ps).await
        }
        Cmd::ImportUnit(ps) => {
            crate::rer_importer::unit::import_unit(mode, &ps).await
        }
        Cmd::OneoffMergeAllNetworks => {
            crate::sigint::network::oneoff_merge_all_possible_networks(mode)
                .await
        }
        Cmd::OneoffMergeTwoNetworks(ps) => {
            crate::sigint::network::oneoff_merge_two_networks(mode, &ps).await
        }
        Cmd::OneoffInstall(ps) => crate::install::mount_tmp(&ps)
            .await
            .map_err(|e| AppError::AnyhowError { source: e }),
        Cmd::OneoffReprocessUnitsSearchIndex => {
            crate::sigint::unit::oneoff_reprocess_units_search_index(mode).await
        }
        Cmd::OneoffExportEtalonData(ps) => {
            crate::sigint::import::oneoff_export_etalon_data(
                mode,
                ps.destination_path,
            )
            .await
        }
        Cmd::OneoffImportEtalonData(ps) => {
            crate::sigint::import::oneoff_import_etalon_data(
                mode,
                ps.path,
                ps.origin,
                ps.autocommit.unwrap_or(false),
            )
            .await
        }
        Cmd::OneoffBackupVaultSecretsToBitwarden => {
            crate::secret::oneoff_backup_vault_secrets_to_bitwarden(mode).await
        }
        Cmd::OneoffRestoreVaultSecretsFromBitwarden => {
            crate::secret::oneoff_restore_vault_secrets_from_bitwarden(mode)
                .await
        }
        Cmd::OneoffImportDataSource(ps) => {
            crate::datasource::importer::oneoff_import_datasource(mode, ps)
                .await
        }
        Cmd::OneoffExportDataSource(ps) => {
            crate::datasource::importer::oneoff_export_datasource(mode, ps)
                .await
        }
        Cmd::OneoffFixAreasOfResponsibility(ps) => {
            oneoff::oneoff_fix_areas_of_responsibility(
                mode,
                ps.force_all_networks,
            )
            .await
        }
        Cmd::OneoffPrintOrganismGroups(ps) => {
            crate::organism::oneoff::oneoff_print_organism_groups(mode, &ps)
                .await
        }
        Cmd::OneoffAssignMessageIds(ps) => {
            crate::messenger::id::oneoff_assign_message_ids(
                mode,
                ps.dry_run.unwrap_or(true),
            )
            .await
        }
        Cmd::OneoffGetNetworksActivityStats(ps) => {
            crate::sigint::network::oneoff_network_activity_stat(mode, &ps).await
        }
    }
}
