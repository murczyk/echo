//! Supported upload formats and how each one is extracted.

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Extraction {
    /// Decoded and chunked in-process; no extractor round trip.
    LocalText,
    /// Sent to `echo-document-extractor` on the native path.
    Extractor,
    /// Raster image: OCR through the extractor plus a vision preview.
    Image,
}

const LOCAL_TEXT: &[&str] = &["txt", "md", "markdown", "csv", "json"];
const EXTRACTOR: &[&str] = &[
    "pdf", "docx", "doc", "rtf", "odt", "xlsx", "xlsm", "xls", "ods", "pptx",
    "ppt", "odp", "html", "htm", "xml", "zip", "rar", "7z",
];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "webp"];

pub(crate) fn extension(file_name: &str) -> String {
    std::path::Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub(crate) fn extraction(extension: &str) -> Option<Extraction> {
    if LOCAL_TEXT.contains(&extension) {
        Some(Extraction::LocalText)
    } else if EXTRACTOR.contains(&extension) {
        Some(Extraction::Extractor)
    } else if IMAGES.contains(&extension) {
        Some(Extraction::Image)
    } else {
        None
    }
}

pub(crate) fn is_image(extension: &str) -> bool {
    extraction(extension) == Some(Extraction::Image)
}

/// Comma-separated `accept` list for the browser file picker.
pub(crate) fn accepted_extensions() -> Vec<&'static str> {
    LOCAL_TEXT
        .iter()
        .chain(EXTRACTOR)
        .chain(IMAGES)
        .copied()
        .collect()
}

/// Rejects files whose bytes contradict their extension. Binary formats with
/// a reliable signature must match it; text formats must not be binaries.
pub(crate) fn validate_content(
    extension: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let sniffed = infer::get(bytes).map(|kind| kind.mime_type());
    let consistent = match extension {
        "png" => sniffed == Some("image/png"),
        "jpg" | "jpeg" => sniffed == Some("image/jpeg"),
        "webp" => sniffed == Some("image/webp"),
        "pdf" => sniffed == Some("application/pdf"),
        "docx" | "xlsx" | "xlsm" | "pptx" | "odt" | "ods" | "odp" | "zip" => {
            sniffed.is_some_and(|mime| {
                mime == "application/zip"
                    || mime.starts_with("application/vnd.openxmlformats")
                    || mime.starts_with("application/vnd.oasis.opendocument")
                    || mime.starts_with("application/vnd.ms-")
            })
        }
        "rar" => sniffed == Some("application/vnd.rar"),
        "7z" => sniffed == Some("application/x-7z-compressed"),
        _ if extraction(extension) == Some(Extraction::LocalText) => {
            sniffed.is_none_or(|mime| mime.starts_with("text/"))
        }
        _ => true,
    };
    if consistent {
        Ok(())
    } else {
        Err(AppError::BL {
            msg: "Вміст файлу не відповідає його розширенню".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions() {
        assert_eq!(extraction("md"), Some(Extraction::LocalText));
        assert_eq!(extraction("docx"), Some(Extraction::Extractor));
        assert_eq!(extraction("jpeg"), Some(Extraction::Image));
        assert_eq!(extraction("exe"), None);
        assert_eq!(extension("Звіт.Final.PDF"), "pdf");
        assert_eq!(extension("no-extension"), "");
    }

    #[test]
    fn rejects_mismatched_signatures() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert!(validate_content("png", png).is_ok());
        assert!(validate_content("pdf", png).is_err());
        assert!(validate_content("txt", png).is_err());
        assert!(validate_content("txt", "привіт".as_bytes()).is_ok());
        assert!(validate_content("pdf", b"%PDF-1.7\n").is_ok());
    }
}
