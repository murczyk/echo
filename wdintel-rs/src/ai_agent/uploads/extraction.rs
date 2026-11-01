//! Turns an upload into searchable chunks.
//!
//! Plain text is chunked in-process. Everything else goes to the native path
//! of `echo-document-extractor`, which also OCRs PDFs and images.

use super::formats::{self, Extraction};
use crate::attachments::worker::{bounded_response, unpack, Package, Section};
use crate::config::{
    AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS, AI_AGENT_UPLOAD_WARNINGS_MAX,
    AI_AGENT_UPLOAD_WARNING_MAX_CHARS,
};
use crate::entities::{ai_agent_upload, ai_agent_upload_chunk};
use crate::h;
use crate::types::{Env, ShortContext};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter,
    TransactionTrait,
};
use uuid::Uuid;

pub(super) enum Step {
    /// Chunks are published; the upload is ready.
    Published,
    /// The extractor accepted or is still processing the job.
    Pending { extractor_job_id: Option<String> },
    /// The extractor is saturated; try again later without counting a failure.
    Busy,
    /// The file cannot be extracted; retrying would not help.
    Rejected(&'static str),
}

pub(super) async fn step(
    env: &Env,
    upload: &ai_agent_upload::Model,
) -> anyhow::Result<Step> {
    let extraction = formats::extraction(&upload.extension).c(h!())?;
    if extraction == Extraction::LocalText {
        let bytes = source_bytes(env, upload).await.c(h!())?;
        let Some(text) = decode_text(&bytes) else {
            return Ok(Step::Rejected(
                "Файл не є текстом у UTF-8, UTF-16 чи Windows-1251",
            ));
        };
        publish(env, upload, local_text(&upload.file_name, &text))
            .await
            .c(h!())?;
        return Ok(Step::Published);
    }
    let config = crate::attachments::store::extractor_config(env).c(h!())?;
    match &upload.extractor_job_id {
        Some(id) => poll(env, upload, &config, id).await.c(h!()),
        None => submit(env, upload, &config, extraction).await.c(h!()),
    }
}

async fn source_bytes(
    env: &Env,
    upload: &ai_agent_upload::Model,
) -> anyhow::Result<Vec<u8>> {
    crate::messenger::media::fetch_media_bytes_by_key(env, &upload.storage_key)
        .await
        .c(h!())
}

/// Mirrors the extractor's `decode_text`: UTF-16 with a BOM, then UTF-8, then
/// Windows-1251. Binary content (NUL bytes) is not text.
pub(super) fn decode_text(bytes: &[u8]) -> Option<String> {
    let utf16 = if bytes.starts_with(b"\xff\xfe") {
        Some(encoding_rs::UTF_16LE)
    } else if bytes.starts_with(b"\xfe\xff") {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    };
    let text = match utf16 {
        Some(encoding) => {
            let (text, malformed) =
                encoding.decode_without_bom_handling(&bytes[2..]);
            (!malformed).then(|| text.into_owned())?
        }
        None if bytes.contains(&0) => return None,
        None => match std::str::from_utf8(bytes) {
            Ok(text) => text.to_string(),
            Err(_) => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
        },
    };
    (!text.contains('\0')).then_some(text)
}

pub(super) fn local_text(file_name: &str, text: &str) -> Package {
    let text = text.trim_start_matches('\u{feff}');
    let mut sections = Vec::new();
    let mut current = String::new();
    let mut first_line = 1;
    let mut line_number = 0;
    let mut current_chars = 0;
    for line in text.lines() {
        line_number += 1;
        for piece in line_pieces(line) {
            let piece_chars = piece.chars().count();
            if !current.is_empty()
                && current_chars + piece_chars
                    > AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS
            {
                let last_line = if current.ends_with('\n') {
                    line_number - 1
                } else {
                    line_number
                };
                sections.push(text_section(
                    file_name,
                    first_line,
                    last_line,
                    std::mem::take(&mut current),
                ));
                current_chars = 0;
                first_line = line_number;
            }
            current.push_str(piece);
            current_chars += piece_chars;
        }
        current.push('\n');
        current_chars += 1;
    }
    if !current.trim().is_empty() {
        sections.push(text_section(
            file_name,
            first_line,
            line_number,
            current,
        ));
    }
    Package {
        sections,
        complete: true,
        ..Default::default()
    }
}

/// Splits a line into pieces of at most the chunk budget so one huge line
/// (minified JSON, CSV without breaks) cannot become an unreadable section.
fn line_pieces(line: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut rest = line;
    while rest.chars().count() > AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS {
        let split = rest
            .char_indices()
            .nth(AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS)
            .map_or(rest.len(), |(index, _)| index);
        let (piece, tail) = rest.split_at(split);
        pieces.push(piece);
        rest = tail;
    }
    pieces.push(rest);
    pieces
}

fn text_section(
    file_name: &str,
    first_line: usize,
    last_line: usize,
    text: String,
) -> Section {
    Section {
        member: file_name.to_string(),
        locator: format!("рядки {first_line}–{last_line}"),
        markdown: text.clone(),
        html: String::new(),
        text,
    }
}

async fn submit(
    env: &Env,
    upload: &ai_agent_upload::Model,
    config: &crate::ocr::OcrRuntimeConfig,
    extraction: Extraction,
) -> anyhow::Result<Step> {
    let mut bytes = source_bytes(env, upload).await.c(h!())?;
    let mut extension = upload.extension.clone();
    if extraction == Extraction::Image && extension == "webp" {
        bytes =
            tokio::task::spawn_blocking(move || super::image::to_png(&bytes))
                .await
                .c(h!())?
                .c(h!())?;
        extension = "png".to_string();
    }
    let name = format!("document.{extension}");
    let manifest = serde_json::json!({
        "schema_version": 1,
        "inputs": [name],
        "metadata": { "attachment_native": true },
    });
    let response = env
        .rq
        .post(format!("{}/v1/jobs", config.base_url))
        .bearer_auth(&config.token)
        .header(
            "Idempotency-Key",
            format!("ai-upload-{}-{}", config.instance_id, upload.id),
        )
        .multipart(
            reqwest::multipart::Form::new()
                .part(
                    "files",
                    reqwest::multipart::Part::bytes(bytes).file_name(name),
                )
                .text("manifest", manifest.to_string()),
        )
        .send()
        .await
        .c(h!())?;
    if extractor_busy(response.status()) {
        return Ok(Step::Busy);
    }
    let job: serde_json::Value =
        response.error_for_status().c(h!())?.json().await.c(h!())?;
    Ok(Step::Pending {
        extractor_job_id: Some(job["id"].as_str().c(h!())?.to_string()),
    })
}

async fn poll(
    env: &Env,
    upload: &ai_agent_upload::Model,
    config: &crate::ocr::OcrRuntimeConfig,
    id: &str,
) -> anyhow::Result<Step> {
    let response = env
        .rq
        .get(format!("{}/v1/jobs/{id}", config.base_url))
        .bearer_auth(&config.token)
        .send()
        .await
        .c(h!())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // The extractor lost the job (restart or retention); submit again.
        return Ok(Step::Pending {
            extractor_job_id: None,
        });
    }
    if extractor_busy(response.status()) {
        return Ok(Step::Busy);
    }
    let status: serde_json::Value =
        response.error_for_status().c(h!())?.json().await.c(h!())?;
    match status["state"].as_str() {
        Some("completed") => {
            let response = env
                .rq
                .get(format!("{}/v1/jobs/{id}/result", config.base_url))
                .bearer_auth(&config.token)
                .send()
                .await
                .c(h!())?
                .error_for_status()
                .c(h!())?;
            let bytes = bounded_response(response).await.c(h!())?;
            let mut package = unpack(&bytes).c(h!())?;
            rename_members(&mut package, &upload.file_name);
            publish(env, upload, package).await.c(h!())?;
            Ok(Step::Published)
        }
        Some("failed" | "cancelled") => anyhow::bail!(
            "document extractor failed: {}",
            status["error_summary"]
        ),
        _ => Ok(Step::Pending {
            extractor_job_id: Some(id.to_string()),
        }),
    }
}

/// Archives can produce one warning per member; keep the stored list within
/// the runner's payload contract.
fn bounded_warnings(warnings: Vec<String>) -> Vec<String> {
    let total = warnings.len();
    let mut bounded = warnings
        .into_iter()
        .take(AI_AGENT_UPLOAD_WARNINGS_MAX)
        .map(|warning| {
            warning
                .chars()
                .take(AI_AGENT_UPLOAD_WARNING_MAX_CHARS)
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    if total > bounded.len() {
        bounded.truncate(AI_AGENT_UPLOAD_WARNINGS_MAX - 1);
        bounded.push(format!(
            "Ще {} попереджень пропущено",
            total - bounded.len()
        ));
    }
    bounded
}

fn extractor_busy(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::TOO_MANY_REQUESTS
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::INSUFFICIENT_STORAGE
    )
}

/// The extractor sees `document.<ext>`; show the user's file name instead.
fn rename_members(package: &mut Package, file_name: &str) {
    for section in &mut package.sections {
        section.member = match section.member.split_once("!/") {
            Some((_, member)) => format!("{file_name}!/{member}"),
            None => file_name.to_string(),
        };
    }
}

async fn publish(
    env: &Env,
    upload: &ai_agent_upload::Model,
    package: Package,
) -> anyhow::Result<()> {
    let txn = env.dbx.begin().await.c(h!())?;
    ai_agent_upload_chunk::Entity::delete_many()
        .filter(ai_agent_upload_chunk::Column::UploadId.eq(upload.id))
        .exec(&txn)
        .await
        .c(h!())?;
    let mut text_chars = 0_i64;
    let sections = package
        .sections
        .into_iter()
        .filter(|section| !section.text.trim().is_empty())
        .collect::<Vec<_>>();
    for (ordinal, section) in sections.iter().enumerate() {
        text_chars += section.text.chars().count() as i64;
        ai_agent_upload_chunk::ActiveModel {
            id: Set(Uuid::now_v7()),
            upload_id: Set(upload.id),
            ordinal: Set(ordinal as i32),
            member: Set(section.member.clone()),
            locator: Set(section.locator.clone()),
            text: Set(section.text.clone()),
            markdown: Set(if section.markdown.trim().is_empty() {
                section.text.clone()
            } else {
                section.markdown.clone()
            }),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }
    let mut warnings = bounded_warnings(package.warnings);
    if sections.is_empty() {
        warnings.push("Текст у файлі не знайдено".to_string());
    }
    ai_agent_upload::Entity::update_many()
        .col_expr(ai_agent_upload::Column::State, "ready".into())
        .col_expr(
            ai_agent_upload::Column::ChunkCount,
            (sections.len() as i32).into(),
        )
        .col_expr(ai_agent_upload::Column::TextChars, text_chars.into())
        .col_expr(
            ai_agent_upload::Column::Warnings,
            serde_json::to_value(warnings).c(h!())?.into(),
        )
        .col_expr(
            ai_agent_upload::Column::LastError,
            Option::<String>::None.into(),
        )
        .col_expr(ai_agent_upload::Column::Lease, Option::<Uuid>::None.into())
        .col_expr(
            ai_agent_upload::Column::LeaseUntil,
            Option::<chrono::NaiveDateTime>::None.into(),
        )
        .col_expr(
            ai_agent_upload::Column::UpdatedAt,
            chrono::Utc::now().naive_utc().into(),
        )
        .filter(ai_agent_upload::Column::Id.eq(upload.id))
        .filter(ai_agent_upload::Column::Lease.eq(upload.lease))
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_text_splits_on_lines_within_budget() {
        let line = "а".repeat(3_000);
        let text = format!("\u{feff}{line}\n{line}\n{line}\n");
        let package = local_text("notes.txt", &text);
        assert_eq!(package.sections.len(), 2);
        assert_eq!(package.sections[0].locator, "рядки 1–2");
        assert_eq!(package.sections[1].locator, "рядки 3–3");
        assert!(!package.sections[0].text.starts_with('\u{feff}'));
        assert!(package.sections.iter().all(|section| {
            section.text.chars().count()
                <= AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS + 2
        }));
        let minified = format!("{{\"a\":\"{}\"}}", "я".repeat(20_000));
        let package = local_text("data.json", &minified);
        assert_eq!(package.sections.len(), 3);
        assert!(package.sections.iter().all(|section| {
            section.text.chars().count()
                <= AI_AGENT_UPLOAD_LOCAL_CHUNK_MAX_CHARS + 1
                && section.locator == "рядки 1–1"
        }));
        let joined = package
            .sections
            .iter()
            .map(|section| section.text.trim_end_matches('\n'))
            .collect::<String>();
        assert_eq!(joined, minified);
    }

    #[test]
    fn issue_3962_decodes_supported_text_encodings() {
        let (cp1251, _, _) = encoding_rs::WINDOWS_1251.encode("Зведення: Київ");
        assert_eq!(decode_text(&cp1251).unwrap(), "Зведення: Київ");
        let mut utf16 = vec![0xff, 0xfe];
        for unit in "Звіт, ok".encode_utf16() {
            utf16.extend(unit.to_le_bytes());
        }
        assert_eq!(decode_text(&utf16).unwrap(), "Звіт, ok");
        assert_eq!(decode_text("Звіт".as_bytes()).unwrap(), "Звіт");
        assert!(decode_text(b"PK\x03\x04\0\0binary").is_none());
        let warnings = bounded_warnings(
            (0..60)
                .map(|index| format!("member {index}: unsupported"))
                .collect(),
        );
        assert_eq!(warnings.len(), AI_AGENT_UPLOAD_WARNINGS_MAX);
        assert_eq!(warnings.last().unwrap(), "Ще 41 попереджень пропущено");
    }

    #[test]
    fn renames_extractor_members() {
        let mut package = Package {
            sections: vec![
                text_section("document.zip", 1, 1, "x".into()),
                text_section("document.zip!/inner/a.docx", 1, 1, "y".into()),
            ],
            ..Default::default()
        };
        rename_members(&mut package, "архів.zip");
        assert_eq!(package.sections[0].member, "архів.zip");
        assert_eq!(package.sections[1].member, "архів.zip!/inner/a.docx");
    }
}
