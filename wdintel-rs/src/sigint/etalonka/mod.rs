use crate::error::AppError;
use crate::sigint::network::types::{NetworkDescrType, NetworkDescription};
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use chrono::prelude::*;
use docx_rs::*;
use futures::stream::StreamExt;
use log::*;

use crate::rer_importer::reports::{
    cleanup_old_reports_nofail, save_report_log,
};
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use std::str::FromStr;

const OLD_CALLSIGNS_COLOR: &str = "696969";
const DEFAULT_TABLE_HEADER_COLOR: &str = "f2f2f2";
const DEFAULT_PURPOSE: &str =
    "для управління підлеглим особовим складом підрозділу.";
const DEFAULT_OPERATION_MODE: &str = "дуплекс";
const DEFAULT_OPERATION_TYPE: &str = "ведення службового радіообміну";
const DEFAULT_OPERATION_PERIOD: &str = "цілодобово";
const DEFAULT_MODULATION: &str = "уточнюється";

pub mod query;
pub mod types;

#[post("/api/sigint/etalonka/report")]
pub async fn report_freqs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<EtalonkaReq>,
) -> Result<HttpResponse, AppError> {
    info!("> Start Etalonka report generation...");
    let width_unit = 1138;

    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;

    let storage_dir =
        std::path::PathBuf::from_str(&env.config.storage_dir).context(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);
    let filename = format!(
        "report_{}.docx",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f").to_string()
    );
    let outpath = outfolder.join(&filename);
    let user_login = user.id().context(h!())?;

    let dt_since = dt_from_millis(req.list_freq_req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.list_freq_req.till_date_noninclusive_ms)?;
    let tz = crate::config::get_tz();
    let date_from_dt_tz = Utc.from_utc_datetime(&dt_since).with_timezone(&tz);
    let date_to_dt_tz = Utc.from_utc_datetime(&dt_till).with_timezone(&tz);

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await?;

    let file = std::fs::File::create(outpath.clone())?;

    let paragraph_1_style_name = "Paragraph 1";
    let paragraph_1_style_id = gen_style_id_by_name(paragraph_1_style_name);
    let paragraph_1_style = define_new_paragraph_style(
        paragraph_1_style_name,
        "Calibri",
        24,
        true,
        AlignmentType::Left,
    );

    let paragraph_2_style_name = "Paragraph 2";
    let paragraph_2_style_id = gen_style_id_by_name(paragraph_2_style_name);
    let paragraph_2_style = define_new_paragraph_style(
        paragraph_2_style_name,
        "Calibri",
        22,
        true,
        AlignmentType::Left,
    );

    let table_header_style_name = "Table Header";
    let table_header_style_id = gen_style_id_by_name(table_header_style_name);
    let table_header_style = define_new_paragraph_style(
        table_header_style_name,
        "Calibri",
        22,
        true,
        AlignmentType::Center,
    );

    let mut doc = docx_rs::Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(16838, 11906)
        .default_size(20)
        .default_fonts(RunFonts::new().ascii("Calibri"))
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(600)
                .right(300)
                .top(1200),
        )
        .add_style(table_header_style)
        .add_style(paragraph_1_style)
        .add_style(paragraph_2_style)
        .add_paragraph(
            Paragraph::new()
                .style(&paragraph_1_style_id)
                .add_run(Run::new().size(32).add_text(format!(
                    "Опис радіомереж за період {}-{} {} - {}",
                    date_from_dt_tz.format("%d.%m"),
                    date_to_dt_tz.format("%d.%m.%Y"),
                    date_from_dt_tz.format("%H:%M"),
                    date_to_dt_tz.format("%H:%M")
                )))
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().style(&paragraph_1_style_id).add_run(
                Run::new().add_text(
                    "Розділ 1. Радіомережі з визначеною приналежністю",
                ),
            ),
        )
        .add_paragraph(Paragraph::new());

    let freqs_data: HashMap<String, Vec<FreqStatsRes>> =
        load_freqs_per_unit(&env.dbx, groups.clone(), &req).await?;

    let all_known_callsigns = find_all_known_callsigns(&env.dbx).await?;

    let callsigns_data: HashMap<String, Vec<CallsignRes>> =
        futures::future::join_all(freqs_data.keys().map(|unit| {
            let unit = unit.clone();
            let groups = &groups;
            let env = &env;
            let req = &req;
            let all_known_callsigns = &all_known_callsigns;
            let filter = EtalonkaFilter {
                since_date_inclusive_ms: Some(
                    req.list_freq_req.since_date_inclusive_ms,
                ),
                till_date_noninclusive_ms: Some(
                    req.list_freq_req.till_date_noninclusive_ms,
                ),
                filter_freq: req.list_freq_req.filter_freq.clone(),
                filter_unit: Some(unit.clone()),
                network_id: None,
                full_etalonka_report: req.full_etalonka_report,
                filter_further_investigation: req
                    .list_freq_req
                    .filter_further_investigation,
            };

            async move {
                let result = load_callsigns(
                    &env.dbx,
                    groups,
                    &filter,
                    all_known_callsigns,
                    false,
                )
                .await;
                match result {
                    Ok(callsigns) => Some((unit, callsigns)),
                    Err(e) => {
                        warn!("Error loading callsigns for {unit}: {e:#?}",);
                        None
                    }
                }
            }
        }))
        .await
        .into_iter()
        .filter_map(|x| x) // Remove None values
        .collect();

    // Load signals data grouped by unit
    let signals_data: HashMap<String, Vec<SignalRes>> =
        futures::future::join_all(freqs_data.keys().map(|unit| {
            let unit = unit.clone();
            let env = &env;

            async move {
                let result = load_signals_per_unit(&env.dbx, &unit).await;
                match result {
                    Ok(signals) => Some((unit, signals)),
                    Err(e) => {
                        warn!("Error loading signals for {unit}: {e:#?}");
                        None
                    }
                }
            }
        }))
        .await
        .into_iter()
        .filter_map(|x| x) // Remove None values
        .collect();

    // Load pelengs map data grouped by unit
    let pelengs_map_data: HashMap<String, Vec<u8>> =
        futures::stream::iter(freqs_data.keys().cloned())
            .then(|unit| {
                let groups = &groups;
                let env = &env;
                let filter = EtalonkaFilter {
                    since_date_inclusive_ms: Some(
                        req.list_freq_req.since_date_inclusive_ms,
                    ),
                    till_date_noninclusive_ms: Some(
                        req.list_freq_req.till_date_noninclusive_ms,
                    ),
                    filter_freq: req.list_freq_req.filter_freq.clone(),
                    filter_unit: Some(unit.clone()),
                    network_id: None,
                    full_etalonka_report: req.full_etalonka_report,
                    filter_further_investigation: req
                        .list_freq_req
                        .filter_further_investigation,
                };

                async move {
                    let result =
                        load_pelengs_map(&env.dbx, groups, &filter).await;
                    match result {
                        Ok(Some(pelengs_map)) => Some((unit, pelengs_map)),
                        Ok(None) => {
                            trace!("No pelengs map for {}", unit);
                            None
                        }
                        Err(e) => {
                            warn!(
                                "Error loading pelengs map for {unit}: {e:#?}"
                            );
                            None
                        }
                    }
                }
            })
            // .buffered(1) // Execute one by one
            .filter_map(|x| async { x }) // Remove None values
            .collect()
            .await;

    // Build the document using the combined data
    doc = freqs_data.into_iter().fold(doc, |mut d, (unit, freqs)| {
        let callsigns = callsigns_data
            .get(&unit)
            .map(|v| v.as_slice())
            .unwrap_or(&[]);

        let signals =
            signals_data.get(&unit).map(|v| v.as_slice()).unwrap_or(&[]);

        d = d
            // Add heading for frequencies
            .add_paragraph(
                Paragraph::new().style(&paragraph_2_style_id).add_run(
                    Run::new().add_text(format!("Радіомережі {}", &unit)),
                ),
            )
            // Add frequency table
            .add_table(
                Table::new(
                    vec![TableRow::new(vec![
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Частота",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "К-ть перехоплень",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Тип передачі",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "р/c",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 3,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Назва р/м",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Підтвердження приналежності р/м",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Призначення, х-р роботи",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Локація",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Вперше відмічена",
                            false,
                        ),
                    ])]
                    .into_iter()
                    .chain(freqs.into_iter().map(|freq| {
                        TableRow::new(vec![
                            create_table_data_cell(
                                width_unit * 1,
                                &freq.freq,
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 1,
                                &freq.message_count.to_string(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 1,
                                &freq.kind_updated.unwrap_or_default(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 1,
                                &freq.radio_station.unwrap_or_default(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 3,
                                format!(
                                    "{} р/м {}",
                                    &freq.kind.unwrap_or_default(),
                                    &freq.name
                                )
                                .as_str(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                &freq.confirmation.unwrap_or_default(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                &freq.comment.unwrap_or_default(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                &freq.location.unwrap_or_default(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 1,
                                &freq
                                    .first_time
                                    .map(|dt| {
                                        dt.format("%d.%m.%Y %H:%M").to_string()
                                    })
                                    .unwrap_or_else(|| String::new()),
                                None,
                                false,
                            ),
                        ])
                    }))
                    .collect(),
                )
                .width(width_unit * 14, WidthType::Dxa),
            )
            .add_paragraph(Paragraph::new())
            // Add heading for callsigns
            .add_paragraph(
                Paragraph::new()
                    .style(&paragraph_2_style_id)
                    .add_run(Run::new().add_text("Позивні")),
            );

        if !callsigns.is_empty() {
            // Add callsigns table
            d = d.add_table(
                Table::new(
                    vec![TableRow::new(vec![
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Позивний",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Посада",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 5,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Коментар",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Останній раз в етері",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 1,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Частоти",
                            false,
                        ),
                        create_table_header_cell(
                            width_unit * 2,
                            Some(DEFAULT_TABLE_HEADER_COLOR),
                            &table_header_style_id,
                            "Радіомережі",
                            false,
                        ),
                    ])]
                    .into_iter()
                    .chain(callsigns.iter().map(|callsign| {
                        TableRow::new(vec![
                            create_table_data_cell(
                                width_unit * 2,
                                &callsign.callsign.to_uppercase(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                get_unique_field_as_string(
                                    &callsign.known_callsigns,
                                    |item| item.position.clone(),
                                )
                                .as_str(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 5,
                                get_unique_field_as_string(
                                    &callsign.known_callsigns,
                                    |item| item.comment.clone(),
                                )
                                .as_str(),
                                None,
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                format_datetime_field(callsign.last_datetime)
                                    .as_str(),
                                get_color(callsign.is_old),
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 1,
                                get_unique_field_as_string(
                                    &callsign.freqs,
                                    |f| f.clone(),
                                )
                                .as_str(),
                                get_color(callsign.is_old),
                                false,
                            ),
                            create_table_data_cell(
                                width_unit * 2,
                                get_unique_field_as_string(
                                    &callsign.network_names,
                                    |n| n.clone(),
                                )
                                .as_str(),
                                get_color(callsign.is_old),
                                false,
                            ),
                        ])
                    }))
                    .collect(),
                )
                .width(width_unit * 14, WidthType::Dxa),
            );
        } else {
            d = d
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text("За звітний період дані відсутні")
                            .size(20),
                    ),
                )
                .add_paragraph(Paragraph::new());
        }

        d = d
            .add_paragraph(Paragraph::new())
            // Add heading for signals
            .add_paragraph(
                Paragraph::new().style(&paragraph_2_style_id).add_run(
                    Run::new()
                        .add_text("Сигнали управління, розвідувальні ознаки:"),
                ),
            );

        if !signals.is_empty() {
            // Add signals table
            d = d
                .add_table(
                    Table::new(
                        vec![]
                            .into_iter()
                            .chain(signals.iter().map(|signal| {
                                TableRow::new(vec![
                                    create_table_data_cell(
                                        width_unit * 7,
                                        &signal.text,
                                        None,
                                        true,
                                    ),
                                    create_table_data_cell(
                                        width_unit * 7,
                                        &signal.meaning,
                                        None,
                                        true,
                                    ),
                                ])
                            }))
                            .collect(),
                    )
                    .width(width_unit * 14, WidthType::Dxa),
                )
                .add_paragraph(Paragraph::new());
        } else {
            d = d
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text("За звітний період дані відсутні")
                            .size(20),
                    ),
                )
                .add_paragraph(Paragraph::new());
        }

        if let Some(img) = pelengs_map_data.get(&unit) {
            let pic = Pic::new(&img).size(720 * 9525, 540 * 9525);

            d = d
                // Add map locations
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_break(BreakType::Page)),
                )
                .add_paragraph(
                    Paragraph::new()
                        .style(&paragraph_2_style_id)
                        .add_run(Run::new().add_text(
                        "Карта пеленгів частот підрозділу за звітний період:",
                    )),
                )
                .add_paragraph(Paragraph::new())
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_image(pic))
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                )
                .add_paragraph(Paragraph::new());
        }

        d
    });

    let unregistre_networks_data =
        load_unregistred_networks(&env.dbx, &groups, &req)
            .await
            .context(h!())?;

    doc = doc
        .add_paragraph(Paragraph::new())
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().style(&paragraph_1_style_id).add_run(
                Run::new().add_text("Розділ 2. Неприв'язані радіомережі"),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_table(
            Table::new(
                vec![TableRow::new(vec![
                    create_table_header_cell(
                        width_unit * 2,
                        Some(DEFAULT_TABLE_HEADER_COLOR),
                        &table_header_style_id,
                        "Частоти",
                        false,
                    ),
                    create_table_header_cell(
                        width_unit * 1,
                        Some(DEFAULT_TABLE_HEADER_COLOR),
                        &table_header_style_id,
                        "К-ть перехоплень",
                        false,
                    ),
                    create_table_header_cell(
                        width_unit * 7,
                        Some(DEFAULT_TABLE_HEADER_COLOR),
                        &table_header_style_id,
                        "Позивні",
                        false,
                    ),
                    create_table_header_cell(
                        width_unit * 4,
                        Some(DEFAULT_TABLE_HEADER_COLOR),
                        &table_header_style_id,
                        "Локація",
                        false,
                    ),
                ])]
                .into_iter()
                .chain(unregistre_networks_data.iter().map(|network| {
                    TableRow::new(vec![
                        create_table_data_cell(
                            width_unit * 2,
                            &network.freq,
                            None,
                            false,
                        ),
                        create_table_data_cell(
                            width_unit * 1,
                            &network.message_count.to_string(),
                            None,
                            false,
                        ),
                        create_table_data_cell(
                            width_unit * 7,
                            &network
                                .callsigns
                                .clone()
                                .unwrap_or_default()
                                .to_uppercase(),
                            None,
                            false,
                        ),
                        create_table_data_cell(
                            width_unit * 4,
                            &network.locations.clone().unwrap_or_default(),
                            None,
                            false,
                        ),
                    ])
                }))
                .collect(),
            )
            .width(width_unit * 14, WidthType::Dxa),
        );

    doc.build().pack(file).context(h!())?;

    save_report_log(
        &env.dbx,
        format!("reports_log/{}", filename),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;
    Ok(actix_files::NamedFile::open(outpath)?.into_response(&http_req))
}

/// Generate etalonka report for filtered set of networks
#[post("/api/sigint/etalonka/report-networks")]
pub async fn report_networks(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<EtalonkaJimForksReq>,
) -> Result<HttpResponse, AppError> {
    info!("> Start Etalon Networks report generation...");

    let user_login = user.id().context(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer").await?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await?;

    let networks_data: HashMap<String, Vec<NetworkEtalonkaResult>> =
        load_networks(&env.dbx, groups.clone(), &req)
            .await
            .context(h!())?;

    let filename = format!(
        "report_{}.docx",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f").to_string()
    );

    let outpath = generate_networks_docx_report(
        &env,
        &filename,
        &req.settings,
        groups,
        networks_data,
    )
    .await
    .context(h!())?;

    save_report_log(
        &env.dbx,
        format!("reports_log/{}", filename),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;

    info!("> Etalon Networks report generation done");
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
    info!("> Start Etalon Networks by ids report generation...");

    let user_login = user.id().context(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer").await?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await?;

    let networks_data: HashMap<String, Vec<NetworkEtalonkaResult>> =
        load_networks_by_id(&env.dbx, &req).await.context(h!())?;

    let filename = format!(
        "report_{}.docx",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f").to_string()
    );

    let outpath = generate_networks_docx_report(
        &env,
        &filename,
        &req.settings,
        groups,
        networks_data,
    )
    .await
    .context(h!())?;

    save_report_log(
        &env.dbx,
        format!("reports_log/{}", filename),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;

    info!("> Etalon Networks by ids report generation done");

    Ok(actix_files::NamedFile::open(&outpath)?.into_response(&http_req))
}

//  All the docx generation logic for etalonka report
pub async fn generate_networks_docx_report(
    env: &actix_web::web::Data<Env>,
    filename: &str,
    settings: &EtalonkaSettings,
    groups: Vec<String>,
    networks_data: HashMap<String, Vec<NetworkEtalonkaResult>>,
) -> Result<PathBuf, AppError> {
    let all_known_callsigns =
        find_all_known_callsigns(&env.dbx).await.context(h!())?;

    let storage_dir =
        std::path::PathBuf::from_str(&env.config.storage_dir).context(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);

    let outpath = outfolder.join(&filename);
    let file = std::fs::File::create(outpath.clone())?;

    // Define styles for the document
    let paragraph_1_style_name = "Paragraph 1";
    let paragraph_1_style_id = gen_style_id_by_name(paragraph_1_style_name);
    let paragraph_1_style = define_new_paragraph_style(
        paragraph_1_style_name,
        "Times New Roman",
        24,
        true,
        AlignmentType::Left,
    );

    let paragraph_2_style_name = "Paragraph 2";
    let paragraph_2_style_id = gen_style_id_by_name(paragraph_2_style_name);
    let paragraph_2_style = define_new_paragraph_style(
        paragraph_2_style_name,
        "Times New Roman",
        24,
        false,
        AlignmentType::Left,
    );

    let table_header_style_name = "Table Header";
    let table_header_style_id = gen_style_id_by_name(table_header_style_name);
    let table_header_style = define_new_paragraph_style(
        table_header_style_name,
        "Times New Roman",
        24,
        true,
        AlignmentType::Center,
    );

    let invisible_paragraph = Paragraph::new()
        .add_run(Run::new().size(1))
        .line_spacing(LineSpacing::new().before(0).after(0).line(0));

    // Unit	Twips Equivalent
    // 1 inch	1440 twips
    // 1 cm	~567 twips
    // 1 pt (point)	20 twips
    let width_unit;

    let mut doc = docx_rs::Docx::new();

    if settings.networks_only {
        width_unit = 195;
        doc = doc
            .page_orient(PageOrientationType::Portrait)
            .page_size(11906, 16838)
    } else {
        width_unit = 300;
        doc = doc
            .page_orient(PageOrientationType::Landscape)
            .page_size(16838, 11906)
    }
    // Create report document
    doc = doc
        .default_size(24)
        .default_fonts(RunFonts::new().ascii("Times New Roman"))
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(1984)     // 3.5 cm
                .right(567)     // 1 cm
                .top(1134)      // 2 cm
                .bottom(1134)   // 2 cm
        )
        .add_style(table_header_style)
        .add_style(paragraph_1_style)
        .add_style(paragraph_2_style)
        .add_paragraph(
            Paragraph::new()
                .style(&paragraph_1_style_id)
                .add_run(Run::new().add_text(
                    "ДОНЕСЕННЯ").bold())
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(
            Paragraph::new()
                .style(&paragraph_1_style_id)
                .add_run(Run::new().add_text(
                    r#"“Еталонні описи джерел радіовипромінювання противника у зоні відповідальності угруповання військ (сил)”"#).bold())
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new());

    // let mut numbering_id = 0;
    for (i, (unit_name, unit_networks)) in networks_data.iter().enumerate() {
        // doc = doc.add_numbering(Numbering::new(numbering_id, 0));

        // Add unit name as title
        doc = doc.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(28).bold().add_text(unit_name)), // .align(JustificationType::Center),
        );

        for (index, network) in unit_networks.iter().enumerate() {
            let filter = EtalonkaFilter {
                since_date_inclusive_ms: Some(
                    network.active_from.and_utc().timestamp_millis(),
                ),
                till_date_noninclusive_ms: Some(
                    network
                        .active_to
                        .map(|dt| dt.and_utc().timestamp_millis())
                        .unwrap_or_else(|| {
                            Utc::now().naive_utc().and_utc().timestamp_millis()
                        }),
                ),
                filter_freq: None,
                filter_unit: None,
                network_id: Some(network.id.clone()),
                full_etalonka_report: false,
                filter_further_investigation: None,
            };

            let callsigns = load_callsigns(
                &env.dbx,
                &groups,
                &filter,
                &all_known_callsigns,
                settings.active_callsigns_only,
            )
            .await
            .context(h!())?;

            let callsigns_txt = callsigns
                .iter()
                .map(|c| c.callsign.clone())
                .collect::<Vec<_>>();

            let callsigns_reporting = get_network_callsings_reporting(
                &env.dbx,
                network.id.clone(),
                callsigns_txt,
            )
            .await
            .context(h!())?;

            let correspondents_number = if callsigns.is_empty() {
                String::new()
            } else {
                let unique_count = callsigns
                    .iter()
                    .map(|item| &item.callsign)
                    .collect::<HashSet<_>>()
                    .len();
                format!("щонайменше {} ВЗ.", unique_count)
            };

            let freqs = load_freqs(
                &env.dbx,
                &groups,
                &filter,
                settings.active_freqs_only,
            )
            .await
            .context(h!())?;

            let network_descriptions =
                crate::sigint::network::get_network_descriptions(
                    &env.dbx, network.id,
                )
                .await
                .context(h!())?;

            // doc = add_field(doc, "0. Id: ", &network.id.to_string());
            doc = add_field(
                doc,
                "1. Назва радіомережі: ",
                &network.network_full_name,
            );

            doc = add_field(
                doc,
                "2. Район функціонування/розгортання: ",
                network
                    .location
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or_default(),
            );
            doc = add_field(
                doc,
                "3. Призначення: ",
                network
                    .purpose
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or(DEFAULT_PURPOSE),
            );
            doc = add_field(
                doc,
                "4. Склад кореспондентів: ",
                &correspondents_number,
            );
            doc = add_field(doc, "5. Позивні: ", &String::new());
            if !callsigns.is_empty() {
                // Add known callsigns in table
                if let Some(table) = build_callsigns_table(
                    &callsigns,
                    &callsigns_reporting,
                    width_unit,
                    &table_header_style_id,
                    settings.networks_only,
                ) {
                    doc = doc.add_table(table);
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
                            .add_run(Run::new().add_text(callsigns_other)), // .align(
                                                                            //     docx_rs::alignment_type::AlignmentType::Justified,
                                                                            // ),
                    );
                }
            }
            doc = add_field(doc, "6. Робочі частоти: ", &String::new());
            if let Some(table) = build_freqs_table(
                &freqs,
                width_unit,
                &table_header_style_id,
                settings.networks_only,
            ) {
                doc = doc.add_table(table);
            }

            let modulations = freqs
                .iter()
                .filter_map(|f| f.modulation.clone())
                .collect::<Vec<String>>();
            let unique_modulation = uniq_via_btreeset(&modulations).join(", ");

            doc = add_field(doc, "7. Вид передачі: ", &unique_modulation);
            doc = add_field(
                doc,
                "8. Режим роботи радіомережі: ",
                network
                    .operation_mode
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or(DEFAULT_OPERATION_MODE),
            );
            doc = add_field(
                doc,
                "9. Характер роботи: ",
                network
                    .operation_type
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or(DEFAULT_OPERATION_TYPE),
            );
            doc = add_field(
                doc,
                "10. Період функціонування: ",
                network
                    .operation_period
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or(DEFAULT_OPERATION_PERIOD),
            );

            if settings.include_sigint_signs {
                doc = add_field(
                    doc,
                    "11. Розвідувальні ознаки підрозділу: ",
                    &String::default(),
                );
                // first add network description with Sign type
                if let Some(table) = build_network_description_table(
                    &network_descriptions,
                    NetworkDescrType::Sign,
                    width_unit,
                    &table_header_style_id,
                ) {
                    doc = doc.add_table(table);
                }

                // then add network unit signals for each unit in network
                let network_unit_signals =
                    load_signals_per_network(&env.dbx, network.id)
                        .await
                        .context(h!())?;

                // add invisible paragraph between two tables to avoid ms word issue with corrupted rendering of the first table
                if !network_unit_signals.is_empty() {
                    doc = doc.add_paragraph(invisible_paragraph.clone());
                }
                for unit_signals in &network_unit_signals {
                    // if network has multiple units, add unit name
                    if network_unit_signals.len() > 1
                        && !unit_signals.signals.is_empty()
                    {
                        doc = doc.add_paragraph(
                            Paragraph::new()
                                .style(&paragraph_2_style_id)
                                .add_run(
                                    Run::new()
                                        .add_text(
                                            format!(
                                                "{}: ",
                                                unit_signals.unit_name
                                            )
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
                            &table_header_style_id,
                        ) {
                            doc = doc.add_table(table);
                        }
                    }
                }
            }

            if settings.include_confirmation {
                // first add network comments
                doc = add_field(
                    doc,
                    "12. Обгрунтування  прив'язки: ",
                    &network.comment,
                );

                // then add network description with Confitmation type
                if let Some(table) = build_network_description_table(
                    &network_descriptions,
                    NetworkDescrType::Confirmation,
                    width_unit,
                    &table_header_style_id,
                ) {
                    doc = doc.add_table(table);
                }
            }

            if !settings.networks_only {
                if settings.include_pelengs_map {
                    let pelengs_map =
                        load_pelengs_map(&env.dbx, &groups, &filter)
                            .await
                            .context(h!())?;

                    if let Some(img) = pelengs_map {
                        let pic = Pic::new(&img).size(600 * 9525, 450 * 9525);

                        doc = doc
                            // Add map locations
                            .add_paragraph(
                                Paragraph::new()
                                    .add_run(Run::new().add_break(BreakType::Page)),
                            )
                            .add_paragraph(
                                Paragraph::new()
                                    .style(&paragraph_2_style_id)
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
                }
            }

            // Add empty paragraph after each network if this is not the last network
            if index < unit_networks.len() - 1 {
                doc = doc.add_paragraph(Paragraph::new());
            }
        }

        // Add a page break after each unit if this is NOT the last
        if i < networks_data.len() - 1 {
            doc = doc.add_paragraph(Paragraph::new().page_break_before(true));
        }
    }

    doc.build().pack(file).context(h!())?;
    Ok(outpath)
}

/// Helper: Generate the callsigns table
fn build_callsigns_table(
    callsigns: &[CallsignRes],
    callsigns_reporting: &BTreeMap<String, bool>,
    width_unit: usize,
    table_header_style_id: &str,
    networks_only: bool,
) -> Option<Table> {
    let filtered_callsigns: Vec<&CallsignRes> = callsigns
        .iter()
        .filter(|callsign| {
            let has_known = callsign
                .known_callsigns
                .as_ref()
                .map_or(false, |v| !v.is_empty());

            if networks_only {
                has_known
                    && callsigns_reporting
                        .get(&callsign.callsign)
                        .cloned()
                        .unwrap_or(false)
            } else {
                has_known
            }
        })
        .collect();

    if filtered_callsigns.is_empty() {
        return None;
    }

    let (headers, row_builder): (
        Vec<TableCell>,
        Box<dyn Fn(&CallsignRes) -> Vec<TableCell>>,
    ) = if networks_only {
        (
            vec![
                create_table_header_cell(
                    width_unit * 18,
                    None,
                    table_header_style_id,
                    "Позивний",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 30,
                    None,
                    table_header_style_id,
                    "Приналежність",
                    false,
                ),
            ],
            Box::new(move |callsign: &CallsignRes| {
                vec![
                    create_table_data_cell(
                        width_unit * 18,
                        &callsign.callsign.to_uppercase(),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 30,
                        get_unique_field_as_string(
                            &callsign.known_callsigns,
                            |item| {
                                format!(
                                    "{} {}",
                                    item.position.clone(),
                                    item.unit_name.clone()
                                )
                            },
                        )
                        .as_str(),
                        None,
                        false,
                    ),
                ]
            }),
        )
    } else {
        (
            vec![
                create_table_header_cell(
                    width_unit * 6,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Позивний",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 10,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Приналежність",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 10,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Коментар",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 1,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "К-ть перехоплень",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 3,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Частоти",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 7,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Останній раз в етері",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 7,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Дата прив'язки",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 5,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Джерело",
                    false,
                ),
            ],
            Box::new(move |callsign: &CallsignRes| {
                vec![
                    create_table_data_cell(
                        width_unit * 6,
                        &callsign.callsign.to_uppercase(),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 10,
                        get_unique_field_as_string(
                            &callsign.known_callsigns,
                            |item| item.position.clone(),
                        )
                        .as_str(),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 10,
                        get_unique_field_as_string(
                            &callsign.known_callsigns,
                            |item| item.comment.clone(),
                        )
                        .as_str(),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 1,
                        &callsign.message_count.to_string(),
                        get_color(callsign.is_old),
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 3,
                        get_unique_field_as_string(&callsign.freqs, |f| {
                            f.clone()
                        })
                        .as_str(),
                        get_color(callsign.is_old),
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 7,
                        format_datetime_field(callsign.last_datetime).as_str(),
                        get_color(callsign.is_old),
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 7,
                        get_unique_field_as_string(
                            &callsign.known_callsigns,
                            |item| format_datetime_field(Some(item.created_at)),
                        )
                        .as_str(),
                        get_color(callsign.is_old),
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 5,
                        get_unique_field_as_string(
                            &callsign.known_callsigns,
                            |item| item.source_name.clone(),
                        )
                        .as_str(),
                        get_color(callsign.is_old),
                        false,
                    ),
                ]
            }),
        )
    };

    Some(
        Table::new(
            std::iter::once(TableRow::new(headers))
                .chain(
                    filtered_callsigns
                        .into_iter()
                        .map(|callsign| TableRow::new(row_builder(callsign))),
                )
                .collect(),
        )
        .width(width_unit * 48, WidthType::Dxa)
        .layout(TableLayoutType::Fixed)
        .set_borders(TableBorders::with_empty()),
    )
}

/// Helper. Generate table with frequencies
fn build_freqs_table(
    freqs: &[NetworkFreqsRes],
    width_unit: usize,
    table_header_style_id: &str,
    networks_only: bool,
) -> Option<Table> {
    if freqs.is_empty() {
        return None;
    }

    let (headers, row_builder): (
        Vec<TableCell>,
        Box<dyn Fn(&NetworkFreqsRes) -> Vec<TableCell>>,
    ) = if networks_only {
        (
            vec![
                create_table_header_cell(
                    width_unit * 16,
                    None,
                    table_header_style_id,
                    "Частота",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 16,
                    None,
                    table_header_style_id,
                    "Модуляція",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 16,
                    None,
                    table_header_style_id,
                    "Останній раз в етері",
                    false,
                ),
            ],
            Box::new(move |freq: &NetworkFreqsRes| {
                vec![
                    create_table_data_cell(
                        width_unit * 16,
                        &freq.freq,
                        None,
                        false,
                    ),
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
                        width_unit * 16,
                        &format_datetime_field(freq.last_datetime),
                        get_color(!freq.is_active),
                        false,
                    ),
                ]
            }),
        )
    } else {
        (
            vec![
                create_table_header_cell(
                    width_unit * 4,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Частота",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 3,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Модуляція",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 2,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "К-ть перехоплень",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 25,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Позивні",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 7,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Останній раз в етері",
                    false,
                ),
                create_table_header_cell(
                    width_unit * 7,
                    Some(DEFAULT_TABLE_HEADER_COLOR),
                    table_header_style_id,
                    "Дата прив'язки",
                    false,
                ),
            ],
            Box::new(move |freq: &NetworkFreqsRes| {
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
                    create_table_data_cell(
                        width_unit * 4,
                        &freq.freq,
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 3,
                        &freq
                            .modulation
                            .clone()
                            .unwrap_or(DEFAULT_MODULATION.to_string()),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 2,
                        &freq.message_count.clone().to_string(),
                        None,
                        false,
                    ),
                    create_table_data_cell(
                        width_unit * 25,
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
            }),
        )
    };

    Some(
        Table::new(
            std::iter::once(TableRow::new(headers))
                .chain(
                    freqs.iter().map(|freq| TableRow::new(row_builder(freq))),
                )
                .collect(),
        )
        .width(width_unit * 48, WidthType::Dxa)
        .layout(TableLayoutType::Fixed)
        .set_borders(TableBorders::with_empty()),
    )
}

pub fn build_network_description_table(
    network_descriptions: &[NetworkDescription],
    filter_type: NetworkDescrType,
    width_unit: usize,
    _table_header_style_id: &str,
) -> Option<Table> {
    let filtered_descriptions = network_descriptions
        .iter()
        .filter(|desc| desc.descr_type == filter_type)
        .collect::<Vec<_>>();

    if filtered_descriptions.is_empty() {
        return None;
    }

    let row_builder = |descr: &NetworkDescription| {
        vec![
            create_table_data_cell(
                width_unit * 48,
                &descr.description,
                None,
                false,
            ),
            // create_table_data_cell(
            //     width_unit * 15,
            //     &descr.comment.clone().unwrap_or_default(),
            //     None,
            //     false,
            // ),
        ]
    };

    Some(
        Table::new(
            filtered_descriptions
                .iter()
                .map(|descr| TableRow::new(row_builder(descr)))
                .collect(),
        )
        .width(width_unit * 48, WidthType::Dxa)
        .layout(TableLayoutType::Fixed)
        .set_borders(TableBorders::with_empty()),
    )
}

pub fn build_network_unit_signals_table(
    signals: &[Signal],
    width_unit: usize,
    _table_header_style_id: &str,
) -> Option<Table> {
    if signals.is_empty() {
        return None;
    }

    // let headers = vec![
    //     create_table_header_cell(
    //         width_unit * 10,
    //         None,
    //         table_header_style_id,
    //         "Сигнал",
    //         false,
    //     ),
    //     create_table_header_cell(
    //         width_unit * 30,
    //         None,
    //         table_header_style_id,
    //         "Значення",
    //         false,
    //     ),
    // ];

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

    Some(
        Table::new(
            // std::iter::once(TableRow::new(headers))
            //     .chain(
            signals
                .iter()
                .map(|signal| TableRow::new(row_builder(signal)))
                .collect(),
        )
        .width(width_unit * 48, WidthType::Dxa)
        .layout(TableLayoutType::Fixed)
        .set_borders(TableBorders::with_empty()),
    )
}

fn add_field(
    mut doc: Docx,
    field_name: &str,
    value: &str,
    // numbering_id: usize,
) -> Docx {
    doc = doc.add_paragraph(
        Paragraph::new()
            // .numbering(NumberingId::new(numbering_id), IndentLevel::new(0))
            .add_run(Run::new().add_text(field_name).bold())
            .add_run(Run::new().add_text(value)),
    );

    doc
}

fn gen_style_id_by_name(name: &str) -> String {
    format!("Style_{}", name.replace(" ", ""))
}

fn define_new_paragraph_style(
    name: &str,
    font_name: &str,
    font_size: usize,
    bold: bool,
    align: AlignmentType,
) -> Style {
    let style = Style::new(gen_style_id_by_name(name), StyleType::Paragraph)
        .name(name)
        .based_on("Normal")
        .next("Normal");

    let mut run_property = RunProperty::new()
        .fonts(RunFonts::new().ascii(font_name))
        .size(font_size);

    if bold {
        run_property = run_property.bold();
    }

    let style = Style {
        run_property,
        paragraph_property: ParagraphProperty::new().align(align),
        ..style
    };

    style
}

fn get_color(is_old: bool) -> Option<String> {
    if is_old {
        Some(OLD_CALLSIGNS_COLOR.to_string())
    } else {
        None
    }
}

fn create_table_header_cell(
    width: usize,
    fill: Option<&str>,
    style_id: &str,
    text: &str,
    with_empty_borders: bool,
) -> TableCell {
    let table_cell_borders = if with_empty_borders {
        TableCellBorders::with_empty()
    } else {
        TableCellBorders::new()
    };

    let mut cell = TableCell::new()
        .width(width, WidthType::Dxa)
        .add_paragraph(
            Paragraph::new()
                .style(style_id)
                .add_run(Run::new().add_text(text)),
        )
        .set_borders(table_cell_borders);

    if let Some(fill_color) = fill {
        cell = cell.shading(Shading::new().fill(fill_color));
    }

    cell
}

fn create_table_data_cell(
    width: usize,
    text: &str,
    color: Option<String>,
    with_empty_borders: bool,
) -> TableCell {
    let table_cell_borders = if with_empty_borders {
        TableCellBorders::with_empty()
    } else {
        TableCellBorders::new()
    };

    TableCell::new()
        .width(width, WidthType::Dxa)
        .add_paragraph(Paragraph::new().add_run({
            let mut run = Run::new().add_text(text);
            if let Some(color) = color {
                run = run.color(color);
            }
            run
        }))
        .set_borders(table_cell_borders)
}

fn format_datetime_field(dt_millis: Option<i64>) -> String {
    dt_millis
        .and_then(|millis| dt_from_millis(millis).ok())
        .map(|dt| dt.format("%d.%m.%Y %H:%M").to_string())
        .unwrap_or_default()
}

fn get_unique_field_as_string<T, F>(
    input: &Option<Vec<T>>,
    field_extractor: F,
) -> String
where
    T: Ord + Clone,
    F: Fn(&T) -> String,
{
    let field_vec = input.as_ref().map(|vec| {
        vec.iter()
            .map(|item| field_extractor(item))
            .collect::<Vec<_>>()
    });

    if let Some(vec) = field_vec {
        crate::utils::uniq_via_btreeset(&vec).join(", ")
    } else {
        String::new()
    }
}
