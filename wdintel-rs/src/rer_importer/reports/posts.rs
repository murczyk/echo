use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::get_inbox_messages_with_conn;
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::rer_importer::types::InboxMessage;
use crate::types::{Env, ShortContext};
use crate::utils::dt_zoned_from_millis;
use actix_identity::Identity;
use anyhow::Context;
use chrono::{Datelike, TimeZone};
use docx_rs::*;
use once_cell::sync::Lazy;
use regex::Regex;
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
    current_total: usize,
    previous_total: usize,
    networks: BTreeSet<NetworkKey>,
}

pub async fn report_docx_kind_posts(
    user: Identity,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let read_db = env.replica();
    let login = user.id().c(h!())?;
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .c(h!())?;

    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };

    let mut current_req = req.req.clone();
    current_req.return_duplicates = Some(false);

    let current_messages = get_inbox_messages_with_conn(
        &read_db,
        &login,
        &logins,
        env,
        &current_req,
    )
    .await
    .c(h!())?;

    let previous_req = build_shifted_req(&current_req, -DAY_MS)?;
    let previous_messages = get_inbox_messages_with_conn(
        &read_db,
        &login,
        &logins,
        env,
        &previous_req,
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
            entry.networks.insert(network_key.clone());
            overall_networks.insert(network_key);
        }

        if let Some(freq) = message
            .freq
            .as_ref()
            .and_then(|value| parse_frequency(value))
        {
            freq_values.push(freq);
        }
    }

    let mut previous_by_post: BTreeMap<String, usize> = BTreeMap::new();
    for (_, message) in &previous_messages {
        let post_name = normalized_post_name(message);
        *previous_by_post.entry(post_name).or_default() += 1;
    }

    for (post_name, count) in previous_by_post {
        posts.entry(post_name).or_default().previous_total = count;
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

    let freq_range = if freq_values.is_empty() {
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
    };

    let date_from_local =
        dt_zoned_from_millis(since_date_inclusive_ms).context(h!())?;
    let date_to_local =
        dt_zoned_from_millis(till_date_inclusive_ms).context(h!())?;

    let (date_from_txt, time_from_txt) = format_date_time(date_from_local);
    let (date_to_txt, time_to_txt) = format_date_time(date_to_local);

    let summary_paragraph_text = build_summary_paragraph(
        overall_networks.len(),
        current_total,
        previous_total,
        freq_range,
    );

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

    for (post_name, stats) in posts_vec {
        let paragraph = Paragraph::new()
            .add_run(
                Run::new()
                    .add_text(&post_name)
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
                        stats.networks.len()
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

    let file = std::fs::File::create(outpath)?;
    doc.build()
        .pack(file)
        .map_err(anyhow::Error::from)
        .context(h!())?;

    Ok(())
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
