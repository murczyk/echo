use crate::config::{
    OCR_MAX_RESULT_BYTES, OCR_MAX_RESULT_ENTRIES, OCR_MAX_STORED_HTML_BYTES,
};
use crate::h;
use crate::types::ShortContext;
use ammonia::{Builder, UrlRelative};
use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Component, Path};
use std::sync::LazyLock;
use zip::ZipArchive;

static ASSET_SRC_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"src="(assets/[0-9a-f]{64}\.png)""#)
        .expect("valid OCR asset regex")
});

#[derive(Deserialize)]
struct PackageManifest {
    file_hashes: HashMap<String, String>,
}

pub fn stored_html_from_zip(bytes: Vec<u8>) -> anyhow::Result<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).c(h!())?;
    validate_archive_structure(&mut archive).c(h!())?;
    let manifest = read_manifest(&mut archive).c(h!())?;
    validate_manifest_hashes(&mut archive, &manifest).c(h!())?;
    let document_html = read_entry(&mut archive, "document.html").c(h!())?;
    let document_html = String::from_utf8(document_html).c(h!())?;
    let document_html = embed_assets(&mut archive, &document_html).c(h!())?;
    let document_html = sanitize_html(&document_html);
    if document_html.len() > OCR_MAX_STORED_HTML_BYTES {
        anyhow::bail!("sanitized OCR HTML exceeds the storage limit");
    }
    Ok(document_html)
}

pub fn sanitize_html(html: &str) -> String {
    let tags = HashSet::from([
        "article",
        "section",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "span",
        "br",
        "ol",
        "ul",
        "li",
        "table",
        "caption",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "figure",
        "figcaption",
        "img",
        "strong",
        "em",
        "b",
        "i",
    ]);
    let tag_attributes = HashMap::from([
        ("img", HashSet::from(["src", "alt"])),
        ("td", HashSet::from(["rowspan", "colspan"])),
        ("th", HashSet::from(["rowspan", "colspan"])),
        (
            "section",
            HashSet::from(["data-page-id", "data-source-page"]),
        ),
    ]);
    let mut builder = Builder::empty();
    builder
        .tags(tags)
        .tag_attributes(tag_attributes)
        .url_schemes(HashSet::from(["data"]))
        .url_relative(UrlRelative::Deny)
        .link_rel(None)
        .attribute_filter(|element, attribute, value| {
            if element == "img" && attribute == "src" {
                return is_png_data_url(value).then_some(Cow::Borrowed(value));
            }
            Some(Cow::Borrowed(value))
        });
    builder.clean(html).to_string()
}

fn validate_archive_structure(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
) -> anyhow::Result<()> {
    if archive.len() > OCR_MAX_RESULT_ENTRIES {
        anyhow::bail!("OCR package contains too many entries");
    }
    let mut names = HashSet::new();
    let mut expanded_size = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).c(h!())?;
        let name = file.name();
        if !names.insert(name.to_string()) || !safe_archive_name(name) {
            anyhow::bail!("OCR package contains an unsafe or duplicate entry");
        }
        if file.is_dir()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0o100000)
        {
            anyhow::bail!("OCR package contains a non-file entry");
        }
        expanded_size = expanded_size.checked_add(file.size()).c(h!())?;
        if expanded_size > OCR_MAX_RESULT_BYTES {
            anyhow::bail!("OCR package exceeds the expanded size limit");
        }
    }
    for required in [
        "manifest.json",
        "quality.json",
        "provenance.json",
        "document.html",
        "document.md",
    ] {
        if !names.contains(required) {
            anyhow::bail!("OCR package is missing {required}");
        }
    }
    Ok(())
}

fn read_manifest(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
) -> anyhow::Result<PackageManifest> {
    let bytes = read_entry(archive, "manifest.json").c(h!())?;
    serde_json::from_slice(&bytes).c(h!())
}

fn validate_manifest_hashes(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    manifest: &PackageManifest,
) -> anyhow::Result<()> {
    if manifest.file_hashes.len() + 1 != archive.len() {
        anyhow::bail!("OCR package manifest does not cover every entry");
    }
    for (name, expected_digest) in &manifest.file_hashes {
        if !safe_archive_name(name)
            || expected_digest.len() != 64
            || !expected_digest
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            anyhow::bail!("OCR package manifest contains invalid metadata");
        }
        let bytes = read_entry(archive, name).c(h!())?;
        if sha256::digest(&bytes) != *expected_digest {
            anyhow::bail!("OCR package checksum mismatch for {name}");
        }
    }
    Ok(())
}

fn embed_assets(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    document_html: &str,
) -> anyhow::Result<String> {
    let mut assets = HashMap::new();
    for captures in ASSET_SRC_RE.captures_iter(document_html) {
        let path = captures.get(1).c(h!())?.as_str();
        if assets.contains_key(path) {
            continue;
        }
        let bytes = read_entry(archive, path).c(h!())?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            anyhow::bail!("OCR package asset is not a PNG: {path}");
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        assets
            .insert(path.to_string(), format!("data:image/png;base64,{data}"));
    }
    let result = ASSET_SRC_RE
        .replace_all(document_html, |captures: &regex::Captures<'_>| {
            format!("src=\"{}\"", assets[captures.get(1).unwrap().as_str()])
        })
        .into_owned();
    Ok(result)
}

fn read_entry(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    name: &str,
) -> anyhow::Result<Vec<u8>> {
    let mut file = archive.by_name(name).c(h!())?;
    let capacity = usize::try_from(file.size()).c(h!())?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes).c(h!())?;
    Ok(bytes)
}

fn safe_archive_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && Path::new(name)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_png_data_url(value: &str) -> bool {
    value
        .strip_prefix("data:image/png;base64,")
        .is_some_and(|payload| {
            !payload.is_empty()
                && payload.bytes().all(|value| {
                    value.is_ascii_alphanumeric()
                        || matches!(value, b'+' | b'/' | b'=')
                })
        })
}

#[cfg(test)]
mod tests {
    use super::{sanitize_html, stored_html_from_zip};
    use std::collections::HashMap;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    fn canonical_package(extra_name: Option<&str>) -> Vec<u8> {
        let png = b"\x89PNG\r\n\x1a\nsmall-png".to_vec();
        let asset_name = format!("assets/{}.png", sha256::digest(&png));
        let entries = [
            (
                "document.html".to_string(),
                format!(
                    r#"<article><img src="{asset_name}"><script>alert(1)</script></article>"#,
                )
                .into_bytes(),
            ),
            ("document.md".to_string(), b"document".to_vec()),
            ("quality.json".to_string(), b"{}".to_vec()),
            ("provenance.json".to_string(), b"{}".to_vec()),
            (asset_name, png),
        ];
        let file_hashes = entries
            .iter()
            .map(|(name, bytes)| (name.clone(), sha256::digest(bytes)))
            .collect::<HashMap<_, _>>();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "file_hashes": file_hashes,
        }))
        .unwrap();
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            for (name, contents) in
                std::iter::once(("manifest.json".to_string(), manifest))
                    .chain(entries)
            {
                writer
                    .start_file(name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(&contents).unwrap();
            }
            if let Some(name) = extra_name {
                writer
                    .start_file(name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(b"unsafe").unwrap();
            }
            writer.finish().unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn sanitizer_removes_active_content_and_external_images() {
        let html = sanitize_html(
            r#"<article><script>alert(1)</script><img src="data:text/html,x"><img src="data:image/png;base64,AA==" onerror="alert(2)"><form><input></form></article>"#,
        );
        assert!(!html.contains("script"));
        assert!(!html.contains("data:text"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("form"));
        assert!(html.contains("data:image/png;base64,AA=="));
    }

    #[test]
    fn canonical_package_is_verified_embedded_and_sanitized() {
        let html = stored_html_from_zip(canonical_package(None)).unwrap();
        assert!(html.contains("data:image/png;base64,"));
        assert!(!html.contains("assets/"));
        assert!(!html.contains("script"));
    }

    #[test]
    fn canonical_package_rejects_traversal_entries() {
        let error = stored_html_from_zip(canonical_package(Some("../escape")))
            .unwrap_err();
        assert!(format!("{error:#}").contains("unsafe"));
    }
}
