use crate::config::Config;
use crate::entities::{signal_message_group, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::storage;
use crate::types::{error, warn};
use crate::types::{Env, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use echo_im::types::MessageAttachmentF1;
use opendal::Operator;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, NotSet, QueryFilter, QuerySelect, Set,
};
use std::io::ErrorKind;
use std::path::Path;
use tokio::fs;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct MediaUploadInput {
    pub path: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
}

pub struct StoreMediaAttachmentsResult {
    pub media: Vec<signal_message_media::Model>,
    pub skipped_missing: bool,
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

async fn read_attachment_data(path: &str) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path).await {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            warn!(
                "attachment file disappeared before upload, skipping: {path}"
            );
            Ok(None)
        }
        Err(error) => Err(anyhow::Error::from(error).context(h!()).into()),
    }
}

pub async fn store_media_attachments(
    attachments: &[MediaUploadInput],
    signal_message_id: i64,
    config: &Config,
    s3: &Option<Operator>,
    txn: &impl ConnectionTrait,
    delete_uploaded: bool,
) -> Result<StoreMediaAttachmentsResult, AppError> {
    if attachments.is_empty() {
        return Ok(StoreMediaAttachmentsResult {
            media: vec![],
            skipped_missing: false,
        });
    }
    let Some(config) = config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot store attachment!");
        return Ok(StoreMediaAttachmentsResult {
            media: vec![],
            skipped_missing: false,
        });
    };
    let s3_config = storage::S3Config::from(config);
    let strongbox_key = &config.strongbox_key;
    let mut stored = Vec::with_capacity(attachments.len());
    let mut skipped_missing = false;
    for attachment in attachments {
        let Some(data) = read_attachment_data(&attachment.path).await? else {
            skipped_missing = true;
            continue;
        };
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
        let object_key = storage::nested_object_key(&media_id);

        storage::upload_encrypted_to_s3_with_operator(
            s3,
            &s3_config,
            strongbox_key,
            &object_key,
            &data,
        )
        .await
        .c(h!())?;

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
    if delete_uploaded {
        delete_uploaded_attachment_files(attachments).await;
    }
    Ok(StoreMediaAttachmentsResult {
        media: stored,
        skipped_missing,
    })
}

pub async fn delete_uploaded_attachment_files(
    attachments: &[MediaUploadInput],
) {
    for attachment in attachments {
        if let Err(e) = tokio::fs::remove_file(&attachment.path).await {
            if e.kind() == ErrorKind::NotFound {
                continue;
            }
            error!(
                "failed to delete attachment file {}: {:?}",
                attachment.path, e
            );
        }
    }
}

pub(crate) async fn ensure_media_access(
    dbx: &DatabaseConnection,
    login: &str,
    signal_message_id: i64,
) -> Result<(), AppError> {
    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    let is_allowed = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey.eq_any(allowed_groups),
        )
        .select_only()
        .column(signal_message_group::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden("media access denied".into()))
    }
}

pub fn is_audio_media(media: &signal_message_media::Model) -> bool {
    let ct = media.content_type.to_ascii_lowercase();
    if ct.starts_with("audio/") {
        return true;
    }
    if ct.contains("mpeg") || ct.contains("mp3") {
        return true;
    }
    if let Some(ext) = media.file_ext.as_deref() {
        if matches!(
            ext.to_ascii_lowercase().as_str(),
            "mp3"
                | "mpeg"
                | "mpga"
                | "wav"
                | "ogg"
                | "oga"
                | "opus"
                | "m4a"
                | "aac"
                | "flac"
                | "webm"
        ) {
            return true;
        }
    }
    if let Some(name) = media.file_name.as_deref() {
        let name = name.to_ascii_lowercase();
        if name.ends_with(".mp3")
            || name.ends_with(".mpeg")
            || name.ends_with(".wav")
            || name.ends_with(".ogg")
            || name.ends_with(".m4a")
            || name.ends_with(".aac")
            || name.ends_with(".flac")
            || name.ends_with(".opus")
        {
            return true;
        }
    }
    false
}

pub async fn fetch_media_bytes(
    env: &crate::types::Env,
    media: &signal_message_media::Model,
) -> Result<Vec<u8>, AppError> {
    let Some(config) = env.config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot store attachment!");
        return Ok(vec![]);
    };
    let object_key = storage::nested_object_key(&media.id);
    storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &config.strongbox_key,
        &object_key,
    )
    .await
}

pub async fn fetch_media_bytes_by_key(
    env: &Env,
    object_key: &str,
) -> Result<Vec<u8>, AppError> {
    let Some(config) = env.config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot store attachment!");
        return Ok(vec![]);
    };
    storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &config.strongbox_key,
        object_key,
    )
    .await
}

pub async fn store_asset(
    env: &Env,
    data: &[u8],
    name: Option<&str>,
    content_type: Option<&str>,
) -> Result<String, AppError> {
    let config = env.config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let s3_config = env.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let _ct = content_type.map(|s| s.to_string()).unwrap_or_else(|| {
        detect_content_type(name, Path::new(name.unwrap_or("")), data)
    });
    let object_id = Uuid::now_v7();
    let ext = guess_extension(name, Path::new(name.unwrap_or("")));
    let object_key_base = storage::nested_object_key(&object_id);
    let object_key = if ext.is_empty() {
        object_key_base
    } else {
        format!("{object_key_base}.{ext}")
    };

    storage::upload_encrypted_to_s3_with_operator(
        &env.s3,
        s3_config,
        &config.strongbox_key,
        &object_key,
        data,
    )
    .await
    .c(h!())?;

    Ok(object_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_attachment_data_is_skipped() {
        let path = format!("/tmp/echo-missing-attachment-{}", Uuid::new_v4());

        assert!(read_attachment_data(&path).await.unwrap().is_none());
    }
}
