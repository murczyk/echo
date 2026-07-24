use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::inbox_light::blank_inbox_message;
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::rer_importer::types::InboxMessage;
use crate::types::{Env, ShortContext};
use crate::utils::dt_zoned_from_millis;
use anyhow::Context;
use chrono::{DateTime, Datelike, TimeZone};
use chrono_tz::Tz;
use docx_rs::*;
use itertools::Itertools;
use once_cell::sync::Lazy;
use regex::Regex;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const TITLE: &str = "ЗАГАЛЬНИЙ ЗВІТ ПРО РОБОТУ ПОСТІВ РАДІОПЕРЕХОПЛЕННЯ";
const DAY_MS: i64 = 86_400_000;

static FREQ_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d+(?:[.,]\d+)?)").unwrap());

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum NetworkKey {
    Id(i64),
    Label(String),
}

#[derive(Default)]
struct PostStats {
    current_freqs: BTreeSet<String>,
    previous_freqs: BTreeSet<String>,
    current_total: usize,
    previous_total: usize,
    all_networks: BTreeSet<NetworkKey>,
    reference_networks: BTreeSet<NetworkKey>,
}

#[derive(Debug, FromQueryResult)]
struct PostReportMessageRow {
    id: i64,
    freq: Option<String>,
    unit: Option<String>,
    post: Option<String>,
}

fn collect_reference_network_keys(
    message: &InboxMessage,
) -> BTreeSet<NetworkKey> {
    let mut networks = BTreeSet::new();
    if let Some(ids) = message.network_ids.as_ref() {
        for id in ids.iter().copied() {
            networks.insert(NetworkKey::Id(id));
        }
    }
    networks
}

pub async fn report_docx_kind_posts(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let login = *user_login;
    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let Some(since_date_inclusive_ms) = current_req.since_date_inclusive_ms
    else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = current_req.till_date_inclusive_ms
    else {
        return Err("Until date must be specified".into());
    };

    current_req.return_duplicates = Some(false);
    let previous_req = build_shifted_req(&current_req, -DAY_MS)?;
    let analytics_supported =
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &current_req,
        ) && crate::rer_importer::analysis::analytics_inbox_request_supported(
            &previous_req,
        );
    let analytics_current_req = &current_req;
    let analytics_previous_req = &previous_req;
    let postgres_current_req = &current_req;
    let postgres_previous_req = &previous_req;
    let (current_messages, previous_messages) =
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env,
            "posts report interception scans",
            analytics_supported,
            |db| async move {
                Ok((
                    load_post_report_messages(
                        &db,
                        &login,
                        env,
                        analytics_current_req,
                    )
                    .await?,
                    load_post_report_messages(
                        &db,
                        &login,
                        env,
                        analytics_previous_req,
                    )
                    .await?,
                ))
            },
            |db| async move {
                Ok((
                    load_post_report_messages(
                        &db,
                        &login,
                        env,
                        postgres_current_req,
                    )
                    .await?,
                    load_post_report_messages(
                        &db,
                        &login,
                        env,
                        postgres_previous_req,
                    )
                    .await?,
                ))
            },
        )
        .await
        .c(h!())?;

    let strict_networks = env.config.feature_strict_networks.unwrap_or(false);

    let current_total = current_messages.len();
    let previous_total = previous_messages.len();

    let mut posts: BTreeMap<String, PostStats> = BTreeMap::new();
    let mut overall_networks: BTreeSet<NetworkKey> = BTreeSet::new();
    let mut freq_values: Vec<f64> = Vec::new();

    for (_, message) in &current_messages {
        let post_name = normalized_post_name(message);
        let entry = posts.entry(post_name.clone()).or_default();
        entry.current_total += 1;

        let networks = collect_network_keys(message, strict_networks);
        for network_key in networks {
            entry.all_networks.insert(network_key.clone());
            overall_networks.insert(network_key);
        }

        let reference_networks = collect_reference_network_keys(message);
        for network_key in reference_networks {
            entry.reference_networks.insert(network_key);
        }

        if let Some(freq) = message
            .freq
            .as_ref()
            .and_then(|value| parse_frequency(value))
        {
            entry.current_freqs.insert(format_frequency(freq));
            freq_values.push(freq);
        }
    }

    for (_, message) in &previous_messages {
        let post_name = normalized_post_name(message);
        let entry = posts.entry(post_name.clone()).or_default();
        entry.previous_total += 1;

        if let Some(freq) = message
            .freq
            .as_ref()
            .and_then(|value| parse_frequency(value))
        {
            entry.previous_freqs.insert(format_frequency(freq));
        }
    }

    let mut posts_vec: Vec<(String, PostStats)> = posts
        .into_iter()
        .filter(|(_, stats)| stats.current_total > 0)
        .collect();

    posts_vec.sort_by(|(name_a, stats_a), (name_b, stats_b)| {
        stats_b
            .current_total
            .cmp(&stats_a.current_total)
            .then(name_a.cmp(name_b))
    });

    let freq_range = get_freq_range(freq_values);

    let date_from_local =
        dt_zoned_from_millis(since_date_inclusive_ms).context(h!())?;
    let date_to_local =
        dt_zoned_from_millis(till_date_inclusive_ms).context(h!())?;

    let summary_paragraph_text = build_summary_paragraph(
        overall_networks.len(),
        current_total,
        previous_total,
        freq_range,
    );

    let doc = generate_docx_kind_posts(
        summary_paragraph_text,
        posts_vec,
        date_from_local,
        date_to_local,
    );

    build_docx_kind_posts(outpath, doc)
}

async fn load_post_report_messages(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &crate::rer_importer::types::InboxMessagesReq,
) -> Result<Vec<(i64, InboxMessage)>, AppError> {
    let rows = crate::rer_importer::inbox::query::build_filtered_inbox_query(
        dbx, login, env, req,
    )
    .await
    .c(h!())?
    .select_only()
    .column_as(signal_message::Column::Id, "id")
    .column_as(sigint_inbox_item::Column::Freq, "freq")
    .column_as(sigint_inbox_item::Column::UnitV2, "unit")
    .column_as(sigint_post::Column::Name, "post")
    .into_model::<PostReportMessageRow>()
    .all(dbx)
    .await
    .context(h!())?;
    let message_ids = rows.iter().map(|row| row.id).collect_vec();
    // Network cache backfill may write, so keep it off read replicas.
    let mut networks_by_message =
        crate::rer_importer::inbox::load_message_networks_by_ids(
            &env.dbx,
            &message_ids,
        )
        .await
        .context(h!())?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let mut message = blank_inbox_message();
            message.freq = row.freq;
            message.unit = row.unit;
            message.post = row.post;
            message.network_ids = networks_by_message.remove(&row.id);
            (row.id, message)
        })
        .collect())
}

fn get_freq_range(freq_values: Vec<f64>) -> Option<(f64, f64)> {
    if freq_values.is_empty() {
        None
    } else {
        let min = freq_values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = freq_values
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max);
        if min.is_finite() && max.is_finite() {
            if min <= max {
                Some((min, max))
            } else {
                Some((max, min))
            }
        } else {
            None
        }
    }
}

fn generate_docx_kind_posts(
    summary_paragraph_text: String,
    posts_vec: Vec<(String, PostStats)>,
    date_from_local: DateTime<Tz>,
    date_to_local: DateTime<Tz>,
) -> Docx {
    let (date_from_txt, time_from_txt) = format_date_time(date_from_local);
    let (date_to_txt, time_to_txt) = format_date_time(date_to_local);
    let mut doc = Docx::new().default_size(24);

    doc = doc
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new().add_text(TITLE).bold().size(40).fonts(
                        RunFonts::new().ascii("Arial").east_asia("Arial"),
                    ),
                )
                .align(AlignmentType::Center),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(format!(
                            "За період «{date_from_txt}» {time_from_txt} по «{date_to_txt}» {time_to_txt}"
                        ))
                        .size(28)
                        .fonts(
                            RunFonts::new().ascii("Arial").east_asia("Arial"),
                        ),
                )
                .align(AlignmentType::Center),
        )
        .add_paragraph(blank_paragraph())
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(&summary_paragraph_text)
                        .bold()
                        .size(28)
                        .fonts(
                            RunFonts::new()
                                .ascii("Times New Roman")
                                .east_asia("Times New Roman"),
                        ),
                )
                .align(AlignmentType::Left),
        )
        .add_paragraph(blank_paragraph());

    for (post_name, stats) in &posts_vec {
        let paragraph = Paragraph::new()
            .add_run(
                Run::new()
                    .add_text(post_name)
                    .bold()
                    .size(28)
                    .fonts(
                        RunFonts::new()
                            .ascii("Times New Roman")
                            .east_asia("Times New Roman"),
                    ),
            )
            .add_run(
                Run::new()
                    .add_text(format!(
                        " Було дешифровано {} перехоплень (попередня доба — {}) робочих {} мереж",
                        stats.current_total,
                        stats.previous_total,
                        stats.all_networks.len()
                    ))
                    .size(28)
                    .fonts(
                        RunFonts::new()
                            .ascii("Times New Roman")
                            .east_asia("Times New Roman"),
                    ),
            );
        doc = doc
            .add_paragraph(paragraph)
            .add_paragraph(blank_paragraph());
    }

    let table_rows = generate_table_for_docx_kind_posts(posts_vec);

    doc.add_table(Table::new(table_rows))
}

fn generate_table_for_docx_kind_posts(
    posts_vec: Vec<(String, PostStats)>,
) -> Vec<TableRow> {
    const TABLE_SIZE: usize = 22;

    let mut table_rows: Vec<TableRow> = vec![];
    let mut table_total_row = get_table_total_row();
    let cell_headers = get_cell_headers();

    table_rows.push(TableRow::new(cell_headers));

    for (post_name, stats) in &posts_vec {
        let table_cels = get_table_cell_stats(post_name.clone(), stats);
        table_rows.push(TableRow::new(table_cels));

        update_table_total_row_parameters(&mut table_total_row, stats);
    }

    let table_cells_of_total =
        get_cells_of_total(&table_total_row, TABLE_SIZE, true);
    table_rows.push(TableRow::new(table_cells_of_total));

    table_rows
}

fn get_table_total_row() -> PostStats {
    PostStats {
        current_freqs: BTreeSet::new(),
        previous_freqs: BTreeSet::new(),
        current_total: 0,
        previous_total: 0,
        all_networks: BTreeSet::new(),
        reference_networks: BTreeSet::new(),
    }
}

fn get_cells_of_total(
    table_total_row: &PostStats,
    table_size: usize,
    is_bold: bool,
) -> Vec<TableCell> {
    get_table_cells(
        vec![
            "Загалом".to_string(),
            table_total_row.current_freqs.len().to_string(),
            table_total_row.previous_freqs.len().to_string(),
            table_total_row.current_total.to_string(),
            table_total_row.previous_total.to_string(),
            table_total_row.all_networks.len().to_string(),
            table_total_row.reference_networks.len().to_string(),
        ],
        table_size,
        is_bold,
    )
}

fn update_table_total_row_parameters(
    total_row: &mut PostStats,
    stats: &PostStats,
) {
    total_row
        .current_freqs
        .extend(stats.current_freqs.iter().cloned());
    total_row
        .previous_freqs
        .extend(stats.previous_freqs.iter().cloned());
    total_row.current_total += stats.current_total;
    total_row.previous_total += stats.previous_total;
    total_row
        .all_networks
        .extend(stats.all_networks.iter().cloned());
    total_row
        .reference_networks
        .extend(stats.reference_networks.iter().cloned());
}

fn get_table_cell_stats(
    post_name: String,
    stats: &PostStats,
) -> Vec<TableCell> {
    get_table_cells(
        vec![
            post_name.clone(),
            stats.current_freqs.len().to_string(),
            stats.previous_freqs.len().to_string(),
            stats.current_total.to_string(),
            stats.previous_total.to_string(),
            stats.all_networks.len().to_string(),
            stats.reference_networks.len().to_string(),
        ],
        22,
        false,
    )
}

fn get_cell_headers() -> Vec<TableCell> {
    let header_cell = |text: &str| {
        TableCell::new().add_paragraph(
            get_table_cell_paragraph(text.to_string(), 22, true)
                .align(AlignmentType::Center),
        )
    };
    vec![
        header_cell("Пост"),
        header_cell("Кількість частот за день"),
        header_cell("Кількість частот за попередній день"),
        header_cell("Кількість перехоплень"),
        header_cell("Кількість перехоплень за попередній день"),
        header_cell("Кількість прив'язаних мереж"),
        header_cell("Кількість еталонних мереж"),
    ]
}

fn get_table_cells(
    title_array: Vec<String>,
    table_size: usize,
    is_bold: bool,
) -> Vec<TableCell> {
    title_array
        .into_iter()
        .map(|title| get_table_cell(title, table_size, is_bold))
        .collect()
}

fn get_table_cell(
    cell_name: String,
    table_size: usize,
    is_bold: bool,
) -> TableCell {
    TableCell::new()
        .add_paragraph(get_table_cell_paragraph(cell_name, table_size, is_bold))
}

fn get_table_cell_paragraph(
    cell_name: String,
    table_size: usize,
    is_bold: bool,
) -> Paragraph {
    Paragraph::new().add_run(get_table_cell_run(cell_name, table_size, is_bold))
}

fn get_table_cell_run(
    cell_name: String,
    table_size: usize,
    is_bold: bool,
) -> Run {
    let mut run = Run::new().add_text(cell_name).size(table_size);

    if is_bold {
        run = run.bold();
    }
    run
}

fn build_docx_kind_posts(outpath: &Path, doc: Docx) -> Result<(), AppError> {
    let file = std::fs::File::create(outpath).context(h!())?;
    Ok(doc
        .build()
        .pack(file)
        .map_err(anyhow::Error::from)
        .context(h!())?)
}

fn build_shifted_req(
    base_req: &crate::rer_importer::types::InboxMessagesReq,
    delta_ms: i64,
) -> Result<crate::rer_importer::types::InboxMessagesReq, AppError> {
    let mut req = base_req.clone();
    req.since_date_inclusive_ms = req
        .since_date_inclusive_ms
        .map(|v| v.saturating_add(delta_ms));
    req.till_date_inclusive_ms = req
        .till_date_inclusive_ms
        .map(|v| v.saturating_add(delta_ms));
    Ok(req)
}

fn normalized_post_name(message: &InboxMessage) -> String {
    message
        .post
        .as_ref()
        .map(|p| normalize_whitespace(p))
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "Невідомий пост".to_string())
}

fn normalize_whitespace(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn collect_network_keys(
    message: &InboxMessage,
    strict_networks: bool,
) -> BTreeSet<NetworkKey> {
    let mut networks = BTreeSet::new();
    if let Some(ids) = message.network_ids.as_ref() {
        for id in ids.iter().copied() {
            networks.insert(NetworkKey::Id(id));
        }
    }
    if networks.is_empty() && !strict_networks {
        if let Some(unit) = message.unit.as_ref() {
            let normalized = normalize_whitespace(unit);
            if !normalized.is_empty() {
                networks.insert(NetworkKey::Label(normalized.to_uppercase()));
            }
        }
    }
    networks
}

fn parse_frequency(raw: &str) -> Option<f64> {
    let captures = FREQ_RE.captures(raw)?;
    let value = captures.get(1)?.as_str().replace(',', ".");
    value.parse::<f64>().ok()
}

fn format_date_time<Tz: TimeZone>(dt: chrono::DateTime<Tz>) -> (String, String)
where
    Tz::Offset: std::fmt::Display,
{
    let months = [
        "",
        "січня",
        "лютого",
        "березня",
        "квітня",
        "травня",
        "червня",
        "липня",
        "серпня",
        "вересня",
        "жовтня",
        "листопада",
        "грудня",
    ];
    let month_idx = dt.month() as usize;
    let month = months
        .get(month_idx)
        .unwrap_or(&"невідомого місяця")
        .to_owned()
        .to_string();
    let date = format!("{} {} {} року", dt.day(), month, dt.year());
    let time = dt.format("%H:%M").to_string();
    (date, time)
}

fn format_frequency(value: f64) -> String {
    let mut formatted = format!("{value:.3}");
    while formatted.contains('.') && formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

fn blank_paragraph() -> Paragraph {
    Paragraph::new().add_run(
        Run::new().add_text("").fonts(
            RunFonts::new()
                .ascii("Times New Roman")
                .east_asia("Times New Roman"),
        ),
    )
}

fn build_summary_paragraph(
    networks_count: usize,
    current_total: usize,
    previous_total: usize,
    freq_range: Option<(f64, f64)>,
) -> String {
    let mut summary = format!(
        "Протягом звітного періоду постами РЕР зафіксовано роботу {networks_count} УКХ радіомереж противника та здійснено {current_total} перехоплень (попередня доба — {previous_total})."
    );

    if let Some((min_freq, max_freq)) = freq_range {
        summary.push_str(&format!(
            " Окремими постами зафіксовано роботу радіомереж противника в діапазоні {}–{} МГц.",
            format_frequency(min_freq),
            format_frequency(max_freq)
        ));
    }

    summary
}
