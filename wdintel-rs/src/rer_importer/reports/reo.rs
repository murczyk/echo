use super::types::*;
use crate::config::RER_REPORT_ENRICHMENT_ID_BATCH_SIZE;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::highlight::CNCallsign;
use crate::rer_importer::report_chunking::{
    build_filtered_inbox_report_chunk_query, inbox_report_chunk_req,
    inbox_report_period_chunks, ReportPeriodChunk, ReportPeriodEnd,
};
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::*;
use crate::rer_importer::types::InboxMessagesReq;
use crate::sigint::sender::preferred_group_sender_expr;
use crate::types::*;
use anyhow::Context;
use chrono::prelude::*;
use docx_rs::*;
use rust_xlsxwriter::{
    ColNum, ExcelDateTime, Format, FormatAlign, RowNum, Workbook, Worksheet,
};
use sea_orm::{sea_query::Alias, *};
use serde::de::DeserializeOwned;
use std::collections::*;
use std::path::Path;
use std::time::Instant;

mod summary;

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

#[derive(Clone, Debug)]
pub struct NetworkActivity {
    pub since: NaiveDateTime,
    pub till: NaiveDateTime,
    pub seances_qty: u64,
}

impl NetworkActivity {
    fn merge(&mut self, other: &Self) {
        self.since = std::cmp::min(self.since, other.since);
        self.till = std::cmp::max(self.till, other.till);
        self.seances_qty += other.seances_qty;
    }
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

#[derive(Debug, Clone)]
struct ReoInboxMessage {
    activity: Option<NetworkActivity>,
    pub timestamp: Option<i64>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsigns: Vec<String>,
    pub callsigns_alg2: Vec<String>,
    pub callsign_tokens: Vec<CNCallsign>,
    pub network_ids: Option<Vec<i64>>,
    pub group_master_key: Option<String>,
}

impl ReoInboxMessage {
    fn activity_summary(&self) -> anyhow::Result<Option<NetworkActivity>> {
        if let Some(activity) = &self.activity {
            return Ok(Some(activity.clone()));
        }
        let Some(timestamp) = self.timestamp else {
            return Ok(None);
        };
        let timestamp = DateTime::from_timestamp_millis(timestamp)
            .context(h!())?
            .with_timezone(&crate::config::get_tz())
            .naive_local();
        Ok(Some(NetworkActivity {
            since: timestamp,
            till: timestamp,
            seances_qty: 1,
        }))
    }
}

#[derive(Debug, FromQueryResult)]
struct ReoInboxMessageRow {
    pub id: i64,
    pub timestamp: Option<NaiveDateTime>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsign_tokens: Option<serde_json::Value>,
}

#[derive(Debug, FromQueryResult)]
struct ReoGroupKeyRow {
    pub signal_message_id: i64,
    pub group_master_key: Option<String>,
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
    let (range_khz, no_comments, summary_only) = match req.report_type {
        Some(ReportType::Reo(
            ReoReportSettings {
                adjacent_freqs_distance,
                no_comments,
                summary_only,
            },
            _,
        )) => (adjacent_freqs_distance * 1000.0, no_comments, summary_only),
        _ => (0.0, false, false),
    };
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = Some(false);
    let messages = load_reo_report_messages(
        &login,
        env,
        &current_req,
        summary_only,
        no_comments,
        only_comments_from_current_organism,
    )
    .await
    .context(h!())?;
    info!(
        "load_reo_inbox_messages took: {:?}, messages count: {}",
        start.elapsed(),
        messages.len()
    );

    let start = Instant::now();
    let mut report = collect_report(
        messages,
        login_ids.clone(),
        env,
        &read_db,
        range_khz,
        &current_req.selected_aors,
        only_comments_from_current_organism,
        no_comments || summary_only,
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
    let record_count = report
        .hostile_networks
        .len()
        .saturating_add(report.undefined_networks.len());
    crate::report_history::ensure_report_record_count(record_count)
        .context(h!())?;
    info!("sorting networks took: {:?}", start.elapsed());

    let network_summary_total =
        report.summary.identified_qty + report.summary.unidentified_qty;
    let network_summary = format!(
        "Відмічено радіомереж (радіонапрямків): {} (визначені - {}, не визначено - {})",
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
                summary_only,
            )
        }
        _ => generate_docx_kind_reo(
            report,
            network_summary,
            outpath,
            no_comments,
            summary_only,
        ),
    };

    info!(
        "report_docx_kind_reo completed in total: {:?}",
        start_total.elapsed()
    );

    result
}

async fn load_reo_report_messages(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    summary_only: bool,
    no_comments: bool,
    only_comments_from_current_organism: bool,
) -> anyhow::Result<Vec<(i64, ReoInboxMessage)>> {
    if summary_only {
        return summary::load_summary_messages(
            login,
            env,
            req,
            no_comments,
            only_comments_from_current_organism,
        )
        .await
        .context(h!());
    }
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(req, report_settings.chunking_hours)
            .context(h!())?;
    let chunks = &chunks;
    let mut outcome =
        crate::rer_importer::analysis::with_analytics_read_fallback_outcome(
            env,
            "REO report interception scan",
            crate::rer_importer::analysis::analytics_inbox_request_supported(
                req,
            ),
            |db| async move {
                let mut messages = load_reo_inbox_messages_chunks(
                    &db, login, env, req, chunks,
                )
                .await
                .context(h!())?;
                load_reo_analytics_message_networks(&db, &mut messages)
                    .await
                    .context(h!())?;
                Ok(messages)
            },
            |db| async move {
                load_reo_inbox_messages_chunks(&db, login, env, req, chunks)
                    .await
            },
        )
        .await
        .context(h!())?;
    if outcome.postgres_reason.is_some() {
        load_reo_message_networks(&env.dbx, &mut outcome.value)
            .await
            .context(h!())?;
    }
    Ok(outcome.value)
}

async fn load_reo_analytics_message_networks(
    dbx: &DatabaseConnection,
    messages: &mut [(i64, ReoInboxMessage)],
) -> anyhow::Result<()> {
    for messages in messages.chunks_mut(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE) {
        let message_ids = messages.iter().map(|(id, _)| *id).collect_vec();
        let links = sigint_inbox_item_network::Entity::find()
            .select_only()
            .column(sigint_inbox_item_network::Column::SigintInboxItemId)
            .column(sigint_inbox_item_network::Column::SigintNetworkId)
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .is_in(message_ids),
            )
            .into_tuple::<(i64, i64)>()
            .all(dbx)
            .await
            .c(h!())?;
        let mut network_ids_by_message = HashMap::<i64, Vec<i64>>::new();
        for (message_id, network_id) in links {
            network_ids_by_message
                .entry(message_id)
                .or_default()
                .push(network_id);
        }
        for (id, message) in messages {
            message.network_ids =
                Some(network_ids_by_message.remove(id).context(h!())?);
        }
    }
    Ok(())
}

async fn load_reo_message_networks(
    dbx: &DatabaseConnection,
    messages: &mut [(i64, ReoInboxMessage)],
) -> anyhow::Result<()> {
    for messages in messages.chunks_mut(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE) {
        let message_ids = messages.iter().map(|(id, _)| *id).collect_vec();
        let mut network_ids_by_message =
            crate::rer_importer::inbox::load_message_networks_by_ids(
                dbx,
                &message_ids,
            )
            .await
            .context(h!())?;
        for (id, message) in messages {
            message.network_ids = network_ids_by_message.remove(id);
        }
    }
    Ok(())
}

async fn load_reo_inbox_messages_chunks(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    chunks: &[ReportPeriodChunk],
) -> Result<Vec<(i64, ReoInboxMessage)>, AppError> {
    let mut messages = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "REO report chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        for (id, message) in
            load_reo_inbox_messages(dbx, login, env, &chunk_req, chunk.end)
                .await
                .context(h!())?
        {
            messages.entry(id).or_insert(message);
        }
    }
    Ok(messages.into_iter().collect())
}

async fn load_reo_inbox_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Vec<(i64, ReoInboxMessage)>, AppError> {
    let rows = build_filtered_inbox_report_chunk_query(
        dbx, login, env, req, period_end,
    )
    .await
    .context(h!())?
    .filter(
        signal_message::Column::Id.not_in_subquery(
            intel_product::Entity::find()
                .select_only()
                .column(intel_product::Column::IntelMessageId)
                .filter(crate::rer_importer::intel_product_filter::relation_kind_is_in([
                    crate::rer_importer::intel_product_filter::RELATION_KIND_COMMENT,
                    crate::rer_importer::intel_product_filter::RELATION_KIND_REPORT,
                ]))
                .into_query(),
        ),
    )
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(signal_message::Column::Timestamp, "timestamp")
    .column_as(sigint_inbox_item::Column::Freq, "freq")
    .column_as(sigint_inbox_item::Column::Coords, "coords")
    .column_as(sigint_inbox_item::Column::CallsignTokens, "callsign_tokens")
    .into_model::<ReoInboxMessageRow>()
    .all(dbx)
    .await
    .context(h!())?;
    let message_ids = rows.iter().map(|row| row.id).collect_vec();
    let mut group_keys_by_message =
        load_reo_group_master_keys(dbx, login, req, &message_ids)
            .await
            .context(h!())?;
    let mut normalized_callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &message_ids).await?;

    rows.into_iter()
        .map(|row| {
            let id = row.id;
            let callsigns =
                normalized_callsigns.remove(&id).unwrap_or_default();
            Ok((
                id,
                ReoInboxMessage {
                    activity: None,
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
                    network_ids: None,
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
                    preferred_group_sender_expr(None)
                        .is_in(selected_senders.clone()),
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
    summary_only: bool,
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
    ];
    if !summary_only {
        headers.push(("Склад кореспондентів радіомережі та приналежність", 30));
    }
    headers.extend([
        ("Характер радіообміну", 30),
        ("Особливості функціонування радіомереж", 30),
    ]);
    if !no_comments && !summary_only {
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
            summary_only,
        )
        .c(h!())?;
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
            summary_only,
        )
        .c(h!())?;
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
    summary_only: bool,
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

    if !summary_only {
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
    }

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

    if !no_comments && !summary_only {
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
    summary_only: bool,
) -> Result<(), AppError> {
    let start = Instant::now();
    let config = DocxConfig {
        columns_count: if summary_only {
            4
        } else if no_comments {
            5
        } else {
            6
        },
        width_unit: WIDTH_UNIT,
        highlight_color: "FF0000".to_string(),
        split_multiline_cells: true,
        paragraph_spacing: Some(80),
    };

    let mut rows_amrp: Vec<TableRow> = vec![];
    let mut header_cells = vec![
        mk_header_cell("Назва радіомережі", &config),
        mk_header_cell("Час роботи радіомережі", &config),
    ];
    if !summary_only {
        header_cells.push(mk_header_cell(
            "Склад кореспондентів радіомережі та приналежність",
            &config,
        ));
    }
    header_cells.extend([
        mk_header_cell("Характер радіообміну", &config),
        mk_header_cell("Особливості функціонування радіомереж", &config),
    ]);
    if !no_comments && !summary_only {
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
        rows_amrp.push(render_network_row(
            e,
            &config,
            no_comments,
            summary_only,
        ));
    }
    rows_amrp.push(TableRow::new(vec![mk_merged_text_cell(
        "Невизначені",
        false,
        util::ParagraphStyle::Default,
        &config,
    )]));
    for e in report.undefined_networks {
        rows_amrp.push(render_network_row(
            e,
            &config,
            no_comments,
            summary_only,
        ));
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
    let file = std::fs::File::create(outpath).c(h!())?;
    docx.build().pack(file).context(h!())?;
    info!("writing docx to file took: {:?}", start.elapsed());

    Ok(())
}

fn render_network_row(
    row: NetworkRow,
    config: &DocxConfig,
    no_comments: bool,
    summary_only: bool,
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
    let mut cells = vec![network_cell, activity_cell];
    if !summary_only {
        cells.push(mk_multiline_text_cell(
            get_processed_correspondence(row.correspondents),
            util::ParagraphStyle::Default,
            config,
        ));
    }
    cells.extend([communication_kind_cell, functionality_details_cell]);
    if !no_comments && !summary_only {
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
    selected_aors: &Option<Vec<i64>>,
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
        for ids in message_ids.chunks(20000) {
            let report_comments =
                crate::sigint::comments::find_report_comments(
                    dbx,
                    ids,
                    only_comments_from_current_organism
                        .then_some(logins.as_slice()),
                )
                .await
                .context(h!())?;
            for comment in report_comments {
                if comment.comment.trim().is_empty() {
                    continue;
                }
                comments
                    .entry(comment.source_message_id)
                    .or_default()
                    .push(comment.comment);
            }
        }
        let comments_count: usize = comments.values().map(|v| v.len()).sum();
        info!(
            "collect_report: loading comments took: {:?}, count: {}",
            start.elapsed(),
            comments_count
        );
    }

    let networks =
        collect_message_networks(&messages, range_khz, selected_aors, dbx)
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
    let sigint_network_ids: Vec<i64> = networks
        .network_summaries_dictionary
        .keys()
        .cloned()
        .flat_map(|x| x.network_id)
        .unique()
        .collect();
    let unit_callsigns = if callsigns.is_empty() {
        HashMap::new()
    } else {
        sigint_unit::Entity::find()
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
                    .eq_any(sigint_network_ids),
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
            .collect::<HashMap<_, _>>()
    };
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
    let mut seances_map = HashMap::<NetworkSummaryKey, NetworkActivity>::new();
    let mut messages = messages;
    messages.sort_by_key(|(_, v)| v.freq.clone().unwrap_or("0.0".to_string()));
    for (id, message) in messages {
        let is_pure_peleng =
            message.coords.is_some() && message.callsign_tokens.is_empty();
        let has_comments = comments.contains_key(&id);
        if is_pure_peleng && !has_comments {
            continue;
        }

        let networks = get_network_summaries_for_message_id(id, &networks);
        let activity = message.activity_summary().c(h!())?;
        for summary in networks {
            let network_key = summary.key;

            if let Some(activity) = &activity {
                seances_map
                    .entry(network_key.clone())
                    .and_modify(|total| total.merge(activity))
                    .or_insert_with(|| activity.clone());
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
        let activity = seances_map
            .iter()
            .filter(|(k, _)| network.keys.contains(k))
            .map(|(_, activity)| activity.clone())
            .reduce(|mut total, activity| {
                total.merge(&activity);
                total
            });
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
        let Some(activity) = activity else {
            continue;
        };
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
    info!(
        "collect_report: building network rows took: {:?}, identified: {}, undefined: {}",
        start.elapsed(),
        all_hostile_networks.len(),
        all_undefined_networks.len()
    );

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
    selected_aors: &Option<Vec<i64>>,
    db: &DatabaseConnection,
) -> anyhow::Result<NetworkSummaryData> {
    info!("collect_report: loading all_networks from DB");

    let selected_aor_network_ids =
        load_network_ids_in_selected_aors(messages, selected_aors, db)
            .await
            .c(h!())?;

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
            if selected_aor_network_ids
                .as_ref()
                .is_some_and(|allowed| !allowed.contains(network_id))
            {
                continue;
            }
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
            if !message
                .network_ids
                .as_ref()
                .is_some_and(|network_ids| !network_ids.is_empty())
            {
                messages_without_networks.insert(*message_id, message.clone());
            }
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

async fn load_network_ids_in_selected_aors(
    messages: &[(i64, ReoInboxMessage)],
    selected_aors: &Option<Vec<i64>>,
    db: &DatabaseConnection,
) -> anyhow::Result<Option<HashSet<i64>>> {
    let linked_aor_alias = Alias::new("reo_network_aor_filter");
    let Some(condition) =
        crate::rer_importer::analysis::selected_aor_overlap_condition(
            linked_aor_alias.clone(),
            selected_aors,
        )
    else {
        return Ok(None);
    };

    let network_ids = messages
        .iter()
        .flat_map(|(_, message)| message.network_ids.iter().flatten().copied())
        .unique()
        .collect_vec();
    let mut allowed_network_ids = HashSet::new();
    for network_ids in network_ids.chunks(RER_REPORT_ENRICHMENT_ID_BATCH_SIZE) {
        allowed_network_ids.extend(
            sigint_network_aor::Entity::find()
                .join_as(
                    JoinType::InnerJoin,
                    sigint_network_aor::Relation::AreaOfResponsibility.def(),
                    linked_aor_alias.clone(),
                )
                .filter(
                    sigint_network_aor::Column::NetworkId
                        .is_in(network_ids.to_vec()),
                )
                .filter(condition.clone())
                .select_only()
                .column(sigint_network_aor::Column::NetworkId)
                .distinct()
                .into_tuple::<i64>()
                .all(db)
                .await
                .c(h!())?,
        );
    }
    Ok(Some(allowed_network_ids))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, cleanup_locked, find_test_aor, find_test_datasource_group,
        find_test_login, mk_aor, mk_sigint_inbox_item, mk_sigint_network,
        mk_sigint_network_aor, mk_sigint_network_freq, mk_signal_message,
        mk_signal_message_group,
    };
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    async fn mk_reo_test_aor(
        db: &DatabaseConnection,
        name: &str,
        left_bound: f64,
        right_bound: f64,
        now: NaiveDateTime,
    ) -> anyhow::Result<area_of_responsibility::Model> {
        mk_aor(
            db,
            area_of_responsibility::ActiveModel {
                name: Set(name.to_string()),
                left_bound: Set(left_bound),
                right_bound: Set(right_bound),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())
    }

    async fn mk_reo_test_network(
        db: &DatabaseConnection,
        aor_id: i64,
        now: NaiveDateTime,
    ) -> anyhow::Result<sigint_network::Model> {
        let network = mk_sigint_network(
            db,
            sigint_network::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        mk_sigint_network_aor(
            db,
            sigint_network_aor::ActiveModel {
                network_id: Set(network.id),
                aor_id: Set(aor_id),
                created_at: Set(now),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        Ok(network)
    }

    fn reo_test_message(
        now: NaiveDateTime,
        network_ids: Option<Vec<i64>>,
    ) -> ReoInboxMessage {
        ReoInboxMessage {
            activity: None,
            timestamp: Some(now.and_utc().timestamp_millis()),
            freq: Some("1000".to_string()),
            coords: None,
            callsigns: Vec::new(),
            callsigns_alg2: Vec::new(),
            callsign_tokens: Vec::new(),
            network_ids,
            group_master_key: None,
        }
    }

    async fn mk_reo_test_inbox_message(
        db: &DatabaseConnection,
        group: &datasource_group::Model,
        now: NaiveDateTime,
        freq: &str,
    ) -> anyhow::Result<signal_message::Model> {
        let message = mk_signal_message(
            db,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(group.id)),
                timestamp: Set(Some(now)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        mk_signal_message_group(
            db,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.group_master_key.clone())),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(now)),
                freq: Set(Some(freq.to_string())),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        Ok(message)
    }

    #[tokio::test]
    #[serial]
    async fn reo_keeps_analytics_rows_and_networks_together_3780(
    ) -> anyhow::Result<()> {
        let (env, _guard) = cleanup_locked().await.context(h!())?;
        let db = &env.dbx;
        let login = find_test_login(db).await.context(h!())?;
        let group = find_test_datasource_group(db).await.context(h!())?;
        let aor = find_test_aor(db).await.context(h!())?;
        let now = Utc::now().naive_utc();
        let earlier = now - chrono::Duration::minutes(1);
        let old_network =
            mk_reo_test_network(db, aor.id, now).await.context(h!())?;
        let new_network =
            mk_reo_test_network(db, aor.id, now).await.context(h!())?;
        let updated =
            mk_reo_test_inbox_message(db, &group, earlier, "146.4500")
                .await
                .context(h!())?;
        let deleted =
            mk_reo_test_inbox_message(db, &group, earlier, "146.4500")
                .await
                .context(h!())?;
        for message_id in [updated.id, deleted.id] {
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message_id),
                sigint_network_id: Set(old_network.id),
                created_at: Set(now),
                ..Default::default()
            }
            .insert(db)
            .await
            .c(h!())?;
        }
        let analytics =
            crate::new_pg_pool_from_conn_string_with_max_connections(
                crate::mk_conn_string(&env.config),
                1,
            )
            .await
            .c(h!())?;
        analytics
            .execute_unprepared(
                r#"
BEGIN;
CREATE VIEW public.echo_analytics_health AS
    SELECT true AS singleton, true AS healthy,
           CURRENT_TIMESTAMP AS checked_at;
CREATE TEMP TABLE signal_message AS TABLE public.signal_message;
CREATE TEMP TABLE sigint_inbox_item AS TABLE public.sigint_inbox_item;
CREATE TEMP TABLE sigint_inbox_item_network AS TABLE public.sigint_inbox_item_network;
"#,
            )
            .await
            .c(h!())?;
        signal_message::ActiveModel {
            id: Set(updated.id),
            timestamp: Set(Some(now)),
            ..Default::default()
        }
        .update(db)
        .await
        .c(h!())?;
        sigint_inbox_item::ActiveModel {
            id: Set(updated.id),
            freq: Set(Some("155.5000".to_string())),
            ..Default::default()
        }
        .update(db)
        .await
        .c(h!())?;
        sigint_inbox_item_network::Entity::update_many()
            .col_expr(
                sigint_inbox_item_network::Column::SigintNetworkId,
                sea_query::Expr::value(new_network.id),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(updated.id),
            )
            .exec(db)
            .await
            .c(h!())?;
        signal_message::ActiveModel {
            id: Set(deleted.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(db)
        .await
        .c(h!())?;
        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(deleted.id),
            )
            .exec(db)
            .await
            .c(h!())?;
        let mut env = env.as_ref().clone();
        env.analytics = Some(crate::types::AnalyticsPool {
            conn: analytics.clone(),
            retry_after_unix_ms_by_operation: Default::default(),
        });
        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(
                (earlier - chrono::Duration::minutes(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            till_date_inclusive_ms: Some(
                (now + chrono::Duration::minutes(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            nolimit: Some(true),
            ..Default::default()
        };
        let stale =
            load_reo_report_messages(&login.id, &env, &req, false, true, false)
                .await;
        analytics
            .execute_unprepared("DELETE FROM sigint_inbox_item_network")
            .await
            .c(h!())?;
        let fallback =
            load_reo_report_messages(&login.id, &env, &req, false, true, false)
                .await;
        analytics.execute_unprepared("ROLLBACK").await.c(h!())?;
        let stale = stale.context(h!())?;
        assert_eq!(stale.len(), 2);
        for (_, message) in stale {
            assert_eq!(message.freq.as_deref(), Some("146.4500"));
            assert_eq!(
                message.timestamp,
                Some(earlier.and_utc().timestamp_millis())
            );
            assert_eq!(message.network_ids, Some(vec![old_network.id]));
        }
        let fallback = fallback.context(h!())?;
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].0, updated.id);
        assert_eq!(fallback[0].1.freq.as_deref(), Some("155.5000"));
        assert_eq!(
            fallback[0].1.timestamp,
            Some(now.and_utc().timestamp_millis())
        );
        assert_eq!(fallback[0].1.network_ids, Some(vec![new_network.id]));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn reo_read_only_scan_backfills_networks_on_primary_3780(
    ) -> anyhow::Result<()> {
        let env = cleanup().await.context(h!())?;
        let db = &env.dbx;
        let login = find_test_login(db).await.context(h!())?;
        let group = find_test_datasource_group(db).await.context(h!())?;
        let aor = find_test_aor(db).await.context(h!())?;
        let now = Utc::now().naive_utc();
        let network =
            mk_reo_test_network(db, aor.id, now).await.context(h!())?;
        mk_sigint_network_freq(
            db,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.4500".to_string()),
                active_from: Set(now - chrono::Duration::days(1)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
        let matched = mk_reo_test_inbox_message(db, &group, now, "146.4500")
            .await
            .context(h!())?;
        let unmatched = mk_reo_test_inbox_message(db, &group, now, "999.0000")
            .await
            .context(h!())?;
        assert_eq!(
            sigint_inbox_item_network::Entity::find()
                .count(db)
                .await
                .context(h!())?,
            0
        );

        let mut options =
            ConnectOptions::new(crate::mk_conn_string(&env.config));
        options.map_sqlx_postgres_opts(|options| {
            options.options([("default_transaction_read_only", "on")])
        });
        let analytics = Database::connect(options).await.context(h!())?;
        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(
                (now - chrono::Duration::minutes(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            till_date_inclusive_ms: Some(
                (now + chrono::Duration::minutes(1))
                    .and_utc()
                    .timestamp_millis(),
            ),
            nolimit: Some(true),
            ..Default::default()
        };
        let messages = load_reo_inbox_messages(
            &analytics,
            &login.id,
            &env,
            &req,
            ReportPeriodEnd::Inclusive,
        )
        .await
        .context(h!())?;
        assert_eq!(messages.len(), 2);
        assert!(messages
            .iter()
            .all(|(_, message)| message.network_ids.is_none()));
        assert_eq!(
            sigint_inbox_item_network::Entity::find()
                .count(db)
                .await
                .context(h!())?,
            0
        );

        for _ in 0..2 {
            let messages = load_reo_report_messages(
                &login.id, &env, &req, false, true, false,
            )
            .await
            .context(h!())?;
            assert_eq!(messages.len(), 2);
            assert_eq!(
                messages
                    .iter()
                    .find(|(id, _)| *id == matched.id)
                    .context(h!())?
                    .1
                    .network_ids,
                Some(vec![network.id])
            );
            assert_eq!(
                messages
                    .iter()
                    .find(|(id, _)| *id == unmatched.id)
                    .context(h!())?
                    .1
                    .network_ids,
                None
            );
            let links = sigint_inbox_item_network::Entity::find()
                .all(db)
                .await
                .context(h!())?;
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].sigint_inbox_item_id, matched.id);
            assert_eq!(links[0].sigint_network_id, network.id);
        }
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn reo_report_excludes_networks_from_other_aors() -> anyhow::Result<()>
    {
        let env = cleanup().await.context(h!())?;
        let db = &env.dbx;
        let selected_aor = find_test_aor(db).await.context(h!())?;
        let now = Utc::now().naive_utc();
        let nested_aor = mk_reo_test_aor(db, "Nested REO AOR", 10.0, 20.0, now)
            .await
            .context(h!())?;
        let other_aor = mk_reo_test_aor(db, "Other REO AOR", 200.0, 300.0, now)
            .await
            .context(h!())?;
        let selected_network = mk_reo_test_network(db, nested_aor.id, now)
            .await
            .context(h!())?;
        let other_network = mk_reo_test_network(db, other_aor.id, now)
            .await
            .context(h!())?;
        let messages = vec![
            (
                1,
                reo_test_message(
                    now,
                    Some(vec![selected_network.id, other_network.id]),
                ),
            ),
            (2, reo_test_message(now, Some(vec![other_network.id]))),
            (3, reo_test_message(now, None)),
        ];

        let networks = collect_message_networks(
            &messages,
            0.0,
            &Some(vec![selected_aor.id]),
            db,
        )
        .await
        .context(h!())?;

        let message_network_ids = networks
            .message_to_networks_map
            .get(&1)
            .context(h!())?
            .iter()
            .filter_map(|key| key.network_id)
            .collect_vec();
        assert_eq!(message_network_ids, vec![selected_network.id]);
        assert!(!networks.message_to_networks_map.contains_key(&2));
        assert!(!networks.message_to_undefined_networks_map.contains_key(&2));
        assert!(networks.message_to_undefined_networks_map.contains_key(&3));
        Ok(())
    }
}
