use crate::config::Config;
use crate::config::S3_MEDIA_ROOT_PREFIX;
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::storage;
use crate::types::ShortContext;
use echo_im::types::MessageAttachmentF1;
use opendal::Operator;
use sea_orm::{ActiveModelTrait, ConnectionTrait, NotSet, Set};
use std::path::Path;
use tokio::fs;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct MediaUploadInput {
    pub path: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
}

impl From<MessageAttachmentF1> for MediaUploadInput {
    fn from(value: MessageAttachmentF1) -> Self {
        Self {
            path: value.path,
            name: value.name,
            content_type: None,
        }
    }
}

fn guess_extension(name: Option<&str>, path: &Path) -> String {
    let ext = name
        .and_then(|n| Path::new(n).extension().map(|e| e.to_owned()))
        .or_else(|| path.extension().map(|e| e.to_owned()));
    ext.and_then(|os| os.to_str().map(|s| s.to_ascii_lowercase()))
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn fallback_file_name(name: Option<&str>, path: &Path) -> Option<String> {
    match name {
        Some(nm) if !nm.trim().is_empty() => Some(nm.to_string()),
        _ => path
            .file_name()
            .and_then(|v| v.to_str())
            .map(|s| s.to_string()),
    }
}

fn detect_content_type(name: Option<&str>, path: &Path, data: &[u8]) -> String {
    if let Some(ct) = name
        .and_then(|nm| mime_guess::from_path(nm).first_raw())
        .map(|s| s.to_string())
    {
        return ct;
    }
    if let Some(ct) = mime_guess::from_path(path).first_raw() {
        return ct.to_string();
    }
    if let Some(kind) = infer::get(data) {
        return kind.mime_type().to_string();
    }
    "application/octet-stream".to_string()
}

pub async fn store_media_attachments(
    attachments: &[MediaUploadInput],
    signal_message_id: i64,
    config: &Config,
    s3: &Operator,
    txn: &impl ConnectionTrait,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    if attachments.is_empty() {
        return Ok(vec![]);
    }
    let s3_config = storage::S3Config::from(config);
    let strongbox_key = &config.strongbox_key;
    let mut stored = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let data = fs::read(&attachment.path).await.c(h!())?;
        let ct = attachment.content_type.clone().unwrap_or_else(|| {
            detect_content_type(
                attachment.name.as_deref(),
                Path::new(&attachment.path),
                &data,
            )
        });
        let size_bytes = i64::try_from(data.len()).unwrap_or(data.len() as i64);
        let media_id = Uuid::now_v7();
        let ext = guess_extension(
            attachment.name.as_deref(),
            Path::new(&attachment.path),
        );
        let object_key =
            storage::nested_object_key(S3_MEDIA_ROOT_PREFIX, &media_id);

        storage::upload_encrypted_to_s3_with_operator(
            s3,
            &s3_config,
            strongbox_key,
            &object_key,
            &data,
        )
        .await?;

        let model = signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(signal_message_id),
            content_type: Set(ct),
            file_ext: Set(if ext.is_empty() {
                None
            } else {
                Some(ext.to_string())
            }),
            file_name: Set(fallback_file_name(
                attachment.name.as_deref(),
                Path::new(&attachment.path),
            )),
            size_bytes: Set(size_bytes),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
        stored.push(model);
    }
    Ok(stored)
}

pub async fn fetch_media_bytes(
    env: &crate::types::Env,
    media: &signal_message_media::Model,
) -> Result<Vec<u8>, AppError> {
    let s3_config = storage::S3Config::from(&env.config);
    let object_key = storage::nested_object_key(
        crate::config::S3_MEDIA_ROOT_PREFIX,
        &media.id,
    );
    storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &s3_config,
        &env.config.strongbox_key,
        &object_key,
    )
    .await
}
