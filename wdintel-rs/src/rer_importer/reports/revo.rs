use super::super::types::*;
use super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use rust_xlsxwriter::{
    ColNum, ExcelDateTime, Format, FormatAlign, RowNum, Workbook, Worksheet,
};
use sea_orm::*;
use std::collections::*;
use std::path::Path;
use std::time::Instant;

const WIDTH_UNIT: usize = 1870;
const DTM_FORMAT: &str = "%Y.%m.%d %H:%M:%S";
const FUNCTIONALITY_DESC_DEFAULT: &str = "Склад кореспондентів - звичайний, інтенсивність роботи - звичайна, час роботи - звичайний, район роботи - старий/без змін.";

pub struct Report {
    pub summary: ReportSummary,
    pub hostile_networks: Vec<NetworkRow>,
    pub undefined_networks: Vec<NetworkRow>,
}

pub struct ReportSummary {
    pub identified_qty: u64,
    pub unidentified_qty: u64,
}

pub struct NetworkRow {
    pub name: String,
    pub location: Option<String>,
    pub freqs: Vec<String>,
    pub activity: NetworkActivity,
    pub correspondents: Vec<NetworkCorrespondent>,
    pub communication_kind: Option<String>,
    pub functionality_details: String,
    pub identified_details: Vec<String>,
}

pub struct NetworkActivity {
    pub since: NaiveDateTime,
    pub till: NaiveDateTime,
    pub seances_qty: u64,
}

pub struct NetworkCorrespondent {
    pub callsign: String,
    pub position: Option<String>,
}

pub struct NetworkSummaryData {
    pub network_summaries_dictionary: HashMap<i64, NetworkSummary>,
    pub undefined_network_summaries_dictionary: HashMap<i64, NetworkSummary>, // virtual "network summaries" for frequencies that do not have associated sigint networks
    pub message_to_networks_map: HashMap<i64, Vec<i64>>,
    pub message_to_undefined_networks_map: HashMap<i64, Vec<i64>>,
}

impl NetworkSummaryData {
    pub fn list_network_ids(&self) -> Vec<i64> {
        self.network_summaries_dictionary.keys().cloned().collect()
    }
    pub fn list_all_networks(&self) -> HashMap<i64, NetworkSummary> {
        let mut result = self.network_summaries_dictionary.clone();
        for (id, v) in self.undefined_network_summaries_dictionary.clone() {
            result.insert(id, v);
        }
        result
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct NetworkSummary {
    pub id: i64,
    pub name: String,
    pub location: Option<String>,
    pub freq: String,
    pub unit_name: Option<String>,
    pub master_key: Option<String>,
    pub message_ids: Vec<i64>,
}

#[derive(
    Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult, Hash, Eq,
)]
pub struct NetworkSummaryKey {
    pub network_id: i64,
    pub freq: String,
    pub master_key: Option<String>,
}

#[derive(
    Debug, Serialize, Deserialize, PartialEq, Eq, Clone, FromQueryResult, Hash,
)]
pub struct CallsignSummary {
    pub network_id: i64,
    pub unit_id: i64,
    pub unit_name: String,
    pub position: String,
    pub callsign: String,
}

#[derive(Debug, Clone, FromQueryResult)]
struct CommentSummary {
    pub signal_message_id: i64,
    pub comment: String,
}

pub async fn report_docx_kind_revo(
    user: Identity,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_revo started");

    let start = Instant::now();
    let read_db = env.dbx.clone();
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .context(h!())?;
    info!("get_organism_logins took: {:?}", start.elapsed());

    let start = Instant::now();
    let report_tags_only_this_unit =
        req.report_tags_only_this_unit.unwrap_or(false);
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let mut messages: Vec<(i64, InboxMessage)> =
        crate::rer_importer::inbox::get_inbox_messages_with_conn(
            &read_db,
            &login,
            &logins,
            env,
            &current_req,
        )
        .await
        .context(h!())?;
    if report_tags_only_this_unit {
        messages = merge_messages_with_comment_rules(
            &read_db, messages, &login, &logins, env, req,
        )
        .await
        .context(h!())?;
    }
    info!(
        "get_inbox_messages_with_conn took: {:?}, messages count: {}",
        start.elapsed(),
        messages.len()
    );

    let (range_khz, no_comments) = match req.report_type {
        Some(ReportType::Reo(
            ReoReportSettings {
                adjacent_freqs_distance,
                no_comments,
            },
            _,
        )) => (adjacent_freqs_distance * 1000.0, no_comments),
        _ => (0.0, false),
    };

    let start = Instant::now();
    let mut report = collect_report(
        messages,
        logins.clone(),
        env,
        &read_db,
        range_khz,
        report_tags_only_this_unit,
        no_comments,
    )
    .await
    .context(h!())?;
    info!("collect_report took: {:?}", start.elapsed());

    let start = Instant::now();
    report
        .hostile_networks
        .sort_by_key(|x| -(x.activity.seances_qty as i64));
    report
        .undefined_networks
        .sort_by_key(|x| -(x.activity.seances_qty as i64));
    info!("sorting networks took: {:?}", start.elapsed());

    let network_summary_total =
        report.summary.identified_qty + report.summary.unidentified_qty;
    let network_summary =
        format!("Відмічено радіомереж (радіонапрямків): {} (визначені - {}, не визначено - {})",
                network_summary_total,
                report.summary.identified_qty,
                report.summary.unidentified_qty
        );

    let result = match req.report_type {
        Some(ReportType::Reo(_, ReoReportFileType::Xlsx)) => {
            generate_xlsx_kind_revo(
                report,
                network_summary,
                outpath,
                no_comments,
            )
        }
        _ => generate_docx_kind_revo(
            report,
            network_summary,
            outpath,
            no_comments,
        ),
    };

    info!(
        "report_docx_kind_revo completed in total: {:?}",
        start_total.elapsed()
    );

    result
}

fn generate_xlsx_kind_revo(
    report: Report,
    network_summary: String,
    outpath: &Path,
    no_comments: bool,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let sheet = workbook
        .add_worksheet()
        .set_name("РЕО")
        .context(h!())?
        .set_column_width(0, 40)
        .context(h!())?;

    let coltitle = Format::new()
        .set_align(FormatAlign::Center)
        .set_font_size(12.0)
        .set_text_wrap();

    let mut headers: Vec<(&str, i32)> = vec![
        ("Назва радіомережі", 40),
        ("Місто/Населений пункт", 30),
        ("Частоти", 12),
        ("Час початку роботи радіомережі", 20),
        ("Час закінчення роботи радіомережі", 20),
        ("Сеанси", 8),
        ("Склад кореспондентів радіомережі та приналежність", 30),
        ("Характер радіообміну", 30),
        ("Особливості функціонування радіомереж", 30),
    ];
    if !no_comments {
        headers.push(("Що було виявлено", 40));
    }

    let mut row_num: RowNum = 0;
    let max_col_num = (headers.len() as u32) as ColNum;

    sheet
        .merge_range(
            0,
            0,
            0,
            max_col_num - 1,
            network_summary.as_str(),
            &coltitle,
        )
        .context(h!())?;
    row_num += 1;

    for (col_num, (header_name, header_with)) in headers.into_iter().enumerate()
    {
        sheet
            .write_string_with_format(
                row_num,
                col_num as ColNum,
                header_name,
                &coltitle,
            )
            .context(h!())?
            .set_column_width(col_num as ColNum, header_with)
            .context(h!())?;
    }
    row_num += 1;

    sheet
        .merge_range(
            row_num,
            0,
            row_num,
            max_col_num - 1,
            "Російська Федерація",
            &coltitle,
        )
        .context(h!())?;
    row_num += 1;

    for hostile_network in report.hostile_networks {
        generate_networks_sheet(
            sheet,
            row_num,
            &coltitle,
            hostile_network,
            no_comments,
        )?;
        row_num += 1;
    }

    sheet
        .merge_range(
            row_num,
            0,
            row_num,
            max_col_num - 1,
            "Невизначені",
            &coltitle,
        )
        .context(h!())?;
    row_num += 1;

    for undefined_network in report.undefined_networks {
        generate_networks_sheet(
            sheet,
            row_num,
            &coltitle,
            undefined_network,
            no_comments,
        )?;
        row_num += 1;
    }
    let start = Instant::now();
    workbook.save(outpath).context(h!())?; // Save the workbook
    info!("writing xlsx to file took: {:?}", start.elapsed());

    Ok(())
}

fn generate_networks_sheet<'a>(
    sheet: &'a mut Worksheet,
    row_num: RowNum,
    cell_format: &Format,
    network_row: NetworkRow,
    no_comments: bool,
) -> Result<&'a mut Worksheet, AppError> {
    let mut col_num = 0;
    let date_cell_format = cell_format.clone().set_num_format("dd.mm.yy hh:mm");
    let number_cell_format = cell_format.clone().set_num_format("0");

    sheet
        .write_string_with_format(
            row_num,
            col_num,
            network_row.name,
            cell_format,
        )
        .context(h!())?
        .set_column_width(col_num, 40)
        .context(h!())?;
    col_num += 1;

    if let Some(location) = network_row.location {
        sheet
            .write_string_with_format(row_num, col_num, location, cell_format)
            .context(h!())?
            .set_column_width(col_num, 30)
            .context(h!())?;
    }
    col_num += 1;

    sheet
        .write_string_with_format(
            row_num,
            col_num,
            network_row.freqs.join("\n"),
            cell_format,
        )
        .context(h!())?
        .set_column_width(col_num, 12)
        .context(h!())?;
    col_num += 1;

    let since = ExcelDateTime::from_timestamp(
        network_row.activity.since.and_utc().timestamp(),
    )
    .context(h!())?;
    sheet
        .write_datetime_with_format(row_num, col_num, &since, &date_cell_format)
        .context(h!())?
        .set_column_width(col_num, 20)
        .context(h!())?;
    col_num += 1;

    let till = ExcelDateTime::from_timestamp(
        network_row.activity.till.and_utc().timestamp(),
    )
    .context(h!())?;
    sheet
        .write_datetime_with_format(row_num, col_num, till, &date_cell_format)
        .context(h!())?
        .set_column_width(col_num, 20)
        .context(h!())?;
    col_num += 1;

    let sessions = network_row.activity.seances_qty as f64;
    sheet
        .write_number_with_format(
            row_num,
            col_num,
            sessions,
            &number_cell_format,
        )
        .context(h!())?
        .set_column_width(col_num, 8)
        .context(h!())?;
    col_num += 1;

    let correspondences =
        get_processed_correspondence(network_row.correspondents).join(", ");

    sheet
        .write_string_with_format(
            row_num,
            col_num,
            correspondences,
            cell_format,
        )
        .context(h!())?
        .set_column_width(col_num, 30)
        .context(h!())?;
    col_num += 1;

    if let Some(communication_kind) = network_row.communication_kind {
        sheet
            .write_string_with_format(
                row_num,
                col_num,
                communication_kind,
                cell_format,
            )
            .context(h!())?
            .set_column_width(col_num, 30)
            .context(h!())?;
    }
    col_num += 1;

    let functionality_details = network_row.functionality_details;
    sheet
        .write_string_with_format(
            row_num,
            col_num,
            functionality_details,
            cell_format,
        )
        .context(h!())?
        .set_column_width(col_num, 50)
        .context(h!())?;
    col_num += 1;

    if !no_comments {
        let identified_details = network_row.identified_details.join("\n");
        sheet
            .write_string_with_format(
                row_num,
                col_num,
                identified_details,
                cell_format,
            )
            .context(h!())?
            .set_column_width(col_num, 40)
            .context(h!())?;
    }

    Ok(sheet)
}

fn generate_docx_kind_revo(
    report: Report,
    network_summary: String,
    outpath: &Path,
    no_comments: bool,
) -> Result<(), AppError> {
    let start = Instant::now();
    let config = DocxConfig {
        columns_count: if no_comments { 5 } else { 6 },
        width_unit: WIDTH_UNIT,
        highlight_color: "FF0000".to_string(),
        split_multiline_cells: true,
        paragraph_spacing: Some(80),
    };

    let mut rows_amrp: Vec<TableRow> = vec![];
    let mut header_cells = vec![
        mk_header_cell("Назва радіомережі", &config),
        mk_header_cell("Час роботи радіомережі", &config),
        mk_header_cell(
            "Склад кореспондентів радіомережі та приналежність",
            &config,
        ),
        mk_header_cell("Характер радіообміну", &config),
        mk_header_cell("Особливості функціонування радіомереж", &config),
    ];
    if !no_comments {
        header_cells.push(mk_header_cell("Що було виявлено", &config));
    }
    rows_amrp.push(TableRow::new(header_cells));
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Російська Федерація",
        true,
        util::ParagraphStyle::Default,
        &config,
    )]));
    for e in report.hostile_networks {
        rows_amrp.push(render_network_row(e, &config, no_comments));
    }
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Невизначені",
        false,
        util::ParagraphStyle::Default,
        &config,
    )]));
    for e in report.undefined_networks {
        rows_amrp.push(render_network_row(e, &config, no_comments));
    }
    let thin_border = TableBorder::new(TableBorderPosition::Top)
        .border_type(BorderType::Single)
        .size(12);
    let table_amrp = Table::new(rows_amrp)
        .width(WIDTH_UNIT * 12, WidthType::Dxa)
        .set_border(thin_border);

    let docx = Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().size(32).add_text(network_summary))
                .align(AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_table(table_amrp);
    info!("building docx took: {:?}", start.elapsed());

    let start = Instant::now();
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;
    info!("writing docx to file took: {:?}", start.elapsed());

    Ok(())
}

fn render_network_row(
    row: NetworkRow,
    config: &DocxConfig,
    no_comments: bool,
) -> TableRow {
    let mut network_cell =
        mk_text_cell(&row.name, util::ParagraphStyle::Bold, config);
    if let Some(location) = row.location {
        network_cell = network_cell.add_paragraph(
            mk_paragraph(
                &format!("({location})"),
                util::ParagraphStyle::Default,
                config,
            )
            .bold(),
        );
    }
    network_cell = network_cell.add_paragraph(mk_paragraph(
        "",
        util::ParagraphStyle::Default,
        config,
    ));
    for freq in row.freqs {
        network_cell = network_cell.add_paragraph(mk_paragraph(
            &format!("\n{freq} МГц"),
            util::ParagraphStyle::Default,
            config,
        ));
    }
    let activity_cell = mk_text_cell(
        &row.activity.since.format(DTM_FORMAT).to_string(),
        util::ParagraphStyle::Default,
        config,
    )
    .add_paragraph(mk_paragraph(
        &format!("- {}", row.activity.till.format(DTM_FORMAT),),
        util::ParagraphStyle::Default,
        config,
    ))
    .add_paragraph(mk_paragraph(
        &format!("Сеанси: {}", row.activity.seances_qty),
        util::ParagraphStyle::Default,
        config,
    ));

    let correspondents = get_processed_correspondence(row.correspondents);
    let correspondents_cell = mk_multiline_text_cell(
        correspondents,
        util::ParagraphStyle::Default,
        config,
    );

    let functionality_details_cell = mk_text_cell(
        &row.functionality_details,
        util::ParagraphStyle::Default,
        config,
    );
    let communication_kind_cell = mk_text_cell(
        &row.communication_kind.unwrap_or("".to_string()),
        util::ParagraphStyle::Default,
        config,
    );
    let mut cells = vec![
        network_cell,
        activity_cell,
        correspondents_cell,
        communication_kind_cell,
        functionality_details_cell,
    ];
    if !no_comments {
        cells.push(mk_bullet_list_cell(row.identified_details, config));
    }
    TableRow::new(cells)
}

fn get_processed_correspondence(
    correspondents: Vec<NetworkCorrespondent>,
) -> Vec<String> {
    let mut result_correspondents = vec![];
    let mut other_correspondents = vec![];
    for c in correspondents {
        let callsign = c.callsign.to_uppercase();
        match c.position {
            Some(unit_name) => {
                result_correspondents.push(format!("{callsign} - {unit_name}"));
            }
            None => other_correspondents.push(callsign),
        }
    }
    result_correspondents.push(other_correspondents.join(", "));
    result_correspondents
}

async fn collect_report(
    messages: Vec<(i64, InboxMessage)>,
    logins: Vec<String>,
    env: &Env,
    dbx: &DatabaseConnection,
    range_khz: f64,
    report_tags_only_this_unit: bool,
    no_comments: bool,
) -> anyhow::Result<Report> {
    let start_collect = Instant::now();
    let message_ids: Vec<i64> = messages.iter().map(|(id, _)| *id).collect();

    let mut comments = BTreeMap::new();
    if no_comments {
        info!("collect_report: skipping comments loading due to no_comments");
    } else {
        info!("collect_report: loading comments from DB");
        let start = Instant::now();
        // Load all comments in a single query if possible, otherwise chunk
        if message_ids.len() <= 20000 {
            let mut query = sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId.eq_any(message_ids),
                )
                .select_only()
                .column(sigint_comment::Column::SignalMessageId)
                .column(sigint_comment::Column::Comment);
            if report_tags_only_this_unit {
                query =
                    query.filter(sigint_comment::Column::Login.eq_any(logins));
            }
            query
                .into_model::<CommentSummary>()
                .all(dbx)
                .await
                .context(h!())?
                .into_iter()
                .for_each(|c| {
                    comments.insert(c.signal_message_id, c.comment);
                });
        } else {
            // For very large datasets, chunk to avoid query size limits
            for ids in message_ids.chunks(20000) {
                let mut query = sigint_comment::Entity::find()
                    .filter(
                        sigint_comment::Column::SignalMessageId
                            .eq_any(ids.to_vec()),
                    )
                    .select_only()
                    .column(sigint_comment::Column::SignalMessageId)
                    .column(sigint_comment::Column::Comment);
                if report_tags_only_this_unit {
                    query = query
                        .filter(sigint_comment::Column::Login.is_in(&logins));
                }
                query
                    .into_model::<CommentSummary>()
                    .all(dbx)
                    .await
                    .context(h!())?
                    .into_iter()
                    .for_each(|c| {
                        comments.insert(c.signal_message_id, c.comment);
                    });
            }
        }
        info!(
            "collect_report: loading comments took: {:?}, count: {}",
            start.elapsed(),
            comments.len()
        );
    }

    let networks = collect_message_networks(&messages, range_khz, dbx)
        .await
        .c(h!())?;

    let mut callsigns_set = HashSet::new();
    for (_id, message) in &messages {
        for c in &message.callsigns {
            callsigns_set.insert(c.clone());
        }
        for c in &message.callsigns_alg2 {
            callsigns_set.insert(c.clone());
        }
    }
    let callsigns = callsigns_set.into_iter().collect_vec();

    info!("collect_report: loading unit_callsigns from DB");
    let start = Instant::now();
    let unit_callsigns = sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintCallsign.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_callsign::Column::Callsign.eq_any(callsigns))
        .filter(
            sigint_network_unit::Column::NetworkId
                .eq_any(networks.list_network_ids()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .select_only()
        .column_as(sigint_network_unit::Column::NetworkId, "network_id")
        .column_as(sigint_unit::Column::Id, "unit_id")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column_as(sigint_callsign::Column::Position, "position")
        .column_as(sigint_callsign::Column::Callsign, "callsign")
        .column(sigint_unit::Column::Id)
        .into_model::<CallsignSummary>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|c| ((c.network_id, c.callsign.clone()), c))
        .collect::<HashMap<_, _>>();
    info!(
        "collect_report: loading unit_callsigns took: {:?}, count: {}",
        start.elapsed(),
        unit_callsigns.len()
    );

    info!("collect_report: processing messages");
    let start = Instant::now();
    let mut network_comments_map = HashMap::new();
    let mut linked_callsigns_map = HashMap::new();
    let mut unlinked_callsigns_map = HashMap::new();
    let mut seances_map = HashMap::new();
    let mut messages = messages;
    messages.sort_by_key(|(_, v)| v.freq.clone().unwrap_or("0.0".to_string()));
    for (id, message) in messages {
        let is_pure_peleng = message.coords.is_some()
            && message.callsign_tokens.unwrap_or(vec![]).is_empty();
        if is_pure_peleng {
            continue;
        }
        let Some(freq) = message.freq.clone() else {
            continue;
        };

        for summary in get_network_summaries_for_message_id(id, &networks) {
            let network_key = (summary.name.clone(), summary.id, freq.clone());

            if let Some(ts) = message.timestamp {
                let mut data =
                    seances_map.remove(&network_key).unwrap_or(vec![]);
                let utc_datetime = DateTime::from_timestamp_millis(ts)
                    .context(h!())?
                    .with_timezone(&crate::config::get_tz())
                    .naive_local();
                data.push(utc_datetime);
                seances_map.insert(network_key.clone(), data);
            }

            let mut data = unlinked_callsigns_map
                .remove(&network_key)
                .unwrap_or(HashSet::new());
            for c in message.callsigns.clone() {
                data.insert(c.clone());
            }
            for c in message.callsigns_alg2.clone() {
                data.insert(c.clone());
            }
            let mut linked_callsigns = vec![];
            for c in data.clone() {
                if let Some(callsign) =
                    unit_callsigns.get(&(summary.id, c.clone()))
                {
                    data.remove(&c);
                    linked_callsigns.push(callsign.clone());
                }
            }
            linked_callsigns_map.insert(network_key.clone(), linked_callsigns);
            unlinked_callsigns_map.insert(network_key, data);
            if let Some(comment) = comments.remove(&id) {
                let mut list =
                    network_comments_map.remove(&summary.id).unwrap_or(vec![]);
                list.push(comment);
                network_comments_map.insert(summary.id, list);
            }
        }
    }
    info!(
        "collect_report: processing messages took: {:?}",
        start.elapsed()
    );

    info!("collect_report: building network rows");
    let start = Instant::now();
    let mut identified_qty = 0;
    let mut unidentified_qty = 0;
    let mut all_hostile_networks = vec![];
    let mut all_undefined_networks = vec![];
    let mut skipped_callsigns = HashSet::<String>::new();
    for (id, network) in networks.list_all_networks() {
        let comments = network_comments_map.remove(&id).unwrap_or(vec![]);
        let keys = seances_map
            .keys()
            .filter(|&(_, id_val, _)| id == *id_val)
            .cloned()
            .collect_vec();
        let seances = seances_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .collect_vec();
        let mut linked_callsigns = linked_callsigns_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        linked_callsigns.sort_by_key(|a| a.callsign.clone());
        let mut unlinked_callsigns = unlinked_callsigns_map
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        unlinked_callsigns.sort();
        let mut freqs = keys
            .into_iter()
            .map(|(_name, _id, freq)| freq)
            .collect_vec();
        if seances.is_empty() {
            continue;
        }
        let since = *seances.iter().min().context(h!())?;
        let till = *seances.iter().max().context(h!())?;
        let seances_qty = seances.len() as u64;
        let mut correspondents = vec![];

        let mut network_name = network.name.clone();
        if network_name.trim().is_empty() {
            network_name = "Радіомережа".to_string();
        }
        let (name, is_defined) = match network.unit_name.clone() {
            None => (format!("{network_name} невизначеного підрозділу"), false),
            Some(unit_name) => (format!("{network_name} {unit_name}"), true),
        };

        let unmapped_network: bool = id < 0;
        if unmapped_network {
            freqs.sort_unstable();
        }
        for c in linked_callsigns {
            correspondents.push(NetworkCorrespondent {
                callsign: c.callsign,
                position: Some(format!("{} {}", c.position, c.unit_name)),
            })
        }
        for c in unlinked_callsigns {
            if !env.callsigns_whitelist.contains(&c)
                && !crate::rer_importer::callsigns::is_numeric_callsign(&c)
            {
                skipped_callsigns.insert(c);
                continue;
            }
            correspondents.push(NetworkCorrespondent {
                callsign: c,
                position: None,
            })
        }
        let activity = NetworkActivity {
            since,
            till,
            seances_qty,
        };
        let location = network
            .location
            .clone()
            .map(|l| l.trim().to_string())
            .map(|l| {
                if l.starts_with("(") {
                    l.replace("(", "").replace(")", "")
                } else {
                    l
                }
            })
            .filter(|l| !l.is_empty());
        let row = NetworkRow {
            name,
            freqs,
            activity,
            correspondents,
            location,
            communication_kind: None,
            functionality_details: FUNCTIONALITY_DESC_DEFAULT.to_string(),
            identified_details: comments,
        };
        if is_defined {
            identified_qty += 1;
            all_hostile_networks.push(row);
        } else {
            all_undefined_networks.push(row);
        }
    }
    info!("collect_report: building network rows took: {:?}, identified: {}, undefined: {}",
          start.elapsed(), all_hostile_networks.len(), all_undefined_networks.len());

    info!("collect_report: sorting and filtering undefined networks");
    let start = Instant::now();
    all_undefined_networks.sort_by_key(|n| n.activity.seances_qty);
    all_undefined_networks.reverse();
    let total_undefined_seances_count: u64 = all_undefined_networks
        .iter()
        .map(|n| n.activity.seances_qty)
        .sum();
    let mut cutoff = (total_undefined_seances_count as f64 * 0.9).ceil() as i64;
    let mut undefined_networks = vec![];
    for n in all_undefined_networks {
        unidentified_qty += 1;
        cutoff -= n.activity.seances_qty as i64;
        undefined_networks.push(n);
        if cutoff < 0 {
            break;
        }
    }
    info!(
        "collect_report: sorting/filtering undefined networks took: {:?}",
        start.elapsed()
    );

    let report = Report {
        summary: ReportSummary {
            identified_qty,
            unidentified_qty,
        },
        undefined_networks,
        hostile_networks: all_hostile_networks,
    };

    debug!(
        "skipped unmapped callsigns: {}",
        skipped_callsigns.into_iter().sorted_unstable().join(", ")
    );

    info!(
        "collect_report completed in total: {:?}",
        start_collect.elapsed()
    );
    Ok(report)
}

async fn filter_messages_by_logins(
    dbx: &DatabaseConnection,
    messages: Vec<(i64, InboxMessage)>,
    logins: &[String],
) -> anyhow::Result<Vec<(i64, InboxMessage)>> {
    let message_ids: Vec<i64> = messages.iter().map(|(id, _)| *id).collect();
    if message_ids.is_empty() {
        return Ok(messages);
    }
    let mut allowed_ids = HashSet::new();
    if message_ids.len() <= 20000 {
        sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq_any(message_ids))
            .filter(sigint_comment::Column::Login.is_in(logins))
            .filter(sigint_comment::Column::Comment.eq("").not())
            .select_only()
            .column(sigint_comment::Column::SignalMessageId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|id| {
                allowed_ids.insert(id);
            });
    } else {
        for ids in message_ids.chunks(20000) {
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq_any(ids.to_vec()),
                )
                .filter(sigint_comment::Column::Login.is_in(logins))
                .filter(sigint_comment::Column::Comment.eq("").not())
                .select_only()
                .column(sigint_comment::Column::SignalMessageId)
                .into_tuple::<i64>()
                .all(dbx)
                .await
                .context(h!())?
                .into_iter()
                .for_each(|id| {
                    allowed_ids.insert(id);
                });
        }
    }
    Ok(messages
        .into_iter()
        .filter(|(id, _)| allowed_ids.contains(id))
        .collect())
}

// We need this merge to enforce report data validation: include records with
// current-unit comments or tags, but exclude those where a current-unit tag is
// paired only with a non-empty comment from another unit.
async fn merge_messages_with_comment_rules(
    dbx: &DatabaseConnection,
    messages: Vec<(i64, InboxMessage)>,
    login: &str,
    logins: &Vec<String>,
    env: &Env,
    req: &super::types::ReportPreviewReq,
) -> anyhow::Result<Vec<(i64, InboxMessage)>> {
    let tag_message_ids: HashSet<i64> =
        messages.iter().map(|(id, _)| *id).collect();
    let mut comment_req = req.req.clone();
    comment_req.report_tags_only_this_unit = Some(false);
    let comment_messages =
        crate::rer_importer::inbox::get_inbox_messages_with_conn(
            dbx,
            login,
            logins,
            env,
            &comment_req,
        )
        .await
        .context(h!())?;
    let comment_messages =
        filter_messages_by_logins(dbx, comment_messages, logins)
            .await
            .context(h!())?;
    let comment_message_ids: HashSet<i64> =
        comment_messages.iter().map(|(id, _)| *id).collect();
    let other_comment_ids =
        message_ids_with_nonempty_comments_from_other_logins(
            dbx,
            &tag_message_ids,
            logins,
        )
        .await
        .context(h!())?;
    let mut merged_messages = HashMap::new();
    for (id, msg) in messages {
        let include = if comment_message_ids.contains(&id) {
            true
        } else {
            !other_comment_ids.contains(&id)
        };
        if include {
            merged_messages.insert(id, msg);
        }
    }
    for (id, msg) in comment_messages {
        merged_messages.entry(id).or_insert(msg);
    }
    Ok(merged_messages.into_iter().collect())
}

async fn message_ids_with_nonempty_comments_from_other_logins(
    dbx: &DatabaseConnection,
    message_ids: &HashSet<i64>,
    logins: &Vec<String>,
) -> anyhow::Result<HashSet<i64>> {
    if message_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let mut other_ids = HashSet::new();
    let message_ids: Vec<i64> = message_ids.iter().copied().collect();
    if message_ids.len() <= 20000 {
        sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq_any(message_ids))
            .filter(sigint_comment::Column::Login.is_not_in(logins))
            .filter(sigint_comment::Column::Comment.eq("").not())
            .select_only()
            .column(sigint_comment::Column::SignalMessageId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .context(h!())?
            .into_iter()
            .for_each(|id| {
                other_ids.insert(id);
            });
    } else {
        for ids in message_ids.chunks(20000) {
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq_any(ids.to_vec()),
                )
                .filter(sigint_comment::Column::Login.is_not_in(logins))
                .filter(sigint_comment::Column::Comment.eq("").not())
                .select_only()
                .column(sigint_comment::Column::SignalMessageId)
                .into_tuple::<i64>()
                .all(dbx)
                .await
                .context(h!())?
                .into_iter()
                .for_each(|id| {
                    other_ids.insert(id);
                });
        }
    }
    Ok(other_ids)
}

async fn collect_message_networks(
    messages: &Vec<(i64, InboxMessage)>,
    range_khz: f64,
    db: &DatabaseConnection,
) -> anyhow::Result<NetworkSummaryData> {
    info!("collect_report: loading all_networks from DB");

    let mut message_to_networks_map = HashMap::<i64, Vec<i64>>::new();
    let mut network_to_messages_map = HashMap::<i64, Vec<i64>>::new();

    for (message_id, message) in messages {
        let Some(network_ids) = &message.network_ids else {
            continue;
        };
        for network_id in network_ids {
            message_to_networks_map
                .entry(*message_id)
                .or_default()
                .push(*network_id);
            network_to_messages_map
                .entry(*network_id)
                .or_default()
                .push(*message_id);
        }
    }

    let sigint_network_ids = message_to_networks_map
        .values()
        .flat_map(|network_ids| network_ids.iter().copied())
        .unique()
        .collect::<Vec<_>>();

    let all_sigint_networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(sigint_network_ids.clone()))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|n| (n.id, n))
        .collect::<HashMap<_, _>>();
    let mut network_unit_names = HashMap::<i64, Vec<String>>::new();
    sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(
            sigint_network_unit::Column::NetworkId
                .is_in(sigint_network_ids.clone()),
        )
        .select_only()
        .column(sigint_network_unit::Column::NetworkId)
        .column(sigint_unit::Column::Name)
        .into_tuple::<(i64, String)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .for_each(|(network_id, unit_name)| {
            network_unit_names
                .entry(network_id)
                .or_default()
                .push(unit_name)
        });

    let network_unit_names = network_unit_names
        .into_iter()
        .map(|(id, names)| (id, names.into_iter().sorted().join(", ")))
        .collect::<HashMap<i64, String>>();

    let mut network_summaries_dictionary: HashMap<
        NetworkSummaryKey,
        NetworkSummary,
    > = HashMap::new();

    let mut messages_without_networks = HashMap::new();
    for (message_id, message) in messages {
        let Some(freq) = &message.freq else {
            continue;
        };
        let Some(message_network_ids) = message_to_networks_map
            .get(message_id)
            .filter(|x| !x.is_empty())
            .cloned()
        else {
            messages_without_networks.insert(*message_id, message.clone());
            continue;
        };
        for network_id in message_network_ids {
            let n_key = NetworkSummaryKey {
                network_id,
                freq: freq.clone(),
                master_key: message.group_master_key.clone(),
            };
            if !network_summaries_dictionary.contains_key(&n_key) {
                let (network_name, network_location) = match all_sigint_networks
                    .get(&network_id)
                {
                    None => ("".to_string(), None),
                    Some(network) => {
                        (network.name.clone(), Some(network.location.clone()))
                    }
                };
                network_summaries_dictionary.insert(
                    n_key,
                    NetworkSummary {
                        id: network_id,
                        name: network_name,
                        location: network_location,
                        freq: freq.clone(),
                        unit_name: network_unit_names.get(&network_id).cloned(),
                        master_key: message.group_master_key.clone(),
                        message_ids: vec![],
                    },
                );
            }
        }
    }

    let network_summaries_dictionary = network_summaries_dictionary
        .into_values()
        .map(|x| (x.id, x))
        .collect();

    let (
        undefined_network_summaries_dictionary,
        message_to_undefined_networks_map,
    ) = process_messages_without_networks(
        range_khz,
        &mut messages_without_networks,
    )
    .c(h!())?;
    Ok(NetworkSummaryData {
        network_summaries_dictionary,
        undefined_network_summaries_dictionary,
        message_to_networks_map,
        message_to_undefined_networks_map,
    })
}

fn process_messages_without_networks(
    range_khz: f64,
    messages_without_networks: &mut HashMap<i64, InboxMessage>,
) -> anyhow::Result<(HashMap<i64, NetworkSummary>, HashMap<i64, Vec<i64>>)> {
    let mut undefined_network_summaries_dictionary =
        HashMap::<i64, NetworkSummary>::new();
    let mut message_to_undefined_networks_map = HashMap::<i64, Vec<i64>>::new();

    let mut unmapped_freqs = HashMap::<String, (i64, f64)>::new();
    let mut new_freq_id = 0;
    for (id, message) in messages_without_networks {
        let Some(freq) = message.freq.clone() else {
            continue;
        };

        let Ok(freq_num) = freq.parse::<f64>() else {
            continue;
        };

        let mut freq_id = None;
        if let Some((id1, _)) = unmapped_freqs.get(&freq) {
            freq_id = Some(*id1);
        }

        if freq_id.is_none() {
            for (id1, f) in unmapped_freqs.values() {
                if ((*f - freq_num).abs()) <= range_khz {
                    freq_id = Some(*id1);
                    break;
                }
            }
        }
        if let Some(freq_id) = freq_id {
            let rec = undefined_network_summaries_dictionary
                .get_mut(&freq_id)
                .context(h!())?;
            rec.message_ids.push(*id);
            message_to_undefined_networks_map
                .entry(*id)
                .or_default()
                .push(freq_id);
            continue;
        }
        let freq_id = new_freq_id;
        new_freq_id += 1;
        unmapped_freqs.insert(freq.clone(), (freq_id, freq_num));
        let new_summary = NetworkSummary {
            id: freq_id,
            name: "".to_string(),
            freq: freq.clone(),
            unit_name: None,
            master_key: None,
            location: None,
            message_ids: vec![*id],
        };
        undefined_network_summaries_dictionary
            .insert(new_summary.id, new_summary.clone());
        message_to_undefined_networks_map
            .entry(*id)
            .or_default()
            .push(new_summary.id);
    }
    Ok((
        undefined_network_summaries_dictionary,
        message_to_undefined_networks_map,
    ))
}

fn get_network_summaries_for_message_id(
    message_id: i64,
    networks: &NetworkSummaryData,
) -> Vec<NetworkSummary> {
    let message_network_ids = networks
        .message_to_networks_map
        .get(&message_id)
        .filter(|s| !s.is_empty());
    if let Some(network_ids) = message_network_ids {
        let mut result = vec![];
        for id in network_ids {
            if let Some(network) = networks.network_summaries_dictionary.get(id)
            {
                result.push(network.clone());
            }
        }
        return result;
    }
    let message_undefined_network_ids = networks
        .message_to_undefined_networks_map
        .get(&message_id)
        .cloned()
        .unwrap_or_default();
    let mut result = vec![];
    for id in message_undefined_network_ids {
        if let Some(network) =
            networks.undefined_network_summaries_dictionary.get(&id)
        {
            result.push(network.clone());
        }
    }
    result
}
