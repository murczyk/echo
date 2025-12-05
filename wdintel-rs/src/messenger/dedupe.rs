use log::warn;
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
    if !body.trim().is_empty() || attachments.is_empty() {
        return body.to_string();
    }

    let mut markers = Vec::new();
    for attachment in attachments {
        let path = attachment.attachment_path();
        let name = attachment_name(attachment);
        let size_bytes = match tokio::fs::metadata(path).await {
            Ok(meta) => Some(meta.len()),
            Err(e) => {
                warn!("failed to read attachment metadata for {path}: {e:?}");
                None
            }
        };
        let hash = match sha256::try_async_digest(Path::new(path)).await {
            Ok(hash) => Some(hash),
            Err(e) => {
                warn!("failed to hash attachment {path}: {e:?}");
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
        return body.to_string();
    }
    markers.sort();
    markers.join("\n")
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

impl AttachmentForDedupe for crate::entities::whatsapp_queue_attachment::Model {
    fn attachment_path(&self) -> &str {
        &self.path
    }

    fn attachment_name(&self) -> Option<&str> {
        None
    }
}
