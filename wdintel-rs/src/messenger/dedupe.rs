use crate::types::warn;
use base64::{engine::general_purpose, Engine as _};
use sha256;
use std::path::Path;

pub trait AttachmentForDedupe {
    fn attachment_path(&self) -> &str;
    fn attachment_name(&self) -> Option<&str>;
}

pub async fn body_with_attachment_markers<A>(
    body: &str,
    attachments: &[A],
) -> String
where
    A: AttachmentForDedupe,
{
    let attachments_hash = attachments_hash(attachments).await;
    body_with_attachments_hash(body, attachments_hash.as_deref())
}

pub fn body_with_attachments_hash(
    body: &str,
    attachments_hash: Option<&str>,
) -> String {
    let Some(attachments_hash) = attachments_hash else {
        return body.to_string();
    };
    if body.trim().is_empty() {
        attachments_hash.to_string()
    } else {
        format!("{body}\n{attachments_hash}")
    }
}

pub fn redis_key_for_body_for_dedupe(body_for_dedupe: &str) -> String {
    let body_base64 =
        general_purpose::STANDARD.encode(body_for_dedupe.as_bytes());
    format!("signal_message:{body_base64}")
}

pub fn redis_key_for_body_with_attachments_hash(
    body: &str,
    attachments_hash: Option<&str>,
) -> String {
    redis_key_for_body_for_dedupe(&body_with_attachments_hash(
        body,
        attachments_hash,
    ))
}

pub async fn attachments_hash<A>(attachments: &[A]) -> Option<String>
where
    A: AttachmentForDedupe,
{
    if attachments.is_empty() {
        return None;
    }
    let mut markers = Vec::new();
    for attachment in attachments {
        let path = attachment.attachment_path();
        let name = attachment_name(attachment);
        let size_bytes = match tokio::fs::metadata(path).await {
            Ok(meta) => Some(meta.len()),
            Err(e) => {
                warn!("failed to read attachment metadata for {path}: {:?}", e);
                None
            }
        };
        let hash = match sha256::try_async_digest(Path::new(path)).await {
            Ok(hash) => Some(hash),
            Err(e) => {
                warn!("failed to hash attachment {path}: {:?}", e);
                None
            }
        };

        if let Some(hash) = hash {
            markers.push(format!("[attachment sha256:{hash}]"));
            continue;
        }

        if size_bytes.is_none() && name.is_none() {
            warn!("unable to build attachment marker for {path}");
            continue;
        }

        let mut parts = Vec::new();
        if let Some(name) = name {
            parts.push(format!("name:{name}"));
        }
        if let Some(size_bytes) = size_bytes {
            parts.push(format!("size:{size_bytes}"));
        }
        markers.push(format!("[attachment {}]", parts.join(" ")));
    }

    if markers.is_empty() {
        return None;
    }
    markers.sort();
    Some(markers.join("\n"))
}

fn attachment_name<A: AttachmentForDedupe>(attachment: &A) -> Option<String> {
    attachment
        .attachment_name()
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.to_string())
        .or_else(|| {
            Path::new(attachment.attachment_path())
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_string())
        })
}

impl AttachmentForDedupe for echo_im::types::MessageAttachmentF1 {
    fn attachment_path(&self) -> &str {
        &self.path
    }

    fn attachment_name(&self) -> Option<&str> {
        self.name.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use tokio::io::AsyncWriteExt;

    struct TestAttachment {
        path: String,
        name: Option<String>,
    }

    impl AttachmentForDedupe for TestAttachment {
        fn attachment_path(&self) -> &str {
            &self.path
        }

        fn attachment_name(&self) -> Option<&str> {
            self.name.as_deref()
        }
    }

    async fn write_temp_file(data: &[u8]) -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let mut tokio_file =
            tokio::fs::File::create(file.path()).await.unwrap();
        tokio_file.write_all(data).await.unwrap();
        tokio_file.flush().await.unwrap();
        file
    }

    #[tokio::test]
    async fn appends_attachment_hash_markers_to_non_empty_body() {
        let file = write_temp_file(b"payload").await;
        let attachment = TestAttachment {
            path: file.path().display().to_string(),
            name: Some("photo.jpg".to_string()),
        };

        let body =
            body_with_attachment_markers("2026-07-07", &[attachment]).await;

        assert_eq!(
            body,
            format!(
                "2026-07-07\n[attachment sha256:{}]",
                sha256::digest(b"payload")
            )
        );
    }

    #[tokio::test]
    async fn keeps_media_only_dedupe_body_as_attachment_markers() {
        let file = write_temp_file(b"payload").await;
        let attachment = TestAttachment {
            path: file.path().display().to_string(),
            name: Some("photo.jpg".to_string()),
        };

        let body = body_with_attachment_markers("", &[attachment]).await;

        assert_eq!(
            body,
            format!("[attachment sha256:{}]", sha256::digest(b"payload"))
        );
    }
}
