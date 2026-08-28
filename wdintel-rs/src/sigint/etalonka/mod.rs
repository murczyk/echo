use crate::error::AppError;
use crate::sigint::callsign::bl_network_callsign::*;
use crate::sigint::callsign::types::*;
// use crate::sigint::network::network_callsigns;
use crate::sigint::network::types::{NetworkDescrType, NetworkDescription};
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use docx_rs::*;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

use crate::config::{Config, ETALONKA_GEO_SCREENSHOT_CONCURRENCY};
use crate::rer_importer::report_chunking::{
    report_period_chunks, ReportPeriodEnd,
};
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::etalonka::util::*;
use futures_util::{StreamExt, TryStreamExt};
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect,
};
use std::path::Path;
use std::str::FromStr;

const OLD_CALLSIGNS_COLOR: &str = "696969";
const DEFAULT_TABLE_HEADER_COLOR: &str = "f2f2f2";
const DEFAULT_PURPOSE: &str =
    "для управління підлеглим особовим складом підрозділу.";
const DEFAULT_OPERATION_MODE: &str = "дуплекс";
const DEFAULT_OPERATION_TYPE: &str = "ведення службового радіообміну";
const DEFAULT_OPERATION_PERIOD: &str = "цілодобово";
const DEFAULT_MODULATION: &str = "уточнюється";

const PARAGRAPH_1_STYLE_NAME: &str = "Paragraph 1";
const PARAGRAPH_2_STYLE_NAME: &str = "Paragraph 2";
const TABLE_HEADER_STYLE_NAME: &str = "Table Header";

pub mod query;
pub mod task;
pub mod types;
pub mod util;

pub(crate) struct EtalonkaProgress {
    units: ProgressBar,
    networks: ProgressBar,
}

impl EtalonkaProgress {
    pub fn new(multi: &MultiProgress, units_total: usize) -> Self {
        let style = etalonka_progress_style();
        let units = multi.add(ProgressBar::new(units_total as u64));
        units.set_style(style.clone());
        units.set_message("units overall");
        let networks = multi.add(ProgressBar::new(0));
        networks.set_style(style);
        networks.set_message("networks");
        Self { units, networks }
    }

    pub fn start_unit(&self, unit_name: &str, networks_total: usize) {
        self.units
            .set_message(format!("units (current: {unit_name})"));
        self.networks.set_length(networks_total as u64);
        self.networks.set_position(0);
        self.networks
            .set_message(format!("networks for {unit_name}"));
    }

    pub fn inc_network(&self) {
        self.networks.inc(1);
    }

    pub fn finish_unit(&self) {
        self.units.inc(1);
    }

    pub fn finish(&self) {
        self.networks.finish();
        self.units.finish();
    }
}

fn etalonka_progress_style() -> ProgressStyle {
    ProgressStyle::with_template(
        "{msg} [{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} ({percent}%) ETA {eta}",
    )
    .expect("progress style template")
    .progress_chars("=>-")
}

pub enum CallsignTableType {
    MainRadioStations,
    CommandControlStations,
    OtherStations,
    AbsentMainStation,
}

fn select_callsigns_for_table_type(
    net_callsigns: &[NetworkCallsign],
    callsigns_table_type: &CallsignTableType,
) -> Vec<NetworkCallsign> {
    match callsigns_table_type {
        CallsignTableType::MainRadioStations => net_callsigns
            .iter()
            .filter(|nc| nc.main_radio_station)
            .cloned()
            .collect(),
        CallsignTableType::CommandControlStations => net_callsigns
            .iter()
            .filter(|nc| nc.command_control && !nc.main_radio_station)
            .cloned()
            .collect(),
        CallsignTableType::OtherStations => net_callsigns
            .iter()
            .filter(|nc| {
                !nc.main_radio_station && !nc.command_control && !nc.developing
            })
            .cloned()
            .collect(),
        CallsignTableType::AbsentMainStation => net_callsigns
            .iter()
            .filter(|nc| {
                !nc.main_radio_station && !nc.command_control && !nc.developing
            })
            .cloned()
            .collect(),
    }
}

pub async fn bl_etalonka_report_networks_data(
    dbx: &DatabaseConnection,
    user_login: &uuid::Uuid,
    req: &EtalonkaJimForksReq,
    trace_id: Uuid,
) -> Result<EtalonkaData, AppError> {
    let groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_login)
            .await
            .c(h!())?;
    let networks_data = load_networks(dbx, req).await.context(h!())?;

    Ok(collect_etalonka_data(
        dbx,
        user_login,
        groups,
        networks_data,
        &req.etalonka_type,
        trace_id,
    )
    .await
    .c(h!())?)
}

pub async fn bl_etalonka_report_networks_batch_id_data(
    dbx: &DatabaseConnection,
    user_login: &uuid::Uuid,
    req: &EtalonkaNetworkBatchReq,
    trace_id: Uuid,
) -> Result<EtalonkaData, AppError> {
    let groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_login)
            .await
            .c(h!())?;
    let networks_data = load_networks_by_id(dbx, req).await.context(h!())?;

    Ok(collect_etalonka_data(
        dbx,
        user_login,
        groups,
        networks_data,
        &req.etalonka_type,
        trace_id,
    )
    .await
    .c(h!())?)
}

//  All the docx generation logic for etalonka report
pub async fn generate_networks_docx_report(
    filename: &str,
    etalonka_type: &EtalonkaReportType,
    etalonka_data: EtalonkaData,
    config: &Config,
) -> Result<PathBuf, AppError> {
    let storage_dir =
        std::path::PathBuf::from_str(&config.storage_dir).context(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);

    let outpath = outfolder.join(filename);
    generate_networks_docx_report_to_path(
        &outpath,
        etalonka_type,
        etalonka_data,
    )
    .await
    .context(h!())?;
    Ok(outpath)
}

pub async fn generate_networks_docx_report_to_path(
    outpath: &Path,
    etalonka_type: &EtalonkaReportType,
    etalonka_data: EtalonkaData,
) -> Result<(), AppError> {
    crate::report_history::ensure_report_record_count(
        etalonka_report_record_count(&etalonka_data),
    )
    .context(h!())?;
    let file = std::fs::File::create(outpath)?;

    let doc = match etalonka_type {
        EtalonkaReportType::AccordingToTheForm(settings) => {
            etalonka_due_form(etalonka_data, settings).await.c(h!())?
        }
        EtalonkaReportType::ExtendedReport(settings) => {
            etalonka_extended(etalonka_data, settings).await.c(h!())?
        }
    };

    doc.build().pack(file).context(h!())?;
    Ok(())
}

pub struct EtalonkaData {
    groups: Vec<String>,
    networks_data: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    entries: HashMap<EtalonkaEntryKey, EtalonkaEntry>,
    sources: HashMap<i64, String>,
}

fn etalonka_report_record_count(data: &EtalonkaData) -> usize {
    let network_count = data
        .networks_data
        .values()
        .fold(0_usize, |count, networks| {
            count.saturating_add(networks.len())
        });
    data.entries.values().fold(network_count, |count, entry| {
        let signal_count = entry
            .network_unit_signals
            .iter()
            .fold(0_usize, |count, unit| {
                count.saturating_add(unit.signals.len())
            });
        count
            .saturating_add(entry.net_callsigns.len())
            .saturating_add(entry.freqs.len())
            .saturating_add(entry.callsigns_detailed.len())
            .saturating_add(entry.network_descriptions.len())
            .saturating_add(signal_count)
    })
}

fn etalonka_network_ids(
    networks_data: &BTreeMap<
        NetworkEtalonkaUnitKey,
        Vec<NetworkEtalonkaResult>,
    >,
) -> Vec<i64> {
    networks_data
        .values()
        .flat_map(|unit_networks| {
            unit_networks.iter().map(|network| network.id)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[derive(Debug, Eq, PartialEq, Ord, PartialOrd, Clone, Hash, Default)]
pub struct EtalonkaEntryKey {
    pub unit_name: String,
    pub network_id: i64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EtalonkaEntry {
    pub network_unit_signals: Vec<NetworkSignalsRes>,
    correspondents_number: String,
    unique_modulation: String,
    network_descriptions: Vec<NetworkDescription>,
    net_callsigns: Vec<NetworkCallsign>,
    freqs: Vec<NetworkFreqsRes>,
    freq_id_to_str: HashMap<i64, String>,
    callsigns_detailed: Vec<CallsignRes>,
    pelengs_map: Option<Vec<u8>>,
}

struct PelengsMapJob {
    key: EtalonkaEntryKey,
    network_id: i64,
    filters: Vec<NetworkFreqFilter>,
}

async fn load_pelengs_maps(
    dbx: &DatabaseConnection,
    groups: &[String],
    jobs: Vec<PelengsMapJob>,
) -> Result<Vec<(EtalonkaEntryKey, i64, Option<Vec<u8>>)>, AppError> {
    let dbx = dbx.clone();
    let groups = groups.to_vec();

    futures_util::stream::iter(jobs)
        .map(move |job| {
            let dbx = dbx.clone();
            let groups = groups.clone();
            async move {
                let pelengs_map = load_pelengs_map(
                    &dbx,
                    &groups,
                    job.network_id,
                    &job.filters,
                )
                .await
                .context(h!())?;
                Ok::<_, AppError>((job.key, job.network_id, pelengs_map))
            }
        })
        .buffer_unordered(ETALONKA_GEO_SCREENSHOT_CONCURRENCY)
        .try_collect()
        .await
}

pub async fn collect_etalonka_data(
    dbx: &DatabaseConnection,
    user_id: &uuid::Uuid,
    groups: Vec<String>,
    networks_data: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    report_type: &EtalonkaReportType,
    trace_id: Uuid,
) -> Result<EtalonkaData, AppError> {
    collect_etalonka_data_with_progress(
        dbx,
        user_id,
        groups,
        networks_data,
        report_type,
        trace_id,
        None,
    )
    .await
}

struct EtalonkaCollectionOptions {
    is_extended_report: bool,
    include_pelengs_map: bool,
    include_sigint_signs: bool,
    include_confirmation: bool,
    include_headings_and_freqs: bool,
    filters: Vec<NetworkFreqFilter>,
}

pub(crate) fn normalize_etalonka_report_period(
    report_type: &mut EtalonkaReportType,
    now_ms: i64,
) {
    let EtalonkaReportType::ExtendedReport(settings) = report_type else {
        return;
    };
    let till_ms = settings.till_date_inclusive_ms.unwrap_or(now_ms);
    settings.since_date_inclusive_ms =
        etalonka_report_since_ms(settings.since_date_inclusive_ms, till_ms);
    settings.till_date_inclusive_ms = Some(till_ms);
}

fn etalonka_report_since_ms(since_ms: i64, till_ms: i64) -> i64 {
    if since_ms == 0 {
        till_ms.saturating_sub(
            chrono::Duration::days(
                crate::config::RER_ETALONKA_REPORT_SINCE_DEFAULT_DAYS,
            )
            .num_milliseconds(),
        )
    } else {
        since_ms
    }
    .max(crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS)
}

fn etalonka_collection_options(
    report_type: &EtalonkaReportType,
    chunking_hours: i64,
    now_ms: i64,
    network_count: usize,
) -> Result<EtalonkaCollectionOptions, AppError> {
    match report_type {
        EtalonkaReportType::AccordingToTheForm(settings) => {
            Ok(EtalonkaCollectionOptions {
                is_extended_report: false,
                include_pelengs_map: false,
                include_sigint_signs: settings.include_sigint_signs,
                include_confirmation: settings.include_confirmation,
                include_headings_and_freqs: settings.include_headings_and_freqs,
                filters: vec![NetworkFreqFilter {
                    active_freqs_only: settings.active_freqs_only,
                    since_date_inclusive_ms: None,
                    till_date_inclusive_ms: None,
                    till_date_end: ReportPeriodEnd::Inclusive,
                }],
            })
        }
        EtalonkaReportType::ExtendedReport(settings) => {
            let till_ms = settings.till_date_inclusive_ms.unwrap_or(now_ms);
            let since_ms = etalonka_report_since_ms(
                settings.since_date_inclusive_ms,
                till_ms,
            );
            let filters = if network_count
                <= crate::config::RER_ETALONKA_REPORT_UNCHUNKED_NETWORK_LIMIT
            {
                vec![NetworkFreqFilter {
                    active_freqs_only: settings.active_freqs_only,
                    since_date_inclusive_ms: Some(since_ms),
                    till_date_inclusive_ms: Some(till_ms),
                    till_date_end: ReportPeriodEnd::Inclusive,
                }]
            } else {
                report_period_chunks(
                    since_ms,
                    till_ms,
                    chunking_hours,
                    ReportPeriodEnd::Inclusive,
                )
                .context(h!())?
                .into_iter()
                .map(|chunk| NetworkFreqFilter {
                    active_freqs_only: settings.active_freqs_only,
                    since_date_inclusive_ms: Some(chunk.since_ms),
                    till_date_inclusive_ms: Some(chunk.till_ms),
                    till_date_end: chunk.end,
                })
                .collect()
            };
            Ok(EtalonkaCollectionOptions {
                is_extended_report: true,
                include_pelengs_map: settings.include_pelengs_map,
                include_sigint_signs: settings.include_sigint_signs,
                include_confirmation: settings.include_confirmation,
                include_headings_and_freqs: settings.include_headings_and_freqs,
                filters,
            })
        }
    }
}

pub(crate) async fn collect_etalonka_data_with_progress(
    dbx: &DatabaseConnection,
    user_id: &uuid::Uuid,
    groups: Vec<String>,
    networks_data: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    report_type: &EtalonkaReportType,
    trace_id: Uuid,
    progress: Option<&EtalonkaProgress>,
) -> Result<EtalonkaData, AppError> {
    let report_settings =
        crate::system_settings::get_report_generation_settings(dbx)
            .await
            .c(h!())?;
    let network_ids = etalonka_network_ids(&networks_data);
    let network_count = network_ids.len();
    let options = etalonka_collection_options(
        report_type,
        report_settings.chunking_hours,
        chrono::Utc::now().timestamp_millis(),
        network_count,
    )
    .context(h!())?;
    info!(
        "[trace_id={trace_id}] collecting {network_count} distinct networks with {} period filter(s)",
        options.filters.len(),
    );
    let mut data = EtalonkaData {
        groups,
        networks_data,
        entries: HashMap::new(),
        sources: HashMap::new(),
    };

    let mut all_known_callsigns = BTreeMap::new();
    if options.is_extended_report {
        info!(
            "[trace_id={trace_id}] collecting general data for extended report"
        );
        all_known_callsigns =
            find_all_known_callsigns(dbx).await.context(h!())?;
        data.sources = crate::sigint::source::bl_list_sources(dbx)
            .await
            .context(h!())?
            .into_iter()
            .map(|s| (s.id, s.name))
            .collect();
    }

    let network_descriptions_by_id = if options.include_sigint_signs
        || options.include_confirmation
    {
        crate::sigint::network::bl::get_networks_descriptions(dbx, &network_ids)
            .await
            .context(h!())?
    } else {
        Default::default()
    };

    let show_logs = progress.is_none();
    let mut entries_by_network_id: HashMap<i64, EtalonkaEntry> = HashMap::new();
    let mut pelengs_maps_by_network_id: HashMap<i64, Option<Vec<u8>>> =
        HashMap::new();
    let mut units_remaining = data.networks_data.len();
    for (unit_key, unit_networks) in data.networks_data.iter() {
        let unit_name = &unit_key.unit_name;
        if show_logs {
            units_remaining -= 1;
            info!(
                "[trace_id={trace_id}] collecting report data for unit '{unit_name}', {units_remaining} left"
            );
        } else if let Some(progress) = progress {
            progress.start_unit(unit_name, unit_networks.len());
        }
        let mut network_remaining = unit_networks.len();
        let mut pelengs_map_jobs = Vec::new();
        for network in unit_networks.iter() {
            let network_id = network.id;
            if show_logs {
                network_remaining -= 1;
                info!(
                    "[trace_id={trace_id}] collecting report data for network id={network_id}, {network_remaining} left"
                );
            }
            let key = EtalonkaEntryKey {
                unit_name: unit_name.to_string(),
                network_id,
            };
            let mut entry =
                if let Some(entry) = entries_by_network_id.get(&network_id) {
                    entry.clone()
                } else {
                    let entry = collect_etalonka_entry(
                        dbx,
                        &data.groups,
                        user_id,
                        network,
                        &all_known_callsigns,
                        &network_descriptions_by_id,
                        &options,
                        trace_id,
                    )
                    .await
                    .context(h!())?;
                    entries_by_network_id.insert(network_id, entry.clone());
                    entry
                };
            if options.include_pelengs_map {
                if let Some(pelengs_map) =
                    pelengs_maps_by_network_id.get(&network_id)
                {
                    entry.pelengs_map = pelengs_map.clone();
                    if let Some(progress) = progress {
                        progress.inc_network();
                    }
                } else {
                    pelengs_map_jobs.push(PelengsMapJob {
                        key: key.clone(),
                        network_id,
                        filters: options.filters.clone(),
                    });
                }
            } else if let Some(progress) = progress {
                progress.inc_network();
            }
            data.entries.insert(key, entry);
        }
        if options.include_pelengs_map {
            if show_logs && !pelengs_map_jobs.is_empty() {
                info!(
                    "[trace_id={trace_id}] rendering {} pelengs maps for unit '{unit_name}' with concurrency {}",
                    pelengs_map_jobs.len(),
                    ETALONKA_GEO_SCREENSHOT_CONCURRENCY,
                );
            }
            let pelengs_maps =
                load_pelengs_maps(dbx, &data.groups, pelengs_map_jobs)
                    .await
                    .context(h!())?;
            for (key, network_id, pelengs_map) in pelengs_maps {
                pelengs_maps_by_network_id
                    .insert(network_id, pelengs_map.clone());
                data.entries.get_mut(&key).context(h!())?.pelengs_map =
                    pelengs_map;
                if let Some(progress) = progress {
                    progress.inc_network();
                }
            }
        }
        if let Some(progress) = progress {
            progress.finish_unit();
        }
    }
    if let Some(progress) = progress {
        progress.finish();
    }
    Ok(data)
}

async fn collect_etalonka_entry(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    user_id: &uuid::Uuid,
    network: &NetworkEtalonkaResult,
    all_known_callsigns: &BTreeMap<String, Vec<KnownCallsignRes>>,
    network_descriptions_by_id: &HashMap<i64, Vec<NetworkDescription>>,
    options: &EtalonkaCollectionOptions,
    trace_id: Uuid,
) -> Result<EtalonkaEntry, AppError> {
    let mut entry = EtalonkaEntry::default();
    let list_network_callsigns_req = ListNetworkCallsignsReq {
        network_id: network.id,
        sort_by: None,
        period: None,
    };
    for (index, filter) in options.filters.iter().enumerate() {
        if options.filters.len() > 1 {
            info!(
                "[trace_id={trace_id}] etalonka network id={} chunk {}/{}: {:?}..{:?} ({:?})",
                network.id,
                index + 1,
                options.filters.len(),
                filter.since_date_inclusive_ms,
                filter.till_date_inclusive_ms,
                filter.till_date_end,
            );
        }
        let (net_callsigns, callsigns, freqs) = load_etalonka_entry_chunk(
            dbx,
            groups,
            user_id,
            &list_network_callsigns_req,
            all_known_callsigns,
            options.is_extended_report,
            filter,
        )
        .await
        .context(h!())?;
        merge_network_callsign_chunk(&mut entry.net_callsigns, net_callsigns);
        if !callsigns.is_empty() {
            merge_callsign_chunk(&mut entry.callsigns_detailed, callsigns);
        }
        merge_freq_chunk(&mut entry.freqs, freqs);
    }
    finalize_etalonka_entry(&mut entry);
    load_etalonka_entry_metadata(
        dbx,
        network.id,
        network_descriptions_by_id,
        options,
        &mut entry,
    )
    .await
    .context(h!())?;
    Ok(entry)
}

async fn load_etalonka_entry_chunk(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    user_id: &uuid::Uuid,
    req: &ListNetworkCallsignsReq,
    all_known_callsigns: &BTreeMap<String, Vec<KnownCallsignRes>>,
    is_extended_report: bool,
    filter: &NetworkFreqFilter,
) -> Result<
    (Vec<NetworkCallsign>, Vec<CallsignRes>, Vec<NetworkFreqsRes>),
    AppError,
> {
    let net_callsigns = async {
        if is_extended_report {
            bl_get_network_callsigns_list_for_period(req, user_id, dbx, filter)
                .await
                .context(h!())
        } else {
            bl_get_network_callsigns_list(req, user_id, dbx)
                .await
                .context(h!())
        }
    };
    let callsigns = async {
        if is_extended_report {
            load_callsigns(
                dbx,
                groups,
                req.network_id,
                Some(all_known_callsigns),
                true,
                None,
                Some(filter),
                true,
            )
            .await
            .context(h!())
        } else {
            Ok(Vec::new())
        }
    };
    let freqs = async {
        load_freqs(dbx, groups, req.network_id, Some(filter), user_id, true)
            .await
            .context(h!())
    };

    Ok(tokio::try_join!(net_callsigns, callsigns, freqs).context(h!())?)
}

fn finalize_etalonka_entry(entry: &mut EtalonkaEntry) {
    entry.net_callsigns.sort_by(|left, right| {
        left.callsign
            .cmp(&right.callsign)
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    query::sort_callsigns(&mut entry.callsigns_detailed);
    entry.freqs.sort_by(|left, right| {
        left.freq
            .cmp(&right.freq)
            .then_with(|| left.network_freq_id.cmp(&right.network_freq_id))
    });
    if !entry.net_callsigns.is_empty() {
        let unique_count = entry
            .net_callsigns
            .iter()
            .map(|item| &item.callsign)
            .collect::<HashSet<_>>()
            .len();
        entry.correspondents_number = format!("щонайменше {unique_count} ВЗ.");
    }
    let modulations = entry
        .freqs
        .iter()
        .filter_map(|freq| freq.modulation.clone())
        .collect::<Vec<_>>();
    entry.unique_modulation = uniq_via_btreeset(&modulations).join(", ");
}

async fn load_etalonka_entry_metadata(
    dbx: &DatabaseConnection,
    network_id: i64,
    network_descriptions_by_id: &HashMap<i64, Vec<NetworkDescription>>,
    options: &EtalonkaCollectionOptions,
    entry: &mut EtalonkaEntry,
) -> Result<(), AppError> {
    if (options.include_sigint_signs || options.include_confirmation)
        && options.include_headings_and_freqs
    {
        let rows = crate::entities::sigint_network_freq::Entity::find()
            .filter(
                crate::entities::sigint_network_freq::Column::NetworkId
                    .eq(network_id),
            )
            .filter(
                crate::entities::sigint_network_freq::Column::Deleted.eq(false),
            )
            .select_only()
            .column(crate::entities::sigint_network_freq::Column::Id)
            .column(crate::entities::sigint_network_freq::Column::Freq)
            .into_tuple::<(i64, String)>()
            .all(dbx)
            .await
            .context(h!())?;
        entry.freq_id_to_str = rows.into_iter().collect();
    }
    if options.include_sigint_signs || options.include_confirmation {
        entry.network_descriptions = network_descriptions_by_id
            .get(&network_id)
            .cloned()
            .unwrap_or_default();
        if options.include_sigint_signs {
            entry.network_unit_signals =
                load_signals_per_network(dbx, network_id)
                    .await
                    .context(h!())?;
        }
    }
    Ok(())
}

fn merge_network_callsign_chunk(
    target: &mut Vec<NetworkCallsign>,
    chunk: Vec<NetworkCallsign>,
) {
    for callsign in chunk {
        if let Some(existing) = target.iter_mut().find(|existing| {
            existing.id == callsign.id
                && existing.created_at == callsign.created_at
        }) {
            existing.message_count += callsign.message_count;
            existing.last_datetime =
                latest_datetime(existing.last_datetime, callsign.last_datetime);
            merge_optional_strings(&mut existing.freqs, callsign.freqs);
        } else {
            target.push(callsign);
        }
    }
}

fn merge_callsign_chunk(
    target: &mut Vec<CallsignRes>,
    chunk: Vec<CallsignRes>,
) {
    for callsign in chunk {
        if let Some(existing) = target.iter_mut().find(|existing| {
            existing.callsign == callsign.callsign
                && existing.known_callsigns == callsign.known_callsigns
        }) {
            existing.message_count += callsign.message_count;
            existing.last_datetime =
                latest_datetime(existing.last_datetime, callsign.last_datetime);
            merge_optional_strings(&mut existing.freqs, callsign.freqs);
            merge_optional_strings(
                &mut existing.network_names,
                callsign.network_names,
            );
            existing.is_old |= callsign.is_old;
        } else {
            target.push(callsign);
        }
    }
}

fn merge_freq_chunk(
    target: &mut Vec<NetworkFreqsRes>,
    chunk: Vec<NetworkFreqsRes>,
) {
    for freq in chunk {
        if let Some(existing) = target
            .iter_mut()
            .find(|existing| existing.network_freq_id == freq.network_freq_id)
        {
            existing.message_count += freq.message_count;
            existing.last_datetime =
                latest_datetime(existing.last_datetime, freq.last_datetime);
            existing.last_datetime_in_aor = latest_datetime(
                existing.last_datetime_in_aor,
                freq.last_datetime_in_aor,
            );
            merge_optional_strings(&mut existing.callsigns, freq.callsigns);
        } else {
            target.push(freq);
        }
    }
}

fn latest_datetime(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    left.into_iter().chain(right).max()
}

fn merge_optional_strings(
    target: &mut Option<Vec<String>>,
    incoming: Option<Vec<String>>,
) {
    let Some(incoming) = incoming else {
        return;
    };
    let target = target.get_or_insert_default();
    target.extend(incoming);
    target.sort();
    target.dedup();
}

///  Etalonka report according to the MO form
pub async fn etalonka_due_form(
    etalonka_data: EtalonkaData,
    settings: &EtalonkaSettings,
) -> Result<Docx, AppError> {
    // Unit	Twips Equivalent
    // 1 inch	1440 twips
    // 1 cm	~567 twips
    // 1 pt (point)	20 twips
    let width_unit = 195;

    let mut doc = init_report(PageOrientationType::Portrait, 11906, 16838);
    doc = add_report_styles(doc);
    doc = add_report_header(doc);

    for (i, (unit_key, unit_networks)) in
        etalonka_data.networks_data.iter().enumerate()
    {
        let unit_name = &unit_key.unit_name;
        // Add unit name as title
        doc = doc.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(28).bold().add_text(unit_name))
                .outline_lvl(0), // .align(JustificationType::Center),
        );

        for (index, network) in unit_networks.iter().enumerate() {
            let etalonka_data_entry_key = EtalonkaEntryKey {
                unit_name: unit_name.clone(),
                network_id: network.id,
            };
            let etalonka_data_entry = etalonka_data
                .entries
                .get(&etalonka_data_entry_key)
                .context(h!())?;
            // Add Section 1-4 with general information
            doc = add_network_report_section_1_4(
                doc,
                &network.network_full_name,
                &network.location,
                &network.purpose,
                &etalonka_data_entry.correspondents_number,
            );

            // Add Section 5 with network callsigns
            doc = add_network_callsigns_section(
                doc,
                &etalonka_data_entry.net_callsigns,
                None,
                width_unit,
                &EtalonkaReportType::AccordingToTheForm(settings.clone()),
            );

            // Add Section 6 with network freques
            doc = add_network_freqs_section(
                doc,
                &etalonka_data_entry.freqs,
                width_unit,
                &EtalonkaReportType::AccordingToTheForm(settings.clone()),
            );

            // Add Section 7-10 with general information
            doc = add_network_report_section_7_10(
                doc,
                &etalonka_data_entry.unique_modulation,
                &network.operation_mode,
                &network.operation_type,
                &network.operation_period,
            );

            // Add Section 11-12. Розвідувальні ознаки підрозділу, Обгрунтування  прив'язки
            if settings.include_sigint_signs || settings.include_confirmation {
                let freq_map = &etalonka_data_entry.freq_id_to_str;
                if settings.include_sigint_signs {
                    doc = add_network_sigint_signs(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        &etalonka_data_entry.network_unit_signals,
                        settings.include_headings_and_freqs,
                        freq_map,
                    )
                    .await
                    .c(h!())?;
                }

                if settings.include_confirmation {
                    doc = add_network_confirmation(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        settings.include_headings_and_freqs,
                        freq_map,
                    );
                }
            }

            // Add empty paragraph after each network if this is not the last network
            if index < unit_networks.len() - 1 {
                doc = doc.add_paragraph(Paragraph::new());
            }
        }

        // Add empty paragraph after each unit if this is NOT the last
        if i < etalonka_data.networks_data.len() - 1 {
            doc = doc.add_paragraph(Paragraph::new());
        }
    }

    Ok(doc)
}

///  Extended talonka report
pub async fn etalonka_extended(
    etalonka_data: EtalonkaData,
    settings: &EtalonkaExtendedSettings,
) -> Result<Docx, AppError> {
    let sources: HashMap<i64, String> = etalonka_data.sources;

    let width_unit = 300;

    let mut doc = init_report(PageOrientationType::Landscape, 16838, 11906);
    doc = add_report_styles(doc);
    doc = add_report_header(doc);

    for (i, (unit_key, unit_networks)) in
        etalonka_data.networks_data.iter().enumerate()
    {
        let unit_name = &unit_key.unit_name;
        // Add unit name as title
        doc = doc.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(28).bold().add_text(unit_name))
                .outline_lvl(0), // .align(JustificationType::Center),
        );

        for (index, network) in unit_networks.iter().enumerate() {
            let etalonka_data_entry_key = EtalonkaEntryKey {
                unit_name: unit_name.clone(),
                network_id: network.id,
            };
            let etalonka_data_entry = etalonka_data
                .entries
                .get(&etalonka_data_entry_key)
                .context(h!())?;
            // list of callsigns manually assigned to the Network
            let net_callsigns = &etalonka_data_entry.net_callsigns;

            // list of all other callsigns active per network activity period
            let callsigns = &etalonka_data_entry.callsigns_detailed;

            let correspondents_number =
                if net_callsigns.is_empty() && callsigns.is_empty() {
                    String::new()
                } else {
                    let unique_count = net_callsigns
                        .iter()
                        .map(|item| &item.callsign)
                        .chain(callsigns.iter().map(|item| &item.callsign))
                        .collect::<HashSet<_>>()
                        .len();
                    format!("щонайменше {unique_count} ВЗ.")
                };

            let freqs = &etalonka_data_entry.freqs;

            let modulations = freqs
                .iter()
                .filter_map(|f| f.modulation.clone())
                .collect::<Vec<String>>();
            let unique_modulation = uniq_via_btreeset(&modulations).join(", ");

            // Add Section 1-4 with general information
            doc = add_network_report_section_1_4(
                doc,
                &network.network_full_name,
                &network.location,
                &network.purpose,
                &correspondents_number,
            );

            // Add Section 5 with network callsigns
            doc = add_network_callsigns_section(
                doc,
                net_callsigns,
                Some(&sources),
                width_unit,
                &EtalonkaReportType::ExtendedReport(settings.clone()),
            );

            // Add Section 5b with known callsigns assigned to the Unit, which was present in radio communication
            // during selected period
            if settings.include_unit_callsigns {
                doc = add_unit_callsigns_section(
                    doc,
                    callsigns,
                    width_unit,
                    settings.include_callsign_full_names,
                );
            }

            // Add Section 6 with network freques
            doc = add_network_freqs_section(
                doc,
                freqs,
                width_unit,
                &EtalonkaReportType::ExtendedReport(settings.clone()),
            );

            // Add Section 7-10 with general information
            doc = add_network_report_section_7_10(
                doc,
                &unique_modulation,
                &network.operation_mode,
                &network.operation_type,
                &network.operation_period,
            );

            // Add Section 11-12. Розвідувальні ознаки підрозділу, Обгрунтування  прив'язки
            if settings.include_sigint_signs || settings.include_confirmation {
                let freq_map = &etalonka_data_entry.freq_id_to_str;
                if settings.include_sigint_signs {
                    doc = add_network_sigint_signs(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        &etalonka_data_entry.network_unit_signals,
                        settings.include_headings_and_freqs,
                        freq_map,
                    )
                    .await
                    .c(h!())?;
                }

                if settings.include_confirmation {
                    doc = add_network_confirmation(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        settings.include_headings_and_freqs,
                        freq_map,
                    );
                }
            }

            // Section 13. Карти пеленгів для мережі
            if settings.include_pelengs_map {
                doc = add_network_pelengs_map(
                    etalonka_data_entry.pelengs_map.clone(),
                    doc,
                )
                .await
                .c(h!())?
            }

            // Add empty paragraph after each network if this is not the last network
            if index < unit_networks.len() - 1 {
                doc = doc.add_paragraph(Paragraph::new());
            }
        }

        // Add empty paragraph after each unit if this is NOT the last
        if i < etalonka_data.networks_data.len() - 1 {
            doc = doc.add_paragraph(Paragraph::new());
        }
    }

    Ok(doc)
}

/// Create blank docx document
fn init_report(
    page_orientation: PageOrientationType,
    page_w: u32,
    page_h: u32,
) -> Docx {
    docx_rs::Docx::new()
        .page_orient(page_orientation)
        .page_size(page_w, page_h)
        .default_size(24)
        .default_fonts(RunFonts::new().ascii("Times New Roman"))
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(1984) // 3.5 cm
                .right(567) // 1 cm
                .top(1134) // 2 cm
                .bottom(1134), // 2 cm
        )
}

/// Define styles for the report
fn add_report_styles(doc: Docx) -> Docx {
    let paragraph_1_style = define_new_paragraph_style(
        PARAGRAPH_1_STYLE_NAME,
        "Times New Roman",
        24,
        true,
        AlignmentType::Left,
    );

    let paragraph_2_style = define_new_paragraph_style(
        PARAGRAPH_2_STYLE_NAME,
        "Times New Roman",
        24,
        false,
        AlignmentType::Left,
    );

    let table_header_style = define_new_paragraph_style(
        TABLE_HEADER_STYLE_NAME,
        "Times New Roman",
        24,
        true,
        AlignmentType::Center,
    );

    doc.add_style(paragraph_1_style)
        .add_style(paragraph_2_style)
        .add_style(table_header_style)
}

/// Add header text to the report
fn add_report_header(doc: Docx) -> Docx {
    doc.add_paragraph(
        Paragraph::new()
            .style(&gen_style_id_by_name(PARAGRAPH_1_STYLE_NAME))
            .add_run(Run::new().add_text(
                "ДОНЕСЕННЯ").bold())
            .align(docx_rs::alignment_type::AlignmentType::Center),
    )
        .add_paragraph(
            Paragraph::new()
                .style(&gen_style_id_by_name(PARAGRAPH_1_STYLE_NAME))
                .add_run(Run::new().add_text(
                    r#"“Еталонні описи джерел радіовипромінювання противника у зоні відповідальності угруповання військ (сил)”"#).bold())
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
}

// Add section 1-4 to the report
fn add_network_report_section_1_4(
    mut doc: Docx,
    network_full_name: &String,
    network_location: &Option<String>,
    network_purpose: &Option<String>,
    correspondents_number: &String,
) -> Docx {
    doc = add_field(doc, "1. Назва радіомережі: ", network_full_name);

    doc = add_field(
        doc,
        "2. Район функціонування/розгортання: ",
        network_location.as_deref().unwrap_or_default(),
    );
    doc = add_field(
        doc,
        "3. Призначення: ",
        network_purpose.as_deref().unwrap_or(DEFAULT_PURPOSE),
    );
    doc = add_field(doc, "4. Склад кореспондентів: ", correspondents_number);
    doc
}

// Add section 7-10 to the report
fn add_network_report_section_7_10(
    mut doc: Docx,
    unique_modulation: &String,
    network_operation_mode: &Option<String>,
    network_operation_type: &Option<String>,
    network_operation_period: &Option<String>,
) -> Docx {
    doc = add_field(doc, "7. Вид передачі: ", unique_modulation);
    doc = add_field(
        doc,
        "8. Режим роботи радіомережі: ",
        network_operation_mode
            .as_deref()
            .unwrap_or(DEFAULT_OPERATION_MODE),
    );
    doc = add_field(
        doc,
        "9. Характер роботи: ",
        network_operation_type
            .as_deref()
            .unwrap_or(DEFAULT_OPERATION_TYPE),
    );
    doc = add_field(
        doc,
        "10. Період функціонування: ",
        network_operation_period
            .as_deref()
            .unwrap_or(DEFAULT_OPERATION_PERIOD),
    );
    doc
}

/// Add network linkege confirmation to the report
fn add_network_confirmation(
    mut doc: Docx,
    width_unit: usize,
    network_descriptions: &[NetworkDescription],
    include_headings_and_freqs: bool,
    freq_map: &HashMap<i64, String>,
) -> Docx {
    doc = add_field(doc, "12. Обгрунтування  прив'язки: ", &String::default());

    // then add network description with Confitmation type
    if let Some(table) = build_network_description_table(
        network_descriptions,
        NetworkDescrType::Confirmation,
        width_unit,
        include_headings_and_freqs,
        freq_map,
    ) {
        doc = doc.add_table(table);
    }
    doc
}

/// Add network sigint signs to the report
async fn add_network_sigint_signs(
    doc: Docx,
    width_unit: usize,
    network_descriptions: &[NetworkDescription],
    network_unit_signals: &[NetworkSignalsRes],
    include_headings_and_freqs: bool,
    freq_map: &HashMap<i64, String>,
) -> Result<Docx, AppError> {
    let invisible_paragraph = Paragraph::new()
        .add_run(Run::new().size(1))
        .line_spacing(LineSpacing::new().before(0).after(0).line(0));

    let mut doc = add_field(
        doc,
        "11. Розвідувальні ознаки підрозділу: ",
        &String::default(),
    );
    // first add network description with Sign type
    if let Some(table) = build_network_description_table(
        network_descriptions,
        NetworkDescrType::Sign,
        width_unit,
        include_headings_and_freqs,
        freq_map,
    ) {
        doc = doc.add_table(table);
    }

    // add invisible paragraph between two tables to avoid ms word issue with corrupted rendering of the first table
    if !network_unit_signals.is_empty() {
        doc = doc.add_paragraph(invisible_paragraph.clone());
    }
    for unit_signals in network_unit_signals.iter() {
        // if network has multiple units, add unit name
        if network_unit_signals.len() > 1 && !unit_signals.signals.is_empty() {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .style(&gen_style_id_by_name(PARAGRAPH_2_STYLE_NAME))
                    .add_run(
                        Run::new()
                            .add_text(
                                format!("{}: ", unit_signals.unit_name)
                                    .as_str(),
                            )
                            .bold(),
                    ),
            );
        }
        // Add signals table for each unit
        if !unit_signals.signals.is_empty() {
            if let Some(table) = build_network_unit_signals_table(
                &unit_signals.signals,
                width_unit,
            ) {
                doc = doc.add_table(table);
            }
        }
    }
    Ok(doc)
}

async fn add_network_pelengs_map(
    pelengs_map: Option<Vec<u8>>,
    mut doc: Docx,
) -> Result<Docx, AppError> {
    if let Some(img) = pelengs_map {
        let pic = Pic::new(&img).size(600 * 9525, 450 * 9525);

        doc = doc
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_break(BreakType::Page)),
            )
            .add_paragraph(
                Paragraph::new()
                    .style(&gen_style_id_by_name(PARAGRAPH_2_STYLE_NAME))
                    .add_run(Run::new().add_text(
                        "Карта пеленгів частот підрозділу за звітний період:",
                    ).bold()),
            )
            .add_paragraph(Paragraph::new())
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_image(pic))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            )
            .add_paragraph(Paragraph::new());
    }
    Ok(doc)
}

fn add_network_callsigns_section(
    mut doc: Docx,
    net_callsigns: &[NetworkCallsign],
    sources: Option<&HashMap<i64, String>>,
    width_unit: usize,
    report_type: &EtalonkaReportType,
) -> Docx {
    let include_full_names = match report_type {
        EtalonkaReportType::AccordingToTheForm(settings) => {
            settings.include_callsign_full_names
        }
        EtalonkaReportType::ExtendedReport(settings) => {
            settings.include_callsign_full_names
        }
    };

    // Section title
    doc = add_field(doc, "5. Позивні: ", "");

    // Helper closure to choose table builder based on report type
    let build_nc_table = |table_type: &CallsignTableType,
                          callsigns: &Vec<NetworkCallsign>,
                          sources: Option<&HashMap<i64, String>>,
                          width: usize| {
        match report_type {
            EtalonkaReportType::AccordingToTheForm(_) => {
                build_basic_network_callsigns_table(
                    table_type,
                    callsigns,
                    width,
                    include_full_names,
                )
            }
            EtalonkaReportType::ExtendedReport(_) => {
                build_extended_network_callsigns_table(
                    table_type,
                    callsigns,
                    sources,
                    width,
                    include_full_names,
                )
            }
        }
    };

    // Check if any main radio station exists
    let has_main_radio_station =
        net_callsigns.iter().any(|nc| nc.main_radio_station);
    let has_command_control = net_callsigns.iter().any(|nc| nc.command_control);

    if has_main_radio_station {
        let nc_for_main_radio_station = select_callsigns_for_table_type(
            net_callsigns,
            &CallsignTableType::MainRadioStations,
        );

        if let Some(table) = build_nc_table(
            &CallsignTableType::MainRadioStations,
            &nc_for_main_radio_station,
            sources,
            width_unit,
        ) {
            doc = doc.add_table(table).add_paragraph(Paragraph::new());
        }
    }

    if has_command_control {
        let nc_for_command_control = select_callsigns_for_table_type(
            net_callsigns,
            &CallsignTableType::CommandControlStations,
        );

        if let Some(table) = build_nc_table(
            &CallsignTableType::CommandControlStations,
            &nc_for_command_control,
            sources,
            width_unit,
        ) {
            doc = doc.add_table(table).add_paragraph(Paragraph::new());
        }
    }

    if !net_callsigns.is_empty() {
        let nc_filtered = select_callsigns_for_table_type(
            net_callsigns,
            if has_main_radio_station {
                &CallsignTableType::OtherStations
            } else {
                &CallsignTableType::AbsentMainStation
            },
        );

        if let Some(table) = build_nc_table(
            if has_main_radio_station {
                &CallsignTableType::OtherStations
            } else {
                &CallsignTableType::AbsentMainStation
            },
            &nc_filtered,
            sources,
            width_unit,
        ) {
            doc = doc.add_table(table);
        }
    }

    if !net_callsigns.is_empty() {
        let callsigns_other = net_callsigns
            .iter()
            .filter(|c| c.developing)
            .map(|c| format_callsign(c, include_full_names))
            .collect::<Vec<String>>()
            .join(", ");

        if !callsigns_other.is_empty() {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("в дорозвідці - ").bold())
                    .add_run(Run::new().add_text(callsigns_other)),
            );
        }
    }
    doc
}

fn add_unit_callsigns_section(
    mut doc: Docx,
    callsigns: &[CallsignRes],
    width_unit: usize,
    include_full_names: bool,
) -> Docx {
    if !callsigns.is_empty() {
        let filtered_callsigns: Vec<CallsignRes> = callsigns
            .iter()
            .filter(|callsign| {
                callsign
                    .known_callsigns
                    .as_ref()
                    .is_some_and(|v| !v.is_empty())
            })
            .cloned()
            .collect();

        if !filtered_callsigns.is_empty() {
            // Section title
            doc = add_field(doc, "Співпадіння з каталогом: ", "");

            // Add known callsigns linked to the unit in table
            if let Some(table) = build_unit_callsigns_table(
                &filtered_callsigns,
                width_unit,
                include_full_names,
            ) {
                doc = doc.add_table(table);
            }
        }

        // add all other callsigns in text
        let callsigns_other = callsigns
            .iter()
            .filter(|callsign| callsign.known_callsigns.is_none())
            .map(|callsign| callsign.callsign.to_uppercase().clone())
            .collect::<Vec<String>>()
            .join(", ");

        if !callsigns_other.is_empty() {
            doc = doc.add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Приналежність встановлюється - ")
                            .bold(),
                    )
                    .add_run(Run::new().add_text(callsigns_other)),
            );
        }
    }
    doc
}

fn add_network_freqs_section(
    mut doc: Docx,
    net_freqs: &[NetworkFreqsRes],
    width_unit: usize,
    report_type: &EtalonkaReportType,
) -> Docx {
    // Section title
    doc = add_field(doc, "6. Робочі частоти: ", "");

    // Helper closure to choose table builder based on report type
    let build_freqs_table =
        |freqs: &[NetworkFreqsRes], width: usize| match report_type {
            EtalonkaReportType::AccordingToTheForm(_) => {
                build_basic_freqs_table(freqs, width)
            }
            EtalonkaReportType::ExtendedReport(settings) => {
                build_extended_freqs_table(
                    freqs,
                    width,
                    settings.include_freq_active_from,
                    settings.include_freq_created_at,
                )
            }
        };

    if let Some(table) = build_freqs_table(net_freqs, width_unit) {
        doc = doc.add_table(table);
    }
    doc
}

/// Generic helper to build a docx table from headers + row builder
fn build_table<T, F>(
    items: &[T],
    headers: Vec<TableCell>,
    row_builder: F,
    width_unit: usize,
    title_row: Option<TableRow>,
) -> Option<Table>
where
    F: Fn(&T) -> Vec<TableCell>,
{
    if items.is_empty() {
        return None;
    }

    let mut rows: Vec<TableRow> = Vec::new();

    // optional title row (already built by caller if needed)
    if let Some(tr) = title_row {
        rows.push(tr);
    }

    // header row (consumes headers)
    if !headers.is_empty() {
        rows.push(TableRow::new(headers));
    }

    // data rows
    rows.extend(items.iter().map(|item| TableRow::new(row_builder(item))));

    Some(
        Table::new(rows)
            .width(width_unit * 48, WidthType::Dxa)
            .layout(TableLayoutType::Fixed)
            .set_borders(TableBorders::new()),
    )
}

/// Build the "basic network callsigns" table using `build_table`
fn build_basic_network_callsigns_table(
    callsigns_table_type: &CallsignTableType,
    net_callsigns: &[NetworkCallsign],
    width_unit: usize,
    include_full_names: bool,
) -> Option<Table> {
    if net_callsigns.is_empty() {
        return None;
    }

    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);

    let headers = vec![
        create_table_header_cell(
            width_unit * 9,
            None,
            &header_style_id,
            "Позивний",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 26,
            None,
            &header_style_id,
            "Приналежність",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 13,
            None,
            &header_style_id,
            "Останній раз в етері",
            false,
            0,
        ),
    ];

    let row_builder = Box::new(move |callsign: &NetworkCallsign| {
        vec![
            create_table_data_cell(
                width_unit * 9,
                &format_callsign(callsign, include_full_names),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 26,
                format!(
                    "{} {}",
                    callsign.position.clone().unwrap_or_default(),
                    callsign.unit_name.clone().unwrap_or_default(),
                )
                .as_str(),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 13,
                format_datetime_field(callsign.last_datetime).as_str(),
                None,
                false,
            ),
        ]
    });

    // build optional title row and pass to build_table
    let title_row = match callsigns_table_type {
        CallsignTableType::MainRadioStations => Some("Головна радіостанція"),
        CallsignTableType::CommandControlStations => Some("Ланка управління"),
        CallsignTableType::OtherStations => Some("Підлеглі радіостанції"),
        _ => None,
    }
    .map(|title| {
        TableRow::new(vec![create_table_header_cell(
            width_unit * 48,
            None,
            &header_style_id,
            title,
            false,
            3,
        )])
    });

    build_table(net_callsigns, headers, row_builder, width_unit, title_row)
}

/// Build the "extended network callsigns" table using `build_table`
fn build_extended_network_callsigns_table(
    callsigns_table_type: &CallsignTableType,
    net_callsigns: &[NetworkCallsign],
    sources: Option<&HashMap<i64, String>>,
    width_unit: usize,
    include_full_names: bool,
) -> Option<Table> {
    if net_callsigns.is_empty() {
        return None;
    }

    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);

    let headers = vec![
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Позивний",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 10,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Приналежність",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 10,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Коментар",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 2,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "К-ть",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 4,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Частоти",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Останній раз в етері",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Дата прив'язки",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 5,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Джерело",
            false,
            0,
        ),
    ];

    let row_builder = {
        let sources = sources.cloned(); // move into closure safely
        Box::new(move |callsign: &NetworkCallsign| {
            vec![
                create_table_data_cell(
                    width_unit * 6,
                    &format_callsign(callsign, include_full_names),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 10,
                    format!(
                        "{} {}",
                        callsign.position.clone().unwrap_or_default(),
                        callsign.unit_name.clone().unwrap_or_default(),
                    )
                    .as_str(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 10,
                    callsign.comment.as_deref().unwrap_or_default(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 2,
                    &callsign.message_count.to_string(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 4,
                    get_unique_field_as_string(&callsign.freqs, |f| f.clone())
                        .as_str(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 6,
                    format_datetime_field(callsign.last_datetime).as_str(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 6,
                    format_datetime_field(Some(callsign.created_at)).as_str(),
                    None,
                    false,
                ),
                create_table_data_cell(
                    width_unit * 5,
                    callsign
                        .source_id
                        .and_then(|id| {
                            sources.as_ref().and_then(|m| m.get(&id))
                        })
                        .map_or("", |s| s.as_str()),
                    None,
                    false,
                ),
            ]
        })
    };

    // build optional title row and pass to build_table
    let title_row = match callsigns_table_type {
        CallsignTableType::MainRadioStations => Some("Головна радіостанція"),
        CallsignTableType::CommandControlStations => Some("Ланка управління"),
        CallsignTableType::OtherStations => Some("Підлеглі радіостанції"),
        _ => None,
    }
    .map(|title| {
        TableRow::new(vec![create_table_header_cell(
            width_unit * 48,
            None,
            &header_style_id,
            title,
            false,
            8,
        )])
    });

    build_table(net_callsigns, headers, row_builder, width_unit, title_row)
}

/// Helper: Generate the callsigns table
fn build_unit_callsigns_table(
    callsigns: &[CallsignRes],
    width_unit: usize,
    include_full_names: bool,
) -> Option<Table> {
    if callsigns.is_empty() {
        return None;
    }

    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);

    let headers = vec![
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Позивний",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 10,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Приналежність",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 10,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Коментар",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 2,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "К-ть",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 4,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Частоти",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Останній раз в етері",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 6,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Дата прив'язки",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 5,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Джерело",
            false,
            0,
        ),
    ];

    let row_builder = move |callsign: &CallsignRes| {
        vec![
            create_table_data_cell(
                width_unit * 6,
                &format_detailed_callsign(callsign, include_full_names),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 10,
                get_unique_field_as_string(&callsign.known_callsigns, |item| {
                    item.position.clone()
                })
                .as_str(),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 10,
                get_unique_field_as_string(&callsign.known_callsigns, |item| {
                    item.comment.clone()
                })
                .as_str(),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 2,
                &callsign.message_count.to_string(),
                get_color(callsign.is_old),
                false,
            ),
            create_table_data_cell(
                width_unit * 4,
                get_unique_field_as_string(&callsign.freqs, |f| f.clone())
                    .as_str(),
                get_color(callsign.is_old),
                false,
            ),
            create_table_data_cell(
                width_unit * 6,
                format_datetime_field(callsign.last_datetime).as_str(),
                get_color(callsign.is_old),
                false,
            ),
            create_table_data_cell(
                width_unit * 6,
                get_unique_field_as_string(&callsign.known_callsigns, |item| {
                    format_datetime_field(Some(item.created_at))
                })
                .as_str(),
                get_color(callsign.is_old),
                false,
            ),
            create_table_data_cell(
                width_unit * 5,
                get_unique_field_as_string(&callsign.known_callsigns, |item| {
                    item.source_name.clone()
                })
                .as_str(),
                get_color(callsign.is_old),
                false,
            ),
        ]
    };

    build_table(callsigns, headers, row_builder, width_unit, None)
}

/// Build basic frequency table
fn build_basic_freqs_table(
    freqs: &[NetworkFreqsRes],
    width_unit: usize,
) -> Option<Table> {
    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);

    let headers = vec![
        create_table_header_cell(
            width_unit * 19,
            None,
            &header_style_id,
            "Частота",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 16,
            None,
            &header_style_id,
            "Модуляція",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 13,
            None,
            &header_style_id,
            "Останній раз в етері",
            false,
            0,
        ),
    ];

    let row_builder = move |freq: &NetworkFreqsRes| {
        vec![
            create_table_data_cell(width_unit * 19, &freq.freq, None, false),
            create_table_data_cell(
                width_unit * 16,
                &freq
                    .modulation
                    .clone()
                    .unwrap_or(DEFAULT_MODULATION.to_string()),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 13,
                &format_datetime_field(freq.last_datetime),
                get_color(!freq.is_active),
                false,
            ),
        ]
    };

    build_table(freqs, headers, row_builder, width_unit, None)
}

/// Build extended frequency table
fn build_extended_freqs_table(
    freqs: &[NetworkFreqsRes],
    width_unit: usize,
    include_active_from: bool,
    include_created_at: bool,
) -> Option<Table> {
    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);
    let date_columns_count =
        usize::from(include_active_from) + usize::from(include_created_at);
    let callsigns_width = 30 - 7 * date_columns_count;

    let mut headers = vec![
        create_table_header_cell(
            width_unit * 4,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Частота",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 5,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Модуляція",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 2,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "К-ть",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * callsigns_width,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Позивні",
            false,
            0,
        ),
        create_table_header_cell(
            width_unit * 7,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Останній раз в етері",
            false,
            0,
        ),
    ];

    if include_active_from {
        headers.push(create_table_header_cell(
            width_unit * 7,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Активна з",
            false,
            0,
        ));
    }
    if include_created_at {
        headers.push(create_table_header_cell(
            width_unit * 7,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Дата прив'язки",
            false,
            0,
        ));
    }

    let row_builder = move |freq: &NetworkFreqsRes| {
        let formatted_callsigns = freq
            .callsigns
            .as_ref()
            .map(|calls| {
                calls
                    .iter()
                    .map(|s| s.to_uppercase())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();

        let mut cells = vec![
            create_table_data_cell(width_unit * 4, &freq.freq, None, false),
            create_table_data_cell(
                width_unit * 5,
                &freq
                    .modulation
                    .clone()
                    .unwrap_or(DEFAULT_MODULATION.to_string()),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 2,
                &freq.message_count.to_string(),
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * callsigns_width,
                &formatted_callsigns,
                None,
                false,
            ),
            create_table_data_cell(
                width_unit * 7,
                &format_datetime_field(freq.last_datetime),
                get_color(!freq.is_active),
                false,
            ),
        ];

        if include_active_from {
            cells.push(create_table_data_cell(
                width_unit * 7,
                &format_datetime_field(Some(freq.active_from)),
                get_color(!freq.is_active),
                false,
            ));
        }
        if include_created_at {
            cells.push(create_table_data_cell(
                width_unit * 7,
                &format_datetime_field(Some(freq.created_at)),
                get_color(!freq.is_active),
                false,
            ));
        }
        cells
    };

    build_table(freqs, headers, row_builder, width_unit, None)
}

pub fn build_network_description_table(
    network_descriptions: &[NetworkDescription],
    filter_type: NetworkDescrType,
    width_unit: usize,
    include_headings_and_freqs: bool,
    freq_map: &HashMap<i64, String>,
) -> Option<Table> {
    let filtered_descriptions = network_descriptions
        .iter()
        .filter(|desc| desc.descr_type == filter_type)
        .cloned()
        .collect::<Vec<_>>();

    if filtered_descriptions.is_empty() {
        return None;
    }

    if include_headings_and_freqs {
        let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);
        let headers = vec![
            create_table_header_cell(
                width_unit * 10,
                None,
                &header_style_id,
                "Частота",
                false,
                0,
            ),
            create_table_header_cell(
                width_unit * 14,
                None,
                &header_style_id,
                "Заголовок",
                false,
                0,
            ),
            create_table_header_cell(
                width_unit * 24,
                None,
                &header_style_id,
                "Опис",
                false,
                0,
            ),
        ];
        let freq_map = freq_map.clone();
        let row_builder = move |descr: &NetworkDescription| {
            let freq = descr
                .network_frequency_id
                .and_then(|id| freq_map.get(&id))
                .cloned()
                .unwrap_or_default();
            let topic = descr.topic.clone().unwrap_or_default();
            vec![
                create_table_data_cell(width_unit * 10, &freq, None, false),
                create_table_data_cell(width_unit * 14, &topic, None, false),
                create_table_data_cell(
                    width_unit * 24,
                    &descr.description,
                    None,
                    false,
                ),
            ]
        };
        build_table(
            &filtered_descriptions,
            headers,
            row_builder,
            width_unit,
            None,
        )
    } else {
        let row_builder = |descr: &NetworkDescription| {
            vec![create_table_data_cell(
                width_unit * 48,
                &descr.description,
                None,
                false,
            )]
        };
        build_table(
            &filtered_descriptions,
            vec![],
            row_builder,
            width_unit,
            None,
        )
    }
}

pub fn build_network_unit_signals_table(
    signals: &[Signal],
    width_unit: usize,
) -> Option<Table> {
    if signals.is_empty() {
        return None;
    }

    let row_builder = |signal: &Signal| {
        vec![
            create_table_data_cell(width_unit * 10, &signal.text, None, false),
            create_table_data_cell(
                width_unit * 38,
                &signal.meaning.clone().unwrap_or_default(),
                None,
                false,
            ),
        ]
    };

    build_table(signals, vec![], row_builder, width_unit, None)
}

fn get_color(is_old: bool) -> Option<String> {
    if is_old {
        Some(OLD_CALLSIGNS_COLOR.to_string())
    } else {
        None
    }
}

fn format_callsign(
    callsign: &NetworkCallsign,
    include_full_name: bool,
) -> String {
    format_callsign_with_full_names(
        &callsign.callsign,
        callsign.full_name.iter().cloned().collect(),
        include_full_name,
    )
}

fn format_detailed_callsign(
    callsign: &CallsignRes,
    include_full_names: bool,
) -> String {
    let full_names = callsign
        .known_callsigns
        .as_ref()
        .into_iter()
        .flatten()
        .map(|known_callsign| known_callsign.full_name.clone())
        .collect();
    format_callsign_with_full_names(
        &callsign.callsign,
        full_names,
        include_full_names,
    )
}

fn format_callsign_with_full_names(
    callsign: &str,
    full_names: Vec<String>,
    include_full_names: bool,
) -> String {
    let callsign = callsign.trim().to_uppercase();
    if !include_full_names {
        return callsign;
    }

    let full_names = full_names
        .into_iter()
        .map(|full_name| full_name.trim().to_string())
        .filter(|full_name| !full_name.is_empty())
        .collect::<Vec<_>>();
    let full_names = uniq_via_btreeset(&full_names).join(", ");
    match (callsign.is_empty(), full_names.is_empty()) {
        (false, false) => format!("{callsign} ({full_names})"),
        (true, false) => full_names,
        _ => callsign,
    }
}

fn get_unique_field_as_string<T, F>(
    input: &Option<Vec<T>>,
    field_extractor: F,
) -> String
where
    T: Ord + Clone,
    F: Fn(&T) -> String,
{
    let field_vec = input
        .as_ref()
        .map(|vec| vec.iter().map(field_extractor).collect::<Vec<_>>());

    if let Some(vec) = field_vec {
        crate::utils::uniq_via_btreeset(&vec).join(", ")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::SigintNetworkKind;
    use crate::entities::*;
    use crate::functest::tests::*;
    use crate::sigint::network::types::ListNetworksReq;
    use chrono::Utc;
    use sea_orm::prelude::Expr;
    use sea_orm::ActiveValue::Set;
    use sea_orm::*;
    use serde_json::json;
    use serial_test::serial;

    fn make_network_callsign(
        id: i64,
        callsign: &str,
        main_radio_station: bool,
        command_control: bool,
        developing: bool,
    ) -> NetworkCallsign {
        NetworkCallsign {
            id,
            network_id: 1,
            callsign: callsign.to_string(),
            known_callsign_id: None,
            position: None,
            comment: None,
            full_name: None,
            unit_id: None,
            unit_name: None,
            source_id: None,
            radio_freq: None,
            created_at: Utc::now().timestamp_millis(),
            active: true,
            developing,
            message_count: 0,
            last_datetime: None,
            freqs: None,
            unit_developing: false,
            main_radio_station,
            command_control,
        }
    }

    fn extended_report_type(since_ms: i64, till_ms: i64) -> EtalonkaReportType {
        EtalonkaReportType::ExtendedReport(EtalonkaExtendedSettings {
            since_date_inclusive_ms: since_ms,
            till_date_inclusive_ms: Some(till_ms),
            active_freqs_only: true,
            include_freq_active_from: false,
            include_freq_created_at: true,
            include_callsign_full_names: false,
            include_unit_callsigns: false,
            include_sigint_signs: false,
            include_confirmation: false,
            include_pelengs_map: false,
            include_headings_and_freqs: false,
        })
    }

    #[test]
    fn extended_report_period_uses_nonoverlapping_daily_chunks() {
        let hour_ms = chrono::Duration::hours(1).num_milliseconds();
        let since_ms = crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS;
        let options = etalonka_collection_options(
            &extended_report_type(since_ms, since_ms + 49 * hour_ms),
            24,
            since_ms + 50 * hour_ms,
            crate::config::RER_ETALONKA_REPORT_UNCHUNKED_NETWORK_LIMIT + 1,
        )
        .unwrap();

        assert_eq!(options.filters.len(), 3);
        assert_eq!(options.filters[0].since_date_inclusive_ms, Some(since_ms));
        assert_eq!(
            options.filters[0].till_date_inclusive_ms,
            Some(since_ms + 24 * hour_ms)
        );
        assert_eq!(
            options.filters[0].till_date_end,
            ReportPeriodEnd::NonInclusive
        );
        assert_eq!(
            options.filters[1].since_date_inclusive_ms,
            Some(since_ms + 24 * hour_ms)
        );
        assert_eq!(
            options.filters[2].till_date_end,
            ReportPeriodEnd::Inclusive
        );
    }

    #[test]
    fn extended_report_single_network_uses_full_period_filter() {
        let hour_ms = chrono::Duration::hours(1).num_milliseconds();
        let since_ms = crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS;
        let till_ms = since_ms + 49 * hour_ms;
        let options = etalonka_collection_options(
            &extended_report_type(since_ms, till_ms),
            24,
            since_ms + 50 * hour_ms,
            crate::config::RER_ETALONKA_REPORT_UNCHUNKED_NETWORK_LIMIT,
        )
        .unwrap();

        assert_eq!(options.filters.len(), 1);
        assert_eq!(options.filters[0].since_date_inclusive_ms, Some(since_ms));
        assert_eq!(options.filters[0].till_date_inclusive_ms, Some(till_ms));
        assert_eq!(
            options.filters[0].till_date_end,
            ReportPeriodEnd::Inclusive
        );
    }

    #[test]
    fn extended_report_normalizes_missing_period_before_enqueue() {
        let till_ms =
            chrono::DateTime::parse_from_rfc3339("2026-08-13T00:00:00Z")
                .unwrap()
                .timestamp_millis();
        let mut report_type = extended_report_type(0, till_ms);
        let EtalonkaReportType::ExtendedReport(settings) = &mut report_type
        else {
            unreachable!();
        };
        settings.till_date_inclusive_ms = None;
        normalize_etalonka_report_period(&mut report_type, till_ms);
        let EtalonkaReportType::ExtendedReport(settings) = &report_type else {
            unreachable!();
        };

        assert_eq!(settings.till_date_inclusive_ms, Some(till_ms));
        assert_eq!(
            settings.since_date_inclusive_ms,
            till_ms
                - chrono::Duration::days(
                    crate::config::RER_ETALONKA_REPORT_SINCE_DEFAULT_DAYS,
                )
                .num_milliseconds()
        );
        let options = etalonka_collection_options(
            &report_type,
            24,
            till_ms,
            crate::config::RER_ETALONKA_REPORT_UNCHUNKED_NETWORK_LIMIT + 1,
        )
        .unwrap();

        assert_eq!(
            options.filters[0].since_date_inclusive_ms,
            Some(
                till_ms
                    - chrono::Duration::days(
                        crate::config::RER_ETALONKA_REPORT_SINCE_DEFAULT_DAYS,
                    )
                    .num_milliseconds()
            )
        );
    }

    #[test]
    fn extended_report_caps_since_at_2022() {
        let till_ms = crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS
            + chrono::Duration::days(1).num_milliseconds();
        let mut report_type = extended_report_type(1, till_ms);
        normalize_etalonka_report_period(&mut report_type, till_ms);
        let EtalonkaReportType::ExtendedReport(settings) = &report_type else {
            unreachable!();
        };

        assert_eq!(
            settings.since_date_inclusive_ms,
            crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS
        );
        let options = etalonka_collection_options(
            &report_type,
            24,
            till_ms,
            crate::config::RER_ETALONKA_REPORT_UNCHUNKED_NETWORK_LIMIT + 1,
        )
        .unwrap();

        assert_eq!(
            options.filters[0].since_date_inclusive_ms,
            Some(crate::config::RER_ETALONKA_REPORT_SINCE_MIN_MS)
        );
    }

    async fn set_etalonka_report_chunking_hours(
        dbx: &DatabaseConnection,
        hours: i32,
    ) {
        let result = system_settings::Entity::update_many()
            .col_expr(
                system_settings::Column::ReportChunkingHours,
                Expr::value(hours),
            )
            .filter(system_settings::Column::Deleted.eq(false))
            .exec(dbx)
            .await
            .unwrap();
        if result.rows_affected == 0 {
            system_settings::ActiveModel {
                report_chunking_hours: Set(hours),
                limit_big_reports: Set(false),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .unwrap();
        }
    }

    async fn insert_network_activity(
        dbx: &DatabaseConnection,
        datasource_group_id: i64,
        signal_group_master_key: &str,
        network_id: i64,
        freq: &str,
        timestamp: chrono::NaiveDateTime,
        message_uid: &str,
        callsigns: &[&str],
    ) {
        let message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some("test message".to_string())),
                created_at: Set(timestamp),
                timestamp: Set(Some(timestamp)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some(message_uid.to_string())),
                datasource_group_id: Set(Some(datasource_group_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let inbox_item = mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.to_string())),
                date: Set(None),
                time: Set(None),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let actor_id = find_test_login(dbx).await.unwrap().id;
        crate::inbox::callsigns::sync(
            dbx,
            inbox_item.id,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: callsigns
                    .iter()
                    .map(|callsign| String::from(*callsign))
                    .collect(),
                alg2: Vec::new(),
            },
            actor_id,
        )
        .await
        .unwrap();

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(signal_group_master_key.to_string())),
            sender: Set(Some("sender".to_string())),
            message_uid: Set(Some(message_uid.to_string())),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: Set(timestamp),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();

        sigint_inbox_item_network::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inbox_item.id),
            sigint_network_id: Set(network_id),
            created_at: NotSet,
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_bl_etalonka_report_networks_data_merges_chunks() {
        let env = cleanup().await.unwrap();
        set_etalonka_report_chunking_hours(&env.dbx, 6).await;
        let now = chrono::DateTime::from_timestamp_millis(
            Utc::now().timestamp_millis(),
        )
        .unwrap()
        .naive_utc();

        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let signal_group = find_test_signal_group(&env.dbx).await.unwrap();
        let aor = find_test_aor(&env.dbx).await.unwrap();

        let unit = sigint_unit::ActiveModel {
            company: Set("C".to_string()),
            regiment: Set("R".to_string()),
            division: Set("D".to_string()),
            army: Set("A".to_string()),
            active: Set(true),
            deleted: Set(false),
            created_at: Set(now),
            created_by_login_id: Set(login.id),
            name: Set("TestUnit".to_string()),
            comment: Set("".to_string()),
            battalion: Set("B".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let network = sigint_network::ActiveModel {
            name: Set("TestNetwork".to_string()),
            location: Set("TestLocation".to_string()),
            deleted: Set(false),
            created_at: Set(now),
            updated_by_login_id: Set(None),
            updated_at: Set(now),
            radio_station: Set(None),
            purpose: Set(Some("purpose".to_string())),
            operation_mode: Set(None),
            operation_type: Set(None),
            operation_period: Set(None),
            merged_to: Set(None),
            active_from: Set(Some(now)),
            active_to: Set(None),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let other_network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("OtherNetwork".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        sigint_network_unit::ActiveModel {
            network_id: Set(network.id),
            unit_id: Set(unit.id),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        sigint_network_unit::ActiveModel {
            network_id: Set(other_network.id),
            unit_id: Set(unit.id),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        sigint_network_aor::ActiveModel {
            network_id: Set(network.id),
            aor_id: Set(aor.id),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let freq = "123.4500".to_string();

        sigint_network_freq::ActiveModel {
            network_id: Set(network.id),
            freq: Set(freq.clone()),
            created_at: Set(now),
            kind: Set(SigintNetworkKind::Vhf),
            modulation: Set("NFM".to_string()),
            modulation_id: Set(None),
            encryption_id: Set(None),
            active_from: Set(now - chrono::Duration::days(1)),
            active_to: Set(None),
            sigint_origin_id: Set(None),
            deleted: Set(false),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let moved_at = now - chrono::Duration::hours(6);
        let moved_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("Moved".to_string()),
            deleted: Set(false),
            created_at: Set(now - chrono::Duration::days(1)),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        sigint_network_callsign_changelog::ActiveModel {
            sigint_network_callsign_id: Set(moved_callsign.id),
            login_id: Set(login.id),
            action: Set(
                crate::entities::sea_orm_active_enums::ChangelogActionEnum::Update,
            ),
            old_value: Set(Some(json!({
                "sigint_network_id": other_network.id,
            }))),
            new_value: Set(Some(json!({
                "sigint_network_id": network.id,
            }))),
            created_at: Set(moved_at),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let moved_away_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(other_network.id),
            sigint_callsign: Set("MovedAway".to_string()),
            deleted: Set(false),
            created_at: Set(now - chrono::Duration::days(1)),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let returning_created_at = now - chrono::Duration::days(1);
        let returning_left_at = now - chrono::Duration::hours(8);
        let returning_relinked_at = now - chrono::Duration::hours(4);
        let returning_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("Returning".to_string()),
            deleted: Set(false),
            created_at: Set(returning_created_at),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        for (created_at, old_network_id, new_network_id) in [
            (returning_left_at, network.id, other_network.id),
            (returning_relinked_at, other_network.id, network.id),
        ] {
            sigint_network_callsign_changelog::ActiveModel {
                sigint_network_callsign_id: Set(returning_callsign.id),
                login_id: Set(login.id),
                action: Set(
                    crate::entities::sea_orm_active_enums::ChangelogActionEnum::Update,
                ),
                old_value: Set(Some(json!({
                    "sigint_network_id": old_network_id,
                }))),
                new_value: Set(Some(json!({
                    "sigint_network_id": new_network_id,
                }))),
                created_at: Set(created_at),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        sigint_network_callsign_changelog::ActiveModel {
            sigint_network_callsign_id: Set(moved_away_callsign.id),
            login_id: Set(login.id),
            action: Set(
                crate::entities::sea_orm_active_enums::ChangelogActionEnum::Update,
            ),
            old_value: Set(Some(json!({
                "sigint_network_id": network.id,
            }))),
            new_value: Set(Some(json!({
                "sigint_network_id": other_network.id,
            }))),
            created_at: Set(moved_at),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        sigint_callsign::ActiveModel {
            callsign: Set("Alpha".to_string()),
            position: Set("pos".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set("Петренко Петро".to_string()),
            unit_id: Set(unit.id),
            deleted: Set(false),
            created_at: Set(now),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(freq.clone()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let deleted_catalog_callsign = sigint_callsign::ActiveModel {
            callsign: Set("DeletedLinked".to_string()),
            position: Set(String::new()),
            comment: Set(String::new()),
            full_name: Set(String::new()),
            unit_id: Set(unit.id),
            deleted: Set(true),
            created_at: Set(now - chrono::Duration::days(1)),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(freq.clone()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let deleted_linked_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("DeletedLinked".to_string()),
            sigint_callsign_id: Set(Some(deleted_catalog_callsign.id)),
            deleted: Set(false),
            created_at: Set(now - chrono::Duration::days(1)),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for created_at in [
            now - chrono::Duration::days(1),
            now - chrono::Duration::hours(18),
        ] {
            sigint_network_callsign::ActiveModel {
                sigint_network_id: Set(network.id),
                sigint_callsign: Set("Overlapping".to_string()),
                deleted: Set(false),
                created_at: Set(created_at),
                developing: Set(false),
                unit_developing: Set(false),
                main_radio_station: Set(false),
                command_control: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        for (callsign, full_name, created_at) in [
            ("Beta", "Бутилкін Сергій", now - chrono::Duration::days(1)),
            ("Stale", "Старий Позивний", now - chrono::Duration::days(1)),
            ("Late", "Пізній Позивний", now + chrono::Duration::hours(1)),
        ] {
            sigint_network_callsign::ActiveModel {
                sigint_network_id: Set(network.id),
                sigint_callsign: Set(callsign.to_string()),
                full_name: Set(Some(full_name.to_string())),
                deleted: Set(false),
                created_at: Set(created_at),
                developing: Set(false),
                unit_developing: Set(false),
                main_radio_station: Set(false),
                command_control: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        for (callsign, deleted_at) in [
            ("Historical", now + chrono::Duration::hours(1)),
            ("Expired", now - chrono::Duration::hours(1)),
        ] {
            let network_callsign = sigint_network_callsign::ActiveModel {
                sigint_network_id: Set(network.id),
                sigint_callsign: Set(callsign.to_string()),
                deleted: Set(true),
                created_at: Set(now - chrono::Duration::days(1)),
                developing: Set(false),
                unit_developing: Set(false),
                main_radio_station: Set(false),
                command_control: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            sigint_network_callsign_changelog::ActiveModel {
                sigint_network_callsign_id: Set(network_callsign.id),
                login_id: Set(login.id),
                action: Set(
                    crate::entities::sea_orm_active_enums::ChangelogActionEnum::Delete,
                ),
                created_at: Set(deleted_at),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let relinked_at = now - chrono::Duration::hours(6);
        let historical_relinked_callsign =
            sigint_network_callsign::ActiveModel {
                sigint_network_id: Set(network.id),
                sigint_callsign: Set("Relinked".to_string()),
                deleted: Set(true),
                created_at: Set(now - chrono::Duration::days(1)),
                developing: Set(false),
                unit_developing: Set(false),
                main_radio_station: Set(false),
                command_control: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        sigint_network_callsign_changelog::ActiveModel {
            sigint_network_callsign_id: Set(historical_relinked_callsign.id),
            login_id: Set(login.id),
            action: Set(
                crate::entities::sea_orm_active_enums::ChangelogActionEnum::Delete,
            ),
            created_at: Set(relinked_at),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let current_relinked_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("Relinked".to_string()),
            deleted: Set(false),
            created_at: Set(relinked_at),
            developing: Set(false),
            unit_developing: Set(false),
            main_radio_station: Set(false),
            command_control: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        sigint_callsign::ActiveModel {
            callsign: Set(String::new()),
            position: Set("pio".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set("Іваненко Іван Іванович".to_string()),
            unit_id: Set(unit.id),
            deleted: Set(false),
            created_at: Set(now),
            source_id: Set(None),
            developing: Set(false),
            radio_freq: Set(String::new()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let historical_activity_at = now - chrono::Duration::hours(12);
        insert_network_activity(
            &env.dbx,
            datasource_group.id,
            &signal_group.master_key,
            network.id,
            &freq,
            historical_activity_at,
            "uid-historical",
            &["Relinked", "Moved", "MovedAway", "Returning"],
        )
        .await;
        insert_network_activity(
            &env.dbx,
            datasource_group.id,
            &signal_group.master_key,
            network.id,
            &freq,
            historical_activity_at + chrono::Duration::hours(6),
            "uid-boundary",
            &["Alpha", "Beta", "Boundary"],
        )
        .await;
        insert_network_activity(
            &env.dbx,
            datasource_group.id,
            &signal_group.master_key,
            network.id,
            &freq,
            now,
            "uid-current",
            &[
                "Alpha",
                "Beta",
                "Late",
                "Historical",
                "Expired",
                "Relinked",
                "Moved",
                "MovedAway",
                "Returning",
                "DeletedLinked",
                "Overlapping",
            ],
        )
        .await;

        let ts = now.and_utc().timestamp_millis();
        let historical_ts = historical_activity_at.and_utc().timestamp_millis();

        let mut req = EtalonkaJimForksReq {
            req: ListNetworksReq {
                filter_freq: None,
                filter_unit: None,
                filter_unit_army_region: None,
                filter_unit_military_district: None,
                filter_unit_army: None,
                filter_unit_division: None,
                filter_unit_regiment: None,
                filter_unit_battalion: None,
                filter_text: None,
                filter_name: None,
                filter_location: None,
                show_only_further_inverstigation: None,
                show_inactive: None,
                show_only_deleted: None,
                status_filter: None,
                aor_ids: None,
                ids: Some(vec![network.id]),
                limit: None,
                offset: None,
                sort_by: None,
            },
            etalonka_type: extended_report_type(historical_ts, ts),
        };

        let unchunked_data = bl_etalonka_report_networks_data(
            &env.dbx,
            &login.id,
            &req,
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        req.req.ids = Some(vec![network.id, other_network.id]);
        let data = bl_etalonka_report_networks_data(
            &env.dbx,
            &login.id,
            &req,
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        assert!(data.groups.contains(&signal_group.master_key));

        let entry_key = EtalonkaEntryKey {
            unit_name: "TestUnit".to_string(),
            network_id: network.id,
        };
        let entry = data.entries.get(&entry_key).expect("expected entry");
        let unchunked_entry = unchunked_data
            .entries
            .get(&entry_key)
            .expect("expected unchunked entry");
        assert_eq!(entry, unchunked_entry);

        let callsign = entry
            .callsigns_detailed
            .iter()
            .find(|c| c.callsign == "Alpha")
            .expect("expected callsign Alpha");
        assert_eq!(callsign.message_count, 2);
        assert!(callsign.known_callsigns.is_some());
        assert_eq!(callsign.known_callsigns.as_ref().unwrap().len(), 1);
        assert_eq!(
            callsign.known_callsigns.as_ref().unwrap()[0].callsign,
            "Alpha"
        );
        assert_eq!(
            callsign.known_callsigns.as_ref().unwrap()[0].full_name,
            "Петренко Петро"
        );
        assert_eq!(callsign.freqs.as_ref().unwrap(), &vec![freq.clone()]);
        assert!(callsign
            .network_names
            .as_ref()
            .unwrap()
            .contains(&format!("р/м {}", network.name)));

        let linked_callsign = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.callsign == "Beta")
            .expect("expected active linked callsign Beta");
        assert_eq!(linked_callsign.message_count, 2);
        assert_eq!(linked_callsign.last_datetime, Some(ts));
        let historical_callsign = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.callsign == "Historical")
            .expect("expected historically active linked callsign");
        assert!(!historical_callsign.active);
        assert_eq!(historical_callsign.message_count, 1);
        let historical_relinked = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.id == historical_relinked_callsign.id)
            .expect("expected historical relinked callsign");
        assert!(!historical_relinked.active);
        assert_eq!(historical_relinked.message_count, 1);
        assert_eq!(historical_relinked.last_datetime, Some(historical_ts));
        let current_relinked = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.id == current_relinked_callsign.id)
            .expect("expected current relinked callsign");
        assert!(current_relinked.active);
        assert_eq!(current_relinked.message_count, 1);
        assert_eq!(current_relinked.last_datetime, Some(ts));
        let moved = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.id == moved_callsign.id)
            .expect("expected moved callsign");
        assert_eq!(moved.message_count, 1);
        assert_eq!(moved.last_datetime, Some(ts));
        assert_eq!(moved.created_at, moved_at.and_utc().timestamp_millis());
        let moved_unassigned = entry
            .callsigns_detailed
            .iter()
            .find(|callsign| callsign.callsign == "Moved")
            .expect("expected pre-assignment moved callsign activity");
        assert_eq!(moved_unassigned.message_count, 1);
        assert_eq!(moved_unassigned.last_datetime, Some(historical_ts));
        let moved_away = entry
            .net_callsigns
            .iter()
            .find(|callsign| callsign.id == moved_away_callsign.id)
            .expect("expected historically assigned moved-away callsign");
        assert_eq!(moved_away.network_id, network.id);
        assert!(!moved_away.active);
        assert_eq!(moved_away.message_count, 1);
        assert_eq!(moved_away.last_datetime, Some(historical_ts));
        let moved_away_unassigned = entry
            .callsigns_detailed
            .iter()
            .find(|callsign| callsign.callsign == "MovedAway")
            .expect("expected post-assignment moved-away callsign activity");
        assert_eq!(moved_away_unassigned.message_count, 1);
        assert_eq!(moved_away_unassigned.last_datetime, Some(ts));
        let mut returning = entry
            .net_callsigns
            .iter()
            .filter(|callsign| callsign.id == returning_callsign.id)
            .collect::<Vec<_>>();
        returning.sort_by_key(|callsign| callsign.created_at);
        assert_eq!(returning.len(), 2);
        assert_eq!(returning[0].message_count, 1);
        assert_eq!(returning[0].last_datetime, Some(historical_ts));
        assert_eq!(
            returning[0].created_at,
            returning_created_at.and_utc().timestamp_millis()
        );
        assert!(!returning[0].active);
        assert_eq!(returning[1].message_count, 1);
        assert_eq!(returning[1].last_datetime, Some(ts));
        assert_eq!(
            returning[1].created_at,
            returning_relinked_at.and_utc().timestamp_millis()
        );
        assert!(returning[1].active);
        assert!(entry
            .net_callsigns
            .iter()
            .any(|callsign| callsign.id == deleted_linked_callsign.id));
        assert!(!entry
            .callsigns_detailed
            .iter()
            .any(|callsign| callsign.callsign == "DeletedLinked"));
        let overlapping = entry
            .net_callsigns
            .iter()
            .filter(|callsign| callsign.callsign == "Overlapping")
            .collect::<Vec<_>>();
        assert_eq!(overlapping.len(), 2);
        assert!(overlapping.iter().all(|callsign| {
            callsign.message_count == 1 && callsign.last_datetime == Some(ts)
        }));
        assert!(!entry
            .net_callsigns
            .iter()
            .any(|callsign| callsign.callsign == "Stale"));
        assert!(!entry
            .net_callsigns
            .iter()
            .any(|callsign| callsign.callsign == "Expired"));
        assert!(!entry
            .net_callsigns
            .iter()
            .any(|callsign| callsign.callsign == "Late"));
        assert!(entry
            .callsigns_detailed
            .iter()
            .any(|callsign| callsign.callsign == "Late"));
        assert!(!entry
            .callsigns_detailed
            .iter()
            .any(|callsign| callsign.callsign == "Historical"));
        assert!(entry.callsigns_detailed.iter().any(|callsign| {
            callsign.callsign == "Boundary" && callsign.message_count == 1
        }));

        assert_eq!(entry.freqs.len(), 1);
        assert_eq!(entry.freqs[0].freq, freq);
        assert_eq!(entry.freqs[0].message_count, 3);
    }

    #[test]
    fn report_callsign_full_name_is_optional() {
        let callsign = NetworkCallsign {
            full_name: Some("Коваленко Олексій Іванович".to_string()),
            ..make_network_callsign(1, "чебурашка", false, false, false)
        };

        assert_eq!(format_callsign(&callsign, false), "ЧЕБУРАШКА");
        assert_eq!(
            format_callsign(&callsign, true),
            "ЧЕБУРАШКА (Коваленко Олексій Іванович)"
        );
    }

    #[test]
    fn extended_frequency_date_options_keep_header_and_row_layouts_aligned() {
        let freq = NetworkFreqsRes {
            network_freq_id: 1,
            freq: "123.4500".to_string(),
            encryption_id: None,
            encryption: None,
            encryption_key_ids: vec![],
            encryption_keys: vec![],
            message_count: 1,
            callsigns: Some(vec!["alpha".to_string()]),
            last_datetime: None,
            last_datetime_in_aor: None,
            created_at: 1,
            is_active: true,
            active_from: 1,
            active_to: None,
            modulation: None,
        };

        for (include_active_from, include_created_at, expected_cells) in [
            (false, false, 5),
            (true, false, 6),
            (false, true, 6),
            (true, true, 7),
        ] {
            let table = build_extended_freqs_table(
                std::slice::from_ref(&freq),
                1,
                include_active_from,
                include_created_at,
            )
            .unwrap();
            let cell_counts = table
                .rows
                .iter()
                .map(|row| {
                    let TableChild::TableRow(row) = row;
                    row.cells.len()
                })
                .collect::<Vec<_>>();

            assert_eq!(cell_counts, vec![expected_cells, expected_cells]);
        }
    }

    #[test]
    fn test_select_callsigns_for_table_type_excludes_main_from_command_control()
    {
        let rows = vec![
            make_network_callsign(1, "MAIN", true, true, false),
            make_network_callsign(2, "CMD", false, true, false),
            make_network_callsign(3, "OTHER", false, false, false),
        ];

        let main_rows = select_callsigns_for_table_type(
            &rows,
            &CallsignTableType::MainRadioStations,
        );
        let command_rows = select_callsigns_for_table_type(
            &rows,
            &CallsignTableType::CommandControlStations,
        );
        let other_rows = select_callsigns_for_table_type(
            &rows,
            &CallsignTableType::OtherStations,
        );

        assert_eq!(
            main_rows
                .iter()
                .map(|row| row.callsign.as_str())
                .collect::<Vec<_>>(),
            vec!["MAIN"]
        );
        assert_eq!(
            command_rows
                .iter()
                .map(|row| row.callsign.as_str())
                .collect::<Vec<_>>(),
            vec!["CMD"]
        );
        assert_eq!(
            other_rows
                .iter()
                .map(|row| row.callsign.as_str())
                .collect::<Vec<_>>(),
            vec!["OTHER"]
        );
    }
}
