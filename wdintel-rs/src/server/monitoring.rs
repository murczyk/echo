use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpResponse, Responder};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use fs2::available_space;
use log::warn;
use serde::{Deserialize, Serialize};
use std::env;
use std::hash::{Hash, Hasher};
use std::path::Path;

#[get("/api/ping")]
async fn ping() -> impl Responder {
    HttpResponse::Ok().body("pong")
}

fn is_date_heading(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix("## ") {
        let mut parts = rest.split_whitespace();
        if let Some(date) = parts.next() {
            let mut chars = date.chars();
            let y = chars.by_ref().take(4).all(|c| c.is_ascii_digit());
            let dash1 = chars.next() == Some('-');
            let m = chars.by_ref().take(2).all(|c| c.is_ascii_digit());
            let dash2 = chars.next() == Some('-');
            let d = chars.by_ref().take(2).all(|c| c.is_ascii_digit());
            return y && dash1 && m && dash2 && d && chars.next().is_none();
        }
    }
    false
}

fn changelog_paths() -> Vec<std::path::PathBuf> {
    if let Ok(path) = env::var(crate::config::CHANGELOG_ENV_PATH_KEY) {
        return vec![std::path::PathBuf::from(path)];
    }
    vec![
        std::path::PathBuf::from(".")
            .join(crate::config::CHANGELOG_DEFAULT_FILENAME),
        std::path::PathBuf::from(crate::config::CHANGELOG_PACKAGED_PATH),
    ]
}

async fn read_changelog_content() -> Result<String, AppError> {
    let mut errors = Vec::new();
    for changelog_path in changelog_paths() {
        match tokio::fs::read_to_string(&changelog_path).await {
            Ok(content) => return Ok(content),
            Err(err) => {
                errors.push(format!("{}: {}", changelog_path.display(), err))
            }
        }
    }
    warn!(
        "failed to read changelog from known paths, serving empty changelog: {}",
        errors.join(" | ")
    );
    Ok(String::new())
}

fn extract_dated_preview(content: &str) -> Vec<String> {
    let mut preview = Vec::new();
    let mut in_date_section = false;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            in_date_section = is_date_heading(line);
            if in_date_section {
                preview.push(line.to_string());
            }
            continue;
        }
        if !in_date_section {
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if let Some(cleaned_line) = sanitize_preview_line(line) {
            preview.push(cleaned_line);
            if preview.len() >= crate::config::CHANGELOG_PREVIEW_MAX_LINES {
                break;
            }
        }
    }
    preview
}

fn sanitize_preview_line(line: &str) -> Option<String> {
    let trimmed_line = line.trim();
    if trimmed_line.is_empty() {
        return None;
    }
    let without_bullet = trimmed_line
        .strip_prefix("- ")
        .or_else(|| trimmed_line.strip_prefix("* "))
        .unwrap_or(trimmed_line);
    let without_issue_ref = strip_issue_reference(without_bullet);
    let without_tasks = strip_task_tokens(&without_issue_ref);
    let cleaned = without_tasks.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn strip_issue_reference(line: &str) -> String {
    if line.starts_with("[#") {
        if let Some(close_link_index) = line.find(')') {
            return line[(close_link_index + 1)..].trim().to_string();
        }
    }
    line.to_string()
}

fn strip_task_tokens(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|token| !is_task_token(token))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_task_token(token: &str) -> bool {
    let trimmed = token
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '#' && c != '-');
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('#') {
        return trimmed
            .trim_start_matches('#')
            .chars()
            .all(|c| c.is_ascii_digit());
    }
    if trimmed.starts_with("https://github.com/")
        || trimmed.starts_with("http://github.com/")
    {
        return true;
    }
    if let Some(dash_index) = trimmed.find('-') {
        let (left, right) = trimmed.split_at(dash_index);
        let right = right.trim_start_matches('-');
        if !left.is_empty()
            && left.chars().all(|c| c.is_ascii_alphabetic())
            && !right.is_empty()
            && right.chars().all(|c| c.is_ascii_digit())
        {
            return true;
        }
    }
    false
}

#[get("/api-public/ping")]
async fn public_ping() -> impl Responder {
    HttpResponse::Ok().body("pong in public")
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ServerInfo {
    pub mode: String,
    pub public_host: String,
    pub grafana_address: String,
    pub feature_delta: bool,
    pub feature_analysis_map: bool,
    pub feature_rer_duty_short_state: bool,
    pub feature_strict_networks: bool,
    pub version: String,
}

#[post("/api-public/server-info")]
async fn server_info(
    env: actix_web::web::Data<Env>,
) -> Result<Json<ServerInfo>, AppError> {
    Ok(Json(ServerInfo {
        mode: env.mode.to_string(),
        public_host: env.config.public_host.clone(),
        grafana_address: format!("https://{}/grafana", env.config.public_host),
        feature_delta: env.config.feature_delta.unwrap_or(false),
        feature_analysis_map: env.config.feature_analysis_map.unwrap_or(true),
        feature_rer_duty_short_state: env
            .config
            .feature_rer_duty_short_state
            .unwrap_or(false),
        feature_strict_networks: env
            .config
            .feature_strict_networks
            .unwrap_or(false),
        version: env.version.clone(),
    }))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogPreview {
    pub version: String,
    pub preview: Vec<String>,
    pub full_url: String,
}

#[get("/api-public/changelog")]
async fn changelog_raw() -> Result<HttpResponse, AppError> {
    let content = read_changelog_content().await?;
    let html = format_public_changelog_html(&content);
    Ok(HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(html))
}

fn collect_public_changelog_sections(
    content: &str,
) -> Vec<(String, Vec<String>)> {
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    let mut in_date_section = false;
    let mut current_date = String::new();
    let mut current_items: Vec<String> = Vec::new();

    let push_current =
        |sections: &mut Vec<(String, Vec<String>)>,
         current_date: &mut String,
         current_items: &mut Vec<String>| {
            if !current_date.is_empty() {
                sections.push((
                    current_date.clone(),
                    std::mem::take(current_items),
                ));
                current_date.clear();
            }
        };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            if is_date_heading(line) {
                push_current(
                    &mut sections,
                    &mut current_date,
                    &mut current_items,
                );
                in_date_section = true;
                current_date = line
                    .trim_start_matches("## ")
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
            } else {
                push_current(
                    &mut sections,
                    &mut current_date,
                    &mut current_items,
                );
                in_date_section = false;
            }
            continue;
        }
        if !in_date_section {
            continue;
        }

        if let Some(description) = extract_issue_description(line) {
            current_items.push(description);
        }
    }

    push_current(&mut sections, &mut current_date, &mut current_items);
    sections
}

fn format_public_changelog_html(content: &str) -> String {
    let sections = collect_public_changelog_sections(content);
    let mut html = String::new();
    html.push_str(
        "<!doctype html><html lang=\"uk\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Оновлення</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:920px;margin:0 auto;padding:24px;line-height:1.5;color:#111}h1{margin:0 0 20px;font-size:30px}h2{margin:24px 0 8px;font-size:22px}ul{margin:0 0 8px 20px;padding:0}li{margin:6px 0}</style></head><body><h1>Оновлення</h1>",
    );

    for (date, items) in sections {
        html.push_str("<section>");
        html.push_str("<h2>");
        html.push_str(&html_escape(&date));
        html.push_str("</h2><ul>");
        for item in items {
            html.push_str("<li>");
            html.push_str(&html_escape(&item));
            html.push_str("</li>");
        }
        html.push_str("</ul></section>");
    }

    html.push_str("</body></html>");
    html
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn extract_issue_description(line: &str) -> Option<String> {
    if !is_issue_line(line) {
        return None;
    }

    let close_link_index = line.find(')')?;
    let rest = line[(close_link_index + 1)..].trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn is_issue_line(line: &str) -> bool {
    if !line.starts_with("- [#") {
        return false;
    }
    let mut parts = line.split("](");
    let _label = parts.next();
    let link_part = parts.next();
    if let Some(link_part) = link_part {
        return link_part.contains(')');
    }
    false
}

#[post("/api-public/changelog-preview")]
async fn changelog_preview() -> Result<Json<ChangelogPreview>, AppError> {
    let content = read_changelog_content().await?;
    let preview = extract_dated_preview(&content);
    let version = changelog_version(&content);
    let full_url = changelog_docs_url();
    Ok(Json(ChangelogPreview {
        version,
        preview,
        full_url,
    }))
}

fn changelog_docs_url() -> String {
    "/api-public/changelog".to_string()
}

fn changelog_version(content: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut in_date_section = false;
    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        if line.starts_with("## ") {
            in_date_section = is_date_heading(line);
            if in_date_section {
                line.hash(&mut hasher);
            }
            continue;
        }
        if !in_date_section {
            continue;
        }
        line.hash(&mut hasher);
    }
    format!("dated-{:#x}", hasher.finish())
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MonitoringDatasource {
    pub display_name: String,
    pub latest_signal_message_created_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Monitoring {
    pub datasources: Vec<MonitoringDatasource>,
    pub free_space_root_mb: i64,
}

#[post("/api/monitoring")]
async fn monitoring(
    env: actix_web::web::Data<Env>,
) -> Result<Json<Monitoring>, AppError> {
    let data = echo_im::collect_monitoring_data(&env.dbx).await.c(h!())?;
    let mut datasources = vec![];
    for d in data {
        datasources.push(MonitoringDatasource {
            display_name: d.display_name,
            latest_signal_message_created_at_ms: d.last_sync_at_ms,
        });
    }
    Ok(Json(Monitoring {
        datasources,
        free_space_root_mb: root_free_space_mb(),
    }))
}

fn root_free_space_mb() -> i64 {
    const BYTES_IN_MB: u64 = 1_048_576;
    let root_path = Path::new("/");
    match available_space(root_path) {
        Ok(bytes) => {
            let mb = bytes / BYTES_IN_MB;
            (mb.min(i64::MAX as u64)) as i64
        }
        Err(err) => {
            warn!(
                "Failed to read free space for root partition {}: {err}",
                root_path.display()
            );
            0
        }
    }
}
