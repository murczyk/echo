use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{get, post, HttpResponse, Responder};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use fs2::available_space;
use serde::{Deserialize, Serialize};
use std::env;
use std::hash::{Hash, Hasher};
use std::path::Path;

#[get("/api/ping")]
async fn ping() -> impl Responder {
    HttpResponse::Ok().body("pong")
}

fn changelog_path() -> Result<std::path::PathBuf, AppError> {
    let changelog_path = env::var(crate::config::CHANGELOG_ENV_PATH_KEY)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join(crate::config::CHANGELOG_DEFAULT_FILENAME)
        });
    Ok(changelog_path)
}

fn extract_next_preview(content: &str) -> Vec<String> {
    let mut preview = Vec::new();
    let mut in_next = false;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            if in_next {
                break;
            }
            in_next = line == "## NEXT";
            continue;
        }
        if !in_next {
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
    let without_links = strip_markdown_links(without_bullet);
    let without_tasks = strip_task_tokens(&without_links);
    let cleaned = without_tasks.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn strip_markdown_links(value: &str) -> String {
    let mut result = String::new();
    let mut cursor = 0;
    let bytes = value.as_bytes();
    while let Some(open_rel) = value[cursor..].find('[') {
        let open = cursor + open_rel;
        if let Some(mid_rel) = value[open + 1..].find("](") {
            let mid = open + 1 + mid_rel;
            if let Some(close_rel) = value[mid + 2..].find(')') {
                let close = mid + 2 + close_rel;
                result.push_str(&value[cursor..open]);
                let text = &value[open + 1..mid];
                let url = &value[mid + 2..close];
                if !url.contains("github.com") {
                    result.push_str(text);
                }
                cursor = close + 1;
                continue;
            }
        }
        break;
    }
    if cursor < bytes.len() {
        result.push_str(&value[cursor..]);
    }
    result
}

fn strip_task_tokens(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|token| !is_task_token(token))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_task_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| {
        !c.is_alphanumeric() && c != '#' && c != '-'
    });
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('#') {
        return trimmed
            .trim_start_matches('#')
            .chars()
            .all(|c| c.is_ascii_digit());
    }
    if trimmed.starts_with("https://github.com/") || trimmed.starts_with("http://github.com/") {
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
    let changelog_path = changelog_path()?;
    let content = tokio::fs::read_to_string(&changelog_path).await.c(h!())?;
    Ok(HttpResponse::Ok()
        .content_type("text/markdown; charset=utf-8")
        .body(content))
}

#[post("/api-public/changelog-preview")]
async fn changelog_preview() -> Result<Json<ChangelogPreview>, AppError> {
    let changelog_path = changelog_path()?;
    let content = tokio::fs::read_to_string(&changelog_path).await.c(h!())?;
    let preview = extract_next_preview(&content);
    let version = changelog_version(&content);
    Ok(Json(ChangelogPreview {
        version,
        preview,
        full_url: "/api-public/changelog".to_string(),
    }))
}

fn changelog_version(content: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut in_next = false;
    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        if line.starts_with("## ") {
            if in_next {
                break;
            }
            in_next = line == "## NEXT";
            continue;
        }
        if !in_next {
            continue;
        }
        line.hash(&mut hasher);
    }
    format!("next-{:#x}", hasher.finish())
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
