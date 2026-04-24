use crate::config::get_tz;
use crate::entities::{
    area_of_responsibility, sigint_network, sigint_network_aor,
    sigint_network_freq,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::group::get_identity_sigint_groups_noimport;
use crate::rer_importer::analysis::stats::fetch_networks_for_login;
use crate::rer_importer::reports::types::{
    AreaOfResponsibility, ReportPreviewReq,
};
use crate::rer_importer::types::{AnalysisStatsReq, InboxMessagesReq};
use crate::types::Env;
use crate::utils::{dt_from_millis, dt_zoned_from_millis};
use actix_identity::Identity;
use anyhow::Context;
use chrono::{NaiveDateTime, TimeZone};
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
    Table, TableCell, TableRow, VAlignType, WidthType,
};
use log::info;
use sea_orm::{FromQueryResult, *};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Instant;

const CELL_NETWORK_WIDTH: usize = 5400;
const CELL_FREQ_WIDTH: usize = 2300;
const CELL_STATUS_WIDTH: usize = 1800;
const CELL_LAST_SEEN_WIDTH: usize = 2600;

pub async fn report_docx_kind_network_frequencies(
    user: Identity,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let started_at = Instant::now();
    info!("report_docx_kind_network_frequencies started");

    let db = env.dbx.clone();
    let since_dt = format_to_native_date(req.req.since_date_inclusive_ms)?;
    let till_dt = format_to_native_date(req.req.till_date_inclusive_ms)?;
    let aor_data =
        get_aor_network_frequency_rows(&db, &user, env, req, since_dt, till_dt)
            .await?;

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
struct NetworkFrequencyCandidateRow {
    network_id: i64,
    network_name: String,
    freq: String,
    active_to: Option<NaiveDateTime>,
    last_seen_dt: Option<NaiveDateTime>,
}

#[derive(Debug, Clone, FromQueryResult)]
struct NetworkAorLinkRow {
    aor_id: i64,
    aor_name: String,
    network_id: i64,
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
    user: &Identity,
    env: &Env,
    req: &ReportPreviewReq,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Result<Vec<AreaOfResponsibilityNetworkFrequencies>, AppError> {
    let network_ids = get_filtered_network_ids(db, user, env, req).await?;
    if network_ids.is_empty() {
        return Ok(vec![]);
    }

    let rows_by_network = get_network_frequency_rows_by_network(
        db,
        network_ids.clone(),
        since_dt,
        till_dt,
    )
    .await?;
    let aor_links = get_network_aor_links(db, network_ids).await?;

    let mut result_by_aor =
        BTreeMap::<i64, AreaOfResponsibilityNetworkFrequencies>::new();

    for link in aor_links {
        let rows = rows_by_network
            .get(&link.network_id)
            .cloned()
            .unwrap_or_default();
        let entry = result_by_aor.entry(link.aor_id).or_insert_with(|| {
            AreaOfResponsibilityNetworkFrequencies {
                area_of_responsibility: AreaOfResponsibility {
                    id: link.aor_id,
                    name: link.aor_name.clone(),
                },
                rows: vec![],
            }
        });
        entry.rows.extend(rows);
    }

    let mut result = result_by_aor.into_values().collect::<Vec<_>>();
    for aor in &mut result {
        aor.rows.sort_by(|left, right| {
            left.network_name
                .cmp(&right.network_name)
                .then(left.freq.cmp(&right.freq))
        });
        aor.rows.dedup_by(|left, right| {
            left.network_name == right.network_name && left.freq == right.freq
        });
    }
    result.sort_by(|left, right| {
        display_aor_name(&left.area_of_responsibility.name)
            .cmp(&display_aor_name(&right.area_of_responsibility.name))
    });
    Ok(result)
}

async fn get_filtered_network_ids(
    db: &DatabaseConnection,
    user: &Identity,
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<Vec<i64>, AppError> {
    let analysis_req = analysis_stats_req_from_inbox_req(&req.req);
    let master_keys =
        get_identity_sigint_groups_noimport(db, user, &env.config)
            .await
            .context(h!())?;
    let login = user.id().context(h!())?;
    let networks =
        fetch_networks_for_login(&analysis_req, &login, db, master_keys)
            .await
            .context(h!())?;

    Ok(networks
        .into_iter()
        .map(|network| network.network_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

async fn get_network_aor_links(
    db: &DatabaseConnection,
    network_ids: Vec<i64>,
) -> Result<Vec<NetworkAorLinkRow>, AppError> {
    if network_ids.is_empty() {
        return Ok(vec![]);
    }

    area_of_responsibility::Entity::find()
        .join(
            JoinType::InnerJoin,
            area_of_responsibility::Relation::SigintNetworkAor.def(),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .filter(sigint_network_aor::Column::NetworkId.is_in(network_ids))
        .select_only()
        .column_as(area_of_responsibility::Column::Id, "aor_id")
        .column_as(area_of_responsibility::Column::Name, "aor_name")
        .column_as(sigint_network_aor::Column::NetworkId, "network_id")
        .order_by_asc(area_of_responsibility::Column::Name)
        .into_model::<NetworkAorLinkRow>()
        .all(db)
        .await
        .context(h!())
        .map_err(Into::into)
}

async fn get_network_frequency_rows_by_network(
    db: &DatabaseConnection,
    network_ids: Vec<i64>,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Result<BTreeMap<i64, Vec<NetworkFrequencyRow>>, AppError> {
    if network_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let candidate_rows = sigint_network_freq::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .filter(sigint_network_freq::Column::NetworkId.is_in(network_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::ActiveFrom.lte(till_dt))
        .filter(
            Condition::any()
                .add(sigint_network_freq::Column::ActiveTo.is_null())
                .add(sigint_network_freq::Column::ActiveTo.gte(since_dt)),
        )
        .select_only()
        .column(sigint_network_freq::Column::NetworkId)
        .column_as(sigint_network::Column::Name, "network_name")
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveTo)
        .column(sigint_network_freq::Column::LastSeenDt)
        .order_by_asc(sigint_network::Column::Name)
        .order_by_asc(sigint_network_freq::Column::Freq)
        .into_model::<NetworkFrequencyCandidateRow>()
        .all(db)
        .await
        .context(h!())?;

    let mut grouped =
        BTreeMap::<(i64, String), Vec<NetworkFrequencyCandidateRow>>::new();
    for row in candidate_rows {
        grouped
            .entry((row.network_id, row.freq.clone()))
            .or_default()
            .push(row);
    }

    let mut result = BTreeMap::<i64, Vec<NetworkFrequencyRow>>::new();
    for ((network_id, freq), rows) in grouped {
        let Some(first_row) = rows.first() else {
            continue;
        };
        let is_active = rows.iter().any(|row| {
            row.active_to.is_none_or(|active_to| active_to > till_dt)
        });
        let active_to = if is_active {
            None
        } else {
            rows.iter().filter_map(|row| row.active_to).max()
        };
        let last_seen_dt = rows.iter().filter_map(|row| row.last_seen_dt).max();
        result
            .entry(network_id)
            .or_default()
            .push(NetworkFrequencyRow {
                network_name: first_row.network_name.clone(),
                freq,
                active_to,
                last_seen_dt,
            });
    }

    Ok(result)
}

fn analysis_stats_req_from_inbox_req(
    req: &InboxMessagesReq,
) -> AnalysisStatsReq {
    AnalysisStatsReq {
        since_date_inclusive_ms: req.since_date_inclusive_ms.unwrap_or(0),
        till_date_noninclusive_ms: req
            .till_date_inclusive_ms
            .map(|value| value.saturating_add(1))
            .unwrap_or(0),
        selected_groups: req.selected_groups.clone(),
        selected_senders: req.selected_senders.clone(),
        selected_freqs: req.selected_freqs.clone(),
        selected_posts: req.selected_posts.clone(),
        selected_callsigns: req.selected_callsigns.clone(),
        selected_units: req.selected_units.clone(),
        selected_locations: req.selected_locations.clone(),
        or_with_extended_form: req.or_with_extended_form,
        or_bookmarked: req.or_bookmarked,
        or_important: req.or_important,
        or_with_coords: req.or_with_coords,
        or_without_coords: req.or_without_coords,
        search: req.search.clone(),
        selected_tags: req.selected_tags.clone(),
        selected_networks: req.selected_networks.clone(),
        without_network: req.without_network,
        metadata_cc: req.metadata_cc.clone(),
        metadata_sender: req.metadata_sender.clone(),
        metadata_receiver: req.metadata_receiver.clone(),
        metadata_hash: req.metadata_hash.clone(),
        only_with_metadata: req.only_with_metadata,
        without_metadata: req.without_metadata,
        include_peleng_locations: req.include_peleng_locations,
        units_exact_match_only: req.units_exact_match_only,
        filter_tags_option: req.filter_tags_option,
        selected_aors: req.selected_aors.clone(),
        without_model_tags: req.without_model_tags,
        report_tags_only_this_unit: req.report_tags_only_this_unit,
    }
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
