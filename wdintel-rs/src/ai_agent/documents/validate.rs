//! Checks a generated file before Echo stores it: a bounded Office Open XML
//! package whose main part is a regular (macro-free) Word document.

use crate::config::{
    AI_AGENT_DOCUMENT_ARCHIVE_MAX_ENTRIES,
    AI_AGENT_DOCUMENT_ARCHIVE_MAX_EXPANDED_BYTES,
    AI_AGENT_DOCUMENT_CONTENT_TYPES_MAX_BYTES,
    AI_AGENT_DOCUMENT_FILE_STEM_MAX_CHARS, AI_AGENT_DOCUMENT_MAX_BYTES,
};
use crate::error::AppError;
use quick_xml::events::Event;
use std::io::{Cursor, Read};

pub(super) const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAIN_PART_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CONTENT_TYPES_PART: &str = "[Content_Types].xml";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::BL {
        msg: message.into(),
    }
}

pub(super) fn validate_docx(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.is_empty() {
        return Err(invalid("Документ порожній"));
    }
    if bytes.len() > AI_AGENT_DOCUMENT_MAX_BYTES {
        return Err(invalid(format!(
            "Документ більший за {} МБ",
            AI_AGENT_DOCUMENT_MAX_BYTES / 1024 / 1024
        )));
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(invalid("Файл не є документом DOCX"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| invalid("Файл не є документом DOCX"))?;
    crate::utils::zip::validate_archive_limits(
        &mut archive,
        AI_AGENT_DOCUMENT_ARCHIVE_MAX_ENTRIES,
        AI_AGENT_DOCUMENT_ARCHIVE_MAX_EXPANDED_BYTES,
    )?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| invalid("Пошкоджений документ DOCX"))?;
        if entry.encrypted() {
            return Err(invalid("Зашифровані документи не підтримуються"));
        }
        if entry
            .name()
            .to_ascii_lowercase()
            .ends_with("vbaproject.bin")
        {
            return Err(invalid("Документи з макросами не підтримуються"));
        }
    }
    let main_part = main_part_name(&read_content_types(&mut archive)?)?;
    if archive.index_for_name(&main_part).is_none() {
        return Err(invalid("У документі немає основної частини"));
    }
    Ok(())
}

fn read_content_types(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
) -> Result<String, AppError> {
    let entry = archive
        .by_name(CONTENT_TYPES_PART)
        .map_err(|_| invalid("Файл не є документом DOCX"))?;
    let mut text = String::new();
    entry
        .take(AI_AGENT_DOCUMENT_CONTENT_TYPES_MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|_| invalid("Пошкоджений документ DOCX"))?;
    Ok(text)
}

/// The zip entry of the single Override declaring the Word main part; macro
/// and template main parts have other content types and are rejected.
fn main_part_name(content_types: &str) -> Result<String, AppError> {
    let mut reader = quick_xml::Reader::from_str(content_types);
    let mut parts = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element) | Event::Empty(element))
                if element.local_name().as_ref() == b"Override" =>
            {
                let mut part_name = None;
                let mut content_type = None;
                for attribute in element.attributes().flatten() {
                    let value = attribute
                        .unescape_value()
                        .map_err(|_| invalid("Пошкоджений документ DOCX"))?
                        .to_string();
                    match attribute.key.local_name().as_ref() {
                        b"PartName" => part_name = Some(value),
                        b"ContentType" => content_type = Some(value),
                        _ => {}
                    }
                }
                if content_type.as_deref() == Some(MAIN_PART_CONTENT_TYPE) {
                    parts.extend(part_name);
                } else if content_type.is_some_and(|value| {
                    value.contains("wordprocessingml.template.main")
                        || value.contains("macroEnabled")
                }) {
                    return Err(invalid(
                        "Підтримуються лише звичайні документи DOCX",
                    ));
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(invalid("Пошкоджений документ DOCX")),
        }
    }
    match parts.as_slice() {
        [part] => Ok(part.trim_start_matches('/').to_string()),
        _ => Err(invalid("Файл не є документом DOCX")),
    }
}

/// A safe download name ending in `.docx`: the requested name without its
/// directories and extension, or else the title.
pub(super) fn file_name(requested: Option<&str>, title: &str) -> String {
    let requested = requested.map(str::trim).filter(|name| !name.is_empty());
    let stem = match requested {
        Some(name) => {
            let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
            match base.rsplit_once('.') {
                Some((stem, extension))
                    if !stem.is_empty()
                        && extension.len() <= 5
                        && extension
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric()) =>
                {
                    stem
                }
                _ => base,
            }
        }
        None => title,
    };
    let stem = stem
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(
                    c,
                    '/' | '\\' | '"' | '<' | '>' | ':' | '|' | '?' | '*'
                )
            {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let stem = stem
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(AI_AGENT_DOCUMENT_FILE_STEM_MAX_CHARS)
        .collect::<String>();
    let stem = stem.trim_matches(['.', ' ']);
    if stem.is_empty() {
        "Документ.docx".to_string()
    } else {
        format!("{stem}.docx")
    }
}
