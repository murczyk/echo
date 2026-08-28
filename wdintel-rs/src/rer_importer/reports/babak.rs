use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::report_chunking::{
    inbox_report_chunk_req, inbox_report_period_chunks, ReportPeriodEnd,
};
use crate::rer_importer::types::{
    AnalysisStatsReq, InboxMessagesReq, NewCallsignsRes,
};
use crate::sigint::sender::{
    preferred_group_sender_expr, preferred_message_author_expr,
};
use crate::types::*;
use crate::utils::*;
use chrono::prelude::*;
use docx_rs::*;
use sea_orm::*;
use sea_query::{Alias, Expr, Query, SimpleExpr};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Debug;
use std::io::{Seek, Write};
use std::path::Path;

pub struct BabakReportData {
    pub units: Vec<StatsPerUnitReport>,
    pub new_callsigns: NewCallsignsRes,
    pub date_from: NaiveDateTime,
    pub date_to: NaiveDateTime,
    pub without_comments: bool,
}

pub async fn collect_babak_report_data(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
) -> Result<BabakReportData, AppError> {
    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt = dt_from_millis(since_date_inclusive_ms)?;
    let date_to_dt = dt_from_millis(till_date_inclusive_ms)?;
    let without_comments = req.without_comments.unwrap_or(false);
    let new_callsign_min_mentions = req
        .babak_new_callsign_min_mentions
        .unwrap_or(RER_BABAK_NEW_CALLSIGN_MIN_MENTIONS_DEFAULT);
    if new_callsign_min_mentions < 1 {
        return Err(AppError::BL {
            msg: "Мінімальна кількість згадок позивного має бути не менше 1"
                .to_string(),
        });
    }

    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = if without_comments {
        Some(false)
    } else {
        req.report_tags_only_this_unit
    };

    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let units = get_inbox_messages_report_unit(
        user_login,
        env,
        &inbox_req,
        !without_comments,
        report_settings.chunking_hours,
    )
    .await
    .c(h!())?;

    let new_callsing_req = AnalysisStatsReq {
        since_date_inclusive_ms: inbox_req.since_date_inclusive_ms.unwrap_or(0),
        till_date_noninclusive_ms: inbox_req
            .till_date_inclusive_ms
            .unwrap_or(0),
        selected_groups: inbox_req.selected_groups,
        selected_senders: inbox_req.selected_senders,
        selected_freqs: inbox_req.selected_freqs,
        selected_posts: inbox_req.selected_posts,
        selected_callsigns: inbox_req.selected_callsigns,
        selected_units: inbox_req.selected_units,
        selected_locations: inbox_req.selected_locations,
        selected_device_names: inbox_req.selected_device_names,
        or_with_extended_form: inbox_req.or_with_extended_form,
        or_bookmarked: inbox_req.or_bookmarked,
        or_important: inbox_req.or_important,
        or_with_coords: inbox_req.or_with_coords,
        or_without_coords: inbox_req.or_without_coords,
        search: inbox_req.search,
        selected_tags: inbox_req.selected_tags,
        denied_tags: inbox_req.denied_tags,
        tag_presence: inbox_req.tag_presence,
        selected_networks: inbox_req.selected_networks,
        without_network: inbox_req.without_network,
        metadata_cc: inbox_req.metadata_cc,
        metadata_sender: inbox_req.metadata_sender,
        metadata_receiver: inbox_req.metadata_receiver,
        metadata_hash: inbox_req.metadata_hash,
        only_with_metadata: inbox_req.only_with_metadata,
        without_metadata: inbox_req.without_metadata,
        include_peleng_locations: inbox_req.include_peleng_locations,
        units_exact_match_only: inbox_req.units_exact_match_only,
        filter_tags_option: inbox_req.filter_tags_option,
        selected_aors: inbox_req.selected_aors,
        without_model_tags: inbox_req.without_model_tags,
        report_tags_only_this_unit: inbox_req.report_tags_only_this_unit,
    };
    let new_callsigns_res = bi_new_callsigns_chunked(
        user_login,
        env,
        &new_callsing_req,
        report_settings.chunking_hours,
        ReportPeriodEnd::Inclusive,
        new_callsign_min_mentions,
    )
    .await
    .context(h!())?;

    Ok(BabakReportData {
        units,
        new_callsigns: new_callsigns_res,
        date_from: date_from_dt,
        date_to: date_to_dt,
        without_comments,
    })
}

pub async fn bl_babak_report(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
) -> Result<BabakReportData, AppError> {
    collect_babak_report_data(user_login, env, req).await
}

pub async fn report_docx_kind_babak(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let data = collect_babak_report_data(user_login, env, req).await?;
    build_babak_report(data, outpath)
}

pub fn build_babak_report(
    data: BabakReportData,
    outpath: &Path,
) -> Result<(), AppError> {
    let BabakReportData {
        mut units,
        new_callsigns: new_callsigns_res,
        date_from,
        date_to,
        without_comments,
    } = data;
    let stream_units = units
        .iter_mut()
        .map(BabakStreamUnit::from_report)
        .collect::<Vec<_>>();
    let record_count =
        babak_report_record_count(&stream_units, without_comments);
    crate::report_history::ensure_report_record_count(record_count)
        .context(h!())?;
    let tz = crate::config::get_tz();
    let date_from_dt_tz = Utc.from_utc_datetime(&date_from).with_timezone(&tz);
    let date_to_dt_tz = Utc.from_utc_datetime(&date_to).with_timezone(&tz);

    let units_list = units
        .iter()
        .filter_map(|unit| unit.unit.clone())
        .filter(|r| r != "НВ")
        .collect::<Vec<String>>()
        .join(", ");

    let style_invisible = Style::new("Invisible", StyleType::Paragraph)
        .name("Invisible")
        .align(AlignmentType::Center)
        .size(0);

    let bullet_numbering = Numbering::new(0, 1);

    let abs_numbering =
        AbstractNumbering::new(1).add_level(docx_rs::Level::new(
            0,
            Start::new(1),
            NumberFormat::new("bullet"),
            LevelText::new("-"),
            LevelJc::new("left"),
        ));

    let mut trs = vec![TableRow::new(vec![
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("Полк/бригада")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("к-сть перехоплень")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("відмічено БПЛА")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("відмічено РЕБ")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("відмічено артилерія")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("відмічено забезпечення")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("втрати")),
            )
            .set_borders(TableCellBorders::new()),
    ])];
    for stat in units.iter() {
        // dbg!(stat.clone());

        trs.push(TableRow::new(vec![
            TableCell::new()
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text(
                        stat.unit.clone().unwrap_or("НВ".to_string()),
                    ),
                ))
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.count)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.bpla))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.reb))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.arta))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.software)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.losses)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
        ]));
    }
    let stats_table = Table::new(trs);

    let head = "Heading";
    let style_heading = Style::new(head, StyleType::Paragraph)
        .name("Heading 1")
        .align(AlignmentType::Left)
        .size(28)
        .bold();
    let mut doc = docx_rs::Docx::new()
        .default_size(24)
        .add_style(style_invisible)
        .add_style(style_heading)
        .add_numbering(bullet_numbering)
        .add_abstract_numbering(abs_numbering)
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .size(42)
                        .add_text(format!(
                            "Розвідувальне донесення з РЕР за {}-{} {} - {}",
                            date_from_dt_tz.format("%d.%m"),
                            date_to_dt_tz.format("%d.%m.%Y"),
                            date_from_dt_tz.format("%H:%M"),
                            date_to_dt_tz.format("%H:%M")
                        ))
                        .bold(),
                )
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Мапа ймовірних смуг відповідальності підрозділів:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Підрозділи що відмічені в р/о за звітний період:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(units_list))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text("Статистика за звітний період"))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_table(stats_table)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(format!(
                    "Кількість нових частот виявлених в смузі: {}",
                    0
                )))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(
                    Run::new()
                        .add_text("Позивні, присутні в обраний період, але яких не було 7 днів до цього:"),
                )
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(
                    new_callsigns_res.not_seen_7days.join(", ")
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    if !without_comments {
        doc = doc
            .add_paragraph(
                Paragraph::new()
                    .style(head)
                    .add_run(
                        Run::new().add_text(
                            "Характер дій противника за звітний період",
                        ),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(Paragraph::new());

        doc = doc.add_paragraph(babak_stream_marker(BABAK_COMMENTS_MARKER));
    } else {
        doc = doc.add_paragraph(babak_stream_marker(BABAK_COMMENTS_MARKER));
    }

    doc = doc
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text("Втрати противника:"))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    doc = doc.add_paragraph(babak_stream_marker(BABAK_LOSSES_MARKER));

    doc = doc
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(
                    Run::new().add_text("Імовірний характер дій противника:"),
                )
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Радіоперехоплення, що становлять розвідувальну цінність:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    doc = doc.add_paragraph(babak_stream_marker(BABAK_OTHERS_MARKER));

    let file = std::fs::File::create(outpath).context(h!())?;
    pack_babak_docx(doc.build(), file, &stream_units, without_comments)
        .context(h!())?;

    Ok(())
}

const BABAK_COMMENTS_MARKER: &str = "ECHO_BABAK_STREAM_COMMENTS";
const BABAK_LOSSES_MARKER: &str = "ECHO_BABAK_STREAM_LOSSES";
const BABAK_OTHERS_MARKER: &str = "ECHO_BABAK_STREAM_OTHERS";

fn babak_stream_marker(marker: &str) -> Paragraph {
    Paragraph::new()
        .add_run(Run::new().add_text(marker))
        .numbering(NumberingId::new(1), IndentLevel::new(0))
}

struct BabakStreamUnit {
    unit: String,
    comments: Vec<BabakComment>,
    losses_comments: Vec<BabakComment>,
    others_comments: Vec<BabakComment>,
}

fn babak_report_record_count(
    units: &[BabakStreamUnit],
    without_comments: bool,
) -> usize {
    units.iter().fold(units.len(), |count, unit| {
        let comments = if without_comments {
            0
        } else {
            unit.comments
                .iter()
                .filter(|comment| {
                    comment.datetime.is_some()
                        && babak_non_empty_text(comment.comment.as_deref())
                            .is_some()
                })
                .count()
        };
        let supplemental = unit
            .losses_comments
            .iter()
            .chain(&unit.others_comments)
            .filter(|comment| {
                comment.datetime.is_some()
                    && ((!without_comments
                        && babak_non_empty_text(comment.comment.as_deref())
                            .is_some())
                        || babak_non_empty_text(comment.text.as_deref())
                            .is_some())
            })
            .count();
        count.saturating_add(comments).saturating_add(supplemental)
    })
}

impl BabakStreamUnit {
    fn from_report(report: &mut StatsPerUnitReport) -> Self {
        Self {
            unit: report.unit.clone().unwrap_or_else(|| "НВ".to_string()),
            comments: take_babak_comments(report.comments.take()),
            losses_comments: take_babak_comments(report.losses_comments.take()),
            others_comments: take_babak_comments(report.others_comments.take()),
        }
    }
}

fn take_babak_comments(value: Option<Value>) -> Vec<BabakComment> {
    let mut comments: Vec<BabakComment> = value
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    comments.sort_unstable();
    comments.dedup();
    comments
}

fn pack_babak_docx<W: Write + Seek>(
    xml: XMLDocx,
    writer: W,
    units: &[BabakStreamUnit],
    without_comments: bool,
) -> ::zip::result::ZipResult<()> {
    let marker_ranges = babak_marker_paragraph_ranges(
        &xml.document,
        &[
            BABAK_COMMENTS_MARKER,
            BABAK_LOSSES_MARKER,
            BABAK_OTHERS_MARKER,
        ],
    )?;
    let mut zip = ::zip::ZipWriter::new(writer);
    let options = ::zip::write::SimpleFileOptions::default()
        .compression_method(::zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    zip.add_directory("word/", options)?;
    zip.add_directory("word/_rels", options)?;
    zip.add_directory("_rels/", options)?;
    zip.add_directory("docProps/", options)?;
    write_babak_zip_file(
        &mut zip,
        "[Content_Types].xml",
        options,
        &xml.content_type,
    )?;
    write_babak_zip_file(&mut zip, "_rels/.rels", options, &xml.rels)?;
    write_babak_zip_file(
        &mut zip,
        "docProps/app.xml",
        options,
        &xml.doc_props.app,
    )?;
    write_babak_zip_file(
        &mut zip,
        "docProps/core.xml",
        options,
        &xml.doc_props.core,
    )?;
    write_babak_zip_file(
        &mut zip,
        "docProps/custom.xml",
        options,
        &xml.doc_props.custom,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/_rels/document.xml.rels",
        options,
        &xml.document_rels,
    )?;

    zip.start_file("word/document.xml", options)?;
    zip.write_all(&xml.document[..marker_ranges[0].0])?;
    write_babak_comments(&mut zip, units, without_comments)?;
    zip.write_all(&xml.document[marker_ranges[0].1..marker_ranges[1].0])?;
    write_babak_losses(&mut zip, units, without_comments)?;
    zip.write_all(&xml.document[marker_ranges[1].1..marker_ranges[2].0])?;
    write_babak_others(&mut zip, units, without_comments)?;
    zip.write_all(&xml.document[marker_ranges[2].1..])?;

    write_babak_zip_file(&mut zip, "word/styles.xml", options, &xml.styles)?;
    write_babak_zip_file(
        &mut zip,
        "word/settings.xml",
        options,
        &xml.settings,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/fontTable.xml",
        options,
        &xml.font_table,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/comments.xml",
        options,
        &xml.comments,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/numbering.xml",
        options,
        &xml.numberings,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/commentsExtended.xml",
        options,
        &xml.comments_extended,
    )?;
    write_babak_zip_file(
        &mut zip,
        "word/footnotes.xml",
        options,
        &xml.footnotes,
    )?;

    for (index, header) in xml.headers.iter().enumerate() {
        write_babak_zip_file(
            &mut zip,
            &format!("word/header{}.xml", index + 1),
            options,
            header,
        )?;
        if let Some(rels) = xml.header_rels.get(index) {
            write_babak_zip_file(
                &mut zip,
                &format!("word/_rels/header{}.xml.rels", index + 1),
                options,
                rels,
            )?;
        }
    }
    for (index, footer) in xml.footers.iter().enumerate() {
        write_babak_zip_file(
            &mut zip,
            &format!("word/footer{}.xml", index + 1),
            options,
            footer,
        )?;
        if let Some(rels) = xml.footer_rels.get(index) {
            write_babak_zip_file(
                &mut zip,
                &format!("word/_rels/footer{}.xml.rels", index + 1),
                options,
                rels,
            )?;
        }
    }
    if !xml.media.is_empty() {
        zip.add_directory("word/media/", options)?;
        for (name, data) in xml.media {
            write_babak_zip_file(
                &mut zip,
                &format!("word/media/{name}.png"),
                options,
                &data,
            )?;
        }
    }
    if let Some(taskpanes) = xml.taskpanes {
        zip.add_directory("word/webextensions/", options)?;
        zip.add_directory("word/webextensions/_rels", options)?;
        write_babak_zip_file(
            &mut zip,
            "word/webextensions/taskpanes.xml",
            options,
            &taskpanes,
        )?;
        write_babak_zip_file(
            &mut zip,
            "word/webextensions/_rels/taskpanes.xml.rels",
            options,
            &xml.taskpanes_rels,
        )?;
        for (index, extension) in xml.web_extensions.iter().enumerate() {
            write_babak_zip_file(
                &mut zip,
                &format!("word/webextensions/webextension{}.xml", index + 1),
                options,
                extension,
            )?;
        }
    }
    if !xml.custom_items.is_empty() {
        zip.add_directory("customXml/_rels", options)?;
    }
    for (index, item) in xml.custom_items.iter().enumerate() {
        let number = index + 1;
        write_babak_zip_file(
            &mut zip,
            &format!("customXml/_rels/item{number}.xml.rels"),
            options,
            &xml.custom_item_rels[index],
        )?;
        write_babak_zip_file(
            &mut zip,
            &format!("customXml/item{number}.xml"),
            options,
            item,
        )?;
        write_babak_zip_file(
            &mut zip,
            &format!("customXml/itemProps{number}.xml"),
            options,
            &xml.custom_item_props[index],
        )?;
    }
    zip.finish()?;
    Ok(())
}

fn write_babak_zip_file<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    name: &str,
    options: ::zip::write::SimpleFileOptions,
    data: &[u8],
) -> ::zip::result::ZipResult<()> {
    zip.start_file(name, options)?;
    zip.write_all(data)?;
    Ok(())
}

fn babak_marker_paragraph_ranges(
    document: &[u8],
    markers: &[&str],
) -> ::zip::result::ZipResult<Vec<(usize, usize)>> {
    let mut ranges = Vec::with_capacity(markers.len());
    let mut search_from = 0;
    for marker in markers {
        let marker_offset =
            find_bytes(&document[search_from..], marker.as_bytes())
                .map(|offset| search_from + offset)
                .ok_or_else(|| {
                    ::zip::result::ZipError::InvalidArchive(
                        format!("missing Babak stream marker {marker}").into(),
                    )
                })?;
        let paragraph_start = document[..marker_offset]
            .windows(b"<w:p ".len())
            .rposition(|window| window == b"<w:p ")
            .ok_or_else(|| {
                ::zip::result::ZipError::InvalidArchive(
                    "missing Babak marker paragraph start".into(),
                )
            })?;
        let paragraph_end = find_bytes(&document[marker_offset..], b"</w:p>")
            .map(|offset| marker_offset + offset + b"</w:p>".len())
            .ok_or_else(|| {
                ::zip::result::ZipError::InvalidArchive(
                    "missing Babak marker paragraph end".into(),
                )
            })?;
        ranges.push((paragraph_start, paragraph_end));
        search_from = paragraph_end;
    }
    Ok(ranges)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn write_babak_paragraph<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    paragraph: Paragraph,
) -> ::zip::result::ZipResult<()> {
    zip.write_all(&paragraph.build())?;
    Ok(())
}

fn write_babak_unit_heading<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    unit: &str,
) -> ::zip::result::ZipResult<()> {
    write_babak_paragraph(zip, babak_unit_heading_paragraph(unit))?;
    write_babak_paragraph(zip, Paragraph::new())
}

fn write_babak_comments<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    units: &[BabakStreamUnit],
    without_comments: bool,
) -> ::zip::result::ZipResult<()> {
    if without_comments {
        return Ok(());
    }
    let tz = crate::config::get_tz();
    for unit in units {
        let comments = unit.comments.iter().filter(|comment| {
            comment.datetime.is_some()
                && babak_non_empty_text(comment.comment.as_deref()).is_some()
        });
        let mut comments = comments.peekable();
        if comments.peek().is_none() {
            continue;
        }
        write_babak_unit_heading(zip, &unit.unit)?;
        for comment in comments {
            let datetime = comment.datetime.unwrap_or_default();
            let datetime = Utc.from_utc_datetime(&datetime).with_timezone(&tz);
            let text = babak_non_empty_text(comment.comment.as_deref())
                .unwrap_or_default();
            write_babak_paragraph(
                zip,
                add_multiline_text(
                    Paragraph::new(),
                    &format!("{} {text}", datetime.format("%d/%m %H:%M")),
                    false,
                )
                .numbering(NumberingId::new(1), IndentLevel::new(0)),
            )?;
            write_babak_paragraph(zip, Paragraph::new())?;
        }
    }
    Ok(())
}

fn write_babak_losses<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    units: &[BabakStreamUnit],
    without_comments: bool,
) -> ::zip::result::ZipResult<()> {
    let tz = crate::config::get_tz();
    for unit in units {
        let comments = unit.losses_comments.iter().filter(|comment| {
            let has_comment = !without_comments
                && babak_non_empty_text(comment.comment.as_deref()).is_some();
            let has_text =
                babak_non_empty_text(comment.text.as_deref()).is_some();
            comment.datetime.is_some() && (has_comment || has_text)
        });
        let mut comments = comments.peekable();
        if comments.peek().is_none() {
            continue;
        }
        write_babak_unit_heading(zip, &unit.unit)?;
        for comment in comments {
            let datetime = comment.datetime.unwrap_or_default();
            let datetime = Utc.from_utc_datetime(&datetime).with_timezone(&tz);
            let mut paragraph = Paragraph::new().add_run(
                Run::new().add_text(datetime.format("%d/%m %H:%M").to_string()),
            );
            if !without_comments {
                if let Some(comment) =
                    babak_non_empty_text(comment.comment.as_deref())
                {
                    paragraph = add_multiline_text(
                        paragraph,
                        &format!(" {comment}"),
                        false,
                    );
                }
            }
            if let Some(text) = babak_non_empty_text(comment.text.as_deref()) {
                paragraph = paragraph
                    .add_run(Run::new().add_break(BreakType::TextWrapping));
                paragraph = add_multiline_text(paragraph, text, false);
            }
            write_babak_paragraph(
                zip,
                paragraph.numbering(NumberingId::new(1), IndentLevel::new(0)),
            )?;
            write_babak_paragraph(zip, Paragraph::new())?;
        }
    }
    Ok(())
}

fn write_babak_others<W: Write + Seek>(
    zip: &mut ::zip::ZipWriter<W>,
    units: &[BabakStreamUnit],
    without_comments: bool,
) -> ::zip::result::ZipResult<()> {
    let tz = crate::config::get_tz();
    for unit in units {
        let comments = unit.others_comments.iter().filter(|comment| {
            let has_comment = !without_comments
                && babak_non_empty_text(comment.comment.as_deref()).is_some();
            let has_text =
                babak_non_empty_text(comment.text.as_deref()).is_some();
            comment.datetime.is_some() && (has_comment || has_text)
        });
        let mut comments = comments.peekable();
        if comments.peek().is_none() {
            continue;
        }
        write_babak_unit_heading(zip, &unit.unit)?;
        for comment in comments {
            let datetime = comment.datetime.unwrap_or_default();
            let datetime = Utc.from_utc_datetime(&datetime).with_timezone(&tz);
            let mut paragraph = Paragraph::new().add_run(
                Run::new().add_text(datetime.format("%d/%m %H:%M").to_string()),
            );
            if !without_comments {
                if let Some(comment) =
                    babak_non_empty_text(comment.comment.as_deref())
                {
                    paragraph = add_multiline_text(
                        paragraph,
                        &format!(" {comment}"),
                        true,
                    );
                }
            }
            write_babak_paragraph(
                zip,
                paragraph.numbering(NumberingId::new(1), IndentLevel::new(0)),
            )?;
            if let Some(text) = babak_non_empty_text(comment.text.as_deref()) {
                write_babak_paragraph(
                    zip,
                    add_multiline_text(
                        Paragraph::new().indent(Some(720), None, None, None),
                        text,
                        false,
                    ),
                )?;
            }
            write_babak_paragraph(zip, Paragraph::new())?;
        }
    }
    Ok(())
}

#[derive(FromQueryResult, Deserialize, Debug, Clone)]
pub struct StatsPerUnitReport {
    pub unit: Option<String>,
    pub count: i64,
    pub bpla: i64,
    pub reb: i64,
    pub arta: i64,
    pub software: i64,
    pub losses: i64,
    pub comments: Option<Value>,
    pub others_comments: Option<Value>,
    pub losses_comments: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
struct BabakComment {
    datetime: Option<chrono::NaiveDateTime>,
    comment: Option<String>,
    text: Option<String>,
}

fn add_multiline_text(
    paragraph: Paragraph,
    text: &str,
    is_bold: bool,
) -> Paragraph {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized.split('\n').peekable();
    let mut paragraph = paragraph;

    while let Some(line) = lines.next() {
        let mut run = Run::new().add_text(line.to_string());
        if is_bold {
            run = run.bold();
        }
        paragraph = paragraph.add_run(run);

        if lines.peek().is_some() {
            paragraph = paragraph
                .add_run(Run::new().add_break(BreakType::TextWrapping));
        }
    }

    paragraph
}

fn babak_non_empty_text(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

fn babak_unit_heading_paragraph(unit: &str) -> Paragraph {
    Paragraph::new().add_run(
        Run::new()
            .add_text(format!(" {unit} "))
            .bold()
            .shading(Shading::new().fill("d9d9d9")),
    )
}

fn dedup_babak_comments_across_units(units: &mut [StatsPerUnitReport]) {
    let mut seen_comments = BTreeSet::new();
    let mut seen_losses = BTreeSet::new();
    let mut seen_others = BTreeSet::new();

    for unit in units.iter_mut() {
        unit.comments = dedup_babak_comment_values(
            unit.comments.take(),
            &mut seen_comments,
        );
        unit.losses_comments = dedup_babak_comment_values(
            unit.losses_comments.take(),
            &mut seen_losses,
        );
        unit.others_comments = dedup_babak_comment_values(
            unit.others_comments.take(),
            &mut seen_others,
        );
    }
}

fn dedup_babak_comment_values(
    value: Option<Value>,
    seen: &mut BTreeSet<BabakComment>,
) -> Option<Value> {
    let value = value?;
    let original = value.clone();
    let comments: Vec<BabakComment> = match serde_json::from_value(value) {
        Ok(items) => items,
        Err(_) => return Some(original),
    };
    let mut deduped = Vec::with_capacity(comments.len());
    for comment in comments {
        if seen.insert(comment.clone()) {
            deduped.push(comment);
        }
    }

    serde_json::to_value(deduped).ok().or(Some(original))
}

async fn get_inbox_messages_report_unit(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    include_comments: bool,
    chunking_hours: i64,
) -> Result<Vec<StatsPerUnitReport>, AppError> {
    let analytics_supported =
        crate::rer_importer::analysis::analytics_inbox_request_supported(req);
    let access = BabakCandidateAccess::resolve(
        env,
        login,
        analytics_supported,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .await
    .context(h!())?;
    let chunks =
        inbox_report_period_chunks(req, chunking_hours).context(h!())?;
    let mut candidate_ids = BTreeSet::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Babak report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        let scope = resolve_babak_candidate_scope(
            env,
            &chunk_req,
            analytics_supported,
            chunk.end,
        )
        .await
        .context(h!())?;
        if scope.as_ref().is_some_and(|scope| (*scope).is_empty()) {
            continue;
        }
        candidate_ids.extend(
            load_babak_candidate_ids(
                login,
                env,
                &chunk_req,
                &access,
                scope.as_ref(),
                chunk.end,
            )
            .await
            .context(h!())?,
        );
    }
    let candidate_ids = candidate_ids.into_iter().collect::<Vec<_>>();
    let mut stats = BTreeMap::<String, BabakStatsAccumulator>::new();
    let mut unknown = Vec::new();

    for candidate_ids in candidate_ids.chunks(RER_BABAK_ENRICHMENT_BATCH_SIZE) {
        let rows = load_babak_enrichment_batch(
            &env.dbx,
            candidate_ids,
            &access.login_ids,
            req.report_tags_only_this_unit.unwrap_or(false),
            req.without_model_tags.unwrap_or(false),
            include_comments,
        )
        .await
        .context(h!())?;
        for row in rows {
            let units = normalized_babak_units(&row);
            if units.is_empty() {
                if row.lat.is_some() && row.lng.is_some() {
                    unknown.push(row);
                } else {
                    stats.entry("НВ".to_string()).or_default().add(&row);
                }
                continue;
            }
            for unit in units {
                stats.entry(unit).or_default().add(&row);
            }
        }
    }

    add_clustered_unknown_stats(
        &env.dbx,
        &mut stats,
        unknown,
        env.config.cluster_radius.unwrap_or(2.0) / 100.0,
    )
    .await
    .context(h!())?;

    let mut units = stats
        .into_iter()
        .map(|(unit, stats)| stats.into_report(unit))
        .collect::<Vec<_>>();
    if req.report_tags_only_this_unit == Some(true) {
        dedup_babak_comments_across_units(&mut units);
    }
    Ok(units)
}

#[derive(Debug, FromQueryResult)]
struct BabakCandidateRow {
    id: i64,
    datetime: chrono::NaiveDateTime,
}

async fn load_babak_candidate_ids(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    access: &BabakCandidateAccess,
    scope: Option<&AnalyticsMessageIdScope>,
    period_end: ReportPeriodEnd,
) -> Result<Vec<i64>, AppError> {
    let analytics_timeout = core::time::Duration::from_millis(
        env.config
            .analytics
            .as_ref()
            .map(AnalyticsConfig::query_timeout_ms)
            .unwrap_or(ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT),
    );
    crate::rer_importer::analysis::with_internally_timed_analytics_read_fallback(
        env,
        "Babak report candidate scan",
        scope.is_some(),
        |db| async move {
            load_all_babak_candidate_ids(
                &db,
                login,
                req,
                access,
                scope,
                period_end,
                Some(analytics_timeout),
            )
            .await
        },
        |db| async move {
            load_all_babak_candidate_ids(
                &db, login, req, access, None, period_end, None,
            )
            .await
        },
    )
    .await
}

async fn load_all_babak_candidate_ids(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    access: &BabakCandidateAccess,
    scope: Option<&AnalyticsMessageIdScope>,
    period_end: ReportPeriodEnd,
    page_timeout: Option<core::time::Duration>,
) -> Result<Vec<i64>, AppError> {
    let mut result = Vec::new();
    let mut cursor = None;
    loop {
        let load_page = load_babak_candidate_page(
            dbx, login, req, access, scope, cursor, period_end,
        );
        let page = match page_timeout {
            Some(timeout) => {
                tokio::time::timeout(timeout, load_page).await.c(h!())??
            }
            None => load_page.await?,
        };
        let page_is_full = page.len() == RER_BABAK_CANDIDATE_PAGE_SIZE as usize;
        cursor = page.last().map(|row| (row.datetime, row.id));
        result.extend(page.into_iter().map(|row| row.id));
        if !page_is_full {
            break;
        }
    }
    Ok(result)
}

struct BabakCandidateAccess {
    sigint_groups: Vec<String>,
    login_ids: Vec<uuid::Uuid>,
    analytics_tag_access: Option<stats::AnalyticsTagAccess>,
}

impl BabakCandidateAccess {
    async fn resolve(
        env: &Env,
        login: &uuid::Uuid,
        analytics_supported: bool,
        report_tags_only_this_unit: bool,
    ) -> Result<Self, AppError> {
        Ok(Self {
            sigint_groups: crate::messenger::group::get_identity_sigint_groups(
                &env.dbx, login,
            )
            .await
            .c(h!())?,
            login_ids: crate::users::get_organism_login_ids_by_id(
                &env.dbx, login,
            )
            .await
            .context(h!())?,
            analytics_tag_access: if env.analytics.is_some()
                && analytics_supported
            {
                Some(
                    stats::resolve_analytics_tag_access(
                        &env.dbx,
                        login,
                        report_tags_only_this_unit,
                    )
                    .await?,
                )
            } else {
                None
            },
        })
    }
}

async fn resolve_babak_candidate_scope(
    env: &Env,
    req: &InboxMessagesReq,
    analytics_supported: bool,
    period_end: ReportPeriodEnd,
) -> Result<Option<AnalyticsMessageIdScope>, AppError> {
    if env.analytics.is_none() || !analytics_supported {
        return Ok(None);
    }
    let (Some(since), Some(till)) =
        (req.since_date_inclusive_ms, req.till_date_inclusive_ms)
    else {
        return Ok(None);
    };
    let dt_since = dt_from_millis(since).context(h!())?;
    let scope_till = match period_end {
        ReportPeriodEnd::Inclusive => till.saturating_add(1),
        ReportPeriodEnd::NonInclusive => till,
    };
    let dt_till = dt_from_millis(scope_till).context(h!())?;
    let freshness_max_age_ms = env
        .config
        .analytics
        .as_ref()
        .map(AnalyticsConfig::freshness_max_age_ms)
        .unwrap_or(ANALYTICS_FRESHNESS_MAX_AGE_MS_DEFAULT);
    Ok(Some(
        stats::resolve_analytics_message_id_scope_for_range(
            dt_since,
            dt_till,
            &env.dbx,
            freshness_max_age_ms,
        )
        .await
        .context(h!())?,
    ))
}

async fn load_babak_candidate_page(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    access: &BabakCandidateAccess,
    scope: Option<&AnalyticsMessageIdScope>,
    cursor: Option<(chrono::NaiveDateTime, i64)>,
    period_end: ReportPeriodEnd,
) -> Result<Vec<BabakCandidateRow>, AppError> {
    let mut query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .is_in(access.sigint_groups.clone()),
        )
        .filter(sigint_inbox_item::Column::Datetime.is_not_null());
    let linked_message_ids = intel_product::Entity::find()
        .select_only()
        .column(intel_product::Column::IntelMessageId)
        .filter(intel_product::relation_kind_is_in([
            intel_product::RELATION_KIND_COMMENT,
            intel_product::RELATION_KIND_REPORT,
        ]))
        .into_query();
    query = query
        .filter(signal_message::Column::Id.not_in_subquery(linked_message_ids));
    if req.only_show_unprocessed == Some(true) {
        query =
            query.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        query = query.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    query = match scope {
        Some(scope) => apply_babak_analytics_access_filter(
            query,
            &req.selected_groups,
            &req.selected_senders,
            &access.sigint_groups,
            scope,
        )?,
        None => filter_selected_groups_and_senders_with_access(
            query,
            &req.selected_groups,
            &req.selected_senders,
            &access.sigint_groups,
        )?,
    };
    query = filter_denied_senders(query, &req.denied_senders)?;
    query = filter_selected_freqs(query, &req.selected_freqs)?;
    query = filter_selected_posts(query, &req.selected_posts)?;
    query = filter_denied_freqs(query, &req.denied_freqs)?;
    query = filter_selected_callsigns(query, &req.selected_callsigns)?;
    query = match scope {
        Some(scope) => filter_selected_networks_analytics(
            query,
            &req.selected_networks,
            &req.without_network,
            Some(scope),
        ),
        None => filter_selected_networks(
            query,
            &req.selected_networks,
            &req.without_network,
        ),
    }
    .context(h!())?;
    query = filter_selected_metadata_for_inbox_messages(query, req)?;
    query = filter_search(query, &req.search)?;
    query = filter_selected_units(
        query,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    query =
        stats::filter_selected_aors_for_scope(query, &req.selected_aors, scope)
            .context(h!())?;
    query = match scope {
        Some(scope) => {
            let tag_access = access.analytics_tag_access.as_ref().c(h!())?;
            filter_selected_tags_analytics(
                query,
                &req.selected_tags,
                &req.denied_tags,
                &req.tag_presence,
                &req.or_bookmarked,
                &req.or_important,
                &req.or_with_coords,
                &req.or_without_coords,
                &req.or_with_extended_form,
                &req.filter_tags_option,
                &req.without_model_tags,
                login,
                req.report_tags_only_this_unit.unwrap_or(false),
                &tag_access.accessible_tag_ids,
                &tag_access.unit_login_ids,
                Some(scope),
            )
        }
        None => filter_selected_tags(
            query,
            &req.selected_tags,
            &req.denied_tags,
            &req.tag_presence,
            &req.or_bookmarked,
            &req.or_important,
            &req.or_with_coords,
            &req.or_without_coords,
            &req.or_with_extended_form,
            &req.filter_tags_option,
            &req.without_model_tags,
            login,
            req.report_tags_only_this_unit.unwrap_or(false),
        ),
    }?;
    if req.report_tags_only_this_unit == Some(true) {
        query = query
            .filter(babak_unit_comment_exists(&access.login_ids))
            .filter(babak_unit_tag_exists(&access.login_ids));
    }
    if let Some(since) = req.since_date_inclusive_ms {
        query = query.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since).context(h!())?),
        );
    }
    if let Some(till) = req.till_date_inclusive_ms {
        query = match period_end {
            ReportPeriodEnd::Inclusive => query.filter(
                sigint_inbox_item::Column::Datetime
                    .lte(dt_from_millis(till).context(h!())?),
            ),
            ReportPeriodEnd::NonInclusive => query.filter(
                sigint_inbox_item::Column::Datetime
                    .lt(dt_from_millis(till).context(h!())?),
            ),
        };
    }
    query = filter_selected_locations(
        query,
        &req.selected_locations,
        req.include_peleng_locations.unwrap_or(false),
    )
    .context(h!())?;
    if let Some(scope) = scope {
        query = query
            .filter(scope.condition((
                signal_message::Entity,
                signal_message::Column::Id,
            )))
            .filter(scope.condition((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )));
    }
    if let Some((datetime, id)) = cursor {
        query = query.filter(
            sigint_inbox_item::Column::Datetime.gt(datetime).or(
                sigint_inbox_item::Column::Datetime
                    .eq(datetime)
                    .and(signal_message::Column::Id.gt(id)),
            ),
        );
    }
    Ok(query
        .select_only()
        .distinct()
        .column(signal_message::Column::Id)
        .column(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(signal_message::Column::Id)
        .limit(RER_BABAK_CANDIDATE_PAGE_SIZE)
        .into_model::<BabakCandidateRow>()
        .all(dbx)
        .await
        .c(h!())?)
}

fn apply_babak_analytics_access_filter(
    mut query: Select<signal_message::Entity>,
    selected_groups: &Option<Vec<String>>,
    selected_senders: &Option<Vec<String>>,
    allowed_groups: &[String],
    scope: &AnalyticsMessageIdScope,
) -> Result<Select<signal_message::Entity>, AppError> {
    let selected_groups =
        selected_groups.as_ref().filter(|groups| !groups.is_empty());
    let selected_senders = selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty());
    if selected_groups.is_none() && selected_senders.is_none() {
        return Ok(query);
    }
    let allowed = allowed_groups.iter().collect::<HashSet<_>>();
    let effective_groups = selected_groups
        .map(|groups| {
            groups
                .iter()
                .filter(|group| allowed.contains(group))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| allowed_groups.to_vec());
    if effective_groups.is_empty() {
        return Ok(query.filter(Expr::cust("FALSE")));
    }

    let access_alias = Alias::new("babak_message_access");
    QuerySelect::query(&mut query).join_as(
        JoinType::InnerJoin,
        signal_message_group::Entity,
        access_alias.clone(),
        Expr::col((
            access_alias.clone(),
            signal_message_group::Column::SignalMessageId,
        ))
        .equals((signal_message::Entity, signal_message::Column::Id)),
    );
    query = query
        .filter(
            Expr::col((
                access_alias.clone(),
                signal_message_group::Column::GroupMasterKey,
            ))
            .is_in(effective_groups),
        )
        .filter(scope.condition((
            access_alias.clone(),
            signal_message_group::Column::SignalMessageId,
        )));
    if let Some(selected_senders) = selected_senders {
        query = query.filter(
            preferred_group_sender_expr(Some("babak_message_access"))
                .is_in(selected_senders.clone()),
        );
    }
    Ok(query)
}

fn babak_unit_comment_exists(login_ids: &[uuid::Uuid]) -> SimpleExpr {
    let legacy_comment_exists = Expr::exists(
        Query::select()
            .expr(Expr::value(1))
            .from(sigint_comment::Entity)
            .and_where(
                Expr::col((
                    sigint_comment::Entity,
                    sigint_comment::Column::SignalMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .and_where(
                sigint_comment::Column::LoginId.is_in(login_ids.to_vec()),
            )
            .and_where(
                sigint_comment::Column::MigratedSignalMessageId.is_null(),
            )
            .to_owned(),
    );
    let linked_comment_exists = Expr::exists(
        Query::select()
            .expr(Expr::value(1))
            .from(intel_product::Entity)
            .and_where(intel_product::relation_kind_is_in([
                intel_product::RELATION_KIND_COMMENT,
                intel_product::RELATION_KIND_REPORT,
            ]))
            .and_where(
                Expr::col((
                    intel_product::Entity,
                    intel_product::Column::SourceMessageId,
                ))
                .equals((signal_message::Entity, signal_message::Column::Id)),
            )
            .and_where(Expr::exists(
                Query::select()
                    .expr(Expr::value(1))
                    .from(signal_message::Entity)
                    .and_where(
                        Expr::col((
                            signal_message::Entity,
                            signal_message::Column::Id,
                        ))
                        .equals((
                            intel_product::Entity,
                            intel_product::Column::IntelMessageId,
                        )),
                    )
                    .and_where(signal_message::Column::Deleted.eq(false))
                    .and_where(
                        preferred_message_author_expr(None).is_in(
                            login_ids
                                .iter()
                                .map(ToString::to_string)
                                .collect::<Vec<_>>(),
                        ),
                    )
                    .to_owned(),
            ))
            .to_owned(),
    );
    legacy_comment_exists.or(linked_comment_exists)
}

fn babak_unit_tag_exists(login_ids: &[uuid::Uuid]) -> SimpleExpr {
    Expr::exists(
        Query::select()
            .expr(Expr::value(1))
            .from(sigint_inbox_item_tag::Entity)
            .and_where(
                Expr::col((
                    sigint_inbox_item_tag::Entity,
                    sigint_inbox_item_tag::Column::SigintInboxItemId,
                ))
                .equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
            )
            .and_where(
                sigint_inbox_item_tag::Column::Confidence
                    .gte(TAG_MINIMUM_CONFIDENCE),
            )
            .and_where(
                sigint_inbox_item_tag::Column::LoginId
                    .is_in(login_ids.to_vec()),
            )
            .to_owned(),
    )
}

#[derive(Debug, FromQueryResult)]
struct BabakEnrichmentRow {
    datetime: Option<chrono::NaiveDateTime>,
    body: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    fallback_unit: Option<String>,
    units: Vec<String>,
    comments: Vec<String>,
    bpla: bool,
    reb: bool,
    arta: bool,
    software: bool,
    losses: bool,
}

async fn load_babak_enrichment_batch(
    dbx: &DatabaseConnection,
    candidate_ids: &[i64],
    login_ids: &[uuid::Uuid],
    only_this_unit: bool,
    without_model_tags: bool,
    include_comments: bool,
) -> Result<Vec<BabakEnrichmentRow>, AppError> {
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with candidate as (
            select unnest($1::bigint[]) as id
        ),
        message_units as (
            select
                link.sigint_inbox_item_id as id,
                array_remove(array_agg(distinct coalesce(
                    nullif(unit.regiment, ''),
                    nullif(unit.battalion, ''),
                    nullif(unit.division, ''),
                    nullif(unit.army, ''),
                    nullif(unit.name, '')
                )), null) as units
            from candidate
            join sigint_inbox_item_network link
              on link.sigint_inbox_item_id = candidate.id
            join sigint_network network
              on network.id = link.sigint_network_id
             and network.deleted = false
            join sigint_network_unit network_unit
              on network_unit.network_id = network.id
            join sigint_unit unit
              on unit.id = network_unit.unit_id
             and unit.deleted = false
            group by link.sigint_inbox_item_id
        ),
        message_tags as (
            select
                item_tag.sigint_inbox_item_id as id,
                bool_or(lower(tag.label) = 'бпла') as bpla,
                bool_or(lower(tag.label) = 'рер') as reb,
                bool_or(lower(tag.label) = 'арта') as arta,
                bool_or(lower(tag.label) = 'забезп') as software,
                bool_or(lower(tag.label) = 'втрати') as losses
            from candidate
            join sigint_inbox_item_tag item_tag
              on item_tag.sigint_inbox_item_id = candidate.id
             and item_tag.confidence >= $2
             and ($3 = false or item_tag.login_id = any($4::uuid[]))
             and ($5 = false or item_tag.model is null)
            join tag on tag.id = item_tag.tag_id
            group by item_tag.sigint_inbox_item_id
        ),
        message_comments as (
            select
                candidate.id,
                comments.comments
            from candidate
            cross join lateral (
                select array_agg(
                    comment.comment order by comment.created_at, comment.id
                ) as comments
                from (
                    select
                        linked.id,
                        linked.created_at,
                        linked.body as comment,
                        coalesce(linked.sender, linked.login_id::text) as author
                    from intel_product link
                    join signal_message linked
                      on linked.id = link.intel_message_id
                    where link.source_message_id = candidate.id
                      and link.relation_kind in ('comment', 'report')
                      and linked.deleted = false
                    union all
                    select
                        legacy.id,
                        legacy.created_at,
                        legacy.comment,
                        legacy.login_id::text as author
                    from sigint_comment legacy
                    where legacy.signal_message_id = candidate.id
                      and legacy.migrated_signal_message_id is null
                ) comment
                where comment.comment <> ''
                  and $6 = true
                  and ($3 = false or comment.author = any(
                      select unnest($4::uuid[])::text
                  ))
            ) comments
            where comments.comments is not null
        )
        select
            item.datetime,
            message.body,
            item.lat,
            item.lng,
            item.unit_v2 as fallback_unit,
            coalesce(message_units.units, array[]::text[]) as units,
            coalesce(message_comments.comments, array[]::text[]) as comments,
            coalesce(message_tags.bpla, false) as bpla,
            coalesce(message_tags.reb, false) as reb,
            coalesce(message_tags.arta, false) as arta,
            coalesce(message_tags.software, false) as software,
            coalesce(message_tags.losses, false) as losses
        from candidate
        join signal_message message on message.id = candidate.id
        join sigint_inbox_item item on item.id = candidate.id
        left join message_units on message_units.id = candidate.id
        left join message_tags on message_tags.id = candidate.id
        left join message_comments on message_comments.id = candidate.id
        order by item.datetime, message.id
        "#,
        [
            candidate_ids.to_vec().into(),
            TAG_MINIMUM_CONFIDENCE.into(),
            only_this_unit.into(),
            login_ids.to_vec().into(),
            without_model_tags.into(),
            include_comments.into(),
        ],
    );
    Ok(BabakEnrichmentRow::find_by_statement(stmt)
        .all(dbx)
        .await
        .c(h!())?)
}

fn normalized_babak_units(row: &BabakEnrichmentRow) -> Vec<String> {
    let mut units = row
        .units
        .iter()
        .map(|unit| unit.trim())
        .filter(|unit| !unit.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    if units.is_empty() {
        if let Some(unit) = row
            .fallback_unit
            .as_deref()
            .map(str::trim)
            .filter(|unit| !unit.is_empty())
        {
            units.insert(unit.to_string());
        }
    }
    units.into_iter().collect()
}

#[derive(Default)]
struct BabakStatsAccumulator {
    count: i64,
    bpla: i64,
    reb: i64,
    arta: i64,
    software: i64,
    losses: i64,
    comments: Vec<BabakComment>,
    others_comments: Vec<BabakComment>,
    losses_comments: Vec<BabakComment>,
}

impl BabakStatsAccumulator {
    fn add(&mut self, row: &BabakEnrichmentRow) {
        self.count += 1;
        self.bpla += i64::from(row.bpla);
        self.reb += i64::from(row.reb);
        self.arta += i64::from(row.arta);
        self.software += i64::from(row.software);
        self.losses += i64::from(row.losses);

        if row.comments.is_empty() {
            self.add_section_comment(row, None);
        } else {
            for comment in &row.comments {
                self.add_comment(row, Some(comment.clone()));
            }
        }
    }

    fn add_comment(
        &mut self,
        row: &BabakEnrichmentRow,
        comment: Option<String>,
    ) {
        let item = BabakComment {
            datetime: row.datetime,
            comment,
            text: row.body.clone(),
        };
        self.comments.push(item.clone());
        self.add_section_item(row.losses, item);
    }

    fn add_section_comment(
        &mut self,
        row: &BabakEnrichmentRow,
        comment: Option<String>,
    ) {
        let item = BabakComment {
            datetime: row.datetime,
            comment,
            text: row.body.clone(),
        };
        self.add_section_item(row.losses, item);
    }

    fn add_section_item(&mut self, losses: bool, item: BabakComment) {
        if losses {
            self.losses_comments.push(item);
        } else {
            self.others_comments.push(item);
        }
    }

    fn merge(&mut self, other: BabakStatsAccumulator) {
        self.count += other.count;
        self.bpla += other.bpla;
        self.reb += other.reb;
        self.arta += other.arta;
        self.software += other.software;
        self.losses += other.losses;
        self.comments.extend(other.comments);
        self.others_comments.extend(other.others_comments);
        self.losses_comments.extend(other.losses_comments);
    }

    fn into_report(self, unit: String) -> StatsPerUnitReport {
        StatsPerUnitReport {
            unit: Some(unit),
            count: self.count,
            bpla: self.bpla,
            reb: self.reb,
            arta: self.arta,
            software: self.software,
            losses: self.losses,
            comments: serde_json::to_value(self.comments).ok(),
            others_comments: serde_json::to_value(self.others_comments).ok(),
            losses_comments: serde_json::to_value(self.losses_comments).ok(),
        }
    }
}

#[derive(Debug, FromQueryResult)]
struct BabakClusterUnitRow {
    cluster_id: i64,
    unit: String,
}

async fn add_clustered_unknown_stats(
    dbx: &DatabaseConnection,
    stats: &mut BTreeMap<String, BabakStatsAccumulator>,
    unknown: Vec<BabakEnrichmentRow>,
    radius: f64,
) -> Result<(), AppError> {
    let cluster_ids = babak_spatial_cluster_ids(&unknown, radius);
    let mut clusters = BTreeMap::<usize, BabakStatsAccumulator>::new();
    let mut centroid_sums = BTreeMap::<usize, (f64, f64, usize)>::new();
    for (row, cluster_id) in unknown.into_iter().zip(cluster_ids) {
        let Some(cluster_id) = cluster_id else {
            stats.entry("НВ".to_string()).or_default().add(&row);
            continue;
        };
        clusters.entry(cluster_id).or_default().add(&row);
        let (lng_sum, lat_sum, count) =
            centroid_sums.entry(cluster_id).or_default();
        *lng_sum += row.lng.unwrap_or_default();
        *lat_sum += row.lat.unwrap_or_default();
        *count += 1;
    }

    let cluster_units = load_babak_cluster_units(dbx, &centroid_sums).await?;
    for (cluster_id, cluster_stats) in clusters {
        let unit = cluster_units
            .get(&cluster_id)
            .cloned()
            .unwrap_or_else(|| "НВ".to_string());
        stats.entry(unit).or_default().merge(cluster_stats);
    }
    Ok(())
}

fn babak_spatial_cluster_ids(
    rows: &[BabakEnrichmentRow],
    radius: f64,
) -> Vec<Option<usize>> {
    if rows.is_empty() || !radius.is_finite() || radius <= 0.0 {
        return vec![None; rows.len()];
    }
    let mut parents = (0..rows.len()).collect::<Vec<_>>();
    let mut cells = HashMap::<(i64, i64), Vec<usize>>::new();
    let radius_squared = radius * radius;
    for (idx, row) in rows.iter().enumerate() {
        let (Some(lng), Some(lat)) = (row.lng, row.lat) else {
            continue;
        };
        let cell =
            ((lng / radius).floor() as i64, (lat / radius).floor() as i64);
        for x in cell.0 - 1..=cell.0 + 1 {
            for y in cell.1 - 1..=cell.1 + 1 {
                if let Some(neighbours) = cells.get(&(x, y)) {
                    for &other_idx in neighbours {
                        let other = &rows[other_idx];
                        let delta_lng = lng - other.lng.unwrap_or_default();
                        let delta_lat = lat - other.lat.unwrap_or_default();
                        if delta_lng * delta_lng + delta_lat * delta_lat
                            <= radius_squared
                        {
                            babak_union(&mut parents, idx, other_idx);
                        }
                    }
                }
            }
        }
        cells.entry(cell).or_default().push(idx);
    }

    let mut component_sizes = HashMap::<usize, usize>::new();
    for idx in 0..rows.len() {
        let root = babak_find(&mut parents, idx);
        *component_sizes.entry(root).or_default() += 1;
    }
    let mut cluster_by_root = HashMap::new();
    let mut next_cluster_id = 0;
    (0..rows.len())
        .map(|idx| {
            let root = babak_find(&mut parents, idx);
            if component_sizes.get(&root).copied().unwrap_or_default() < 2 {
                return None;
            }
            Some(*cluster_by_root.entry(root).or_insert_with(|| {
                let cluster_id = next_cluster_id;
                next_cluster_id += 1;
                cluster_id
            }))
        })
        .collect()
}

fn babak_find(parents: &mut [usize], idx: usize) -> usize {
    if parents[idx] != idx {
        parents[idx] = babak_find(parents, parents[idx]);
    }
    parents[idx]
}

fn babak_union(parents: &mut [usize], left: usize, right: usize) {
    let left = babak_find(parents, left);
    let right = babak_find(parents, right);
    if left != right {
        parents[right] = left;
    }
}

async fn load_babak_cluster_units(
    dbx: &DatabaseConnection,
    centroids: &BTreeMap<usize, (f64, f64, usize)>,
) -> Result<HashMap<usize, String>, AppError> {
    if centroids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut cluster_ids = Vec::with_capacity(centroids.len());
    let mut lngs = Vec::with_capacity(centroids.len());
    let mut lats = Vec::with_capacity(centroids.len());
    for (&cluster_id, &(lng_sum, lat_sum, count)) in centroids {
        cluster_ids.push(cluster_id as i64);
        lngs.push(lng_sum / count as f64);
        lats.push(lat_sum / count as f64);
    }
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with centroid as (
            select
                cluster_id,
                st_setsrid(st_makepoint(lng, lat), 4326) as geom
            from unnest(
                $1::bigint[],
                $2::double precision[],
                $3::double precision[]
            ) as point(cluster_id, lng, lat)
        )
        select
            centroid.cluster_id,
            format(
                '%s км %s %s',
                round((st_distance(centroid.geom::geography, settlement.geom::geography) / 1000)::numeric, 1),
                case
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 22.5 then 'Пн'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 67.5 then 'Пн-Сх'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 112.5 then 'Сх'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 157.5 then 'Пд-Сх'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 202.5 then 'Пд'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 247.5 then 'Пд-Зх'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 292.5 then 'Зх'
                    when degrees(st_azimuth(centroid.geom::geography, settlement.geom::geography)) < 337.5 then 'Пн-Зх'
                    else 'Пн'
                end,
                settlement.name
            ) as unit
        from centroid
        cross join lateral (
            select
                name,
                st_setsrid(st_makepoint(lon, lat), 4326) as geom
            from settlement
            order by centroid.geom <-> st_setsrid(st_makepoint(lon, lat), 4326)
            limit 1
        ) settlement
        "#,
        [cluster_ids.into(), lngs.into(), lats.into()],
    );
    Ok(BabakClusterUnitRow::find_by_statement(stmt)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| (row.cluster_id as usize, row.unit))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use crate::rer_importer::reports::types::ReportPreviewReq;
    use crate::rer_importer::types::InboxMessagesReq;
    use chrono::Utc;
    use sea_orm::prelude::Expr;
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;
    use std::io::Read;

    fn babak_test_row(
        lat: f64,
        lng: f64,
        comments: Vec<&str>,
    ) -> BabakEnrichmentRow {
        BabakEnrichmentRow {
            datetime: Some(
                chrono::NaiveDate::from_ymd_opt(2026, 7, 30)
                    .unwrap()
                    .and_hms_opt(10, 0, 0)
                    .unwrap(),
            ),
            body: Some("message body".to_string()),
            lat: Some(lat),
            lng: Some(lng),
            fallback_unit: Some("fallback".to_string()),
            units: Vec::new(),
            comments: comments.into_iter().map(ToOwned::to_owned).collect(),
            bpla: true,
            reb: false,
            arta: false,
            software: false,
            losses: false,
        }
    }

    #[test]
    fn babak_clusters_connected_unknown_points_with_minimum_two() {
        let rows = vec![
            babak_test_row(50.0, 30.0, vec![]),
            babak_test_row(50.005, 30.005, vec![]),
            babak_test_row(51.0, 31.0, vec![]),
        ];
        let clusters = babak_spatial_cluster_ids(&rows, 0.02);
        assert_eq!(clusters[0], clusters[1]);
        assert!(clusters[0].is_some());
        assert_eq!(clusters[2], None);
    }

    #[test]
    fn babak_counts_messages_once_with_multiple_comments() {
        let row = babak_test_row(50.0, 30.0, vec!["first", "second"]);
        let mut stats = BabakStatsAccumulator::default();
        stats.add(&row);
        assert_eq!(stats.count, 1);
        assert_eq!(stats.bpla, 1);
        assert_eq!(stats.comments.len(), 2);
        assert_eq!(stats.others_comments.len(), 2);
    }

    #[test]
    fn babak_streams_valid_deflated_docx_in_section_order() {
        let datetime = chrono::NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let comment_value = |comment: &str, text: &str| {
            serde_json::to_value(vec![BabakComment {
                datetime: Some(datetime),
                comment: Some(comment.to_string()),
                text: Some(text.to_string()),
            }])
            .unwrap()
        };
        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("babak.docx");
        build_babak_report(
            BabakReportData {
                units: vec![StatsPerUnitReport {
                    unit: Some("Test unit".to_string()),
                    count: 3,
                    bpla: 1,
                    reb: 0,
                    arta: 0,
                    software: 0,
                    losses: 1,
                    comments: Some(comment_value("regular comment", "body")),
                    losses_comments: Some(comment_value(
                        "loss comment",
                        "loss body",
                    )),
                    others_comments: Some(comment_value(
                        "other comment",
                        "other body",
                    )),
                }],
                new_callsigns: NewCallsignsRes {
                    not_seen_24h: Vec::new(),
                    not_seen_7days: vec!["ALPHA".to_string()],
                    not_seen_30days: Vec::new(),
                },
                date_from: datetime,
                date_to: datetime + chrono::Duration::hours(1),
                without_comments: false,
            },
            &output,
        )
        .unwrap();

        let bytes = std::fs::read(output).unwrap();
        docx_rs::read_docx(&bytes).unwrap();
        let mut archive =
            ::zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut document = archive.by_name("word/document.xml").unwrap();
        assert_eq!(document.compression(), ::zip::CompressionMethod::Deflated);
        let mut xml = String::new();
        document.read_to_string(&mut xml).unwrap();
        assert!(!xml.contains("ECHO_BABAK_STREAM"));
        let regular = xml.find("regular comment").unwrap();
        let losses_heading = xml.find("Втрати противника").unwrap();
        let loss = xml.find("loss comment").unwrap();
        let others_heading = xml
            .find("Радіоперехоплення, що становлять розвідувальну цінність")
            .unwrap();
        let other = xml.find("other comment").unwrap();
        assert!(regular < losses_heading);
        assert!(losses_heading < loss);
        assert!(loss < others_heading);
        assert!(others_heading < other);
        drop(document);
        let mut rels = String::new();
        archive
            .by_name("word/_rels/document.xml.rels")
            .unwrap()
            .read_to_string(&mut rels)
            .unwrap();
        assert!(rels.contains("relationships/numbering"));
    }

    async fn seed_babak_unit_report_data(
        db: &DatabaseConnection,
        login_id: uuid::Uuid,
        message_id: i64,
        tag_id: i64,
        created_at: NaiveDateTime,
        comment: &str,
    ) -> Result<(), AppError> {
        mk_sigint_comment(
            db,
            sigint_comment::ActiveModel {
                login_id: Set(login_id),
                signal_message_id: Set(message_id),
                comment: Set(comment.to_string()),
                created_at: Set(created_at),
                ..Default::default()
            },
        )
        .await?;
        mk_sigint_inbox_item_tag(
            db,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message_id),
                tag_id: Set(tag_id),
                login_id: Set(Some(login_id)),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    #[serial]
    #[tokio::test]
    async fn test_bl_babak_report_returns_unit_stats() {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc() - chrono::Duration::hours(20);

        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let bpla_tag = find_test_bpla_tag(&env.dbx).await.unwrap();

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

        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
                lat: Set(Some(50.0)),
                lng: Set(Some(30.0)),
                tags: Set(Some(json!([bpla_tag.id]))),
                date: Set(Some(now.date().to_string())),
                time: Set(Some(now.time().format("%H:%M:%S").to_string())),
                unit_v2: Set(Some("TestUnit".to_string())),
                checked: Set(Some(true)),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_datetime = now + chrono::Duration::hours(20);
        let second_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("second test message".to_string())),
                created_at: Set(second_datetime),
                timestamp: Set(Some(second_datetime)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some("uid-2".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(second_message.id),
                freq: Set(Some("123.45".to_string())),
                lat: Set(Some(50.0)),
                lng: Set(Some(30.0)),
                tags: Set(Some(json!([bpla_tag.id]))),
                date: Set(Some(second_datetime.date().to_string())),
                time: Set(Some(
                    second_datetime.time().format("%H:%M:%S").to_string(),
                )),
                unit_v2: Set(Some("TestUnit".to_string())),
                checked: Set(Some(true)),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::inbox::callsigns::sync(
            &env.dbx,
            inbox_item.id,
            inbox_item.id_uuid,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: vec!["Alpha".to_string()],
                alg2: Vec::new(),
            },
            login.id,
        )
        .await
        .unwrap();
        crate::inbox::callsigns::sync(
            &env.dbx,
            second_inbox_item.id,
            second_inbox_item.id_uuid,
            crate::inbox::callsigns::InboxItemCallsigns {
                primary: vec!["Alpha".to_string(), "Beta".to_string()],
                alg2: Vec::new(),
            },
            login.id,
        )
        .await
        .unwrap();
        seed_babak_unit_report_data(
            &env.dbx,
            login.id,
            message.id,
            bpla_tag.id,
            now,
            "first comment",
        )
        .await
        .unwrap();
        seed_babak_unit_report_data(
            &env.dbx,
            login.id,
            second_message.id,
            bpla_tag.id,
            second_datetime,
            "second comment",
        )
        .await
        .unwrap();
        let linked_comment = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("linked comment".to_string())),
                created_at: Set(now + chrono::Duration::minutes(1)),
                timestamp: Set(Some(now + chrono::Duration::minutes(1))),
                sender: Set(Some(login.id.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        intel_product::ActiveModel {
            intel_message_id: Set(linked_comment.id),
            source_message_id: Set(message.id),
            relation_kind: Set(intel_product::RELATION_KIND_COMMENT),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let linked_report = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("linked intelligence report".to_string())),
                created_at: Set(now + chrono::Duration::minutes(2)),
                timestamp: Set(Some(now + chrono::Duration::minutes(2))),
                sender: Set(Some(login.id.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        intel_product::ActiveModel {
            intel_message_id: Set(linked_report.id),
            source_message_id: Set(message.id),
            relation_kind: Set(intel_product::RELATION_KIND_REPORT),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let datetime = inbox_item
            .datetime
            .expect("expected auto-set datetime on sigint_inbox_item");
        let second_datetime = second_inbox_item
            .datetime
            .expect("expected auto-set datetime on second sigint_inbox_item");

        let req = ReportPreviewReq {
            kind: "babak".to_string(),
            req: InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    datetime.and_utc().timestamp_millis() - 1_000,
                ),
                till_date_inclusive_ms: Some(
                    second_datetime.and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: Some(true),
            tag_report_sort_by: None,
            report_1213_linked_networks_only: None,
            without_comments: Some(false),
            babak_new_callsign_min_mentions: Some(2),
            interception_keep_full_message: None,
            interception_keep_old_colors: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
            sposob_unit_name: None,
        };

        set_report_chunking_hours(&env.dbx, 24).await;
        let single = bl_babak_report(&login.id, &env, &req).await.unwrap();
        set_report_chunking_hours(&env.dbx, 12).await;
        let res = bl_babak_report(&login.id, &env, &req).await.unwrap();

        assert_eq!(res.units.len(), 1);
        let unit = &res.units[0];
        assert_eq!(unit.unit.as_deref(), Some("TestUnit"));
        assert_eq!(unit.count, 2);
        let comments: Vec<BabakComment> = serde_json::from_value(
            unit.comments.clone().expect("expected Babak comments"),
        )
        .unwrap();
        assert!(comments.iter().any(|comment| {
            comment.comment.as_deref() == Some("linked comment")
        }));
        assert!(comments.iter().any(|comment| {
            comment.comment.as_deref() == Some("linked intelligence report")
        }));
        let single_unit = &single.units[0];
        assert_eq!(unit.unit, single_unit.unit);
        assert_eq!(unit.count, single_unit.count);
        assert_eq!(unit.bpla, single_unit.bpla);
        assert_eq!(unit.reb, single_unit.reb);
        assert_eq!(unit.arta, single_unit.arta);
        assert_eq!(unit.software, single_unit.software);
        assert_eq!(unit.losses, single_unit.losses);
        assert_eq!(unit.comments, single_unit.comments);
        assert_eq!(unit.others_comments, single_unit.others_comments);
        assert_eq!(unit.losses_comments, single_unit.losses_comments);
        assert_eq!(res.new_callsigns, single.new_callsigns);
        assert!(
            res.new_callsigns
                .not_seen_7days
                .contains(&"Alpha".to_string()),
            "expected Alpha to be reported as new callsign"
        );
        assert!(
            !res.new_callsigns
                .not_seen_7days
                .contains(&"Beta".to_string()),
            "expected a callsign mentioned once to be excluded"
        );
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
