#![feature(error_generic_member_access)]
#![feature(once_cell_try_insert)]

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
pub mod icons;
pub mod importer;
mod install;
pub mod kml;
pub mod kv;
mod location;
pub mod log_api;
pub mod migration;
pub mod ml;
pub mod nlp;
pub mod oneoff;
pub mod organism;
pub mod rer_importer;
pub mod secret;
pub mod server;
pub mod session;
pub mod sigint;
pub mod tags;
pub mod tailscale;
pub mod terminal;
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

#[derive(clap::Subcommand, Debug)]
#[command(author, version, about, long_about = None)]
enum Cmd {
    Server(ServerPs),
    GenElm,
    SigintWorker,
    Migration,
    ExportUnit(ExportUnitPs),
    ImportUnit(ImportUnitPs),
    RenewTailscaleCert,
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
    let config = config::read_config(mode).unwrap();
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
    let pg_port = config.pg_port.clone().unwrap_or(DEFAULT_PG_PORT);
    let pg_user = config
        .pg_user
        .clone()
        .unwrap_or(DEFAULT_PG_USER.to_string());
    let pg_password = config
        .pg_password
        .clone()
        .unwrap_or(DEFAULT_PG_PASSWORD.to_string());
    let pg_dbname = config
        .pg_dbname
        .clone()
        .unwrap_or(DEFAULT_PG_DBNAME.to_string());
    let conn_string = format!(
        "postgresql://{}:{}@{}:{}/{}",
        pg_user, pg_password, pg_host, pg_port, pg_dbname,
    );
    conn_string
}

pub async fn new_redis(config: &Config) -> anyhow::Result<ConnectionManager> {
    let host = match &config.redis_host {
        Some(host) => host.clone(),
        None => REDIS_HOST.to_string(),
    };
    let port = match &config.redis_port {
        Some(port) => *port,
        None => REDIS_PORT,
    };
    let redis_url = format!("redis://{}:{}/", host, port);
    let mut redis_cli = redis::Client::open(redis_url)?;
    let is_ok = redis_cli.check_connection();
    if !is_ok {
        bail!("Redis connection failed");
    }
    let conn_manager =
        redis_cli.get_connection_manager().await.context(h!())?;
    Ok(conn_manager)
}

fn main() -> Result<(), AppError> {
    // Install the default rustls crypto provider (ring) for the process
    ring::default_provider()
        .install_default()
        .expect("failed to install default rustls ring provider");
    let args = Arg::parse();
    let mode = args.mode;

    env_logger::init_from_env(
        env_logger::Env::new().default_filter_or("info,wdintel_rs=debug"),
    );

    match args.action {
        Cmd::Server(ps) => Ok(crate::server::main_server(mode, ps).unwrap()),
        Cmd::OneoffEnsureTagsOrdering => {
            crate::tags::ordering::oneoff_ensure_tags_ordering(mode)
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
            crate::terminal::oneoff_test_full_circle()
        }
        Cmd::OneoffKmzToGeojson(ps) => crate::delta::oneoff_kmz_to_geojson(&ps),
        Cmd::OneoffRadioByFreq => crate::kml::oneoff_radio_by_freq(),
        Cmd::OneoffRadioPerDayPerAbonent(ps) => {
            crate::kml::oneoff_radio_per_day_per_abonent_main(
                mode, &ps, None, None,
            )
        }
        Cmd::OneoffFixKmz(ps) => crate::kml::oneoff_fix_kml_main(mode, &ps),
        Cmd::SigintWorker => crate::sigint::worker::sigint_worker(mode),
        Cmd::Migration => crate::migration::run_migration(mode),
        Cmd::RenewTailscaleCert => crate::tailscale::renew_tailscale_cert(mode),
        Cmd::Backup => crate::backup::backup(mode),
        Cmd::OneoffSigintImportMouse(ps) => {
            crate::sigint::oneoff_sigint_import_mouse(mode, &ps)
        }
        Cmd::OneoffReprocessCoords(ps) => {
            crate::sigint::oneoff_reprocess_coords(mode, &ps)
        }
        Cmd::OneoffReprocessUnitNames => {
            crate::rer_importer::oneoff_reprocess_unit_names(mode)
        }
        Cmd::OneoffReprocessSearchIndex(ps) => {
            crate::rer_importer::search::oneoff_reprocess_search_index(
                mode, &ps,
            )
        }
        Cmd::OneoffDeltaCsvToKmz(ps) => {
            let _ = crate::delta::csv::csv_to_kmz(mode, &ps).unwrap();
            Ok(())
        }
        Cmd::OneoffReprocessCallsignTokens(ps) => Ok(
            crate::rer_importer::callsigns::oneoff_reprocess_callsign_tokens(
                mode, &ps,
            )
            .unwrap(),
        ),
        Cmd::OneoffReprocessCallsigns(ps) => {
            Ok(crate::rer_importer::callsigns::oneoff_reprocess_callsigns(
                mode, &ps,
            )
            .unwrap())
        }
        Cmd::OneoffGenDatasetCallsigns => {
            Ok(crate::ml::oneoff_gen_dataset_callsigns(mode).unwrap())
        }
        Cmd::OneoffNominalizeFreq => {
            Ok(crate::rer_importer::oneoff_nominalize_freq(mode).unwrap())
        }
        Cmd::OneoffRoundFreq => {
            Ok(crate::rer_importer::oneoff_round_freq(mode).unwrap())
        }
        Cmd::OneoffRegisterUser(ps) => {
            Ok(crate::users::oneoff_register_user(mode, &ps).unwrap())
        }
        Cmd::OneoffRegisterDeltaUser(ps) => {
            Ok(crate::users::oneoff_register_delta_user(mode, &ps).unwrap())
        }
        Cmd::OneoffRerCsvImport(ps) => Ok(
            crate::rer_importer::import_csv::oneoff_rer_csv_import(mode, &ps)
                .unwrap(),
        ),
        Cmd::OneoffFillCompFreq(ps) => Ok(
            crate::rer_importer::reports::oneoff_fill_comp_freq(mode, &ps)
                .unwrap(),
        ),
        Cmd::OneoffBatchUskToWgs(ps) => {
            Ok(oneoff::oneoff_batch_usk_to_wgs(mode, &ps).unwrap())
        }
        Cmd::ExportUnit(ps) => {
            Ok(crate::rer_importer::unit::export_unit(mode, &ps).unwrap())
        }
        Cmd::ImportUnit(ps) => {
            Ok(crate::rer_importer::unit::import_unit(mode, &ps).unwrap())
        }
        Cmd::OneoffMergeAllNetworks => Ok(
            crate::sigint::network::oneoff_merge_all_possible_networks(mode)
                .unwrap(),
        ),
        Cmd::OneoffMergeTwoNetworks(ps) => {
            Ok(crate::sigint::network::oneoff_merge_two_networks(mode, &ps)
                .unwrap())
        }
        Cmd::OneoffInstall(ps) => Ok(crate::install::mount_tmp(&ps).unwrap()),
        Cmd::OneoffReprocessUnitsSearchIndex => {
            crate::sigint::unit::oneoff_reprocess_units_search_index(mode)
        }
    }
}
