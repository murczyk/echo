use crate::config::Config;
use crate::entities::{
    datasource_group, intel_product, signal_message, signal_message_group,
    signal_message_media,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::dedupe;
use crate::sigint::sender::preferred_message_author_expr;
use crate::storage;
use crate::types::{error, warn};
use crate::types::{Env, ShortContext};
use echo_im::types::MessageAttachmentF1;
use opendal::Operator;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, ExprTrait, NotSet, QueryFilter, QuerySelect, RelationTrait,
    Set,
};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::io::SeekFrom;
use std::path::Path;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
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
    pub uploaded_files_ready_for_deletion: Vec<MediaUploadInput>,
}

struct StagedMediaAttachment {
    id: Uuid,
    content_type: String,
    file_ext: Option<String>,
    file_name: Option<String>,
    size_bytes: i64,
    is_encrypted: bool,
    storage_key: String,
    upload_input: MediaUploadInput,
    retains_thumbnail_source: bool,
    thumbnail_source_lease:
        Option<crate::messenger::media_thumbnail::ThumbnailSourceLease>,
}

pub struct StagedMediaAttachments {
    attachments_hash: Option<String>,
    attachments: Vec<StagedMediaAttachment>,
    input_count: usize,
    skipped_missing: bool,
    deletion: UploadedAttachmentDeletion,
}

impl StagedMediaAttachments {
    pub(crate) fn without_uploaded_objects(
        input_count: usize,
        attachments_hash: Option<String>,
        deletion: UploadedAttachmentDeletion,
    ) -> Self {
        Self {
            attachments_hash,
            attachments: vec![],
            input_count,
            skipped_missing: false,
            deletion,
        }
    }

    pub fn len(&self) -> usize {
        self.input_count
    }

    pub fn is_empty(&self) -> bool {
        self.input_count == 0
    }

    pub fn attachments_hash(&self) -> Option<&str> {
        self.attachments_hash.as_deref()
    }

    pub fn skipped_missing(&self) -> bool {
        self.skipped_missing
    }

    pub(crate) fn uploaded_files_ready_after_discard(
        &self,
    ) -> Vec<MediaUploadInput> {
        if !self.deletion.should_delete() {
            return vec![];
        }
        self.attachments
            .iter()
            .map(|attachment| attachment.upload_input.clone())
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn uploaded_object_count(&self) -> usize {
        self.attachments.len()
    }

    fn uploaded_files_ready_for_deletion(&self) -> Vec<MediaUploadInput> {
        let retained_paths = self
            .attachments
            .iter()
            .filter(|attachment| attachment.retains_thumbnail_source)
            .map(|attachment| attachment.upload_input.path.as_str())
            .collect::<HashSet<_>>();
        self.attachments
            .iter()
            .filter(|attachment| {
                !retained_paths.contains(attachment.upload_input.path.as_str())
            })
            .map(|attachment| attachment.upload_input.clone())
            .collect()
    }

    pub async fn cleanup_after_rollback(
        &self,
        config: &Config,
        s3: &Option<Operator>,
    ) {
        for attachment in &self.attachments {
            delete_staged_object_best_effort(config, s3, attachment).await;
            if attachment.thumbnail_source_lease.is_some() {
                crate::messenger::media_thumbnail::remove_uncommitted_media_thumbnail_files_best_effort(
                    config,
                    attachment.id,
                )
                .await;
            }
        }
    }

    pub async fn finalize_after_commit(
        &self,
        config: &Config,
        s3: &Option<Operator>,
        dbx: &DatabaseConnection,
    ) {
        if self.attachments.is_empty() {
            return;
        }
        let media_ids = self
            .attachments
            .iter()
            .map(|attachment| attachment.id)
            .collect::<Vec<_>>();
        let committed_media = signal_message_media::Entity::find()
            .filter(signal_message_media::Column::Id.is_in(media_ids))
            .all(dbx)
            .await;
        let committed_media = match committed_media {
            Ok(committed_media) => committed_media
                .into_iter()
                .map(|media| media.id)
                .collect::<HashSet<_>>(),
            Err(err) => {
                error!(
                    "failed to check committed staged media references; preserving uploaded objects and local files: {:?}",
                    err
                );
                return;
            }
        };
        for attachment in self
            .attachments
            .iter()
            .filter(|attachment| !committed_media.contains(&attachment.id))
        {
            delete_staged_object_best_effort(config, s3, attachment).await;
            if attachment.thumbnail_source_lease.is_some() {
                crate::messenger::media_thumbnail::remove_uncommitted_media_thumbnail_files_best_effort(
                    config,
                    attachment.id,
                )
                .await;
            }
        }
        if !self.deletion.should_delete() {
            return;
        }
        let retained_paths = self
            .attachments
            .iter()
            .filter(|attachment| {
                committed_media.contains(&attachment.id)
                    && attachment.retains_thumbnail_source
            })
            .map(|attachment| attachment.upload_input.path.as_str())
            .collect::<HashSet<_>>();
        let uploaded_files_ready_for_deletion = self
            .attachments
            .iter()
            .filter(|attachment| {
                committed_media.contains(&attachment.id)
                    && !retained_paths
                        .contains(attachment.upload_input.path.as_str())
            })
            .map(|attachment| attachment.upload_input.clone())
            .collect::<Vec<_>>();
        delete_uploaded_attachment_files(&uploaded_files_ready_for_deletion)
            .await;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadedAttachmentDeletion {
    Preserve,
    DeleteAfterStore,
    DeleteAfterCommit,
}

impl UploadedAttachmentDeletion {
    fn should_delete(self) -> bool {
        self != Self::Preserve
    }
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

impl dedupe::AttachmentForDedupe for MediaUploadInput {
    fn attachment_path(&self) -> &str {
        &self.path
    }

    fn attachment_name(&self) -> Option<&str> {
        self.name.as_deref()
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

fn media_upload_is_excluded_from_encryption(
    attachment: &MediaUploadInput,
    guessed_extension: &str,
) -> bool {
    if attachment
        .content_type
        .as_deref()
        .is_some_and(content_type_is_explicit_non_video_media)
    {
        return false;
    }
    is_encryption_excluded_metadata(
        attachment.content_type.as_deref().unwrap_or_default(),
        (!guessed_extension.is_empty()).then_some(guessed_extension),
        attachment.name.as_deref(),
    ) || Path::new(&attachment.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(extension_is_excluded_from_encryption)
}

fn detect_content_type(name: Option<&str>, path: &Path, data: &[u8]) -> String {
    detect_content_type_from_probe(name, path, probed_content_type(data))
}

fn detect_content_type_from_probe(
    name: Option<&str>,
    path: &Path,
    probed_content_type: Option<&str>,
) -> String {
    if let Some(content_type) = probed_content_type.filter(|content_type| {
        content_type_is_excluded_from_encryption(content_type)
    }) {
        return content_type.to_string();
    }

    let mut generic_guess = None;
    for path in name.map(Path::new).into_iter().chain(std::iter::once(path)) {
        if path_has_ambiguous_video_extension(path) {
            continue;
        }
        let Some(content_type) = mime_guess::from_path(path).first_raw() else {
            continue;
        };
        if !content_type_is_generic(content_type) {
            return content_type.to_string();
        }
        generic_guess.get_or_insert(content_type);
    }
    probed_content_type
        .or(generic_guess)
        .unwrap_or("application/octet-stream")
        .to_string()
}

fn resolve_attachment_content_type(
    attachment: &MediaUploadInput,
    probed_content_type: Option<&str>,
) -> String {
    let detected_content_type = detect_content_type_from_probe(
        attachment.name.as_deref(),
        Path::new(&attachment.path),
        probed_content_type,
    );
    if let Some(content_type) = attachment.content_type.as_deref() {
        if content_type_describes_media(content_type) {
            return content_type.to_string();
        }
        if !content_type.trim().is_empty()
            && !content_type_is_generic(content_type)
            && !content_type_is_excluded_from_encryption(&detected_content_type)
        {
            return content_type.to_string();
        }
    }
    detected_content_type
}

fn content_type_describes_media(content_type: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    content_type.starts_with("audio/")
        || content_type.starts_with("image/")
        || content_type.starts_with("video/")
        || content_type_is_excluded_from_encryption(&content_type)
}

fn content_type_is_generic(content_type: &str) -> bool {
    matches!(
        content_type
            .split(';')
            .next()
            .unwrap_or(content_type)
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "application/octet-stream"
            | "application/binary"
            | "binary/octet-stream"
    )
}

fn content_type_is_explicit_non_video_media(content_type: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    content_type.starts_with("audio/") || content_type.starts_with("image/")
}

fn path_has_ambiguous_video_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            crate::config::MESSENGER_MEDIA_AMBIGUOUS_VIDEO_FILE_EXTENSIONS
                .iter()
                .any(|ambiguous| extension.eq_ignore_ascii_case(ambiguous))
        })
}

fn probed_content_type(data: &[u8]) -> Option<&'static str> {
    if is_mpeg_transport_stream(data) {
        return Some("video/mp2t");
    }
    infer::get(data).map(|kind| kind.mime_type())
}

pub(crate) fn device_content_probe_is_excluded_video(data: &[u8]) -> bool {
    probed_content_type(data)
        .is_some_and(content_type_is_excluded_from_encryption)
}

fn is_mpeg_transport_stream(data: &[u8]) -> bool {
    crate::config::MESSENGER_MEDIA_MPEG_TS_PACKET_LAYOUTS
        .iter()
        .any(|(sync_offset, packet_size)| {
            (0..crate::config::MESSENGER_MEDIA_MPEG_TS_PROBE_MIN_PACKETS).all(
                |packet_index| {
                    data.get(sync_offset + packet_index * packet_size)
                        == Some(&0x47)
                },
            )
        })
}

enum PreparedAttachmentData {
    Encrypted(Vec<u8>),
    Plaintext { file: fs::File },
}

struct PreparedAttachment {
    data: PreparedAttachmentData,
    size_bytes: i64,
    is_encrypted: bool,
    probed_content_type: Option<&'static str>,
}

async fn prepare_attachment(
    path: &str,
    force_plaintext: bool,
    allow_probed_video_exclusion: bool,
) -> Result<Option<PreparedAttachment>, AppError> {
    let mut file = match fs::File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .await
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            warn!(
                "attachment file disappeared before upload, skipping: {path}"
            );
            return Ok(None);
        }
        Err(error) => {
            return Err(anyhow::Error::from(error).context(h!()).into());
        }
    };
    let metadata = file.metadata().await.c(h!())?;
    if !metadata.is_file() {
        return Err(AppError::BL {
            msg: "attachment source is not a regular file".to_string(),
        });
    }
    let size_bytes = i64::try_from(metadata.len()).c(h!())?;
    let mut probe =
        vec![0; crate::config::MESSENGER_MEDIA_CONTENT_TYPE_PROBE_SIZE_BYTES];
    let read = file.read(&mut probe).await.c(h!())?;
    probe.truncate(read);
    file.seek(SeekFrom::Start(0)).await.c(h!())?;
    let probed_content_type = probed_content_type(&probe);
    let detected_excluded_media = allow_probed_video_exclusion
        && probed_content_type
            .is_some_and(content_type_is_excluded_from_encryption);
    let is_encrypted = should_encrypt_media(
        size_bytes,
        force_plaintext || detected_excluded_media,
    );
    let data = if is_encrypted {
        let expected_size = usize::try_from(size_bytes).c(h!())?;
        let read_limit = u64::try_from(expected_size)
            .c(h!())?
            .checked_add(1)
            .c(h!())?;
        let mut data = Vec::with_capacity(expected_size);
        file.take(read_limit).read_to_end(&mut data).await.c(h!())?;
        if data.len() != expected_size {
            return Err(AppError::BL {
                msg: format!(
                    "attachment changed while reading {path}: expected {expected_size} bytes, read {}",
                    data.len()
                ),
            });
        }
        PreparedAttachmentData::Encrypted(data)
    } else {
        PreparedAttachmentData::Plaintext { file }
    };
    Ok(Some(PreparedAttachment {
        data,
        size_bytes,
        is_encrypted,
        probed_content_type,
    }))
}

pub fn should_encrypt_media(size_bytes: i64, force_plaintext: bool) -> bool {
    !force_plaintext
        && size_bytes
            <= crate::config::MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES
}

async fn upload_prepared_attachment(
    s3: &Option<Operator>,
    s3_config: &storage::S3Config,
    strongbox_key: &str,
    object_key: &str,
    data: PreparedAttachmentData,
    size_bytes: i64,
) -> Result<(), AppError> {
    match data {
        PreparedAttachmentData::Encrypted(data) => {
            storage::upload_encrypted_to_s3_with_operator(
                s3,
                s3_config,
                strongbox_key,
                object_key,
                data.into(),
            )
            .await
        }
        PreparedAttachmentData::Plaintext { file } => {
            storage::upload_plaintext_file_to_s3_with_operator(
                s3,
                s3_config,
                object_key,
                file,
                u64::try_from(size_bytes).c(h!())?,
            )
            .await
        }
    }
}

pub async fn store_media_attachments(
    attachments: &[MediaUploadInput],
    signal_message_id: i64,
    signal_message_uuid: Option<Uuid>,
    config: &Config,
    s3: &Option<Operator>,
    txn: &impl ConnectionTrait,
    deletion: UploadedAttachmentDeletion,
) -> Result<StoreMediaAttachmentsResult, AppError> {
    let staged =
        stage_media_attachments(attachments, config, s3, deletion, None)
            .await
            .c(h!())?;
    let media = match persist_staged_media(
        &staged,
        signal_message_id,
        signal_message_uuid,
        txn,
    )
    .await
    {
        Ok(media) => media,
        Err(err) => {
            staged.cleanup_after_rollback(config, s3).await;
            return Err(err);
        }
    };
    let uploaded_files_ready_for_deletion =
        staged.uploaded_files_ready_for_deletion();
    if deletion == UploadedAttachmentDeletion::DeleteAfterStore {
        delete_uploaded_attachment_files(&uploaded_files_ready_for_deletion)
            .await;
    }
    Ok(StoreMediaAttachmentsResult {
        media,
        skipped_missing: staged.skipped_missing,
        uploaded_files_ready_for_deletion,
    })
}

pub async fn stage_media_attachments(
    attachments: &[MediaUploadInput],
    config: &Config,
    s3: &Option<Operator>,
    deletion: UploadedAttachmentDeletion,
    attachments_hash: Option<String>,
) -> Result<StagedMediaAttachments, AppError> {
    let mut staged = StagedMediaAttachments {
        attachments_hash,
        attachments: Vec::with_capacity(attachments.len()),
        input_count: attachments.len(),
        skipped_missing: false,
        deletion,
    };
    if attachments.is_empty() {
        return Ok(staged);
    }
    let Some(s3_config) = config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot store attachment!");
        return Ok(staged);
    };
    let storage_config = storage::S3Config::from(s3_config);
    for attachment in attachments {
        match stage_media_attachment(
            attachment,
            config,
            s3,
            s3_config,
            &storage_config,
            deletion,
        )
        .await
        {
            Ok(Some(attachment)) => staged.attachments.push(attachment),
            Ok(None) => staged.skipped_missing = true,
            Err(err) => {
                staged.cleanup_after_rollback(config, s3).await;
                return Err(err);
            }
        }
    }
    Ok(staged)
}

async fn stage_media_attachment(
    attachment: &MediaUploadInput,
    config: &Config,
    s3: &Option<Operator>,
    s3_config: &crate::config::S3Config,
    storage_config: &storage::S3Config,
    deletion: UploadedAttachmentDeletion,
) -> Result<Option<StagedMediaAttachment>, AppError> {
    let source_lease = crate::sigint::file_upload::lock_uploaded_source(
        Path::new(&attachment.path),
    )
    .await
    .c(h!())?;
    let ext = guess_extension(
        attachment.name.as_deref(),
        Path::new(&attachment.path),
    );
    let force_plaintext =
        media_upload_is_excluded_from_encryption(attachment, &ext);
    let allow_probed_video_exclusion = !attachment
        .content_type
        .as_deref()
        .is_some_and(content_type_is_explicit_non_video_media);
    let Some(prepared) = prepare_attachment(
        &attachment.path,
        force_plaintext,
        allow_probed_video_exclusion,
    )
    .await?
    else {
        if source_lease.is_some() {
            return Err(AppError::BL { msg: "attachment upload expired or was removed before submission; upload it again".to_string() });
        }
        return Ok(None);
    };
    let content_type = resolve_attachment_content_type(
        attachment,
        prepared.probed_content_type,
    );
    let id = Uuid::now_v7();
    let file_ext = (!ext.is_empty()).then_some(ext);
    let file_name = fallback_file_name(
        attachment.name.as_deref(),
        Path::new(&attachment.path),
    );
    let storage_key = if prepared.is_encrypted {
        storage::nested_object_key(&id)
    } else {
        storage::plaintext_media_object_key(&id)
    };
    let is_video = is_video_metadata(
        &content_type,
        file_ext.as_deref(),
        file_name.as_deref(),
    );
    let size_bytes = prepared.size_bytes;
    let is_encrypted = prepared.is_encrypted;
    if let Err(err) = upload_prepared_attachment(
        s3,
        storage_config,
        &s3_config.strongbox_key,
        &storage_key,
        prepared.data,
        size_bytes,
    )
    .await
    {
        delete_staged_storage_key_best_effort(config, s3, &storage_key).await;
        return Err(err);
    }
    let mut thumbnail_source_lease = None;
    let mut retains_thumbnail_source = false;
    if is_video {
        thumbnail_source_lease = Some(
            crate::messenger::media_thumbnail::ThumbnailSourceLease::new(id),
        );
        match crate::messenger::media_thumbnail::stage_upload_thumbnail_source_file(
            config,
            id,
            Path::new(&attachment.path),
            size_bytes,
            deletion.should_delete(),
        )
        .await
        {
            Ok(crate::messenger::media_thumbnail::UploadThumbnailSourceStage::Independent) => {}
            Ok(crate::messenger::media_thumbnail::UploadThumbnailSourceStage::Referenced) => {
                retains_thumbnail_source = true;
            }
            Err(err) => {
                warn!(
                    "failed to stage upload thumbnail source for media {id}: {err:#?}"
                );
            }
        }
    }
    Ok(Some(StagedMediaAttachment {
        id,
        content_type,
        file_ext,
        file_name,
        size_bytes,
        is_encrypted,
        storage_key,
        upload_input: attachment.clone(),
        retains_thumbnail_source,
        thumbnail_source_lease,
    }))
}

pub async fn persist_staged_media(
    staged: &StagedMediaAttachments,
    signal_message_id: i64,
    signal_message_uuid: Option<Uuid>,
    txn: &impl ConnectionTrait,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    let mut media = Vec::with_capacity(staged.attachments.len());
    for attachment in &staged.attachments {
        media.push(
            signal_message_media::ActiveModel {
                id: Set(attachment.id),
                signal_message_id: Set(signal_message_id),
                signal_message_uuid: Set(signal_message_uuid),
                content_type: Set(attachment.content_type.clone()),
                file_ext: Set(attachment.file_ext.clone()),
                file_name: Set(attachment.file_name.clone()),
                size_bytes: Set(attachment.size_bytes),
                is_encrypted: Set(attachment.is_encrypted),
                storage_key: Set(Some(attachment.storage_key.clone())),
                created_at: NotSet,
            }
            .insert(txn)
            .await
            .c(h!())?,
        );
    }
    Ok(media)
}

async fn delete_staged_object_best_effort(
    config: &Config,
    s3: &Option<Operator>,
    attachment: &StagedMediaAttachment,
) {
    delete_staged_storage_key_best_effort(config, s3, &attachment.storage_key)
        .await;
}

async fn delete_staged_storage_key_best_effort(
    config: &Config,
    s3: &Option<Operator>,
    storage_key: &str,
) {
    let (Some(s3_config), Some(s3)) = (config.s3_config.as_ref(), s3) else {
        return;
    };
    let remote_key =
        storage::S3Config::from(s3_config).prefixed_key(storage_key);
    if let Err(err) = s3.delete(&remote_key).await {
        error!(
            "failed to delete uncommitted staged media object {}: {:?}",
            remote_key, err
        );
    }
}

pub async fn delete_uploaded_attachment_files(
    attachments: &[MediaUploadInput],
) {
    for attachment in attachments {
        match crate::sigint::file_upload::remove_consumed_upload(
            std::path::Path::new(&attachment.path),
        )
        .await
        {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                error!(
                    "failed to delete attachment upload {}: {error:?}",
                    attachment.path
                );
                continue;
            }
        }
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

pub async fn delete_stored_media_files(
    media: &[signal_message_media::Model],
    ocr_result_keys: &[String],
    config: &Config,
    s3: &Option<Operator>,
) {
    if media.is_empty() && ocr_result_keys.is_empty() {
        return;
    }
    let Some(config) = config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot delete attachment files!");
        return;
    };
    let s3_config = storage::S3Config::from(config);
    let Some(s3) = s3 else {
        warn!("S3 is not configured, cannot delete attachment files!");
        return;
    };
    for media in media {
        let mut object_keys = vec![
            media_object_key(media),
            storage::nested_object_key(&media.id),
            storage::plaintext_media_object_key(&media.id),
            storage::plaintext_media_migration_marker_object_key(&media.id),
        ];
        if media.is_encrypted {
            if let Some(storage_key) = media.storage_key.as_deref() {
                object_keys.push(format!("{storage_key}.plaintext"));
            }
        }
        for object_key in object_keys {
            let remote_key = s3_config.prefixed_key(&object_key);
            if let Err(e) = s3.delete(&remote_key).await {
                error!(
                    "failed to delete stored attachment file {}: {:?}",
                    remote_key, e
                );
            }
        }
    }
    for object_key in ocr_result_keys {
        let remote_key = s3_config.prefixed_key(object_key);
        if let Err(e) = s3.delete(&remote_key).await {
            error!(
                "failed to delete stored OCR result {}: {:?}",
                remote_key, e
            );
        }
    }
}

pub async fn delete_local_media_files(
    media: &[signal_message_media::Model],
    config: &Config,
) {
    if media.is_empty() {
        return;
    }
    for media in media {
        crate::messenger::media_cache::remove_cached_media_file_best_effort(
            config, media.id,
        )
        .await;
        crate::messenger::media_thumbnail::remove_media_thumbnail_files_best_effort(
            config, media.id,
        )
        .await;
    }
}

/// Authorizes access to a message's media by requiring a group shared by the
/// user and message. This gate is shared by individual and archive downloads;
/// knowing a media or message URL alone must never grant access.
pub(crate) async fn ensure_media_access(
    dbx: &DatabaseConnection,
    login: &uuid::Uuid,
    signal_message_id: i64,
) -> Result<(), AppError> {
    let allowed_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    let is_deleted_report = intel_product::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            intel_product::Relation::SignalMessage1.def(),
        )
        .filter(intel_product::Column::IntelMessageId.eq(signal_message_id))
        .filter(intel_product::relation_kind_eq(
            intel_product::RELATION_KIND_REPORT,
        ))
        .filter(signal_message::Column::Deleted.eq(true))
        .select_only()
        .column(intel_product::Column::IntelMessageId)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_deleted_report {
        return Err(AppError::Forbidden("media access denied".into()));
    }
    let is_allowed = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(allowed_groups.clone()),
        )
        .select_only()
        .column(signal_message_group::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_allowed {
        return Ok(());
    }

    let parent_signal_message_ids = intel_product::Entity::find()
        .filter(intel_product::Column::IntelMessageId.eq(signal_message_id))
        .filter(intel_product::relation_kind_eq(
            intel_product::RELATION_KIND_REPORT,
        ))
        .select_only()
        .column(intel_product::Column::SourceMessageId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    let is_parent_datasource_allowed = signal_message::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::Id.is_in(parent_signal_message_ids))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(allowed_groups.clone()),
        )
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if is_parent_datasource_allowed {
        return Ok(());
    }

    let is_parent_allowed = signal_message_group::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message_group::Entity::belongs_to(
                crate::entities::intel_product::Entity,
            )
            .from(signal_message_group::Column::SignalMessageId)
            .to(crate::entities::intel_product::Column::SourceMessageId)
            .into(),
        )
        .filter(
            crate::entities::intel_product::Column::IntelMessageId
                .eq(signal_message_id),
        )
        .filter(crate::entities::intel_product::relation_kind_eq(
            crate::entities::intel_product::RELATION_KIND_REPORT,
        ))
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
    if is_parent_allowed {
        return Ok(());
    }

    let logins = crate::users::get_organism_login_ids_by_id(dbx, login)
        .await
        .c(h!())?;
    let owner_sender_ids = logins
        .iter()
        .chain(std::iter::once(login))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let is_owner = signal_message::Entity::find_by_id(signal_message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::DatasourceGroupId.is_null())
        .filter(preferred_message_author_expr(None).is_in(owner_sender_ids))
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    let has_group_links = if is_owner {
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(signal_message_id),
            )
            .select_only()
            .column(signal_message_group::Column::Id)
            .into_tuple::<i64>()
            .one(dbx)
            .await
            .c(h!())?
            .is_some()
    } else {
        false
    };
    if is_owner && !has_group_links {
        return Ok(());
    }

    Err(AppError::Forbidden("media access denied".into()))
}

pub fn is_audio_media(media: &signal_message_media::Model) -> bool {
    let ct = media
        .content_type
        .split(';')
        .next()
        .unwrap_or(&media.content_type)
        .trim()
        .to_ascii_lowercase();
    if ct.starts_with("audio/") {
        return true;
    }
    if ct.starts_with("image/") || is_video_media(media) {
        return false;
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

pub fn is_video_media(media: &signal_message_media::Model) -> bool {
    is_video_metadata(
        &media.content_type,
        media.file_ext.as_deref(),
        media.file_name.as_deref(),
    )
}

fn is_encryption_excluded_metadata(
    content_type: &str,
    file_ext: Option<&str>,
    file_name: Option<&str>,
) -> bool {
    if content_type_is_explicit_non_video_media(content_type) {
        return false;
    }
    content_type_is_excluded_from_encryption(content_type)
        || file_ext.is_some_and(extension_is_excluded_from_encryption)
        || file_name
            .and_then(|name| Path::new(name).extension())
            .and_then(|extension| extension.to_str())
            .is_some_and(extension_is_excluded_from_encryption)
}

fn extension_is_excluded_from_encryption(extension: &str) -> bool {
    crate::config::MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_FILE_EXTENSIONS
        .iter()
        .any(|excluded| extension.eq_ignore_ascii_case(excluded))
}

fn content_type_is_excluded_from_encryption(content_type: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim();
    crate::config::MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_CONTENT_TYPES
        .iter()
        .any(|excluded| content_type.eq_ignore_ascii_case(excluded))
}

fn is_video_metadata(
    content_type: &str,
    file_ext: Option<&str>,
    file_name: Option<&str>,
) -> bool {
    if content_type_is_excluded_from_encryption(content_type) {
        return true;
    }
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    if ct.starts_with("video/") {
        return true;
    }
    if ct.starts_with("audio/") || ct.starts_with("image/") {
        return false;
    }
    if file_ext.is_some_and(is_video_file_extension) {
        return true;
    }
    file_name
        .and_then(|name| Path::new(name).extension())
        .and_then(|extension| extension.to_str())
        .is_some_and(is_video_file_extension)
}

fn is_video_file_extension(extension: &str) -> bool {
    extension_is_excluded_from_encryption(extension)
}

pub async fn fetch_media_bytes(
    env: &crate::types::Env,
    media: &signal_message_media::Model,
) -> Result<Vec<u8>, AppError> {
    if !media.is_encrypted {
        return Err(AppError::BL {
            msg: format!(
                "plaintext media {} must be read through a bounded range stream",
                media.id
            ),
        });
    }
    let Some(config) = env.config.s3_config.as_ref() else {
        warn!("S3 is not configured, cannot store attachment!");
        return Ok(vec![]);
    };
    let object_key = media_object_key(media);
    storage::download_and_decrypt_messenger_media_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &config.strongbox_key,
        &object_key,
    )
    .await
}

pub async fn stream_plaintext_media_range(
    env: &Env,
    media: &signal_message_media::Model,
    range: std::ops::Range<u64>,
) -> Result<opendal::FuturesBytesStream, AppError> {
    if media.is_encrypted {
        return Err(AppError::BL {
            msg: format!("media {} is encrypted", media.id),
        });
    }
    let object_key = media_object_key(media);
    storage::stream_s3_object_range_with_operator(
        &env.s3,
        &env.s3_config,
        &object_key,
        range,
    )
    .await
}

pub fn media_object_key(media: &signal_message_media::Model) -> String {
    if let Some(storage_key) = &media.storage_key {
        return storage_key.clone();
    }
    if media.is_encrypted {
        storage::nested_object_key(&media.id)
    } else {
        storage::plaintext_media_object_key(&media.id)
    }
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
    data: actix_web::web::Bytes,
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
        detect_content_type(name, Path::new(name.unwrap_or("")), &data)
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
    use crate::entities::*;
    use crate::error::AppError;
    use crate::functest::tests::{
        cleanup, cleanup_locked, mk_aor, mk_datasource, mk_datasource_group,
        mk_login, mk_organism, mk_organism_aor, mk_sigint_zone,
        mk_sigint_zone_datasource, mk_signal_group, mk_signal_message,
    };
    use crate::types::Env;
    use opendal::{services::Memory, Operator};
    use sea_orm::*;
    use serial_test::serial;

    struct MediaAccessFixture {
        env: std::sync::Arc<Env>,
        login: Uuid,
        message_id: i64,
        group_a: String,
        group_b: String,
    }

    async fn media_access_fixture(rer_role: bool) -> MediaAccessFixture {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let aor = mk_aor(
            &txn,
            area_of_responsibility::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism = mk_organism(
            &txn,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_organism_aor(
            &txn,
            organism_aor::ActiveModel {
                organism_id: Set(organism.id),
                aor_id: Set(aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let zone = mk_sigint_zone(
            &txn,
            sigint_zone::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_a = mk_datasource(
            &txn,
            datasource::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_b = mk_datasource(
            &txn,
            datasource::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group_a = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource_a.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group_b = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource_b.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for (datasource, group) in
            [(&datasource_a, &group_a), (&datasource_b, &group_b)]
        {
            mk_datasource_group(
                &txn,
                datasource_group::ActiveModel {
                    datasource_id: Set(datasource.id),
                    group_master_key: Set(group.master_key.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_zone_datasource(
                &txn,
                sigint_zone_datasource::ActiveModel {
                    sigint_zone_id: Set(zone.id),
                    datasource_id: Set(datasource.id),
                    group_master_key: Set(group.master_key.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            signal_group_aor::ActiveModel {
                master_key: Set(group.master_key.clone()),
                aor_id: Set(aor.id),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .unwrap();
        }
        organism_group::ActiveModel {
            organism_id: Set(organism.id),
            signal_group_master_key: Set(group_a.master_key.clone()),
        }
        .insert(&txn)
        .await
        .unwrap();
        let login_name = format!("media-access-{}", Uuid::new_v4());
        let roles = if rer_role {
            serde_json::json!(["Rer"])
        } else {
            serde_json::json!([])
        };
        let login = mk_login(
            &txn,
            login::ActiveModel {
                login: Set(login_name),
                roles: Set(roles),
                sigint_zone_id: Set(Some(zone.id)),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group_a.master_key.clone())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        MediaAccessFixture {
            env,
            login: login.id,
            message_id: message.id,
            group_a: group_a.master_key,
            group_b: group_b.master_key,
        }
    }

    async fn set_message_groups(
        env: &Env,
        message_id: i64,
        group_master_keys: &[String],
    ) {
        signal_message_group::Entity::delete_many()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message_id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        for group_master_key in group_master_keys {
            signal_message_group::ActiveModel {
                signal_message_id: Set(message_id),
                group_master_key: Set(Some(group_master_key.clone())),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
    }

    #[serial]
    #[tokio::test]
    async fn allows_access_when_user_and_message_share_a_sigint_group() {
        let fixture = media_access_fixture(false).await;

        assert!(ensure_media_access(
            &fixture.env.dbx,
            &fixture.login,
            fixture.message_id,
        )
        .await
        .is_ok());
    }

    #[serial]
    #[tokio::test]
    async fn denies_access_when_user_and_message_groups_do_not_overlap() {
        let fixture = media_access_fixture(false).await;
        set_message_groups(
            &fixture.env,
            fixture.message_id,
            std::slice::from_ref(&fixture.group_b),
        )
        .await;

        assert!(matches!(
            ensure_media_access(
                &fixture.env.dbx,
                &fixture.login,
                fixture.message_id,
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
    }

    #[serial]
    #[tokio::test]
    async fn denies_access_for_rer_user_without_a_shared_group() {
        let fixture = media_access_fixture(true).await;
        set_message_groups(
            &fixture.env,
            fixture.message_id,
            std::slice::from_ref(&fixture.group_b),
        )
        .await;

        assert!(matches!(
            ensure_media_access(
                &fixture.env.dbx,
                &fixture.login,
                fixture.message_id,
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
    }

    #[serial]
    #[tokio::test]
    async fn allows_access_when_message_has_multiple_groups_and_one_matches() {
        let fixture = media_access_fixture(false).await;
        set_message_groups(
            &fixture.env,
            fixture.message_id,
            &[fixture.group_a.clone(), fixture.group_b.clone()],
        )
        .await;

        assert!(ensure_media_access(
            &fixture.env.dbx,
            &fixture.login,
            fixture.message_id,
        )
        .await
        .is_ok());
    }

    fn media(
        content_type: &str,
        file_ext: Option<&str>,
        file_name: Option<&str>,
    ) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::nil(),
            signal_message_id: 1,
            signal_message_uuid: Some(Uuid::now_v7()),
            content_type: content_type.to_string(),
            file_ext: file_ext.map(str::to_string),
            file_name: file_name.map(str::to_string),
            size_bytes: 1,
            is_encrypted: true,
            storage_key: None,
            created_at: Default::default(),
        }
    }

    #[tokio::test]
    async fn missing_attachment_is_skipped() {
        let path = format!("/tmp/echo-missing-attachment-{}", Uuid::new_v4());

        assert!(prepare_attachment(&path, false, true)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rollback_cleanup_removes_staged_object_and_preserves_source() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollback.txt");
        tokio::fs::write(&path, b"rollback media").await.unwrap();
        let mut config = env.config.clone();
        config.s3_config = Some(crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        });
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let staged = stage_media_attachments(
            &[MediaUploadInput {
                path: path.display().to_string(),
                name: Some("rollback.txt".into()),
                content_type: Some("text/plain".into()),
            }],
            &config,
            &s3,
            UploadedAttachmentDeletion::DeleteAfterCommit,
            None,
        )
        .await
        .unwrap();
        let remote_key =
            crate::storage::S3Config::from(config.s3_config.as_ref().unwrap())
                .prefixed_key(&staged.attachments[0].storage_key);
        s3.as_ref().unwrap().stat(&remote_key).await.unwrap();

        staged.cleanup_after_rollback(&config, &s3).await;

        assert!(s3.as_ref().unwrap().stat(&remote_key).await.is_err());
        assert!(path.exists());
    }

    #[tokio::test]
    async fn partial_missing_discard_deletes_successfully_staged_sources() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let existing_path = temp.path().join("existing.txt");
        let missing_path = temp.path().join("missing.txt");
        tokio::fs::write(&existing_path, b"available media")
            .await
            .unwrap();
        let mut config = env.config.clone();
        config.s3_config = Some(crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        });
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let staged = stage_media_attachments(
            &[
                MediaUploadInput {
                    path: existing_path.display().to_string(),
                    name: Some("existing.txt".into()),
                    content_type: Some("text/plain".into()),
                },
                MediaUploadInput {
                    path: missing_path.display().to_string(),
                    name: Some("missing.txt".into()),
                    content_type: Some("text/plain".into()),
                },
            ],
            &config,
            &s3,
            UploadedAttachmentDeletion::DeleteAfterCommit,
            None,
        )
        .await
        .unwrap();

        assert!(staged.skipped_missing());
        let sources = staged.uploaded_files_ready_after_discard();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, existing_path.display().to_string());

        staged.cleanup_after_rollback(&config, &s3).await;
        delete_uploaded_attachment_files(&sources).await;
        assert!(!existing_path.exists());
    }

    #[tokio::test]
    async fn removed_resolved_upload_fails_staging_and_rolls_back_earlier_objects(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let handler = crate::sigint::file_upload::tus::TusHandler::new(
            temporary.path().display().to_string(),
            crate::sigint::file_upload::TUS_PATH_BASE,
        );
        let login = Uuid::new_v4();
        let upload = handler
            .create_completed_upload(
                &login,
                Default::default(),
                futures_util::stream::iter([Ok(
                    actix_web::web::Bytes::from_static(b"source"),
                )]),
            )
            .await
            .unwrap();
        let crate::sigint::file_upload::tus::CompletedUploadWriteResult::Stored { upload_url, .. } = upload else { panic!("missing upload"); };
        let mut attachments = handler
            .resolve_completed_uploads(&login, &[upload_url])
            .await
            .unwrap();
        delete_uploaded_attachment_files(&attachments).await;
        let first = temporary.path().join("valid.bin");
        tokio::fs::write(&first, b"valid first source")
            .await
            .unwrap();
        attachments.insert(
            0,
            MediaUploadInput {
                path: first.display().to_string(),
                name: None,
                content_type: None,
            },
        );
        let mut config = env.config.clone();
        config.s3_config = Some(crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        });
        let op = Operator::new(Memory::default()).unwrap().finish();
        let result = stage_media_attachments(
            &attachments,
            &config,
            &Some(op.clone()),
            UploadedAttachmentDeletion::DeleteAfterCommit,
            None,
        )
        .await;
        assert!(matches!(result, Err(AppError::BL { .. })));
        assert!(op.list("/").await.unwrap().is_empty());
        assert!(first.exists());
    }

    #[test]
    fn media_at_encryption_limit_stays_encrypted() {
        assert!(should_encrypt_media(
            crate::config::MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES,
            false,
        ));
    }

    #[test]
    fn media_over_encryption_limit_is_plaintext() {
        assert!(!should_encrypt_media(
            crate::config::MESSENGER_MEDIA_ENCRYPTION_MAX_FILE_SIZE_BYTES + 1,
            false,
        ));
    }

    #[test]
    fn common_video_media_is_plaintext_below_size_limit() {
        assert!(!should_encrypt_media(1, true));
        assert!(is_encryption_excluded_metadata(
            "video/mp4; codecs=avc1",
            None,
            None
        ));
        assert!(is_encryption_excluded_metadata(
            "video/quicktime",
            None,
            None
        ));
        assert!(is_encryption_excluded_metadata(
            "application/x-matroska",
            None,
            None
        ));
        assert!(is_encryption_excluded_metadata(
            "video/vnd.dlna.mpeg-tts; profile=DLNA.ORG_PN=MPEG_TS_HD_NA",
            None,
            None
        ));
        assert!(is_encryption_excluded_metadata(
            "video/x-ms-vob",
            None,
            None
        ));
        assert!(is_encryption_excluded_metadata(
            "application/octet-stream",
            Some("MOV"),
            None
        ));
        assert!(media_upload_is_excluded_from_encryption(
            &MediaUploadInput {
                path: "/tmp/source.WEBM".to_string(),
                name: Some("renamed.bin".to_string()),
                content_type: Some("application/octet-stream".to_string()),
            },
            "bin",
        ));
    }

    #[test]
    fn explicit_audio_or_image_type_overrides_ambiguous_video_extension() {
        for content_type in [
            "audio/webm",
            "Audio/WebM; codecs=opus",
            "audio/mpeg",
            "image/webp",
        ] {
            assert!(!is_encryption_excluded_metadata(
                content_type,
                Some("webm"),
                Some("recording.webm"),
            ));
            assert!(!media_upload_is_excluded_from_encryption(
                &MediaUploadInput {
                    path: "/tmp/recording.webm".to_string(),
                    name: Some("recording.webm".to_string()),
                    content_type: Some(content_type.to_string()),
                },
                "webm",
            ));
        }
    }

    #[test]
    fn typescript_extensions_are_not_video_without_video_evidence() {
        for extension in ["ts", "mts"] {
            let file_name = format!("source.{extension}");
            assert!(!is_encryption_excluded_metadata(
                "application/typescript",
                Some(extension),
                Some(&file_name),
            ));
            let media = media(
                "application/typescript",
                Some(extension),
                Some(&file_name),
            );
            assert!(!is_video_media(&media));
            assert_eq!(
                detect_content_type(None, Path::new(&file_name), b"export {}"),
                "application/octet-stream"
            );
        }
    }

    #[test]
    fn mpeg_transport_stream_probe_recognizes_common_packet_layouts() {
        for (sync_offset, packet_size) in
            crate::config::MESSENGER_MEDIA_MPEG_TS_PACKET_LAYOUTS
                .iter()
                .copied()
        {
            let mut data = vec![
                0_u8;
                sync_offset
                    + packet_size
                        * crate::config::MESSENGER_MEDIA_MPEG_TS_PROBE_MIN_PACKETS
            ];
            for packet_index in
                0..crate::config::MESSENGER_MEDIA_MPEG_TS_PROBE_MIN_PACKETS
            {
                data[sync_offset + packet_index * packet_size] = 0x47;
            }

            assert_eq!(probed_content_type(&data), Some("video/mp2t"));
        }
    }

    #[test]
    fn probed_video_mime_replaces_generic_attachment_metadata() {
        let attachment = MediaUploadInput {
            path: "/tmp/source.webm".to_string(),
            name: Some("renamed.bin".to_string()),
            content_type: Some("application/octet-stream".to_string()),
        };

        assert_eq!(
            resolve_attachment_content_type(&attachment, Some("video/webm")),
            "video/webm"
        );
    }

    #[test]
    fn explicit_mpeg_transport_stream_mime_remains_video() {
        assert!(is_encryption_excluded_metadata(
            "video/mp2t",
            Some("ts"),
            Some("clip.ts"),
        ));
        assert!(is_video_media(&media(
            "video/mp2t",
            Some("ts"),
            Some("clip.ts"),
        )));
    }

    #[test]
    fn media_object_key_keeps_plaintext_separate_from_encrypted_data() {
        let mut media = media("video/mp4", Some("mp4"), Some("clip.mp4"));
        media.id =
            Uuid::parse_str("019f7ec5-e60d-7e23-b4e7-b605ba6dcfff").unwrap();

        assert_eq!(
            media_object_key(&media),
            "019f7/019f7ec5-e60d-7e23-b4e7-b605ba6dcfff"
        );
        media.is_encrypted = false;
        assert_eq!(
            media_object_key(&media),
            "019f7/019f7ec5-e60d-7e23-b4e7-b605ba6dcfff.plaintext"
        );
    }

    #[test]
    fn media_object_key_reuses_shared_storage_key() {
        let mut media = media("image/jpeg", Some("jpg"), Some("photo.jpg"));
        media.storage_key = Some("shared/photo-object".to_string());

        assert_eq!(media_object_key(&media), "shared/photo-object");
    }

    #[test]
    fn video_mpeg_is_video_not_audio() {
        let media = media("video/mpeg", Some("mpeg"), Some("clip.mpeg"));

        assert!(is_video_media(&media));
        assert!(!is_audio_media(&media));
    }

    #[test]
    fn application_octet_stream_uses_video_extension() {
        let media =
            media("application/octet-stream", Some("MP4"), Some("clip.bin"));

        assert!(is_video_media(&media));
    }

    #[test]
    fn video_extension_wins_over_audio_extension_fallback() {
        for extension in ["mpeg", "webm"] {
            let file_name = format!("clip.{extension}");
            let media = media(
                "application/octet-stream",
                Some(extension),
                Some(&file_name),
            );

            assert!(is_video_media(&media));
            assert!(!is_audio_media(&media));
        }
    }

    #[test]
    fn excluded_video_container_mime_wins_over_audio_extension_fallback() {
        let media = media("application/mp4", Some("m4a"), Some("voice.m4a"));

        assert!(is_video_media(&media));
        assert!(!is_audio_media(&media));
    }

    #[test]
    fn explicit_audio_content_type_wins_over_video_extension() {
        let media = media(
            " Audio/WebM; codecs=opus ",
            Some("webm"),
            Some("voice.webm"),
        );

        assert!(!is_video_media(&media));
        assert!(is_audio_media(&media));
    }
}
