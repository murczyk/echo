use crate::entities::{
    datasource, intel_product, sigint_inbox_item, sigint_peleng, signal_message,
};
use crate::error::AppError;
use crate::location::peleng::inbox_item_has_active_peleng_exists;
use crate::rer_importer::report_chunking::{
    build_filtered_inbox_report_chunk_query, inbox_report_chunk_req,
    inbox_report_period_chunks, ReportPeriodEnd,
};
use crate::rer_importer::reports::inbox_light::load_message_group_info;
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::types::*;
use crate::utils::dt_zoned_from_millis;
use anyhow::Context;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
    RunFonts, Table, TableCell, TableRow, VAlignType, WidthType,
};
use geoconvert::{LatLon, Mgrs};
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const DOCX_FONT: &str = "Times New Roman";
const DOCX_FONT_SIZE: usize = 24;
const DOCX_PAGE_WIDTH: u32 = 11906;
const DOCX_PAGE_HEIGHT: u32 = 16838;
const DOCX_PAGE_MARGIN: i32 = 600;

const REPORT_125_FORM: &str = "Форма № 1.2.5  /ГУР";
const REPORT_125_TITLE: &str = "Донесення за результатами функціонування тактичної радіопеленгаторної мережі у зоні відповідальності УОС (УВ (с), УСіЗ)";
const REPORT_125_SECTION_TITLE: &str =
    "Результати визначення місцеположення джерел (об’єктів) розвідки.";
const REPORT_125_FOOTER: &str = "Начальник ОВУР";

const CELL_NUM_WIDTH: usize = 600;
const CELL_DATETIME_WIDTH: usize = 2380;
const CELL_MGRS_WIDTH: usize = 2620;
const CELL_TYPE_WIDTH: usize = 2020;
const CELL_RECON_WIDTH: usize = 1540;
const CELL_STRIKE_WIDTH: usize = 1540;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Report125Data {
    rows: Vec<Report125Row>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Report125Row {
    inbox_item_id: i64,
    peleng_id: i64,
    datetime: NaiveDateTime,
    mgrs: String,
    rls_type: String,
}

#[derive(Debug, Clone, FromQueryResult)]
struct Report125MessageRow {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    date: Option<String>,
    time: Option<String>,
    datetime: Option<NaiveDateTime>,
    unit: Option<String>,
}

#[derive(Debug, Clone)]
struct Report125Message {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    date: Option<String>,
    time: Option<String>,
    datetime: Option<NaiveDateTime>,
    unit: Option<String>,
    datasource_id: Option<i64>,
}

pub async fn report_docx_kind_report_125(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let (read_db, replica_label) = env.replica_with_label();
    match replica_label {
        Some(label) => info!("Report 1.2.5 using replica {label}"),
        None => info!("Report 1.2.5 using primary database"),
    }

    let login = *user_login;
    let login_ids =
        crate::users::get_organism_login_ids_by_id(&read_db, &login)
            .await
            .c(h!())?;
    let analytics_login_ids = &login_ids;
    let postgres_login_ids = &login_ids;
    let report_data =
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env,
            "report 1.2.5 data collection",
            crate::rer_importer::analysis::analytics_inbox_request_supported(
                &req.req,
            ),
            |db| async move {
                collect_report_125_data(
                    &db,
                    &login,
                    analytics_login_ids,
                    env,
                    req,
                )
                .await
            },
            |db| async move {
                collect_report_125_data(
                    &db,
                    &login,
                    postgres_login_ids,
                    env,
                    req,
                )
                .await
            },
        )
        .await?;

    build_report_125_docx_to_path(&report_data, outpath).context(h!())?;
    Ok(())
}

async fn collect_report_125_data(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<Report125Data, AppError> {
    let mut inbox_req = req.req.clone();
    inbox_req.nolimit = Some(true);
    inbox_req.report_tags_only_this_unit = Some(false);

    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(&inbox_req, report_settings.chunking_hours)
            .context(h!())?;
    let mut messages_by_id = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "Report 1.2.5 chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let chunk_req = inbox_report_chunk_req(&inbox_req, chunk);
        for message in
            load_report_125_messages(dbx, login, env, &chunk_req, chunk.end)
                .await
                .context(h!())?
        {
            messages_by_id.entry(message.id).or_insert(message);
        }
    }
    let own_datasource_ids = if req.report_tags_only_this_unit == Some(true) {
        Some(
            load_report_125_datasource_ids(dbx, logins)
                .await
                .context(h!())?,
        )
    } else {
        None
    };
    let messages = messages_by_id
        .into_values()
        .filter(|message| {
            report_125_message_matches_datasource_scope(
                message,
                own_datasource_ids.as_ref(),
            )
        })
        .collect_vec();
    let message_ids = messages.iter().map(|message| message.id).collect_vec();
    let pelengs_by_message = load_report_125_pelengs(dbx, &message_ids).await?;
    build_report_125_data(messages, &pelengs_by_message)
}

async fn load_report_125_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Vec<Report125Message>, AppError> {
    let linked_message_ids = intel_product::Entity::find()
        .select_only()
        .column(intel_product::Column::IntelMessageId)
        .filter(intel_product::Column::RelationKind.is_in([
            intel_product::RELATION_KIND_COMMENT,
            intel_product::RELATION_KIND_REPORT,
        ]))
        .into_query();
    let rows = build_filtered_inbox_report_chunk_query(
        dbx, login, env, req, period_end,
    )
    .await
    .c(h!())?
    .filter(signal_message::Column::Id.not_in_subquery(linked_message_ids))
    .filter(inbox_item_has_active_peleng_exists())
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(signal_message::Column::Timestamp, "timestamp")
    .column_as(sigint_inbox_item::Column::Date, "date")
    .column_as(sigint_inbox_item::Column::Time, "time")
    .column_as(sigint_inbox_item::Column::Datetime, "datetime")
    .column_as(sigint_inbox_item::Column::Unit, "unit")
    .into_model::<Report125MessageRow>()
    .all(dbx)
    .await
    .context(h!())?;

    let message_ids = rows.iter().map(|row| row.id).collect_vec();
    let mut groups_by_message =
        load_message_group_info(dbx, login, req, &message_ids)
            .await
            .context(h!())?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let group_info = groups_by_message.remove(&row.id);
            Report125Message {
                id: row.id,
                timestamp: row.timestamp,
                date: row.date,
                time: row.time,
                datetime: row.datetime,
                unit: row.unit,
                datasource_id: group_info.and_then(|group| group.datasource_id),
            }
        })
        .collect())
}

async fn load_report_125_datasource_ids(
    dbx: &DatabaseConnection,
    logins: &[uuid::Uuid],
) -> Result<BTreeSet<i64>, AppError> {
    if logins.is_empty() {
        return Ok(BTreeSet::new());
    }

    Ok(datasource::Entity::find()
        .filter(datasource::Column::Deleted.eq(false))
        .filter(datasource::Column::ApiLoginId.is_in(logins.to_vec()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|datasource| datasource.id)
        .collect())
}

async fn load_report_125_pelengs(
    dbx: &DatabaseConnection,
    message_ids: &[i64],
) -> Result<BTreeMap<i64, Vec<sigint_peleng::Model>>, AppError> {
    if message_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for message_ids in message_ids.chunks(20_000) {
        for peleng in sigint_peleng::Entity::find()
            .filter(sigint_peleng::Column::Deleted.eq(false))
            .filter(
                sigint_peleng::Column::SourceInboxItemId
                    .eq_any(message_ids.to_vec()),
            )
            .order_by_asc(sigint_peleng::Column::SourceInboxItemId)
            .order_by_asc(sigint_peleng::Column::Id)
            .all(dbx)
            .await
            .c(h!())?
        {
            pelengs_map
                .entry(peleng.source_inbox_item_id)
                .or_default()
                .push(peleng);
        }
    }

    Ok(pelengs_map)
}

fn build_report_125_data(
    messages: Vec<Report125Message>,
    pelengs_by_message: &BTreeMap<i64, Vec<sigint_peleng::Model>>,
) -> Result<Report125Data, AppError> {
    let mut rows = Vec::new();
    let mut seen_row_keys = BTreeSet::new();
    for message in messages {
        let Some(datetime) = report_125_datetime(&message)? else {
            continue;
        };
        let fallback_rls_type = report_125_rls_type(&message);
        for peleng in pelengs_by_message.get(&message.id).into_iter().flatten()
        {
            let Some(mgrs) = report_125_mgrs(peleng) else {
                continue;
            };
            if !seen_row_keys.insert((message.id, mgrs.clone())) {
                continue;
            }
            rows.push(Report125Row {
                inbox_item_id: message.id,
                peleng_id: peleng.id,
                datetime,
                mgrs,
                rls_type: peleng
                    .pelengation_object
                    .as_deref()
                    .map(str::trim)
                    .filter(|object| !object.is_empty())
                    .unwrap_or(&fallback_rls_type)
                    .to_string(),
            });
        }
    }

    rows.sort_by_key(|row| (row.datetime, row.inbox_item_id, row.peleng_id));
    Ok(Report125Data { rows })
}

fn report_125_message_matches_datasource_scope(
    message: &Report125Message,
    own_datasource_ids: Option<&BTreeSet<i64>>,
) -> bool {
    match own_datasource_ids {
        Some(datasource_ids) => {
            message.datasource_id.is_some_and(|datasource_id| {
                datasource_ids.contains(&datasource_id)
            })
        }
        None => true,
    }
}

fn report_125_datetime(
    message: &Report125Message,
) -> Result<Option<NaiveDateTime>, AppError> {
    if let Some(datetime) = message.datetime {
        let datetime =
            dt_zoned_from_millis(datetime.and_utc().timestamp_millis())?;
        return Ok(Some(datetime.naive_local()));
    }
    if let Some(timestamp) = message.timestamp {
        let datetime =
            dt_zoned_from_millis(timestamp.and_utc().timestamp_millis())?;
        return Ok(Some(datetime.naive_local()));
    }

    let (Some(date), Some(time)) =
        (message.date.as_ref(), message.time.as_ref())
    else {
        return Ok(None);
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
    let time = report_125_parse_time(time)?;
    Ok(Some(date.and_time(time)))
}

fn report_125_parse_time(input: &str) -> Result<NaiveTime, AppError> {
    for fmt in ["%H:%M:%S", "%H:%M"] {
        if let Ok(time) = NaiveTime::parse_from_str(input, fmt) {
            return Ok(time);
        }
    }
    Err(format!("Unable to parse report 1.2.5 time value: {input}").into())
}

fn report_125_rls_type(message: &Report125Message) -> String {
    let Some(unit) = non_empty_text(message.unit.as_deref()) else {
        return String::new();
    };
    if report_125_unit_is_not_rls_type(unit) {
        return String::new();
    }
    unit.to_string()
}

fn report_125_unit_is_not_rls_type(unit: &str) -> bool {
    let unit = unit.to_lowercase();
    ["dmr", "укх", "р/м", "mhz", "мгц"]
        .iter()
        .any(|marker| unit.contains(marker))
}

fn report_125_mgrs(peleng: &sigint_peleng::Model) -> Option<String> {
    let latlon = LatLon::create(peleng.lat, peleng.lng).ok()?;
    Some(Mgrs::from_latlon(&latlon, 5).to_string())
}

fn non_empty_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn format_report_125_datetime(datetime: NaiveDateTime) -> String {
    datetime.format("%d.%m.%Y %H:%M:%S").to_string()
}

fn build_report_125_docx_to_path(
    report_data: &Report125Data,
    outpath: &Path,
) -> Result<(), AppError> {
    let file = std::fs::File::create(outpath)?;
    build_report_125_docx(report_data)
        .build()
        .pack(file)
        .context(h!())?;
    Ok(())
}

fn build_report_125_docx(report_data: &Report125Data) -> Docx {
    let mut docx = Docx::new()
        .page_orient(PageOrientationType::Portrait)
        .default_size(DOCX_FONT_SIZE)
        .default_fonts(
            RunFonts::new()
                .ascii(DOCX_FONT)
                .east_asia(DOCX_FONT)
                .cs(DOCX_FONT),
        )
        .page_size(DOCX_PAGE_WIDTH, DOCX_PAGE_HEIGHT)
        .page_margin(
            PageMargin::new()
                .left(DOCX_PAGE_MARGIN)
                .right(DOCX_PAGE_MARGIN)
                .top(DOCX_PAGE_MARGIN)
                .bottom(DOCX_PAGE_MARGIN),
        )
        .add_paragraph(right_paragraph(REPORT_125_FORM, false))
        .add_paragraph(Paragraph::new())
        .add_paragraph(center_paragraph(REPORT_125_TITLE, true))
        .add_paragraph(Paragraph::new())
        .add_paragraph(center_paragraph(REPORT_125_SECTION_TITLE, false))
        .add_paragraph(Paragraph::new())
        .add_table(build_report_125_table(report_data));

    for _ in 0..7 {
        docx = docx.add_paragraph(Paragraph::new());
    }

    docx.add_paragraph(left_paragraph(REPORT_125_FOOTER, false))
}

fn build_report_125_table(report_data: &Report125Data) -> Table {
    let mut rows = Vec::with_capacity(report_data.rows.len() + 1);
    rows.push(TableRow::new(vec![
        header_cell("", CELL_NUM_WIDTH),
        header_cell("Дата/час", CELL_DATETIME_WIDTH),
        header_cell("Координати/вектор", CELL_MGRS_WIDTH),
        header_cell("Тип РлС", CELL_TYPE_WIDTH),
        header_cell("Проведення дорозвідки", CELL_RECON_WIDTH),
        header_cell("Проведення ураження", CELL_STRIKE_WIDTH),
    ]));

    for (index, row) in report_data.rows.iter().enumerate() {
        rows.push(TableRow::new(vec![
            text_cell(&format!("{}.", index + 1), CELL_NUM_WIDTH),
            text_cell(
                &format_report_125_datetime(row.datetime),
                CELL_DATETIME_WIDTH,
            ),
            text_cell(&row.mgrs, CELL_MGRS_WIDTH),
            text_cell(&row.rls_type, CELL_TYPE_WIDTH),
            text_cell("", CELL_RECON_WIDTH),
            text_cell("", CELL_STRIKE_WIDTH),
        ]));
    }

    Table::new(rows).width(
        CELL_NUM_WIDTH
            + CELL_DATETIME_WIDTH
            + CELL_MGRS_WIDTH
            + CELL_TYPE_WIDTH
            + CELL_RECON_WIDTH
            + CELL_STRIKE_WIDTH,
        WidthType::Dxa,
    )
}

fn left_paragraph(text: &str, bold: bool) -> Paragraph {
    Paragraph::new()
        .add_run(text_run(text, bold))
        .align(AlignmentType::Left)
}

fn right_paragraph(text: &str, bold: bool) -> Paragraph {
    Paragraph::new()
        .add_run(text_run(text, bold))
        .align(AlignmentType::Right)
}

fn center_paragraph(text: &str, bold: bool) -> Paragraph {
    Paragraph::new()
        .add_run(text_run(text, bold))
        .align(AlignmentType::Center)
}

fn header_cell(text: &str, width: usize) -> TableCell {
    TableCell::new()
        .width(width, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(center_paragraph(text, true))
}

fn text_cell(text: &str, width: usize) -> TableCell {
    TableCell::new()
        .width(width, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(Paragraph::new().add_run(text_run(text, false)))
}

fn text_run(text: &str, bold: bool) -> Run {
    let run = Run::new()
        .fonts(
            RunFonts::new()
                .ascii(DOCX_FONT)
                .east_asia(DOCX_FONT)
                .cs(DOCX_FONT),
        )
        .size(DOCX_FONT_SIZE)
        .add_text(text);
    if bold {
        run.bold()
    } else {
        run
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        datasource_group, sigint_inbox_item, sigint_peleng, signal_message,
        signal_message_group,
    };
    use crate::functest::tests::*;
    use chrono::NaiveDate;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };
    use serial_test::serial;
    use std::io::Read;
    use tempfile::NamedTempFile;
    use zip::ZipArchive;

    async fn seed_report_125_message(
        dbx: &DatabaseConnection,
        datasource_group: &datasource_group::Model,
        label: &str,
        seen_at: NaiveDateTime,
        unit: Option<&str>,
        unit_v2: Option<&str>,
        pelengs: &[(f64, f64, bool)],
    ) -> Result<i64, AppError> {
        let signal_message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(label.to_string())),
                created_at: Set(seen_at),
                timestamp: Set(Some(seen_at)),
                message_uid: Set(Some(label.to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(
                    datasource_group.group_master_key.clone(),
                )),
                datasource_group_id: Set(Some(datasource_group.id)),
                sender: Set(Some(format!("{label}-sender"))),
                message_uid: Set(Some(label.to_string())),
                created_at: Set(seen_at),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                freq: Set(Some("3330".to_string())),
                date: Set(Some(seen_at.date().to_string())),
                time: Set(Some(seen_at.time().format("%H:%M:%S").to_string())),
                unit: Set(unit.map(ToString::to_string)),
                unit_v2: Set(unit_v2.map(ToString::to_string)),
                reviewed: Set(Some(true)),
                checked: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;

        for (lat, lng, deleted) in pelengs {
            mk_sigint_peleng(
                dbx,
                sigint_peleng::ActiveModel {
                    source_inbox_item_id: Set(signal_message.id),
                    lat: Set(*lat),
                    lng: Set(*lng),
                    deleted: Set(*deleted),
                    created_at: Set(seen_at),
                    ..Default::default()
                },
            )
            .await
            .context(h!())?;
        }

        Ok(signal_message.id)
    }

    fn test_dt(day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, day)
            .expect("date")
            .and_hms_opt(hour, minute, second)
            .expect("time")
    }

    fn mgrs_from_latlng(lat: f64, lng: f64) -> String {
        Mgrs::from_latlon(&LatLon::create(lat, lng).expect("latlon"), 5)
            .to_string()
    }

    fn report_req() -> ReportPreviewReq {
        ReportPreviewReq {
            kind: "report_125".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(16, 0, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(17, 0, 0, 0).and_utc().timestamp_millis(),
                ),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            tag_report_sort_by: None,
            report_1213_linked_networks_only: None,
            without_comments: None,
            babak_new_callsign_min_mentions: None,
            interception_keep_full_message: None,
            interception_keep_old_colors: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
            sposob_unit_name: None,
        }
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_125_data_expands_active_pelengs_and_raw_unit_fields(
    ) {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();

        let first_id = seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-first",
            test_dt(16, 11, 34, 32),
            Some("А-50 (А-50У) РЛС з РТК «Шмєль-М»"),
            None,
            &[(48.1, 37.1, false), (48.2, 37.2, false)],
        )
        .await
        .unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-linked-unit",
            test_dt(16, 12, 0, 0),
            Some("Су-35"),
            Some("linked unit"),
            &[(48.3, 37.3, false)],
        )
        .await
        .unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-no-peleng",
            test_dt(16, 13, 0, 0),
            Some("No peleng"),
            None,
            &[],
        )
        .await
        .unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-deleted-peleng",
            test_dt(16, 14, 0, 0),
            Some("Deleted peleng"),
            None,
            &[(48.4, 37.4, true)],
        )
        .await
        .unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-old",
            test_dt(15, 14, 0, 0),
            Some("Old"),
            None,
            &[(48.5, 37.5, false)],
        )
        .await
        .unwrap();

        let req = report_req();
        let logins = vec![login.id];
        let report_data =
            collect_report_125_data(&env.dbx, &login.id, &logins, &env, &req)
                .await
                .unwrap();

        assert_eq!(report_data.rows.len(), 3);
        assert_eq!(report_data.rows[0].inbox_item_id, first_id);
        assert_eq!(report_data.rows[0].datetime, test_dt(16, 11, 34, 32));
        assert_eq!(report_data.rows[0].mgrs, mgrs_from_latlng(48.1, 37.1));
        assert_eq!(
            report_data.rows[0].rls_type,
            "А-50 (А-50У) РЛС з РТК «Шмєль-М»"
        );
        assert_eq!(report_data.rows[1].mgrs, mgrs_from_latlng(48.2, 37.2));
        assert_eq!(report_data.rows[2].rls_type, "Су-35");
    }

    #[test]
    fn build_report_125_data_deduplicates_same_message_mgrs_rows() {
        let messages = vec![Report125Message {
            id: 1,
            timestamp: None,
            date: Some("2026-07-16".to_string()),
            time: Some("12:14:31".to_string()),
            datetime: None,
            unit: Some("Сканер ФЛЧМ (80)".to_string()),
            datasource_id: None,
        }];
        let pelengs_by_message = BTreeMap::from([(
            1,
            vec![
                test_peleng(1118866, 49.439780423423215, 37.839316297246626),
                test_peleng(1118867, 49.43978, 37.839316),
            ],
        )]);

        let report_data =
            build_report_125_data(messages, &pelengs_by_message).unwrap();

        assert_eq!(report_data.rows.len(), 1);
        assert_eq!(report_data.rows[0].peleng_id, 1118866);
    }

    #[test]
    fn build_report_125_data_prefers_pelengation_object() {
        let messages = vec![Report125Message {
            id: 1,
            timestamp: None,
            date: Some("2026-07-16".to_string()),
            time: Some("12:14:31".to_string()),
            datetime: None,
            unit: Some("fallback unit".to_string()),
            datasource_id: None,
        }];
        let mut peleng = test_peleng(1118866, 49.43, 37.83);
        peleng.pelengation_object = Some("РЛС 9С35М ЗРК “Бук-М1”".to_string());
        let pelengs_by_message = BTreeMap::from([(1, vec![peleng])]);

        let report_data =
            build_report_125_data(messages, &pelengs_by_message).unwrap();

        assert_eq!(report_data.rows[0].rls_type, "РЛС 9С35М ЗРК “Бук-М1”");
    }

    #[tokio::test]
    #[serial]
    async fn collect_report_125_data_can_be_empty_without_pelengs() {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-empty",
            test_dt(16, 11, 34, 32),
            Some("No peleng"),
            None,
            &[],
        )
        .await
        .unwrap();

        let req = report_req();
        let logins = vec![login.id];
        let report_data =
            collect_report_125_data(&env.dbx, &login.id, &logins, &env, &req)
                .await
                .unwrap();

        assert!(report_data.rows.is_empty());
    }

    #[test]
    fn report_125_rls_type_blanks_non_rls_unit_markers() {
        for unit in [
            "DMR мережа",
            "УКХ р/м управління",
            "р/м управління",
            "141.715 MHz",
            "141.715 МГц",
        ] {
            assert_eq!(report_125_rls_type(&message_with_unit(unit)), "");
        }
        assert_eq!(
            report_125_rls_type(&message_with_unit(
                "А-50 (А-50У) РЛС з РТК «Шмєль-М»"
            )),
            "А-50 (А-50У) РЛС з РТК «Шмєль-М»"
        );
        assert_eq!(
            report_125_rls_type(&message_with_unit(
                "РЛС 35Д6 (19Ж6 рідкий запуск)"
            )),
            "РЛС 35Д6 (19Ж6 рідкий запуск)"
        );
    }

    fn message_with_unit(unit: &str) -> Report125Message {
        Report125Message {
            id: 1,
            timestamp: None,
            date: None,
            time: None,
            datetime: None,
            unit: Some(unit.to_string()),
            datasource_id: None,
        }
    }

    fn test_peleng(id: i64, lat: f64, lng: f64) -> sigint_peleng::Model {
        sigint_peleng::Model {
            id,
            source_inbox_item_id: 1,
            lat,
            lng,
            settlement: None,
            locality_direction: None,
            distance_m: None,
            country_code: None,
            pelengation_object: None,
            deleted: false,
            created_at: test_dt(16, 12, 14, 31),
            updated_at: None,
        }
    }

    #[test]
    fn build_report_125_docx_to_path_writes_expected_document_xml() {
        let report_data = Report125Data {
            rows: vec![Report125Row {
                inbox_item_id: 1,
                peleng_id: 7,
                datetime: test_dt(16, 11, 34, 32),
                mgrs: "37UDR3251505505".to_string(),
                rls_type: "А-50 (А-50У) РЛС з РТК «Шмєль-М»".to_string(),
            }],
        };
        let tmp = NamedTempFile::new().unwrap();
        build_report_125_docx_to_path(&report_data, tmp.path()).unwrap();

        let xml = document_xml(tmp.path());
        assert!(xml.contains(REPORT_125_FORM));
        assert!(xml.contains(r#"<w:jc w:val="right""#));
        assert!(xml.contains(REPORT_125_TITLE));
        assert!(xml.contains(REPORT_125_SECTION_TITLE));
        assert!(xml.contains("Дата/час"));
        assert!(xml.contains("Координати/вектор"));
        assert!(xml.contains("Тип РлС"));
        assert!(xml.contains("16.07.2026 11:34:32"));
        assert!(xml.contains("37UDR3251505505"));
        assert!(xml.contains(REPORT_125_FOOTER));
        assert!(xml.contains(DOCX_FONT));
        assert_eq!(xml.matches("<w:tr>").count(), 2);
    }

    fn document_xml(path: &Path) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let mut document = zip.by_name("word/document.xml").unwrap();
        let mut xml = String::new();
        document.read_to_string(&mut xml).unwrap();
        xml
    }

    #[tokio::test]
    #[serial]
    async fn report_125_message_scope_respects_report_tags_only_this_unit() {
        let (env, _cleanup_guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        seed_report_125_message(
            &env.dbx,
            &datasource_group,
            "msg-report-125-own",
            test_dt(16, 11, 34, 32),
            Some("Own"),
            None,
            &[(48.1, 37.1, false)],
        )
        .await
        .unwrap();

        let mut datasource =
            datasource::Entity::find_by_id(datasource_group.datasource_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        datasource.api_login_id = Set(None);
        datasource.update(&env.dbx).await.unwrap();

        let mut req = report_req();
        req.report_tags_only_this_unit = Some(true);
        let logins = vec![login.id];
        let report_data =
            collect_report_125_data(&env.dbx, &login.id, &logins, &env, &req)
                .await
                .unwrap();

        assert!(report_data.rows.is_empty());
    }
}
