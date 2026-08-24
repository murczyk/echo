use crate::config::get_tz;
use crate::entities::{
    area_of_responsibility, sigint_network, sigint_network_aor,
    sigint_network_freq,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::{
    AreaOfResponsibility, ReportPreviewReq,
};
use crate::types::info;
use crate::types::Env;
use crate::utils::{dt_from_millis, dt_zoned_from_millis};
use anyhow::Context;
use chrono::{NaiveDateTime, TimeZone};
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
    Table, TableCell, TableRow, VAlignType, WidthType,
};
use sea_orm::{FromQueryResult, *};
use std::path::Path;
use std::time::Instant;

const CELL_NETWORK_WIDTH: usize = 5400;
const CELL_FREQ_WIDTH: usize = 2300;
const CELL_STATUS_WIDTH: usize = 1800;
const CELL_LAST_SEEN_WIDTH: usize = 2600;

pub async fn report_docx_kind_network_frequencies(
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let started_at = Instant::now();
    info!("report_docx_kind_network_frequencies started");

    let since_dt = format_to_native_date(req.req.since_date_inclusive_ms)?;
    let till_dt = format_to_native_date(req.req.till_date_inclusive_ms)?;
    let analytics_req = req;
    let postgres_req = req;
    let aor_data = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "network frequencies report",
        true,
        |db| async move {
            get_aor_network_frequency_rows(
                &db,
                analytics_req,
                since_dt,
                till_dt,
            )
            .await
        },
        |db| async move {
            get_aor_network_frequency_rows(&db, postgres_req, since_dt, till_dt)
                .await
        },
    )
    .await?;
    let record_count = aor_data
        .iter()
        .fold(0_usize, |count, aor| count.saturating_add(aor.rows.len()));
    crate::report_history::ensure_report_record_count(record_count)?;

    let mut docx = get_docx_document(req);

    if aor_data.is_empty() {
        docx = add_empty_state_paragraph(docx);
    }

    for aor_row in aor_data {
        docx = add_aor_paragraph(docx, &aor_row.area_of_responsibility);

        if aor_row.rows.is_empty() {
            docx = add_empty_state_paragraph(docx);
            continue;
        }

        docx = docx.add_table(build_table(&aor_row.rows, since_dt, till_dt));
        docx = docx.add_paragraph(Paragraph::new());
    }

    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;

    info!(
        "report_docx_kind_network_frequencies completed in {:?}",
        started_at.elapsed()
    );
    Ok(())
}

struct AreaOfResponsibilityNetworkFrequencies {
    area_of_responsibility: AreaOfResponsibility,
    rows: Vec<NetworkFrequencyRow>,
}

#[derive(Debug, Clone, FromQueryResult)]
struct NetworkFrequencyRow {
    network_name: String,
    freq: String,
    active_to: Option<NaiveDateTime>,
    last_seen_dt: Option<NaiveDateTime>,
}

impl NetworkFrequencyRow {
    fn activity_label(&self, till_dt: NaiveDateTime) -> &'static str {
        if self.active_to.is_some_and(|active_to| active_to <= till_dt) {
            "неактивна"
        } else {
            "активна"
        }
    }
}

async fn get_aor_network_frequency_rows(
    db: &DatabaseConnection,
    req: &ReportPreviewReq,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Result<Vec<AreaOfResponsibilityNetworkFrequencies>, AppError> {
    let aor_ids = get_request_aor_ids(req);
    let aors = get_areas_of_responsibility(db, aor_ids).await?;
    let mut result = Vec::with_capacity(aors.len());

    for area_of_responsibility in aors {
        let rows = get_network_frequency_rows_for_aor(
            db,
            req,
            area_of_responsibility.id,
            since_dt,
            till_dt,
        )
        .await?;
        result.push(AreaOfResponsibilityNetworkFrequencies {
            area_of_responsibility,
            rows,
        });
    }

    Ok(result)
}

fn get_request_aor_ids(req: &ReportPreviewReq) -> Vec<i64> {
    req.req.selected_aors.clone().unwrap_or_default()
}

async fn get_areas_of_responsibility(
    db: &DatabaseConnection,
    aor_ids: Vec<i64>,
) -> Result<Vec<AreaOfResponsibility>, AppError> {
    let mut aors_select = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true));

    if !aor_ids.is_empty() {
        aors_select = aors_select
            .filter(area_of_responsibility::Column::Id.is_in(aor_ids));
    }

    aors_select
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .column(area_of_responsibility::Column::Name)
        .order_by_asc(area_of_responsibility::Column::Name)
        .into_model::<AreaOfResponsibility>()
        .all(db)
        .await
        .context(h!())
        .map_err(Into::into)
}

async fn get_network_frequency_rows_for_aor(
    db: &DatabaseConnection,
    req: &ReportPreviewReq,
    aor_id: i64,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Result<Vec<NetworkFrequencyRow>, AppError> {
    let mut query = sigint_network_freq::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .filter(sigint_network_aor::Column::AorId.eq(aor_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::ActiveFrom.lte(till_dt))
        .filter(
            Condition::any()
                .add(sigint_network_freq::Column::ActiveTo.is_null())
                .add(sigint_network_freq::Column::ActiveTo.gte(since_dt)),
        )
        .distinct()
        .select_only()
        .column_as(sigint_network::Column::Name, "network_name")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveTo)
        .column(sigint_network_freq::Column::LastSeenDt)
        .order_by_asc(sigint_network::Column::Name)
        .order_by_asc(sigint_network_freq::Column::Freq);

    if let Some(selected_networks) = req
        .req
        .selected_networks
        .as_ref()
        .filter(|ids| !ids.is_empty())
    {
        query = query.filter(
            sigint_network::Column::Id.is_in(selected_networks.clone()),
        );
    }

    if let Some(selected_freqs) = req
        .req
        .selected_freqs
        .as_ref()
        .filter(|freqs| !freqs.is_empty())
    {
        query = query.filter(
            sigint_network_freq::Column::Freq.is_in(selected_freqs.clone()),
        );
    }

    query
        .into_model::<NetworkFrequencyRow>()
        .all(db)
        .await
        .context(h!())
        .map_err(Into::into)
}

fn get_docx_document(req: &ReportPreviewReq) -> Docx {
    let tz = get_tz();
    Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(24)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().bold().add_text(format!(
                    "Частоти Радіомереж за період з {} по {}",
                    format_datetime_ms(req.req.since_date_inclusive_ms, &tz),
                    format_datetime_ms(req.req.till_date_inclusive_ms, &tz),
                )))
                .align(AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
}

fn add_aor_paragraph(
    docx: Docx,
    area_of_responsibility: &AreaOfResponsibility,
) -> Docx {
    docx.add_paragraph(
        Paragraph::new().add_run(
            Run::new()
                .bold()
                .add_text(display_aor_name(&area_of_responsibility.name)),
        ),
    )
}

fn add_empty_state_paragraph(docx: Docx) -> Docx {
    docx.add_paragraph(Paragraph::new().add_run(
        Run::new().add_text("Частоти радіомереж за обраний період не виявлено"),
    ))
}

fn build_table(
    rows: &[NetworkFrequencyRow],
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Table {
    let mut table_rows = Vec::with_capacity(rows.len() + 1);
    table_rows.push(TableRow::new(vec![
        build_header_cell("Мережа", CELL_NETWORK_WIDTH),
        build_header_cell("Частота", CELL_FREQ_WIDTH),
        build_header_cell("Активність", CELL_STATUS_WIDTH),
        build_header_cell("Останній раз в етері", CELL_LAST_SEEN_WIDTH),
    ]));

    for row in rows {
        table_rows.push(TableRow::new(vec![
            build_text_cell(&row.network_name, CELL_NETWORK_WIDTH),
            build_text_cell(&row.freq, CELL_FREQ_WIDTH),
            build_text_cell(row.activity_label(till_dt), CELL_STATUS_WIDTH),
            build_text_cell(
                &format_last_seen_datetime(row.last_seen_dt, since_dt, till_dt),
                CELL_LAST_SEEN_WIDTH,
            ),
        ]));
    }

    Table::new(table_rows).width(
        CELL_NETWORK_WIDTH
            + CELL_FREQ_WIDTH
            + CELL_STATUS_WIDTH
            + CELL_LAST_SEEN_WIDTH,
        WidthType::Dxa,
    )
}

fn build_header_cell(text: &str, width: usize) -> TableCell {
    TableCell::new()
        .width(width, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().bold().add_text(text))
                .align(AlignmentType::Center),
        )
}

fn build_text_cell(text: &str, width: usize) -> TableCell {
    TableCell::new()
        .width(width, WidthType::Dxa)
        .vertical_align(VAlignType::Center)
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(text)))
}

fn format_last_seen_datetime(
    dt: Option<NaiveDateTime>,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> String {
    let tz = get_tz();
    dt.map(|value| {
        if value < since_dt || value > till_dt {
            "поза обраним періодом".to_string()
        } else {
            tz.from_utc_datetime(&value)
                .format("%Y.%m.%d %H:%M")
                .to_string()
        }
    })
    .unwrap_or_else(|| "невідомо".to_string())
}

fn format_datetime_ms(dt_millis: Option<i64>, tz: &chrono_tz::Tz) -> String {
    dt_millis
        .and_then(|millis| dt_zoned_from_millis(millis).ok())
        .map(|dt| dt.with_timezone(tz).format("%Y.%m.%d %H:%M").to_string())
        .unwrap_or_default()
}

fn format_to_native_date(dt: Option<i64>) -> Result<NaiveDateTime, AppError> {
    Ok(dt
        .map(dt_from_millis)
        .transpose()
        .context(h!())?
        .unwrap_or_default())
}

fn display_aor_name(name: &str) -> String {
    if name == "DEFAULT AOR" {
        "Вся смуга".to_string()
    } else {
        name.to_string()
    }
}
