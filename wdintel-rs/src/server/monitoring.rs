use crate::error::AppError;
use crate::types::*;
use actix_files::NamedFile;
use actix_web::web::Json;
use actix_web::{get, post, HttpRequest, HttpResponse, Responder};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use fs2::available_space;
use log::warn;
use pulldown_cmark::{html, Options, Parser};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::env;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::sync::RwLock;

#[get("/api/ping")]
async fn ping() -> impl Responder {
    HttpResponse::Ok().body("pong")
}

fn parse_changelog_updates_blocks_cached(
    content: &str,
) -> Vec<ParsedUpdatesBlock> {
    let content_hash = hash_text(content);

    if let Ok(cache_guard) = updates_blocks_cache().read() {
        if let Some(cache) = cache_guard.as_ref() {
            if cache.content_hash == content_hash {
                return cache.blocks.clone();
            }
        }
    }

    let blocks = parse_changelog_updates_blocks(content);

    if let Ok(mut cache_guard) = updates_blocks_cache().write() {
        *cache_guard = Some(ParsedUpdatesCache {
            content_hash,
            blocks: blocks.clone(),
        });
    }

    blocks
}

fn updates_blocks_cache() -> &'static RwLock<Option<ParsedUpdatesCache>> {
    static CACHE: OnceLock<RwLock<Option<ParsedUpdatesCache>>> =
        OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn hash_text(content: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

fn changelog_item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(.+)$")
            .expect("valid changelog item regex")
    })
}

fn updates_image_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").expect("valid image regex")
    })
}

fn updates_video_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"<video[^>]*src=[\"']([^\"']+)[\"'][^>]*/?>"#)
            .expect("valid video regex")
    })
}

fn updates_html_src_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\bsrc\s*=\s*[\"']([^\"']+)[\"']"#)
            .expect("valid html src regex")
    })
}

fn updates_self_closing_video_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)<video([^>]*)/>"#)
            .expect("valid self closing video regex")
    })
}

async fn read_changelog_updates_content() -> Result<String, AppError> {
    let mut errors = Vec::new();
    for updates_path in changelog_updates_paths() {
        match tokio::fs::read_to_string(&updates_path).await {
            Ok(content) => return Ok(content),
            Err(err) => {
                errors.push(format!("{}: {}", updates_path.display(), err))
            }
        }
    }
    warn!(
        "failed to read changelog updates from known paths, serving empty details: {}",
        errors.join(" | ")
    );
    Ok(String::new())
}

fn strip_leading_markers(value: &str) -> String {
    value
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim_start()
        .to_string()
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
        return vec![PathBuf::from(path)];
    }
    vec![
        PathBuf::from(".").join(crate::config::CHANGELOG_DEFAULT_FILENAME),
        PathBuf::from("..").join(crate::config::CHANGELOG_DEFAULT_FILENAME),
    ]
}

fn changelog_updates_paths() -> Vec<PathBuf> {
    if let Ok(path) = env::var(crate::config::CHANGELOG_UPDATES_ENV_PATH_KEY) {
        return vec![PathBuf::from(path)];
    }
    vec![
        PathBuf::from(".")
            .join(crate::config::CHANGELOG_UPDATES_DEFAULT_FILENAME),
        PathBuf::from("..")
            .join(crate::config::CHANGELOG_UPDATES_DEFAULT_FILENAME),
    ]
}

fn changelog_updates_media_paths() -> Vec<PathBuf> {
    if let Ok(path) =
        env::var(crate::config::CHANGELOG_UPDATES_MEDIA_ENV_PATH_KEY)
    {
        return vec![PathBuf::from(path)];
    }
    vec![
        PathBuf::from(".")
            .join(crate::config::CHANGELOG_UPDATES_MEDIA_DEFAULT_DIR),
        PathBuf::from("..")
            .join(crate::config::CHANGELOG_UPDATES_MEDIA_DEFAULT_DIR),
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
    let mut current_date: Option<String> = None;
    let mut current_items: Vec<String> = Vec::new();

    let flush_section =
        |preview: &mut Vec<String>,
         current_date: &mut Option<String>,
         current_items: &mut Vec<String>| {
            if current_items.is_empty() {
                current_date.take();
                return;
            }

            if let Some(date) = current_date.take() {
                preview.push(format!("## {date}"));
                preview.extend(std::mem::take(current_items));
            }
        };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            let is_date = is_date_heading(line);
            if !is_date {
                flush_section(
                    &mut preview,
                    &mut current_date,
                    &mut current_items,
                );
                in_date_section = false;
                continue;
            }

            if in_date_section {
                flush_section(
                    &mut preview,
                    &mut current_date,
                    &mut current_items,
                );
            }

            in_date_section = true;
            current_date = Some(line.trim_start_matches("## ").to_string());

            if preview.len() >= crate::config::CHANGELOG_PREVIEW_MAX_LINES {
                break;
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
            current_items.push(cleaned_line);

            if preview.len() + current_items.len() + 1
                >= crate::config::CHANGELOG_PREVIEW_MAX_LINES
            {
                flush_section(
                    &mut preview,
                    &mut current_date,
                    &mut current_items,
                );
            }

            if preview.len() >= crate::config::CHANGELOG_PREVIEW_MAX_LINES {
                break;
            }
        }
    }

    flush_section(&mut preview, &mut current_date, &mut current_items);
    preview.truncate(crate::config::CHANGELOG_PREVIEW_MAX_LINES);
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
    let without_markers = strip_leading_markers(&without_issue_ref);
    let without_tasks = strip_task_tokens(&without_markers);
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

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogSection {
    pub date: String,
    pub items: Vec<ChangelogEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogEntry {
    pub entry_id: String,
    pub task_ref: String,
    pub url: String,
    pub title: String,
    pub has_details: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogDetailsReq {
    pub task_ref: String,
    pub url: String,
    pub title: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogMedia {
    pub kind: String,
    pub url: String,
    pub alt: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ChangelogItemDetails {
    pub description: String,
    pub media: Vec<ChangelogMedia>,
    pub content_html: String,
}

#[derive(Debug, Clone)]
struct ParsedUpdatesBlock {
    task_ref: String,
    url: String,
    title: String,
    details: ChangelogItemDetails,
}

#[derive(Debug, Clone)]
struct ParsedUpdatesCache {
    content_hash: u64,
    blocks: Vec<ParsedUpdatesBlock>,
}

#[get("/api-public/changelog")]
async fn changelog_raw() -> Result<Json<Vec<ChangelogSection>>, AppError> {
    let changelog_content = read_changelog_content().await?;
    let updates_content = read_changelog_updates_content().await?;
    let updates_blocks =
        parse_changelog_updates_blocks_cached(&updates_content);
    let sections =
        collect_public_changelog_sections(&changelog_content, &updates_blocks);
    Ok(Json(sections))
}

#[post("/api-public/changelog-details")]
async fn changelog_details(
    req: Json<ChangelogDetailsReq>,
) -> Result<Json<Option<ChangelogItemDetails>>, AppError> {
    let updates_content = read_changelog_updates_content().await?;
    let updates_blocks =
        parse_changelog_updates_blocks_cached(&updates_content);
    let details = find_matching_updates_block(&req, &updates_blocks)
        .map(|block| block.details.clone());
    Ok(Json(details))
}

#[get("/api-public/changelog-details/{detail_key}")]
async fn changelog_details_by_key(
    req: HttpRequest,
) -> Result<Json<Option<ChangelogItemDetails>>, AppError> {
    let detail_key = req.match_info().query("detail_key").trim();
    if !is_safe_detail_key(detail_key) {
        return Ok(Json(None));
    }

    let changelog_content = read_changelog_content().await?;
    let updates_content = read_changelog_updates_content().await?;
    let updates_blocks =
        parse_changelog_updates_blocks_cached(&updates_content);

    let details = find_details_by_entry_key(
        detail_key,
        &changelog_content,
        &updates_blocks,
    );

    Ok(Json(details))
}

#[get("/api-public/changelog-media/{path:.*}")]
async fn changelog_media(req: HttpRequest) -> Result<impl Responder, AppError> {
    let requested = req.match_info().query("path");
    let Ok(relative_path) = parse_safe_relative_path(requested) else {
        return Ok(HttpResponse::NotFound().body("Media not found"));
    };

    for media_root in changelog_updates_media_paths() {
        let local_path = media_root.join(&relative_path);
        if local_path.is_file() {
            if let Ok(named_file) = NamedFile::open(local_path) {
                return Ok(named_file.into_response(&req));
            }
        }
    }

    Ok(HttpResponse::NotFound().body("Media not found"))
}

fn collect_public_changelog_sections(
    content: &str,
    updates_blocks: &[ParsedUpdatesBlock],
) -> Vec<ChangelogSection> {
    let mut sections: Vec<ChangelogSection> = Vec::new();
    let mut in_date_section = false;
    let mut current_date = String::new();
    let mut current_items: Vec<ChangelogEntry> = Vec::new();

    let mut entry_index = 0usize;

    let push_current =
        |sections: &mut Vec<ChangelogSection>,
         current_date: &mut String,
         current_items: &mut Vec<ChangelogEntry>| {
            if !current_date.is_empty() && !current_items.is_empty() {
                sections.push(ChangelogSection {
                    date: current_date.clone(),
                    items: std::mem::take(current_items),
                });
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

        if let Some((task_ref, url, title)) = parse_changelog_item_line(line) {
            let req = ChangelogDetailsReq {
                task_ref: task_ref.clone(),
                url: url.clone(),
                title: title.clone(),
            };
            let has_details =
                find_matching_updates_block(&req, updates_blocks).is_some();
            current_items.push(ChangelogEntry {
                entry_id: build_entry_id(&current_date, entry_index, &task_ref),
                task_ref,
                url,
                title,
                has_details,
            });
            entry_index += 1;
        }
    }

    push_current(&mut sections, &mut current_date, &mut current_items);
    sections
}

fn parse_changelog_item_line(line: &str) -> Option<(String, String, String)> {
    let trimmed_line = line.trim();
    let line_regex = changelog_item_regex();
    let captures = line_regex.captures(trimmed_line)?;
    let task_ref = captures.get(1)?.as_str().trim().to_string();
    let url = captures.get(2)?.as_str().trim().to_string();
    let raw_title = captures.get(3)?.as_str().trim();
    let title = sanitize_changelog_title(raw_title);
    if task_ref.is_empty() || url.is_empty() || title.is_empty() {
        return None;
    }
    Some((task_ref, url, title))
}

fn sanitize_changelog_title(raw_title: &str) -> String {
    let without_issue_ref = strip_issue_reference(raw_title);
    let without_tasks = strip_task_tokens(&without_issue_ref);
    let without_markers = strip_leading_markers(&without_tasks);
    let without_symbol_noise: String = without_markers
        .chars()
        .filter(|&ch| {
            ch.is_alphanumeric()
                || ch.is_whitespace()
                || matches!(
                    ch,
                    '.' | ','
                        | ':'
                        | ';'
                        | '!'
                        | '?'
                        | '('
                        | ')'
                        | '/'
                        | '-'
                        | '–'
                        | '—'
                        | '"'
                        | '\''
                        | '№'
                        | '%'
                )
        })
        .collect();

    without_symbol_noise
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_changelog_updates_blocks(content: &str) -> Vec<ParsedUpdatesBlock> {
    let mut blocks = Vec::new();
    let mut current_header: Option<(String, String, String)> = None;
    let mut current_body: Vec<String> = Vec::new();

    let flush = |blocks: &mut Vec<ParsedUpdatesBlock>,
                 current_header: &mut Option<(String, String, String)>,
                 current_body: &mut Vec<String>| {
        let Some((task_ref, url, title)) = current_header.take() else {
            current_body.clear();
            return;
        };

        let details = parse_updates_body(current_body);
        blocks.push(ParsedUpdatesBlock {
            task_ref,
            url,
            title,
            details,
        });
        current_body.clear();
    };

    for raw_line in content.lines() {
        if let Some(header) = parse_changelog_item_line(raw_line) {
            flush(&mut blocks, &mut current_header, &mut current_body);
            current_header = Some(header);
            continue;
        }

        if current_header.is_some() {
            current_body.push(raw_line.to_string());
        }
    }

    flush(&mut blocks, &mut current_header, &mut current_body);
    blocks
}

fn parse_updates_body(lines: &[String]) -> ChangelogItemDetails {
    let normalized_lines: Vec<String> = lines
        .iter()
        .map(|line| normalize_updates_line(line))
        .collect();

    let markdown_content = normalized_lines.join("\n").trim().to_string();

    let mut description_lines = Vec::new();
    let mut media = Vec::new();

    let image_regex = updates_image_regex();
    let video_regex = updates_video_regex();

    for line in &normalized_lines {
        for captures in image_regex.captures_iter(line) {
            let alt = captures
                .get(1)
                .map(|group| group.as_str().trim().to_string())
                .unwrap_or_default();
            let source = captures
                .get(2)
                .map(|group| group.as_str().trim().to_string())
                .unwrap_or_default();
            if !source.is_empty() {
                media.push(ChangelogMedia {
                    kind: "image".to_string(),
                    url: normalize_media_url(&source),
                    alt,
                });
            }
        }

        for captures in video_regex.captures_iter(line) {
            let source = captures
                .get(1)
                .map(|group| group.as_str().trim().to_string())
                .unwrap_or_default();
            if !source.is_empty() {
                media.push(ChangelogMedia {
                    kind: "video".to_string(),
                    url: normalize_media_url(&source),
                    alt: "video".to_string(),
                });
            }
        }

        let without_images = image_regex.replace_all(line, "");
        let without_media = video_regex.replace_all(&without_images, "");
        let cleaned_line = without_media.trim_end().to_string();
        if !cleaned_line.trim().is_empty() {
            description_lines.push(cleaned_line);
        }
    }

    ChangelogItemDetails {
        description: description_lines.join("\n").trim().to_string(),
        media,
        content_html: render_updates_markdown_html(&markdown_content),
    }
}

fn normalize_updates_line(line: &str) -> String {
    let image_regex = updates_image_regex();
    let normalized_images =
        image_regex.replace_all(line, |captures: &regex::Captures| {
            let alt = captures
                .get(1)
                .map(|group| group.as_str())
                .unwrap_or_default();
            let source = captures
                .get(2)
                .map(|group| group.as_str())
                .unwrap_or_default();
            format!("![{alt}]({})", normalize_media_url(source))
        });

    let normalized_html_sources =
        normalize_html_media_sources(&normalized_images);

    normalize_video_line(&normalized_html_sources)
}

fn normalize_html_media_sources(line: &str) -> String {
    let src_regex = updates_html_src_regex();
    src_regex
        .replace_all(line, |captures: &regex::Captures| {
            let source = captures
                .get(1)
                .map(|group| group.as_str())
                .unwrap_or_default();
            format!("src=\"{}\"", normalize_media_url(source))
        })
        .to_string()
}

fn normalize_video_line(line: &str) -> String {
    let Some(src_marker_start) = line.find("src=") else {
        return line.to_string();
    };

    let Some(quote_char) = line[src_marker_start + 4..].chars().next() else {
        return line.to_string();
    };

    if quote_char != '"' && quote_char != '\'' {
        return line.to_string();
    }

    let source_start = src_marker_start + 5;
    let Some(source_end_rel) = line[source_start..].find(quote_char) else {
        return line.to_string();
    };
    let source_end = source_start + source_end_rel;

    let normalized = normalize_media_url(&line[source_start..source_end]);

    let mut out = String::new();
    out.push_str(&line[..source_start]);
    out.push_str(&normalized);
    out.push_str(&line[source_end..]);

    if out.contains("<video") {
        out = updates_self_closing_video_regex()
            .replace_all(&out, "<video$1></video>")
            .to_string();
    }

    out
}

fn render_updates_markdown_html(markdown_content: &str) -> String {
    if markdown_content.trim().is_empty() {
        return String::new();
    }

    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(markdown_content, options);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);
    html_output
}

fn find_matching_updates_block<'a>(
    req: &ChangelogDetailsReq,
    blocks: &'a [ParsedUpdatesBlock],
) -> Option<&'a ParsedUpdatesBlock> {
    let req_task_ref = normalize_match_text(&req.task_ref);
    if !req_task_ref.is_empty() {
        if let Some(found_block) = blocks
            .iter()
            .find(|block| normalize_match_text(&block.task_ref) == req_task_ref)
        {
            return Some(found_block);
        }
    }

    let req_url = req.url.trim();
    if !req_url.is_empty() {
        if let Some(found_block) =
            blocks.iter().find(|block| block.url == req_url)
        {
            return Some(found_block);
        }
    }

    let req_title = normalize_match_text(&req.title);
    if req_title.is_empty() {
        return None;
    }

    blocks.iter().find(|block| {
        let block_title = normalize_match_text(&block.title);
        !block_title.is_empty()
            && (block_title == req_title
                || block_title.contains(&req_title)
                || req_title.contains(&block_title))
    })
}

fn find_details_by_entry_key(
    detail_key: &str,
    changelog_content: &str,
    updates_blocks: &[ParsedUpdatesBlock],
) -> Option<ChangelogItemDetails> {
    let mut in_date_section = false;
    let mut current_date = String::new();
    let mut entry_index = 0usize;

    for raw_line in changelog_content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            if is_date_heading(line) {
                in_date_section = true;
                current_date = line
                    .trim_start_matches("## ")
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
            } else {
                in_date_section = false;
            }
            continue;
        }

        if !in_date_section {
            continue;
        }

        if let Some((task_ref, url, title)) = parse_changelog_item_line(line) {
            let entry_id =
                build_entry_id(&current_date, entry_index, &task_ref);
            if entry_id == detail_key {
                let req = ChangelogDetailsReq {
                    task_ref,
                    url,
                    title,
                };
                return find_matching_updates_block(&req, updates_blocks)
                    .map(|block| block.details.clone());
            }
            entry_index += 1;
        }
    }

    None
}

fn is_safe_detail_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn normalize_match_text(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_media_url(source: &str) -> String {
    let trimmed = source.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if trimmed.starts_with("/api-public/changelog-media/") {
        return trimmed.to_string();
    }

    let normalized = trimmed.trim_start_matches("./");
    let relative = normalized
        .strip_prefix("media/")
        .unwrap_or(normalized)
        .trim_start_matches('/');
    format!("/api-public/changelog-media/{relative}")
}

fn parse_safe_relative_path(requested_path: &str) -> Result<PathBuf, AppError> {
    let candidate = PathBuf::from(requested_path);
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir
                | Component::RootDir
                | Component::Prefix(_)
                | Component::CurDir
        )
    }) {
        return Err(AppError::BL {
            msg: "unsafe media path".to_string(),
        });
    }
    Ok(candidate)
}

fn build_entry_id(date: &str, entry_index: usize, task_ref: &str) -> String {
    format!(
        "changelog-{}-{}-{}",
        sanitize_entry_id_fragment(date),
        entry_index,
        sanitize_entry_id_fragment(task_ref)
    )
}

fn sanitize_entry_id_fragment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    cleaned.trim_matches('-').to_string()
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
    "/updates".to_string()
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
