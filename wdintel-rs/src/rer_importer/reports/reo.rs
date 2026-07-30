use super::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::highlight::CNCallsign;
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::rer_importer::types::InboxMessagesReq;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use rust_xlsxwriter::{
    ColNum, ExcelDateTime, Format, FormatAlign, RowNum, Workbook, Worksheet,
};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use serde::de::DeserializeOwned;
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
    pub network_summaries_dictionary:
        HashMap<NetworkSummaryKey, NetworkSummary>,
    pub undefined_network_summaries_dictionary:
        HashMap<NetworkSummaryKey, NetworkSummary>, // virtual "network summaries" for frequencies that do not have associated sigint networks
    pub message_to_networks_map: HashMap<i64, Vec<NetworkSummaryKey>>,
    pub message_to_undefined_networks_map: HashMap<i64, Vec<NetworkSummaryKey>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct NetworkSummary {
    pub key: NetworkSummaryKey,
    pub name: String,
    pub location: Option<String>,
    pub unit_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct NetworkSummaryAggregate {
    pub network_id: Option<i64>,
    pub keys: Vec<NetworkSummaryKey>,
    pub name: String,
    pub location: Option<String>,
    pub unit_name: Option<String>,
}

#[derive(
    Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult, Hash, Eq,
)]
pub struct NetworkSummaryKey {
    pub network_id: Option<i64>, // if None - it's undefined network, not mapped in etalon yet
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

#[derive(Debug, Clone)]
struct ReoInboxMessage {
    pub timestamp: Option<i64>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsigns: Vec<String>,
    pub callsigns_alg2: Vec<String>,
    pub callsign_tokens: Vec<CNCallsign>,
    pub network_ids: Option<Vec<i64>>,
    pub group_master_key: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct ReoInboxMessageRow {
    pub id: i64,
    pub timestamp: Option<NaiveDateTime>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsigns: Option<serde_json::Value>,
    pub callsigns_alg2: Option<serde_json::Value>,
    pub callsign_tokens: Option<serde_json::Value>,
}

#[derive(Debug, FromQueryResult)]
struct ReoGroupKeyRow {
    pub signal_message_id: i64,
    pub group_master_key: Option<String>,
}

fn non_empty_comment_filter() -> SimpleExpr {
    Expr::cust_with_expr(
        "length(trim($1)) > 0",
        Expr::col(sigint_comment::Column::Comment),
    )
}

pub async fn report_docx_kind_reo(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_reo started");

    let start = Instant::now();
    let read_db = env.dbx.clone();
    let login = *user_login;
    let login_ids =
        crate::users::get_organism_login_ids_by_id(&read_db, &login)
            .await
            .context(h!())?;
    info!("get_organism_logins took: {:?}", start.elapsed());

    let start = Instant::now();
    let only_comments_from_current_organism =
        req.report_tags_only_this_unit.unwrap_or(false);
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = Some(false);
    let analytics_req = &current_req;
    let postgres_req = &current_req;
    let messages = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "REO report interception scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &current_req,
        ),
        |db| async move {
            load_reo_inbox_messages(&db, &login, env, analytics_req).await
        },
        |db| async move {
            load_reo_inbox_messages(&db, &login, env, postgres_req).await
        },
    )
    .await
    .context(h!())?;
    info!(
        "load_reo_inbox_messages took: {:?}, messages count: {}",
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
        login_ids.clone(),
        env,
        &read_db,
        range_khz,
        only_comments_from_current_organism,
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
            generate_xlsx_kind_reo(
                report,
                network_summary,
                outpath,
                no_comments,
            )
        }
        _ => generate_docx_kind_reo(
            report,
            network_summary,
            outpath,
            no_comments,
        ),
    };

    info!(
        "report_docx_kind_reo completed in total: {:?}",
        start_total.elapsed()
    );

    result
}

async fn load_reo_inbox_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<(i64, ReoInboxMessage)>, AppError> {
    let rows = crate::rer_importer::inbox::query::build_filtered_inbox_query(
        dbx, login, env, req,
    )
    .await
    .context(h!())?
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(signal_message::Column::Timestamp, "timestamp")
    .column_as(sigint_inbox_item::Column::Freq, "freq")
    .column_as(sigint_inbox_item::Column::Coords, "coords")
    .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
    .column_as(sigint_inbox_item::Column::CallsignsAlg2, "callsigns_alg2")
    .column_as(sigint_inbox_item::Column::CallsignTokens, "callsign_tokens")
    .into_model::<ReoInboxMessageRow>()
    .all(dbx)
    .await
    .context(h!())?;
    let message_ids = rows.iter().map(|row| row.id).collect_vec();
    let mut network_ids_by_message =
        crate::rer_importer::inbox::load_message_networks_by_ids(
            dbx,
            &message_ids,
        )
        .await
        .context(h!())?;
    let mut group_keys_by_message =
        load_reo_group_master_keys(dbx, login, req, &message_ids)
            .await
            .context(h!())?;
    let mut normalized_callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &message_ids).await?;

    rows.into_iter()
        .map(|row| {
            let id = row.id;
            let callsigns = match normalized_callsigns.remove(&id) {
                Some(callsigns) => callsigns,
                None => crate::inbox::callsigns::from_legacy_values(
                    row.callsigns,
                    row.callsigns_alg2,
                )?,
            };
            Ok((
                id,
                ReoInboxMessage {
                    timestamp: row.timestamp.map(|timestamp| {
                        timestamp.and_utc().timestamp_millis()
                    }),
                    freq: row.freq,
                    coords: row.coords,
                    callsigns: callsigns.primary,
                    callsigns_alg2: callsigns.alg2,
                    callsign_tokens: parse_optional_json_vec(
                        row.callsign_tokens,
                    )?,
                    network_ids: network_ids_by_message.remove(&id),
                    group_master_key: group_keys_by_message
                        .remove(&id)
                        .unwrap_or_default(),
                },
            ))
        })
        .collect()
}

async fn load_reo_group_master_keys(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    message_ids: &[i64],
) -> Result<HashMap<i64, Option<String>>, AppError> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .context(h!())?;
    let mut group_keys = HashMap::new();
    for ids in message_ids.chunks(20000) {
        let mut query = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .is_in(ids.to_vec()),
            )
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq_any(sigint_groups.clone()),
            );
        if let Some(selected_groups) = req.selected_groups.as_ref() {
            if !selected_groups.is_empty() {
                query = query.filter(
                    signal_message_group::Column::GroupMasterKey
                        .eq_any(selected_groups.clone()),
                );
            }
        }
        if let Some(selected_senders) = req.selected_senders.as_ref() {
            if !selected_senders.is_empty() {
                query = query.filter(
                    signal_message_group::Column::Sender
                        .eq_any(selected_senders.clone()),
                );
            }
        }
        let rows = query
            .select_only()
            .column(signal_message_group::Column::SignalMessageId)
            .column(signal_message_group::Column::GroupMasterKey)
            .order_by_asc(signal_message_group::Column::SignalMessageId)
            .order_by_asc(signal_message_group::Column::Id)
            .into_model::<ReoGroupKeyRow>()
            .all(dbx)
            .await
            .context(h!())?;
        for row in rows {
            group_keys
                .entry(row.signal_message_id)
                .or_insert(row.group_master_key);
        }
    }
    Ok(group_keys)
}

fn parse_optional_json_vec<T>(
    value: Option<serde_json::Value>,
) -> Result<Vec<T>, AppError>
where
    T: DeserializeOwned,
{
    match value {
        Some(value) => Ok(serde_json::from_value(value).context(h!())?),
        None => Ok(vec![]),
    }
}

fn generate_xlsx_kind_reo(
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

fn generate_docx_kind_reo(
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
    messages: Vec<(i64, ReoInboxMessage)>,
    logins: Vec<uuid::Uuid>,
    env: &Env,
    dbx: &DatabaseConnection,
    range_khz: f64,
    only_comments_from_current_organism: bool,
    no_comments: bool,
) -> anyhow::Result<Report> {
    let start_collect = Instant::now();
    let message_ids: Vec<i64> = messages.iter().map(|(id, _)| *id).collect();

    let mut comments = HashMap::<i64, Vec<String>>::new();
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
                .filter(non_empty_comment_filter())
                .select_only()
                .column(sigint_comment::Column::SignalMessageId)
                .column(sigint_comment::Column::Comment)
                .order_by_asc(sigint_comment::Column::SignalMessageId)
                .order_by_asc(sigint_comment::Column::CreatedAt);
            if only_comments_from_current_organism {
                query = query
                    .filter(sigint_comment::Column::LoginId.eq_any(logins));
            }
            query
                .into_model::<CommentSummary>()
                .all(dbx)
                .await
                .context(h!())?
                .into_iter()
                .for_each(|c| {
                    comments
                        .entry(c.signal_message_id)
                        .or_default()
                        .push(c.comment);
                });
        } else {
            // For very large datasets, chunk to avoid query size limits
            for ids in message_ids.chunks(20000) {
                let mut query = sigint_comment::Entity::find()
                    .filter(
                        sigint_comment::Column::SignalMessageId
                            .eq_any(ids.to_vec()),
                    )
                    .filter(non_empty_comment_filter())
                    .select_only()
                    .column(sigint_comment::Column::SignalMessageId)
                    .column(sigint_comment::Column::Comment)
                    .order_by_asc(sigint_comment::Column::SignalMessageId)
                    .order_by_asc(sigint_comment::Column::CreatedAt);
                if only_comments_from_current_organism {
                    query = query.filter(
                        sigint_comment::Column::LoginId.is_in(logins.clone()),
                    );
                }
                query
                    .into_model::<CommentSummary>()
                    .all(dbx)
                    .await
                    .context(h!())?
                    .into_iter()
                    .for_each(|c| {
                        comments
                            .entry(c.signal_message_id)
                            .or_default()
                            .push(c.comment);
                    });
            }
        }
        let comments_count: usize = comments.values().map(|v| v.len()).sum();
        info!(
            "collect_report: loading comments took: {:?}, count: {}",
            start.elapsed(),
            comments_count
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
    let sigint_network_ids = networks
        .network_summaries_dictionary
        .keys()
        .cloned()
        .flat_map(|x| x.network_id)
        .unique()
        .collect();
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
            sigint_network_unit::Column::NetworkId.eq_any(sigint_network_ids),
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
        let is_pure_peleng =
            message.coords.is_some() && message.callsign_tokens.is_empty();
        if is_pure_peleng {
            continue;
        }

        let networks = get_network_summaries_for_message_id(id, &networks);
        for summary in networks {
            let network_key = summary.key;

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
            if let Some(network_id) = network_key.network_id {
                for c in data.clone() {
                    if let Some(callsign) =
                        unit_callsigns.get(&(network_id, c.clone()))
                    {
                        data.remove(&c);
                        linked_callsigns.push(callsign.clone());
                    }
                }
            }

            linked_callsigns_map.insert(network_key.clone(), linked_callsigns);
            unlinked_callsigns_map.insert(network_key.clone(), data);
            if let Some(message_comments) = comments.get(&id) {
                let mut list =
                    network_comments_map.remove(&network_key).unwrap_or(vec![]);
                list.extend(message_comments.iter().cloned());
                network_comments_map.insert(network_key, list);
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

    let mut aggregate =
        HashMap::<i64, Vec<(NetworkSummaryKey, NetworkSummary)>>::new();
    for (key, n) in networks.network_summaries_dictionary {
        aggregate
            .entry(key.network_id.c(h!())?)
            .or_default()
            .push((key, n));
    }
    let mut aggregated_networks = vec![];
    for (network_id, recs) in aggregate {
        let Some((_, n)) = recs.first().cloned() else {
            continue;
        };
        let keys = recs.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        aggregated_networks.push(NetworkSummaryAggregate {
            network_id: Some(network_id),
            keys,
            name: n.name,
            location: n.location,
            unit_name: n.unit_name,
        });
    }
    for (key, n) in networks.undefined_network_summaries_dictionary {
        aggregated_networks.push(NetworkSummaryAggregate {
            network_id: None,
            keys: vec![key],
            name: n.name,
            location: n.location,
            unit_name: n.unit_name,
        });
    }

    for network in aggregated_networks {
        let comments = network_comments_map
            .iter()
            .filter(|(k, _)| network.keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .collect_vec();
        let seances = seances_map
            .iter()
            .filter(|(k, _)| network.keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .collect_vec();
        let mut linked_callsigns = linked_callsigns_map
            .iter()
            .filter(|(k, _)| network.keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        linked_callsigns.sort_by_key(|a| a.callsign.clone());
        let mut unlinked_callsigns = unlinked_callsigns_map
            .iter()
            .filter(|(k, _)| network.keys.contains(k))
            .flat_map(|(_, v)| v.iter())
            .cloned()
            .unique()
            .collect_vec();
        unlinked_callsigns.sort();
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
        let freqs = network
            .keys
            .iter()
            .map(|k| k.freq.clone())
            .unique()
            .sorted()
            .collect_vec();
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

async fn collect_message_networks(
    messages: &Vec<(i64, ReoInboxMessage)>,
    range_khz: f64,
    db: &DatabaseConnection,
) -> anyhow::Result<NetworkSummaryData> {
    info!("collect_report: loading all_networks from DB");

    let mut message_to_networks_map =
        HashMap::<i64, Vec<NetworkSummaryKey>>::new();
    let mut network_to_messages_map =
        HashMap::<i64, Vec<NetworkSummaryKey>>::new();

    for (message_id, message) in messages {
        let Some(network_ids) = &message.network_ids else {
            continue;
        };
        let Some(freq) = message.freq.clone() else {
            continue;
        };
        for network_id in network_ids {
            let key = NetworkSummaryKey {
                network_id: Some(*network_id),
                freq: freq.clone(),
                master_key: message.group_master_key.clone(),
            };
            message_to_networks_map
                .entry(*message_id)
                .or_default()
                .push(key.clone());
            network_to_messages_map
                .entry(*network_id)
                .or_default()
                .push(key.clone());
        }
    }

    let sigint_network_ids = message_to_networks_map
        .values()
        .flat_map(|network_ids| network_ids.iter().clone())
        .flat_map(|x| x.network_id)
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
        let Some(message_network_ids) = message_to_networks_map
            .get(message_id)
            .filter(|x| !x.is_empty())
            .cloned()
        else {
            messages_without_networks.insert(*message_id, message.clone());
            continue;
        };
        for key in message_network_ids {
            network_summaries_dictionary
                .entry(key.clone())
                .or_insert_with(|| {
                    let (network_name, network_location) =
                        match key.network_id.and_then(|network_id| {
                            all_sigint_networks.get(&network_id)
                        }) {
                            None => ("".to_string(), None),
                            Some(network) => (
                                network.name.clone(),
                                Some(network.location.clone()),
                            ),
                        };
                    let unit_name = key
                        .network_id
                        .and_then(|network_id| {
                            network_unit_names.get(&network_id)
                        })
                        .cloned();
                    NetworkSummary {
                        key,
                        unit_name,
                        name: network_name,
                        location: network_location,
                    }
                });
        }
    }

    let network_summaries_dictionary = network_summaries_dictionary
        .into_values()
        .map(|x| (x.key.clone(), x))
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
    messages_without_networks: &mut HashMap<i64, ReoInboxMessage>,
) -> anyhow::Result<(
    HashMap<NetworkSummaryKey, NetworkSummary>,
    HashMap<i64, Vec<NetworkSummaryKey>>,
)> {
    let mut undefined_network_summaries_dictionary =
        HashMap::<NetworkSummaryKey, NetworkSummary>::new();
    let mut message_to_undefined_networks_map =
        HashMap::<i64, Vec<NetworkSummaryKey>>::new();

    let mut unmapped_freqs = HashMap::<String, f64>::new();
    for (id, message) in messages_without_networks {
        let Some(freq) = message.freq.clone() else {
            continue;
        };

        let Ok(freq_num) = freq.parse::<f64>() else {
            continue;
        };

        let mut freq_val = None;
        if let Some(f) = unmapped_freqs.get(&freq) {
            freq_val = Some(*f);
        } else {
            for f in unmapped_freqs.values() {
                if ((*f - freq_num).abs()) <= range_khz {
                    freq_val = Some(*f);
                    break;
                }
            }
        }

        let key = NetworkSummaryKey {
            network_id: None,
            freq: freq.clone(),
            master_key: message.group_master_key.clone(),
        };

        if freq_val.is_some() {
            let n_key = NetworkSummaryKey {
                network_id: None,
                freq: freq.clone(),
                master_key: message.group_master_key.clone(),
            };
            message_to_undefined_networks_map
                .entry(*id)
                .or_default()
                .push(n_key);
            continue;
        }
        unmapped_freqs.insert(freq.clone(), freq_num);
        let new_summary = NetworkSummary {
            key: key.clone(),
            name: "".to_string(),
            unit_name: None,
            location: None,
        };
        undefined_network_summaries_dictionary
            .insert(key.clone(), new_summary.clone());
        message_to_undefined_networks_map
            .entry(*id)
            .or_default()
            .push(key);
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
    for key in message_undefined_network_ids {
        if let Some(network) =
            networks.undefined_network_summaries_dictionary.get(&key)
        {
            result.push(network.clone());
        }
    }
    result
}
