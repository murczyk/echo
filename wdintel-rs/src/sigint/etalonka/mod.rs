use crate::error::AppError;
use crate::sigint::callsign::bl_network_callsign::*;
use crate::sigint::callsign::types::*;
// use crate::sigint::network::network_callsigns;
use crate::sigint::network::types::{NetworkDescrType, NetworkDescription};
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use chrono::prelude::*;
use docx_rs::*;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

use crate::config::Config;
use crate::rer_importer::reports::{
    cleanup_old_reports_nofail, save_report_log,
};
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::etalonka::util::*;
use sea_orm::DatabaseConnection;
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

pub async fn bl_etalonka_report_networks_data(
    dbx: &DatabaseConnection,
    user_login: &str,
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
    user_login: &str,
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

/// Generate etalonka report for filtered set of networks
#[post("/api/sigint/etalonka/report-networks")]
pub async fn report_networks(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<EtalonkaJimForksReq>,
) -> Result<HttpResponse, AppError> {
    let trace_id = Uuid::new_v4();
    info!("[trace_id={trace_id}] Etalon Networks report: Started report generation...");

    let user_login = user.id().context(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    let req = req.into_inner();
    info!("[trace_id={trace_id}] Etalon Networks report collected network data, querying report data...");

    let filename =
        format!("report_{}.docx", Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f"));

    let etalonka_data =
        bl_etalonka_report_networks_data(&env.dbx, &user_login, &req, trace_id)
            .await
            .context(h!())?;
    info!("[trace_id={trace_id}] Etalon Networks report: collected report data, building a report...");

    let outpath = generate_networks_docx_report(
        &filename,
        &req.etalonka_type,
        etalonka_data,
        &env.config,
    )
    .await
    .context(h!())?;
    info!("[trace_id={trace_id}] Etalon Networks report: saving report log...");

    save_report_log(
        &env.dbx,
        format!("reports_log/{filename}"),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;

    info!("[trace_id={trace_id}] Etalon Networks report: Done");
    Ok(actix_files::NamedFile::open(&outpath)?.into_response(&http_req))
}

/// Generate etalonka report for list of network by their ids
#[post("/api/sigint/etalonka/report-networks-batch-id")]
pub async fn report_networks_batch_id(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<EtalonkaNetworkBatchReq>,
) -> Result<HttpResponse, AppError> {
    let trace_id = Uuid::new_v4();
    info!("[trace_id={trace_id}] Etalon Networks by IDs report: Started report generation...");

    let user_login = user.id().context(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    info!("[trace_id={trace_id}] Etalon Networks by IDs report: collected network data, querying report data...");
    let req = req.into_inner();

    let filename =
        format!("report_{}.docx", Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f"));

    let etalonka_data = bl_etalonka_report_networks_batch_id_data(
        &env.dbx,
        &user_login,
        &req,
        trace_id,
    )
    .await
    .context(h!())?;

    info!("[trace_id={trace_id}] Etalon Networks by IDs report: collected report data, building a report...");
    let outpath = generate_networks_docx_report(
        &filename,
        &req.etalonka_type,
        etalonka_data,
        &env.config,
    )
    .await
    .context(h!())?;

    save_report_log(
        &env.dbx,
        format!("reports_log/{filename}"),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;

    info!("[trace_id={trace_id}] Etalon Networks by IDs report: Done");

    Ok(actix_files::NamedFile::open(&outpath)?.into_response(&http_req))
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

#[derive(Debug, Eq, PartialEq, Ord, PartialOrd, Clone, Hash, Default)]
pub struct EtalonkaEntryKey {
    pub unit_name: String,
    pub network_id: i64,
}

#[derive(Debug, Clone, Default)]
pub struct EtalonkaEntry {
    pub network_unit_signals: Vec<NetworkSignalsRes>,
    correspondents_number: String,
    unique_modulation: String,
    network_descriptions: Vec<NetworkDescription>,
    net_callsigns: Vec<NetworkCallsign>,
    freqs: Vec<NetworkFreqsRes>,
    callsigns_detailed: Vec<CallsignRes>,
    pelengs_map: Option<Vec<u8>>,
}

pub async fn collect_etalonka_data(
    dbx: &DatabaseConnection,
    user_id: &str,
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

pub(crate) async fn collect_etalonka_data_with_progress(
    dbx: &DatabaseConnection,
    user_id: &str,
    groups: Vec<String>,
    networks_data: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    report_type: &EtalonkaReportType,
    trace_id: Uuid,
    progress: Option<&EtalonkaProgress>,
) -> Result<EtalonkaData, AppError> {
    let mut data = EtalonkaData {
        groups,
        networks_data,
        entries: HashMap::new(),
        sources: HashMap::new(),
    };
    let (
        is_extended_report,
        include_pelengs_map,
        active_freqs_only,
        since_date_inclusive_ms,
        till_date_inclusive_ms,
        include_sigint_signs,
        include_confirmation,
    ) = match report_type {
        EtalonkaReportType::AccordingToTheForm(s) => (
            false,
            false,
            s.active_freqs_only,
            None,
            None,
            s.include_sigint_signs,
            s.include_confirmation,
        ),
        EtalonkaReportType::ExtendedReport(s) => (
            true,
            s.include_pelengs_map,
            s.active_freqs_only,
            Some(s.since_date_inclusive_ms),
            s.till_date_inclusive_ms,
            s.include_sigint_signs,
            s.include_confirmation,
        ),
    };

    let mut all_known_callsigns = BTreeMap::new();
    if is_extended_report {
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

    let show_logs = progress.is_none();
    let mut units_remaining = data.networks_data.len();
    for (unit_key, unit_networks) in data.networks_data.iter() {
        let unit_name = &unit_key.unit_name;
        if show_logs {
            units_remaining -= 1;
            info!("[trace_id={trace_id}] collecting report data for unit '{unit_name}', {units_remaining} left");
        } else if let Some(progress) = progress {
            progress.start_unit(unit_name, unit_networks.len());
        }
        let mut network_remaining = unit_networks.len();
        for network in unit_networks.iter() {
            let network_id = network.id;
            if show_logs {
                network_remaining -= 1;
                info!("[trace_id={trace_id}] collecting report data for network id={network_id}, {network_remaining} left");
            }
            let key = EtalonkaEntryKey {
                unit_name: unit_name.to_string(),
                network_id,
            };
            let mut entry = EtalonkaEntry::default();

            let filter = NetworkFreqFilter {
                since_date_inclusive_ms,
                till_date_inclusive_ms,
                active_freqs_only,
            };

            let list_network_callsigns_req = ListNetworkCallsignsReq {
                network_id: network.id,
                sort_by: None,
            };
            // list of callsigns manually assigned to the Network
            let net_callsigns = bl_get_network_callsigns_list(
                &list_network_callsigns_req,
                user_id,
                dbx,
            )
            .await
            .context(h!())?;

            if !net_callsigns.is_empty() {
                let unique_count = net_callsigns
                    .iter()
                    .map(|item| &item.callsign)
                    .collect::<HashSet<_>>()
                    .len();
                entry.net_callsigns = net_callsigns;
                entry.correspondents_number =
                    format!("щонайменше {unique_count} ВЗ.");
            };

            let callsigns_detailed = if is_extended_report {
                load_callsigns(
                    dbx,
                    &data.groups,
                    network.id,
                    Some(&all_known_callsigns),
                    true,
                    Some(&filter),
                )
                .await
                .context(h!())?
            } else {
                vec![]
            };

            entry.callsigns_detailed = callsigns_detailed;

            let freqs = load_freqs(
                dbx,
                &data.groups,
                network.id,
                Some(&filter),
                user_id,
                true,
            )
            .await
            .context(h!())?;

            let modulations = freqs
                .iter()
                .filter_map(|f| f.modulation.clone())
                .collect::<Vec<String>>();
            let unique_modulation = uniq_via_btreeset(&modulations).join(", ");
            entry.unique_modulation = unique_modulation;
            entry.freqs = freqs;
            if include_sigint_signs || include_confirmation {
                let network_descriptions_map =
                    crate::sigint::network::bl::get_networks_descriptions(
                        dbx,
                        &[network_id],
                    )
                    .await
                    .context(h!())?;
                let network_descriptions = network_descriptions_map
                    .get(&network_id)
                    .cloned()
                    .unwrap_or_default();
                entry.network_descriptions = network_descriptions;

                // then add network unit signals for each unit in network
                let network_unit_signals: Vec<NetworkSignalsRes> =
                    if include_sigint_signs {
                        load_signals_per_network(dbx, network_id)
                            .await
                            .context(h!())?
                    } else {
                        vec![]
                    };
                entry.network_unit_signals = network_unit_signals;
            }
            let pelengs_map = if include_pelengs_map {
                load_pelengs_map(dbx, &data.groups, network_id, filter)
                    .await
                    .context(h!())?
            } else {
                None
            };
            entry.pelengs_map = pelengs_map;
            data.entries.insert(key, entry);
            if let Some(progress) = progress {
                progress.inc_network();
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
                if settings.include_sigint_signs {
                    doc = add_network_sigint_signs(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        &etalonka_data_entry.network_unit_signals,
                    )
                    .await
                    .c(h!())?;
                }

                if settings.include_confirmation {
                    doc = add_network_confirmation(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
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
                doc = add_unit_callsigns_section(doc, callsigns, width_unit);
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
                if settings.include_sigint_signs {
                    doc = add_network_sigint_signs(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
                        &etalonka_data_entry.network_unit_signals,
                    )
                    .await
                    .c(h!())?;
                }

                if settings.include_confirmation {
                    doc = add_network_confirmation(
                        doc,
                        width_unit,
                        &etalonka_data_entry.network_descriptions,
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
) -> Docx {
    doc = add_field(doc, "12. Обгрунтування  прив'язки: ", &String::default());

    // then add network description with Confitmation type
    if let Some(table) = build_network_description_table(
        network_descriptions,
        NetworkDescrType::Confirmation,
        width_unit,
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
                    table_type, callsigns, width,
                )
            }
            EtalonkaReportType::ExtendedReport(_) => {
                build_extended_network_callsigns_table(
                    table_type, callsigns, sources, width,
                )
            }
        }
    };

    // Check if any main radio station exists
    let has_main_radio_station =
        net_callsigns.iter().any(|nc| nc.main_radio_station);
    let has_command_control = net_callsigns.iter().any(|nc| nc.command_control);

    if has_main_radio_station {
        let nc_for_main_radio_station: Vec<NetworkCallsign> = net_callsigns
            .iter()
            .filter(|nc| nc.main_radio_station)
            .cloned()
            .collect();

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
        let nc_for_command_control: Vec<NetworkCallsign> = net_callsigns
            .iter()
            .filter(|nc| nc.command_control)
            .cloned()
            .collect();

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
        let nc_filtered: Vec<NetworkCallsign> = net_callsigns
            .iter()
            .filter(|nc| {
                !nc.main_radio_station && !nc.command_control && !nc.developing
            })
            .cloned()
            .collect();

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
            .map(|c| c.callsign.to_uppercase())
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
            if let Some(table) =
                build_unit_callsigns_table(&filtered_callsigns, width_unit)
            {
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
            EtalonkaReportType::ExtendedReport(_) => {
                build_extended_freqs_table(freqs, width)
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
                &callsign.callsign.to_uppercase(),
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
                    &callsign.callsign.to_uppercase(),
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
                &callsign.callsign.to_uppercase(),
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
) -> Option<Table> {
    let header_style_id = gen_style_id_by_name(TABLE_HEADER_STYLE_NAME);

    let headers = vec![
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
            width_unit * 23,
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
        create_table_header_cell(
            width_unit * 7,
            Some(DEFAULT_TABLE_HEADER_COLOR),
            &header_style_id,
            "Дата прив'язки",
            false,
            0,
        ),
    ];

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

        vec![
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
                width_unit * 23,
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
            create_table_data_cell(
                width_unit * 7,
                &format_datetime_field(Some(freq.created_at)),
                get_color(!freq.is_active),
                false,
            ),
        ]
    };

    build_table(freqs, headers, row_builder, width_unit, None)
}

pub fn build_network_description_table(
    network_descriptions: &[NetworkDescription],
    filter_type: NetworkDescrType,
    width_unit: usize,
) -> Option<Table> {
    let filtered_descriptions = network_descriptions
        .iter()
        .filter(|desc| desc.descr_type == filter_type)
        .cloned()
        .collect::<Vec<_>>();

    if filtered_descriptions.is_empty() {
        return None;
    }

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
    use crate::entities::*;
    use crate::functest::tests::*;
    use crate::sigint::network::types::ListNetworksReq;
    use chrono::Utc;
    use sea_orm::ActiveValue::Set;
    use sea_orm::*;
    use serde_json::json;
    use serial_test::serial;

    #[serial]
    #[tokio::test]
    async fn test_bl_etalonka_report_networks_data_includes_callsigns() {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();

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
            created_by: Set(login.login.clone()),
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
            updated_by: Set(None),
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

        sigint_network_unit::ActiveModel {
            network_id: Set(network.id),
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
            kind: Set(sea_orm_active_enums::SigintNetworkKind::Vhf),
            modulation_id: Set(None),
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

        sigint_callsign::ActiveModel {
            callsign: Set("Alpha".to_string()),
            position: Set("pos".to_string()),
            comment: Set("comment".to_string()),
            full_name: Set(String::new()),
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

        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("test message".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some("uid-1".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let dt_kyiv = DateTime::<Utc>::from_naive_utc_and_offset(now, Utc)
            .with_timezone(&Kyiv);
        let date = dt_kyiv.format("%Y-%m-%d").to_string();
        let time = dt_kyiv.format("%H:%M:%S").to_string();

        let _inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.clone())),
                callsigns: Set(Some(json!(["Alpha"]))),
                date: Set(Some(date)),
                time: Set(Some(time)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(signal_group.master_key.clone())),
            sender: Set(Some("sender".to_string())),
            message_uid: Set(Some("uid-1".to_string())),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .expect("expected inbox item");

        sigint_inbox_item_network::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inbox_item.id),
            sigint_network_id: Set(network.id),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let datetime = inbox_item.datetime.expect("expected datetime");
        let ts = datetime.and_utc().timestamp_millis();

        let req = EtalonkaJimForksReq {
            req: ListNetworksReq {
                filter_freq: None,
                filter_unit: None,
                show_only_further_inverstigation: None,
                show_inactive: None,
                show_only_deleted: None,
                aor_ids: None,
                ids: None,
                limit: None,
                offset: None,
                sort_by: None,
            },
            etalonka_type: EtalonkaReportType::ExtendedReport(
                EtalonkaExtendedSettings {
                    since_date_inclusive_ms: ts - 1_000,
                    till_date_inclusive_ms: Some(ts + 1_000),
                    active_freqs_only: true,
                    include_unit_callsigns: false,
                    include_sigint_signs: false,
                    include_confirmation: false,
                    include_pelengs_map: false,
                },
            ),
        };

        let data = bl_etalonka_report_networks_data(
            &env.dbx,
            &login.login,
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

        let callsign = entry
            .callsigns_detailed
            .iter()
            .find(|c| c.callsign == "Alpha")
            .expect("expected callsign Alpha");
        assert_eq!(callsign.message_count, 1);
        assert!(callsign.known_callsigns.is_some());
        assert_eq!(callsign.known_callsigns.as_ref().unwrap().len(), 1);
        assert_eq!(
            callsign.known_callsigns.as_ref().unwrap()[0].callsign,
            "Alpha"
        );
        assert_eq!(callsign.freqs.as_ref().unwrap(), &vec![freq.clone()]);
        assert!(callsign
            .network_names
            .as_ref()
            .unwrap()
            .contains(&format!("р/м {}", network.name)));

        assert_eq!(entry.freqs.len(), 1);
        assert_eq!(entry.freqs[0].freq, freq);
        assert_eq!(entry.freqs[0].message_count, 1);
    }
}
