use super::super::types::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::report_chunking::{
    report_period_chunks, ReportPeriodChunk, ReportPeriodEnd,
};
use crate::rer_importer::reports::inbox_light::{
    blank_inbox_message, parse_optional_json_vec,
};
use crate::types::*;
use crate::utils::*;
use anyhow::Context;
// Add this import if h!() uses anyhow::Context
use crate::utils::orm::ArrayColumnOps;
use chrono::prelude::*;
use docx_rs::AlignmentType;
use docx_rs::LineSpacing;
use docx_rs::Paragraph;
use docx_rs::Run;
use docx_rs::Shading;
use docx_rs::Table;
use docx_rs::TableCell;
use docx_rs::TableRow;
use docx_rs::VAlignType;
use docx_rs::VMergeType;
use docx_rs::WidthType;
use sea_orm::*;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, FromQueryResult)]
struct MouseReportMessageRow {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    freq: Option<String>,
    coords: Option<String>,
    callsigns: Option<serde_json::Value>,
    date: Option<String>,
    time: Option<String>,
    unit: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct MouseInboxTagRow {
    sigint_inbox_item_id: i64,
    id: i64,
    tag_id: i64,
    confidence: f64,
    login: Option<String>,
    model: Option<String>,
    organism_id: Option<i64>,
}

struct MouseReportData {
    messages: Vec<(i64, InboxMessage)>,
    date_to: String,
    highlighted_message_ids: BTreeSet<i64>,
    uniq_freqs_sorted: Vec<String>,
    freq_first_seen: BTreeMap<String, NaiveDateTime>,
    freq_callsign_first_seen: BTreeMap<(String, String), NaiveDateTime>,
    important_ids: BTreeSet<i64>,
    bookmark_ids: BTreeSet<i64>,
    datasource_map: BTreeMap<i64, datasource::Model>,
    message_map: BTreeMap<i64, signal_message::Model>,
    inbox_map: BTreeMap<i64, sigint_inbox_item::Model>,
    comments_map: BTreeMap<i64, sigint_comment::Model>,
    group_datasources_map: HashMap<i64, i64>,
}

pub async fn report_docx_kind_mouse(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let data = collect_mouse_report_data(user_login, env, req).await?;
    build_mouse_report(&data, outpath)
}

async fn collect_mouse_report_data(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
) -> Result<MouseReportData, AppError> {
    let (read_db, replica_label) = env.replica_with_label();
    match replica_label {
        Some(label) => info!("Mouse report using replica {label}"),
        None => info!("Mouse report using primary database"),
    }
    let login = *user_login;
    let login_ids =
        crate::users::get_organism_login_ids_by_id(&read_db, &login)
            .await
            .c(h!())?;
    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let Some(since_date_inclusive_ms) = inbox_req.since_date_inclusive_ms
    else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = inbox_req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks = report_period_chunks(
        since_date_inclusive_ms,
        till_date_inclusive_ms,
        report_settings.chunking_hours,
        ReportPeriodEnd::Inclusive,
    )?;
    let mut messages_by_id = BTreeMap::new();
    for (index, chunk) in chunks.iter().enumerate() {
        info!(
            "Mouse report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let mut chunk_req = inbox_req.clone();
        chunk_req.since_date_inclusive_ms = Some(chunk.since_ms);
        chunk_req.till_date_inclusive_ms = Some(chunk.till_ms);
        let max_messages = report_settings
            .limit_big_reports
            .then_some(RER_MOUSE_REPORT_MESSAGE_MAX + 1);
        let chunk_messages = load_mouse_report_messages_chunk(
            &read_db,
            &login,
            env,
            &chunk_req,
            true,
            max_messages,
            chunk.end,
        )
        .await
        .c(h!())?;
        merge_mouse_report_message_chunk(
            &mut messages_by_id,
            chunk_messages,
            &login,
            report_settings.limit_big_reports,
        )?;
    }
    let messages = messages_by_id.into_iter().collect::<Vec<_>>();
    let date_to: String = dt_zoned_from_millis(till_date_inclusive_ms)?
        .format("%H:%M %d.%m.%Y")
        .to_string();

    let without_model_tags = inbox_req.without_model_tags.unwrap_or(false);

    let highlighted_message_ids: BTreeSet<i64> = messages
        .iter()
        .filter_map(|(message_id, message)| {
            message
                .inbox_tags
                .as_ref()?
                .iter()
                .any(|tag| {
                    tag.confidence >= TAG_MINIMUM_CONFIDENCE
                        && (!without_model_tags || tag.model.is_none())
                })
                .then_some(*message_id)
        })
        .collect();

    let uniq_freqs: BTreeSet<String> =
        BTreeSet::from_iter(messages.iter().map(|(_message_id, message)| {
            message.freq.clone().unwrap_or("".to_string())
        }));
    let mut uniq_freqs_sorted: Vec<String> = uniq_freqs.into_iter().collect();
    uniq_freqs_sorted.sort();
    let Some(zone_id) = crate::sigint::zone::get_user_zone_id(&read_db, &login)
        .await
        .c(h!())?
    else {
        return Err("Zone not found 918273".into());
    };
    let comp_freqs = comp_freq::Entity::find()
        .filter(comp_freq::Column::ZoneId.eq(zone_id))
        .filter(comp_freq::Column::Freq.eq_any(uniq_freqs_sorted.clone()))
        .all(&read_db)
        .await
        .c(h!())?;
    let freq_first_seen: BTreeMap<String, NaiveDateTime> = comp_freqs
        .iter()
        .filter_map(|comp_freq| {
            comp_freq.first_seen.map(|x| (comp_freq.freq.clone(), x))
        })
        .collect();
    let comp_freqs_callsigns = comp_freq_callsign::Entity::find()
        .filter(comp_freq_callsign::Column::ZoneId.eq(zone_id))
        .filter(
            comp_freq_callsign::Column::Freq.eq_any(uniq_freqs_sorted.clone()),
        )
        .all(&read_db)
        .await
        .c(h!())?;
    let freq_callsign_first_seen: BTreeMap<(String, String), NaiveDateTime> =
        comp_freqs_callsigns
            .iter()
            .filter_map(|comp_freq_callsign| {
                comp_freq_callsign.first_seen.map(|x| {
                    (
                        (
                            comp_freq_callsign.freq.clone(),
                            comp_freq_callsign.callsign.clone(),
                        ),
                        x,
                    )
                })
            })
            .collect();

    let groups =
        crate::messenger::group::get_identity_sigint_groups(&read_db, &login)
            .await
            .context(h!())?;
    let important_ids =
        load_mouse_important_ids(&read_db, &login, &groups, &chunks)
            .await
            .c(h!())?;
    let bookmark_ids =
        load_mouse_bookmark_ids(&read_db, &login, &groups, &chunks)
            .await
            .c(h!())?;

    let all_message_ids: Vec<i64> =
        messages.iter().map(|(id, _)| *id).collect();
    let datasource_map: BTreeMap<i64, datasource::Model> =
        datasource::Entity::find()
            .all(&read_db)
            .await
            .context(h!())?
            .into_iter()
            .map(|datasource| (datasource.id, datasource))
            .collect();
    let (message_map, inbox_map, comments_map) =
        load_mouse_enrichment_maps(&read_db, &all_message_ids, &login_ids)
            .await
            .c(h!())?;
    let group_datasources_map: HashMap<i64, i64> =
        datasource_group::Entity::find()
            .select_only()
            .column(datasource_group::Column::Id)
            .column(datasource_group::Column::DatasourceId)
            .into_tuple::<(i64, i64)>()
            .all(&read_db)
            .await
            .context(h!())?
            .into_iter()
            .collect();

    Ok(MouseReportData {
        messages,
        date_to,
        highlighted_message_ids,
        uniq_freqs_sorted,
        freq_first_seen,
        freq_callsign_first_seen,
        important_ids,
        bookmark_ids,
        datasource_map,
        message_map,
        inbox_map,
        comments_map,
        group_datasources_map,
    })
}

fn build_mouse_report(
    data: &MouseReportData,
    outpath: &Path,
) -> Result<(), AppError> {
    let MouseReportData {
        messages,
        date_to,
        highlighted_message_ids,
        uniq_freqs_sorted,
        freq_first_seen,
        freq_callsign_first_seen,
        important_ids,
        bookmark_ids,
        datasource_map,
        message_map,
        inbox_map,
        comments_map,
        group_datasources_map,
    } = data;
    let file = std::fs::File::create(outpath)?;
    let width_unit = 1870;
    let network_count = uniq_freqs_sorted.len();
    let mut per_freq_callsigns: BTreeMap<String, BTreeSet<String>> =
        BTreeMap::new();
    let mut per_freq_messages: BTreeMap<String, Vec<(i64, &InboxMessage)>> =
        BTreeMap::new();
    for (message_id, message) in messages {
        let freq = message.freq.clone().unwrap_or_default();
        for callsign in &message.callsigns {
            per_freq_callsigns
                .entry(freq.clone())
                .or_default()
                .insert(callsign.clone());
        }
        per_freq_messages
            .entry(freq)
            .or_default()
            .push((*message_id, message));
    }
    let mut per_freq_units_counted: BTreeMap<String, BTreeMap<String, i64>> =
        BTreeMap::new();
    for (_message_id, message) in messages {
        let Some(unit) = message.unit.as_ref() else {
            continue;
        };
        if unit.trim().is_empty() {
            continue;
        }
        let Some(freq) = message.freq.clone() else {
            continue;
        };
        if freq.is_empty() {
            continue;
        }
        per_freq_units_counted
            .entry(freq)
            .or_default()
            .entry(unit.clone())
            .and_modify(|count| *count += 1)
            .or_insert(1);
    }

    let mut rows: Vec<TableRow> = vec![];
    rows.push(TableRow::new(vec![
        TableCell::new()
            .width(width_unit * 2, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Назва радіомережі, робоча частота")
                            .bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new().add_text("Час роботи радіомережі").bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 7, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(3)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Склад кореспондентів радіомережі")
                            .bold(),
                    )
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 2, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Restart)
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Характер радіообміну").bold())
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    rows.push(TableRow::new(vec![
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .width(width_unit * 6, WidthType::Dxa)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(2)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Позивні кореспондентів радіомережі та їх приналежність")
                            .bold(),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .line_spacing(LineSpacing::new().before(80).after(80)),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .width(width_unit, WidthType::Dxa)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text("Відмічене вперше")
                            .bold(),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .line_spacing(LineSpacing::new().before(80).after(80)),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .vertical_merge(VMergeType::Continue)
            .add_paragraph(Paragraph::new()),
    ]));

    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let Some(earliest_msg) = freq_msgs.iter().min_by_key(|m| m.1.timestamp)
        else {
            continue;
        };
        let Some(earliest_timestamp) = earliest_msg.1.timestamp else {
            continue;
        };
        let Some(latest_msg) = freq_msgs.iter().max_by_key(|m| m.1.timestamp)
        else {
            continue;
        };
        let Some(latest_timestamp) = latest_msg.1.timestamp else {
            continue;
        };
        let time_from =
            dt_zoned_from_millis(earliest_timestamp)?.format("%H:%M:%S");
        let time_to =
            dt_zoned_from_millis(latest_timestamp)?.format("%H:%M:%S");
        let unit_with_max_count = match per_freq_units_counted.get(freq) {
            None => "УКХ НВ".to_string(),
            Some(units_with_count) => units_with_count
                .iter()
                .max_by_key(|(_, count)| *count)
                .map(|(unit, _)| unit.clone())
                .unwrap_or("УКХ НВ".to_string()),
        };
        rows.push(TableRow::new(vec![
            TableCell::new()
                .width(width_unit * 2, WidthType::Dxa)
                .vertical_merge(VMergeType::Restart)
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text(format!(
                                "Радіомережа №{},",
                                freq.clone().replace(".", ",")
                            ))
                            .bold(),
                    ),
                )
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(unit_with_max_count.clone()),
                    ),
                )
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text(format!("Робочі частоти: {freq} МГц")),
                )),
            TableCell::new()
                .vertical_merge(VMergeType::Restart)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(
                            Run::new()
                                .add_text(format!("{time_from}-{time_to}")),
                        )
                        .align(docx_rs::alignment_type::AlignmentType::Center),
                ),
            TableCell::new()
                .width(width_unit * 2, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new().add_run(Run::new().add_text("")),
                ),
            TableCell::new()
                .width(width_unit * 4, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text("НВ".to_string())),
                ),
            TableCell::new()
                .width(width_unit, WidthType::Dxa)
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(
                            freq_first_seen
                                .get(freq)
                                .map(|x| x.format("%d.%m.%Y").to_string())
                                .unwrap_or("".to_string()),
                        ),
                    ),
                ),
            TableCell::new()
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text("Ведення службового обміну."),
                )),
        ]));

        let empty = BTreeSet::new();
        let freq_callsigns: &BTreeSet<String> =
            per_freq_callsigns.get(freq).unwrap_or(&empty);
        for callsign in freq_callsigns {
            rows.push(TableRow::new(vec![
                TableCell::new()
                    .width(width_unit * 2, WidthType::Dxa)
                    .vertical_merge(VMergeType::Continue)
                    .add_paragraph(Paragraph::new().add_run(Run::new())),
                TableCell::new()
                    .vertical_merge(VMergeType::Continue)
                    .add_paragraph(Paragraph::new().add_run(Run::new())),
                TableCell::new()
                    .width(width_unit * 2, WidthType::Dxa)
                    .add_paragraph(Paragraph::new().add_run(
                        Run::new().add_text(callsign.clone().to_uppercase()),
                    )),
                TableCell::new()
                    .width(width_unit * 4, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .add_run(Run::new().add_text("НВ".to_string())),
                    ),
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                freq_callsign_first_seen
                                    .get(&(
                                        freq.clone(),
                                        callsign.clone().to_lowercase(),
                                    ))
                                    .map(|x| x.format("%d.%m.%Y").to_string())
                                    .unwrap_or("".to_string()),
                            ),
                        ),
                    ),
                TableCell::new().add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text("Ведення службового обміну."),
                )),
            ]));
        }
        rows.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .grid_span(6)
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text("Особливості функціонування радіомережі:")
                        .bold(),
                ),
            )]));
        rows.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .grid_span(6)
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text("Аналіз матеріалів радіоперехоплення, що вплинули на оцінку РЕО: ")
                        .bold(),
                ).add_run(Run::new().add_text("не відмічено")),
            )]));
    }
    let table = Table::new(rows).width(width_unit * 12, WidthType::Dxa);

    let mut rows2: Vec<TableRow> = vec![];
    rows2.push(TableRow::new(vec![
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Частота"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Дата"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Час перехоплення"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Хто передає"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Кому передає"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit * 6, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Зміст радіообміну"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .width(width_unit, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Пеленг"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let mut freq_msgs = freq_msgs.clone();
        freq_msgs.sort_by_key(|a| a.1.timestamp);
        let unit_with_max_count = match per_freq_units_counted.get(freq) {
            None => "УКХ НВ".to_string(),
            Some(units_with_count) => units_with_count
                .iter()
                .max_by_key(|(_, count)| *count)
                .map(|(unit, _)| unit.clone())
                .unwrap_or("УКХ НВ".to_string()),
        };
        rows2.push(TableRow::new(vec![TableCell::new()
            .width(width_unit * 12, WidthType::Dxa)
            .vertical_align(VAlignType::Center)
            .grid_span(7)
            .add_paragraph(
                Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(format!(
                                "Радіомережа №{}, ",
                                freq.clone().replace(".", ",")
                            ))
                            .bold(),
                    )
                    .add_run(Run::new().add_text(unit_with_max_count))
                    .add_run(
                        Run::new()
                            .add_text(format!(". Робочі частоти: {freq} МГц")),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            )]));
        // Use pre-loaded maps instead of querying inside loop
        for (message_id, message) in freq_msgs {
            let Some(freq) = message.freq.as_ref() else {
                continue;
            };
            let Some(timestamp) = message.timestamp.as_ref() else {
                continue;
            };
            let mut body_cell =
                TableCell::new().width(width_unit * 6, WidthType::Dxa);
            let Some(msg) = message_map.get(&message_id) else {
                continue;
            };
            let Some(group_id) = msg.datasource_group_id else {
                continue;
            };
            let Some(datasource_id) = group_datasources_map.get(&group_id)
            else {
                continue;
            };
            let Some(inbox) = inbox_map.get(&message_id) else {
                continue;
            };
            let Some(datasource) = datasource_map.get(datasource_id) else {
                continue;
            };
            let mut need_highlight =
                highlighted_message_ids.contains(&message_id);
            if important_ids.contains(&message_id) {
                need_highlight = true;
            }
            if bookmark_ids.contains(&message_id) {
                need_highlight = true;
            }
            let m_comment = comments_map.get(&message_id);
            let mut full_text =
                message_full_text(msg, inbox, datasource, m_comment)?;
            if need_highlight {
                full_text = format!("⚠️ {full_text}");
            }
            for line in full_text.lines() {
                body_cell = body_cell.add_paragraph(
                    Paragraph::new().add_run(Run::new().add_text(line)),
                );
            }
            rows2.push(TableRow::new(vec![
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(Run::new().add_text(freq.clone())),
                    ),
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(
                                Run::new().add_text(
                                    dt_zoned_from_millis(*timestamp)?
                                        .format("%d.%m.%Y")
                                        .to_string(),
                                ),
                            ),
                    ),
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(
                                docx_rs::alignment_type::AlignmentType::Center,
                            )
                            .add_run(
                                Run::new().add_text(
                                    dt_zoned_from_millis(*timestamp)?
                                        .format("%H:%M:%S")
                                        .to_string(),
                                ),
                            ),
                    ),
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                message
                                    .callsigns
                                    .first()
                                    .unwrap_or(&"".to_string())
                                    .clone()
                                    .to_uppercase(),
                            ),
                        ),
                    ),
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new().add_run(
                            Run::new().add_text(
                                message
                                    .callsigns
                                    .get(1)
                                    .unwrap_or(&"".to_string())
                                    .clone()
                                    .to_uppercase(),
                            ),
                        ),
                    ),
                body_cell,
                TableCell::new()
                    .width(width_unit, WidthType::Dxa)
                    .add_paragraph(
                        Paragraph::new()
                            .align(AlignmentType::Center)
                            .add_run(Run::new().add_text("-".to_string())),
                    ),
            ]));
        }
    }
    let table2 = Table::new(rows2).width(width_unit * 12, WidthType::Dxa);

    let mut rows_amrp: Vec<TableRow> = vec![];
    // table: Дата, Час, Частота, WGS84, XY
    rows_amrp.push(TableRow::new(vec![
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Дата"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Час"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("Частота"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("WGS84"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
        TableCell::new()
            .vertical_align(VAlignType::Center)
            .shading(Shading::new().fill("f2f2f2"))
            .grid_span(2)
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("XY"))
                    .line_spacing(LineSpacing::new().before(80).after(80))
                    .align(docx_rs::alignment_type::AlignmentType::Center),
            ),
    ]));
    let mut messages_datetime_sorted = messages
        .iter()
        .map(|(_, message)| message)
        .collect::<Vec<_>>();
    messages_datetime_sorted.sort_by(|a, b| {
        let dt_a = format!(
            "{}T{}",
            a.date.clone().unwrap_or("".to_string()),
            a.time.clone().unwrap_or("".to_string())
        );
        let dt_b = format!(
            "{}T{}",
            b.date.clone().unwrap_or("".to_string()),
            b.time.clone().unwrap_or("".to_string())
        );
        dt_a.cmp(&dt_b)
    });
    for message in messages_datetime_sorted {
        let Some(coords) = message.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        let (lat, lon) = milgeo_rs::coordinates::parse_latlng_f64(coords)?;
        let Some(date) = message.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
        let Some(time) = message.time.as_ref() else {
            continue;
        };
        let Some(freq) = message.freq.as_ref() else {
            continue;
        };
        let usk2000 = milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng: lon },
        )?;
        rows_amrp.push(TableRow::new(vec![
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(
                        Run::new()
                            .add_text(format!("{}", date.format("%d.%m"))),
                    ),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(time.clone())),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(freq.clone())),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(Run::new().add_text(format!("{lat}, {lon}"))),
            ),
            TableCell::new().add_paragraph(
                Paragraph::new()
                    .align(docx_rs::alignment_type::AlignmentType::Center)
                    .add_run(
                        Run::new()
                            .add_text(format!("{} {}", usk2000.x, usk2000.y)),
                    ),
            ),
        ]));
    }
    let table_amrp =
        Table::new(rows_amrp).width(width_unit * 12, WidthType::Dxa);

    let mut docx = docx_rs::Docx::new()
        .page_orient(docx_rs::page_orientation_type::PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(
            docx_rs::page_margin::PageMargin::new()
                .left(600)
                .right(300)
                .top(1200)
            )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .size(32)
                        .add_text("РОЗВІДУВАЛЬНЕ ЗВЕДЕННЯ")
                        .bold(),
                )
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(
            Paragraph::new()
            .add_run(
                Run::new()
                .add_text("Зведеного підрозділу ТЗР щодо змін у радіоелектронній обстановці")
            )
            .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!("станом на {date_to} року")))
                .align(docx_rs::alignment_type::AlignmentType::Center)
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!("1. Кількість радіомереж (радіонапрямків), які відмічались: {network_count}")))
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text("2. Опис радіомереж:"))
        )
        .add_paragraph(Paragraph::new())
        .add_table(table)
        .add_paragraph(Paragraph::new())
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("3. Висновки з оцінки РЕО: ").bold()));

    for freq in uniq_freqs_sorted.iter() {
        if freq.trim().is_empty() {
            continue;
        }
        let Some(freq_msgs) = per_freq_messages.get(freq) else {
            continue;
        };
        let mut freq_msgs = freq_msgs.clone();
        freq_msgs.sort_by_key(|a| a.1.timestamp);
        for (message_id, message) in freq_msgs {
            let Some(freq) = message.freq.as_ref() else {
                continue;
            };
            let Some(timestamp) = message.timestamp.as_ref() else {
                continue;
            };
            // Use pre-loaded maps instead of querying
            let Some(_inbox) = inbox_map.get(&message_id) else {
                continue;
            };
            let m_comment = comments_map.get(&message_id);
            if let Some(extended_form) = m_comment.map(|x| &x.comment) {
                let paragraph =
                    Paragraph::new().add_run(Run::new().add_text(format!(
                        "- {date} {time}: {freq} {extended_form}",
                        date = dt_zoned_from_millis(*timestamp)?
                            .format("%d.%m.%Y"),
                        time = dt_zoned_from_millis(*timestamp)?
                            .format("%H:%M:%S"),
                        extended_form = extended_form
                    )));
                docx = docx.add_paragraph(paragraph);
            }
        }
    }

    docx.add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("З АМРП встановлено:").bold()),
        )
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("")))
        .add_table(table_amrp)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new()
                    .add_text(
                        "Додаток з оригіналами матеріалів радіоперехоплення",
                    )
                    .bold(),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_table(table2)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new()
                    .add_text("Статистика функціонування радіомереж")
                    .bold(),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new().add_run(
                Run::new().add_text(
                    uniq_freqs_sorted
                        .iter()
                        .map(|x| x.replace(".", ","))
                        .collect::<Vec<String>>()
                        .join(", "),
                ),
            ),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text("Командир зведеного взводу ТЗР")),
        )
        .add_paragraph(Paragraph::new())
        .build()
        .pack(file)
        .context(h!())?;
    Ok(())
}

async fn load_mouse_important_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    groups: &[String],
    chunks: &[ReportPeriodChunk],
) -> Result<BTreeSet<i64>, AppError> {
    let mut ids = BTreeSet::new();
    for chunk in chunks {
        let query = sigint_important::Entity::find()
            .filter(sigint_important::Column::LoginId.eq(*login))
            .join(
                JoinType::InnerJoin,
                sigint_important::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(
                datasource_group::Column::GroupMasterKey
                    .eq_any(groups.to_vec()),
            );
        let query = filter_mouse_time_chunk(query, *chunk)?;
        ids.extend(
            query
                .all(dbx)
                .await
                .c(h!())?
                .into_iter()
                .map(|important| important.signal_message_id),
        );
    }
    Ok(ids)
}

async fn load_mouse_bookmark_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    groups: &[String],
    chunks: &[ReportPeriodChunk],
) -> Result<BTreeSet<i64>, AppError> {
    let mut ids = BTreeSet::new();
    for chunk in chunks {
        let query = sigint_bookmark::Entity::find()
            .filter(sigint_bookmark::Column::LoginId.eq(*login))
            .join(
                JoinType::InnerJoin,
                sigint_bookmark::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(
                datasource_group::Column::GroupMasterKey
                    .eq_any(groups.to_vec()),
            );
        let query = filter_mouse_time_chunk(query, *chunk)?;
        ids.extend(
            query
                .all(dbx)
                .await
                .c(h!())?
                .into_iter()
                .map(|bookmark| bookmark.signal_message_id),
        );
    }
    Ok(ids)
}

fn filter_mouse_time_chunk<Q>(
    query: Q,
    chunk: ReportPeriodChunk,
) -> Result<Q, AppError>
where
    Q: QueryFilter,
{
    let query = query.filter(
        sigint_inbox_item::Column::Datetime
            .gte(dt_from_millis(chunk.since_ms)?),
    );
    let till = dt_from_millis(chunk.till_ms)?;
    Ok(match chunk.end {
        ReportPeriodEnd::Inclusive => {
            query.filter(sigint_inbox_item::Column::Datetime.lte(till))
        }
        ReportPeriodEnd::NonInclusive => {
            query.filter(sigint_inbox_item::Column::Datetime.lt(till))
        }
    })
}

type MouseEnrichmentMaps = (
    BTreeMap<i64, signal_message::Model>,
    BTreeMap<i64, sigint_inbox_item::Model>,
    BTreeMap<i64, sigint_comment::Model>,
);

async fn load_mouse_enrichment_maps(
    dbx: &DatabaseConnection,
    message_ids: &[i64],
    login_ids: &[uuid::Uuid],
) -> Result<MouseEnrichmentMaps, AppError> {
    let mut message_map = BTreeMap::new();
    let mut inbox_map = BTreeMap::new();
    let mut comments_map = BTreeMap::new();
    for ids in message_ids.chunks(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE) {
        message_map.extend(
            signal_message::Entity::find()
                .filter(signal_message::Column::Deleted.eq(false))
                .filter(signal_message::Column::Id.eq_any(ids.to_vec()))
                .all(dbx)
                .await
                .c(h!())?
                .into_iter()
                .map(|message| (message.id, message)),
        );
        inbox_map.extend(
            sigint_inbox_item::Entity::find()
                .filter(sigint_inbox_item::Column::Id.eq_any(ids.to_vec()))
                .all(dbx)
                .await
                .c(h!())?
                .into_iter()
                .map(|inbox| (inbox.id, inbox)),
        );
        comments_map.extend(
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq_any(ids.to_vec()),
                )
                .filter(
                    sigint_comment::Column::LoginId.eq_any(login_ids.to_vec()),
                )
                .all(dbx)
                .await
                .c(h!())?
                .into_iter()
                .map(|comment| (comment.signal_message_id, comment)),
        );
    }
    Ok((message_map, inbox_map, comments_map))
}

async fn load_mouse_report_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    include_tags: bool,
    max_messages: Option<usize>,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    load_mouse_report_messages_chunk(
        dbx,
        login,
        env,
        req,
        include_tags,
        max_messages,
        ReportPeriodEnd::Inclusive,
    )
    .await
}

async fn load_mouse_report_messages_chunk(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    include_tags: bool,
    max_messages: Option<usize>,
    period_end: ReportPeriodEnd,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let mut query_req = req.clone();
    if period_end == ReportPeriodEnd::NonInclusive {
        query_req.till_date_inclusive_ms = None;
    }
    let query = crate::rer_importer::inbox::query::build_filtered_inbox_query(
        dbx, login, env, &query_req,
    )
    .await
    .c(h!())?;
    let query = if period_end == ReportPeriodEnd::NonInclusive {
        let till = req.till_date_inclusive_ms.ok_or_else(|| AppError::BL {
            msg: "Until date must be specified".to_string(),
        })?;
        let till = dt_from_millis(till)?;
        match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
            InboxMessagesSortBy::IMSDatetime => {
                query.filter(sigint_inbox_item::Column::Datetime.lt(till))
            }
            InboxMessagesSortBy::IMSTimestamp => {
                query.filter(signal_message::Column::Timestamp.lt(till))
            }
        }
    } else {
        query
    };
    let query = query
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::Coords, "coords")
        .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
        .column_as(sigint_inbox_item::Column::Date, "date")
        .column_as(sigint_inbox_item::Column::Time, "time")
        .column_as(sigint_inbox_item::Column::UnitV2, "unit");
    let query = match max_messages {
        Some(max_messages) => query.limit(max_messages as u64),
        None => query,
    };
    let rows = query
        .into_model::<MouseReportMessageRow>()
        .all(dbx)
        .await
        .context(h!())?;
    let message_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let mut tags_by_message = if include_tags {
        load_mouse_inbox_tags(dbx, login, req, &message_ids).await?
    } else {
        BTreeMap::new()
    };

    rows.into_iter()
        .map(|row| {
            let mut message = blank_inbox_message();
            message.timestamp = row
                .timestamp
                .map(|timestamp| timestamp.and_utc().timestamp_millis());
            message.freq = row.freq;
            message.coords = row.coords;
            message.callsigns = parse_optional_json_vec(row.callsigns)?;
            message.date = row.date;
            message.time = row.time;
            message.unit = row.unit;
            message.inbox_tags = tags_by_message.remove(&row.id);
            Ok((row.id, message))
        })
        .collect()
}

fn ensure_mouse_report_message_limit(
    user_login: &uuid::Uuid,
    message_count: usize,
) -> Result<(), AppError> {
    if message_count <= RER_MOUSE_REPORT_MESSAGE_MAX {
        return Ok(());
    }

    log::error!(
        "mouse report message limit exceeded: user={user_login}, messages={message_count}, max_messages={RER_MOUSE_REPORT_MESSAGE_MAX}",
    );
    Err(AppError::BL {
        msg: RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE.to_string(),
    })
}

fn merge_mouse_report_message_chunk(
    messages_by_id: &mut BTreeMap<i64, InboxMessage>,
    messages: Vec<(i64, InboxMessage)>,
    user_login: &uuid::Uuid,
    enforce_limit: bool,
) -> Result<(), AppError> {
    messages_by_id.extend(messages);
    if enforce_limit {
        ensure_mouse_report_message_limit(user_login, messages_by_id.len())?;
    }
    Ok(())
}

async fn load_mouse_inbox_tags(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, Vec<InboxMessageTag>>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let owner_organism_id =
        crate::tags::query::current_user_organism_id(dbx, login)
            .await
            .context(h!())?;
    let without_model_tags = req.without_model_tags.unwrap_or(false);
    let mut tags_by_message = BTreeMap::new();
    for ids in message_ids.chunks(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE) {
        let rows = sigint_inbox_item_tag::Entity::find()
            .select_only()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_tag::Relation::Tag.def(),
            )
            .join(
                JoinType::LeftJoin,
                sigint_inbox_item_tag::Relation::Login.def(),
            )
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq_any(ids.to_vec()),
            )
            .filter(
                sigint_inbox_item_tag::Column::Confidence
                    .gte(TAG_MINIMUM_CONFIDENCE),
            )
            .filter(crate::tags::query::accessible_tag_condition(
                owner_organism_id,
            ))
            .apply_if(without_model_tags.then_some(()), |query, _| {
                query.filter(sigint_inbox_item_tag::Column::Model.is_null())
            })
            .column(sigint_inbox_item_tag::Column::SigintInboxItemId)
            .column(sigint_inbox_item_tag::Column::Id)
            .column(sigint_inbox_item_tag::Column::TagId)
            .column(sigint_inbox_item_tag::Column::Confidence)
            .column(sigint_inbox_item_tag::Column::LoginId)
            .column(sigint_inbox_item_tag::Column::Model)
            .column_as(login::Column::OrganismId, "organism_id")
            .into_model::<MouseInboxTagRow>()
            .all(dbx)
            .await
            .context(h!())?;

        for row in rows {
            tags_by_message
                .entry(row.sigint_inbox_item_id)
                .or_insert_with(Vec::new)
                .push(InboxMessageTag {
                    id: row.id,
                    tag_id: row.tag_id,
                    confidence: row.confidence,
                    login: row.login,
                    model: row.model,
                    organism_id: row.organism_id,
                });
        }
    }
    Ok(tags_by_message)
}

// report_xlsx_kind_pelengs
pub async fn report_xlsx_kind_pelengs(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    _outpath: &PathBuf, // Marked as unused
) -> Result<(), AppError> {
    let read_db = env.replica();
    let login = *user_login;
    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let messages = load_mouse_report_messages(
        &read_db, &login, env, &inbox_req, false, None,
    )
    .await
    .c(h!())?;
    let messages: Vec<(i64, InboxMessage)> = messages
        .iter()
        .filter(|(_, m)| m.coords.is_some())
        .cloned()
        .collect();

    let mut workbook = rust_xlsxwriter::Workbook::new(); // Use rust_xlsxwriter

    let mut messages_datetime_sorted = messages.clone();
    messages_datetime_sorted.sort_by(|a, b| {
        let dt_a = format!(
            "{}T{}",
            a.1.date.clone().unwrap_or("".to_string()),
            a.1.time.clone().unwrap_or("".to_string())
        );
        let dt_b = format!(
            "{}T{}",
            b.1.date.clone().unwrap_or("".to_string()),
            b.1.time.clone().unwrap_or("".to_string())
        );
        dt_a.cmp(&dt_b)
    });

    let coltitle = rust_xlsxwriter::Format::new() // Removed mut
        .set_bold() // Chained methods
        .set_align(rust_xlsxwriter::FormatAlign::Center)
        .set_font_size(12.0);

    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?; // Use rust_xlsxwriter
    sheet1
        .write_string_with_format(0, 0, "№", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(0, 4.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 1, "ДАТА", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(1, 8.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 2, "ЧАС", &coltitle)
        .context(h!())?;
    sheet1
        .write_string_with_format(0, 3, "ЧАСТОТА", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(3, 10.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 4, "WGS84", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(4, 20.0).context(h!())?;
    sheet1
        .write_string_with_format(0, 5, "XY", &coltitle)
        .context(h!())?;
    sheet1.set_column_width(5, 16.0).context(h!())?;

    for (i, (_message_id, message)) in
        messages_datetime_sorted.iter().enumerate()
    {
        let Some(coords) = message.coords.as_ref() else {
            continue;
        };
        if coords.is_empty() {
            continue;
        }
        let (lat, lon) = milgeo_rs::coordinates::parse_latlng_f64(coords)?;
        let Some(date) = message.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
        let Some(time) = message.time.as_ref() else {
            continue;
        };
        let Some(freq) = message.freq.as_ref() else {
            continue;
        };
        let usk2000 = milgeo_rs::coordinates::usk2000::wgs84_to_usk2000(
            milgeo_rs::coordinates::Wgs84 { lat, lng: lon },
        )?;

        sheet1
            .write_number(i as u32 + 1, 0, i as f64 + 1.0)
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 1, format!("{}", date.format("%d.%m")))
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 2, time.clone())
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 3, freq.clone())
            .context(h!())?;
        sheet1
            .write_string(i as u32 + 1, 4, format!("{lat}, {lon}"))
            .context(h!())?;
        sheet1
            .write_string(
                i as u32 + 1,
                5,
                format!("{} {}", usk2000.x, usk2000.y),
            )
            .context(h!())?;
    }

    workbook.save(_outpath).context(h!())?; // Save the workbook
    Ok(())
}

fn message_full_text(
    message: &signal_message::Model,
    inbox: &sigint_inbox_item::Model,
    datasource: &datasource::Model,
    m_comment: Option<&sigint_comment::Model>,
) -> Result<String, AppError> {
    if datasource.kind == "signal" || datasource.kind == "whatsapp" {
        let extended_form = m_comment.map(|x| x.comment.as_str());
        Ok(format!(
            "{}\n\n{}",
            message.body.clone().unwrap_or("".to_string()),
            extended_form.unwrap_or("")
        ))
    } else if datasource.kind == "api" {
        let datetime_part = match (inbox.date.clone(), inbox.time.clone()) {
            (Some(date), Some(time)) => format!("{} ", date + " " + &time),
            (Some(date), None) => format!("{date} "),
            (None, Some(time)) => format!("{time} "),
            (None, None) => "".to_string(),
        };
        let freq_part = match inbox.freq.clone() {
            Some(freq) => format!("{freq} "),
            None => "".to_string(),
        };
        let unit_part = match inbox.freq {
            Some(_) => {
                format!("{} ", inbox.unit.clone().unwrap_or("НВ".to_string()))
            }
            None => "".to_string(),
        };
        let location_part = match inbox.freq {
            Some(_) => {
                format!("{} ", inbox.location.clone().unwrap_or("".to_string()))
            }
            None => "".to_string(),
        };
        let extended_form = m_comment.map(|x| x.comment.as_str());
        let comment_part = match extended_form {
            Some(comment) => format!("\n\nКоментар: {comment}"),
            None => "".to_string(),
        };
        Ok(format!(
            "{datetime_part}{freq_part}\n{unit_part}{location_part}\n{}{comment_part}",
            message.body.clone().unwrap_or("".to_string()),
        ))
    } else {
        Err(format!("Unknown datasource kind: {:?}", datasource.kind).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, find_test_datasource_group, find_test_login,
        mk_sigint_inbox_item, mk_signal_message,
    };
    use crate::rer_importer::reports::types::ReportPreviewReq;
    use sea_orm::prelude::Expr;
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    #[test]
    fn mouse_report_message_limit_allows_maximum() {
        assert!(ensure_mouse_report_message_limit(
            &uuid::Uuid::nil(),
            RER_MOUSE_REPORT_MESSAGE_MAX,
        )
        .is_ok());
    }

    #[test]
    fn mouse_report_message_limit_rejects_overflow() {
        let err = ensure_mouse_report_message_limit(
            &uuid::Uuid::nil(),
            RER_MOUSE_REPORT_MESSAGE_MAX + 1,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            AppError::BL { msg }
                if msg == RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE
        ));
    }

    #[test]
    fn mouse_chunks_deduplicate_boundary_ids_and_keep_sorted_order() {
        let mut first = blank_inbox_message();
        first.freq = Some("111".to_string());
        let mut boundary = blank_inbox_message();
        boundary.freq = Some("222".to_string());
        let mut messages = BTreeMap::new();

        merge_mouse_report_message_chunk(
            &mut messages,
            vec![(2, first.clone()), (1, first)],
            &uuid::Uuid::nil(),
            true,
        )
        .unwrap();
        merge_mouse_report_message_chunk(
            &mut messages,
            vec![(2, boundary)],
            &uuid::Uuid::nil(),
            true,
        )
        .unwrap();

        assert_eq!(messages.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(
            messages.get(&2).and_then(|message| message.freq.as_deref()),
            Some("222")
        );
    }

    #[test]
    fn mouse_chunk_limit_can_be_disabled() {
        let mut messages = BTreeMap::new();
        let message = blank_inbox_message();
        for id in 0..=RER_MOUSE_REPORT_MESSAGE_MAX as i64 {
            messages.insert(id, message.clone());
        }

        assert!(merge_mouse_report_message_chunk(
            &mut messages,
            Vec::new(),
            &uuid::Uuid::nil(),
            false,
        )
        .is_ok());
    }

    #[tokio::test]
    #[serial]
    async fn mouse_chunked_collection_matches_single_window() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let first = Utc::now().naive_utc() - chrono::Duration::hours(2);
        let second = first + chrono::Duration::hours(2);
        for (index, datetime) in [first, second].into_iter().enumerate() {
            let inbox_datetime = if index == 0 { second } else { datetime };
            let message = mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    body: Set(Some(format!("mouse chunk {index}"))),
                    created_at: Set(datetime),
                    timestamp: Set(Some(datetime)),
                    sender: Set(Some("sender".to_string())),
                    message_uid: Set(Some(format!("mouse-chunk-{index}"))),
                    datasource_group_id: Set(Some(datasource_group.id)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(message.id),
                    freq: Set(Some(format!("12{index}.45"))),
                    callsigns: Set(Some(serde_json::json!([format!(
                        "Mouse{index}"
                    )]))),
                    date: Set(Some(inbox_datetime.date().to_string())),
                    time: Set(Some(
                        inbox_datetime.time().format("%H:%M:%S").to_string(),
                    )),
                    unit_v2: Set(Some(format!("MouseUnit{index}"))),
                    checked: Set(Some(true)),
                    reviewed: Set(Some(true)),
                    parsed_unit_v2: Set(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let req = ReportPreviewReq {
            kind: "mouse".to_string(),
            req: InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    (first - chrono::Duration::minutes(30))
                        .and_utc()
                        .timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    (second + chrono::Duration::minutes(30))
                        .and_utc()
                        .timestamp_millis(),
                ),
                sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: Some(false),
            tag_report_sort_by: None,
            report_1213_linked_networks_only: None,
            without_comments: Some(false),
            interception_keep_full_message: None,
            interception_keep_old_colors: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
            sposob_unit_name: None,
        };

        set_report_chunking_hours(&env.dbx, 24).await;
        let single = collect_mouse_report_data(&login.id, &env, &req)
            .await
            .unwrap();
        set_report_chunking_hours(&env.dbx, 1).await;
        let chunked = collect_mouse_report_data(&login.id, &env, &req)
            .await
            .unwrap();

        assert_eq!(chunked.messages, single.messages);
        assert_eq!(chunked.date_to, single.date_to);
        assert_eq!(
            chunked.highlighted_message_ids,
            single.highlighted_message_ids
        );
        assert_eq!(chunked.uniq_freqs_sorted, single.uniq_freqs_sorted);
        assert_eq!(chunked.freq_first_seen, single.freq_first_seen);
        assert_eq!(
            chunked.freq_callsign_first_seen,
            single.freq_callsign_first_seen
        );
        assert_eq!(chunked.important_ids, single.important_ids);
        assert_eq!(chunked.bookmark_ids, single.bookmark_ids);
        assert_eq!(chunked.datasource_map, single.datasource_map);
        assert_eq!(chunked.message_map, single.message_map);
        assert_eq!(chunked.inbox_map, single.inbox_map);
        assert_eq!(chunked.comments_map, single.comments_map);
        assert_eq!(chunked.group_datasources_map, single.group_datasources_map);
    }

    async fn set_report_chunking_hours(db: &DatabaseConnection, hours: i32) {
        let result = system_settings::Entity::update_many()
            .col_expr(
                system_settings::Column::ReportChunkingHours,
                Expr::value(hours),
            )
            .filter(system_settings::Column::Deleted.eq(false))
            .exec(db)
            .await
            .unwrap();
        if result.rows_affected == 0 {
            system_settings::ActiveModel {
                report_chunking_hours: Set(hours),
                limit_big_reports: Set(false),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
    }
}
