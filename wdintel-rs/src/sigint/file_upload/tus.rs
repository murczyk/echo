use super::lifecycle::{self, UploadLock};
use crate::config::{
    SIGINT_FILE_UPLOAD_COMPLETED_TTL_SECS,
    SIGINT_FILE_UPLOAD_FALLBACK_CHANNEL_CAPACITY, SIGINT_FILE_UPLOAD_MAX_BYTES,
    SIGINT_FILE_UPLOAD_PENDING_TTL_SECS, SIGINT_MESSAGE_MAX_ATTACHMENTS,
};
use crate::error::AppError;
use crate::messenger::media::MediaUploadInput;
use crate::tus::{format_upload_expires, has_supported_version, TUS_VERSION};
use crate::types::*;
use actix_web::http::header::{HeaderMap, HeaderName, HeaderValue};
use actix_web::http::{header, Method, StatusCode};
use actix_web::{web, HttpResponse, ResponseError};
use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

const BASE_UPLOAD_DIR: &str = "file_upload_tus";
const PENDING_DIR: &str = "pending";
const COMPLETED_DIR: &str = "completed";
const METADATA_EXT: &str = "json";
const HEADER_NAME_TUS_VERSION: HeaderName =
    HeaderName::from_static("tus-version");
const HEADER_VALUE_TUS_VERSION: HeaderValue =
    HeaderValue::from_static(TUS_VERSION);
const HEADER_NAME_TUS_RESUMABLE: HeaderName =
    HeaderName::from_static("tus-resumable");
const HEADER_VALUE_TUS_RESUMABLE: HeaderValue =
    HeaderValue::from_static(TUS_VERSION);
const HEADER_NAME_TUS_MAX_SIZE: HeaderName =
    HeaderName::from_static("tus-max-size");
const HEADER_NAME_TUS_EXTENSION: HeaderName =
    HeaderName::from_static("tus-extension");
const HEADER_VALUE_TUS_EXTENSION: HeaderValue =
    HeaderValue::from_static("creation,expiration,termination");
const HEADER_VALUE_CACHE_CONTROL: HeaderValue =
    HeaderValue::from_static("no-store");
const HEADER_NAME_UPLOAD_OFFSET: HeaderName =
    HeaderName::from_static("upload-offset");
const HEADER_NAME_UPLOAD_LENGTH: HeaderName =
    HeaderName::from_static("upload-length");
const HEADER_NAME_UPLOAD_METADATA: HeaderName =
    HeaderName::from_static("upload-metadata");
const HEADER_NAME_UPLOAD_EXPIRES: HeaderName =
    HeaderName::from_static("upload-expires");
const HEADER_VALUE_CONTENT_TYPE_PATCH: HeaderValue =
    HeaderValue::from_static("application/offset+octet-stream");

#[derive(Debug, Clone)]
pub struct TusHandler {
    pub(super) upload_dir: PathBuf,
    pub(super) config: TusConfig,
    prefix: String,
}

#[derive(Debug, Clone)]
pub struct TusConfig {
    pub max_size: Option<u64>,
    pub pending_expires_in: Duration,
    pub completed_expires_in: Duration,
}

pub struct TusUpload {
    pub file_id: Uuid,
    pub login: String,
    pub file_path: PathBuf,
    pub upload_length: u64,
    pub created: DateTime<Utc>,
    pub expires: DateTime<Utc>,
    pub metadata: TusUploadMetadata,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TusUploadMetadata {
    pub relative_path: Option<String>,
    pub meta_name: Option<String>,
    pub meta_type: Option<String>,
    pub filetype: Option<String>,
    pub filename: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum CompletedUploadWriteResult {
    Empty,
    Stored {
        file_id: Uuid,
        size: u64,
        upload_url: String,
    },
    TooLarge,
}

enum WriteResult {
    Conflict { current_offset: u64 },
    TooLarge { current_offset: u64 },
    Written(u64),
    Expired,
}

#[derive(Debug)]
enum FallbackUploadMessage {
    Chunk(Result<web::Bytes, AppError>),
    Complete,
}

struct FallbackArtifacts {
    root: PathBuf,
    paths: Vec<PathBuf>,
    lock: Option<UploadLock>,
    armed: bool,
}

impl FallbackArtifacts {
    fn new(root: PathBuf, pending: PathBuf, lock: UploadLock) -> Self {
        Self {
            root,
            paths: vec![pending],
            lock: Some(lock),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn cleanup(&mut self) -> anyhow::Result<()> {
        for path in &self.paths {
            lifecycle::remove_artifacts(&self.root, path)
                .await
                .c(h!())?;
        }
        self.disarm();
        Ok(())
    }
}

impl Drop for FallbackArtifacts {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::error!("cannot clean fallback upload without async runtime");
            return;
        };
        let root = self.root.clone();
        let paths = std::mem::take(&mut self.paths);
        let lock = self.lock.take();
        runtime.spawn(async move {
            let _lock = lock;
            for path in paths {
                if let Err(error) =
                    lifecycle::remove_artifacts(&root, &path).await
                {
                    log::error!("failed to clean fallback upload: {error:#}");
                }
            }
        });
    }
}

impl Default for TusConfig {
    fn default() -> TusConfig {
        TusConfig {
            max_size: Some(SIGINT_FILE_UPLOAD_MAX_BYTES),
            pending_expires_in: Duration::from_secs(
                SIGINT_FILE_UPLOAD_PENDING_TTL_SECS,
            ),
            completed_expires_in: Duration::from_secs(
                SIGINT_FILE_UPLOAD_COMPLETED_TTL_SECS,
            ),
        }
    }
}

impl TusHandler {
    pub fn new(storage_dir: String, path_base: &str) -> TusHandler {
        let mut upload_dir = if storage_dir.trim().is_empty() {
            std::env::temp_dir()
        } else {
            PathBuf::from(storage_dir)
        };
        upload_dir.push(BASE_UPLOAD_DIR);

        let mut prefix = String::from(path_base);
        prefix.push('/');

        TusHandler {
            upload_dir,
            config: TusConfig::default(),
            prefix,
        }
    }

    pub async fn handle_request(
        &self,
        login: &uuid::Uuid,
        method: &Method,
        headers: &HeaderMap,
        request_file: Option<String>,
        payload: web::Payload,
    ) -> Result<HttpResponse, AppError> {
        match self
            .handle_request_inner(login, method, headers, request_file, payload)
            .await
        {
            Err(error @ AppError::ServiceUnavailable { .. }) => {
                let mut response = error.error_response();
                response.headers_mut().insert(
                    HEADER_NAME_TUS_RESUMABLE,
                    HEADER_VALUE_TUS_RESUMABLE,
                );
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HEADER_VALUE_CACHE_CONTROL);
                Ok(response)
            }
            result => result,
        }
    }

    async fn handle_request_inner(
        &self,
        login: &uuid::Uuid,
        method: &Method,
        headers: &HeaderMap,
        request_file: Option<String>,
        payload: web::Payload,
    ) -> Result<HttpResponse, AppError> {
        let _lock = match request_file.as_deref().and_then(parse_request_file) {
            Some((file_id, _)) if *method != Method::OPTIONS => {
                if !self
                    .owned_upload_exists(
                        login,
                        request_file.as_deref().unwrap(),
                    )
                    .await
                    .c(h!())?
                {
                    return Ok(
                        self.build_status_response(StatusCode::NOT_FOUND)
                    );
                }
                match UploadLock::acquire(&self.upload_dir, file_id)
                    .await
                    .c(h!())
                    .map_err(AppError::from)
                {
                    Err(AppError::ServiceUnavailable {
                        retry_after_secs,
                        ..
                    }) if *method == Method::HEAD => {
                        let mut builder =
                            HttpResponse::build(StatusCode::LOCKED);
                        self.add_default_headers(&mut builder);
                        return Ok(builder
                            .insert_header((
                                header::RETRY_AFTER,
                                retry_after_secs.to_string(),
                            ))
                            .finish());
                    }
                    result => Some(result.context(h!())?),
                }
            }
            _ => None,
        };
        match (method.clone(), request_file) {
            (Method::HEAD, Some(request_file)) => {
                self.process_head_request(login, headers, &request_file)
                    .await
            }
            (Method::DELETE, Some(request_file)) => {
                self.process_delete_request(login, headers, &request_file)
                    .await
            }
            (Method::PATCH, Some(request_file)) => {
                self.process_patch_request(
                    login,
                    headers,
                    &request_file,
                    payload,
                    _lock,
                )
                .await
            }
            (Method::POST, None) => {
                self.process_post_request(login, headers).await
            }
            (Method::OPTIONS, _) => self.process_options_request().await,
            _ => Ok(self.build_status_response(StatusCode::NOT_FOUND)),
        }
    }

    pub async fn open_completed_url(
        &self,
        login: &uuid::Uuid,
        upload_url: &str,
    ) -> Result<Option<TusUpload>, AppError> {
        let Some(request_file) = upload_url.strip_prefix(&self.prefix) else {
            return Ok(None);
        };
        let Some((file_id, _)) = parse_request_file(request_file) else {
            return Ok(None);
        };
        if !self
            .owned_upload_exists(login, request_file)
            .await
            .c(h!())?
        {
            return Ok(None);
        }
        let _lock = UploadLock::acquire(&self.upload_dir, file_id)
            .await
            .c(h!())?;
        self.open_completed_file(login, request_file).await
    }

    pub async fn resolve_completed_uploads(
        &self,
        login: &uuid::Uuid,
        upload_urls: &[String],
    ) -> Result<Vec<MediaUploadInput>, AppError> {
        if upload_urls.len() > SIGINT_MESSAGE_MAX_ATTACHMENTS {
            return Err(AppError::BL {
                msg: format!(
                    "too many attachments: maximum is {SIGINT_MESSAGE_MAX_ATTACHMENTS}"
                ),
            });
        }

        let mut uploads = Vec::with_capacity(upload_urls.len());
        for upload_url in upload_urls {
            let upload = self
                .open_completed_url(login, upload_url)
                .await
                .c(h!())?
                .ok_or_else(|| AppError::BL {
                    msg: format!(
                        "upload not found or incomplete: {upload_url}"
                    ),
                })?;
            uploads.push(media_upload_input_from_tus_upload(upload));
        }

        Ok(uploads)
    }

    pub async fn create_completed_upload<S>(
        &self,
        login: &Uuid,
        metadata: TusUploadMetadata,
        chunks: S,
    ) -> Result<CompletedUploadWriteResult, AppError>
    where
        S: Stream<Item = Result<web::Bytes, AppError>> + Unpin,
    {
        let (sender, receiver) = tokio::sync::mpsc::channel(
            SIGINT_FILE_UPLOAD_FALLBACK_CHANNEL_CAPACITY,
        );
        let (respond, mut response) = tokio::sync::oneshot::channel();
        let (accept, accepted) = tokio::sync::oneshot::channel();
        let handler = self.clone();
        let login = *login;
        // The worker retains the source lock until native filesystem work and
        // cancellation cleanup finish, even when the request future is dropped.
        tokio::spawn(async move {
            handler
                .run_fallback_upload(
                    login, metadata, receiver, respond, accepted,
                )
                .await;
        });
        let mut chunks = chunks;
        let send_chunks = async move {
            while let Some(chunk) = chunks.next().await {
                let failed = chunk.is_err();
                if sender
                    .send(FallbackUploadMessage::Chunk(chunk))
                    .await
                    .is_err()
                    || failed
                {
                    return;
                }
            }
            let _ = sender.send(FallbackUploadMessage::Complete).await;
        };
        tokio::pin!(send_chunks);
        let result = tokio::select! {
            result = &mut response => result,
            () = &mut send_chunks => response.await,
        }
        .c(h!())?;
        let _ = accept.send(());
        result
    }

    async fn run_fallback_upload(
        &self,
        login: Uuid,
        metadata: TusUploadMetadata,
        receiver: tokio::sync::mpsc::Receiver<FallbackUploadMessage>,
        respond: tokio::sync::oneshot::Sender<
            Result<CompletedUploadWriteResult, AppError>,
        >,
        accepted: tokio::sync::oneshot::Receiver<()>,
    ) {
        let chunks = Box::pin(futures_util::stream::unfold(
            Some(receiver),
            |receiver| async move {
                let mut receiver = receiver?;
                match receiver.recv().await {
                    Some(FallbackUploadMessage::Chunk(chunk)) => {
                        Some((chunk, Some(receiver)))
                    }
                    Some(FallbackUploadMessage::Complete) => None,
                    None => Some((
                        Err(AppError::BL {
                            msg: "attachment upload was cancelled".to_string(),
                        }),
                        None,
                    )),
                }
            },
        ));
        match self.stage_completed_upload(&login, metadata, chunks).await {
            Ok((result, mut artifacts)) => {
                if matches!(result, CompletedUploadWriteResult::Stored { .. }) {
                    if respond.send(Ok(result)).is_ok()
                        && accepted.await.is_ok()
                    {
                        artifacts.disarm();
                    } else if let Err(error) = artifacts.cleanup().await {
                        log::error!("failed to clean cancelled fallback upload: {error:#}");
                    }
                } else {
                    let _ = respond.send(Ok(result));
                }
            }
            Err(error) => {
                let _ = respond.send(Err(error));
            }
        }
    }

    async fn stage_completed_upload<S>(
        &self,
        login: &Uuid,
        metadata: TusUploadMetadata,
        chunks: S,
    ) -> Result<(CompletedUploadWriteResult, FallbackArtifacts), AppError>
    where
        S: Stream<Item = Result<web::Bytes, AppError>> + Unpin,
    {
        let file_id = Uuid::now_v7();
        let lock = UploadLock::acquire(&self.upload_dir, file_id)
            .await
            .c(h!())?;
        let mut artifacts = FallbackArtifacts::new(
            self.upload_dir.clone(),
            self.fallback_path(file_id, login),
            lock,
        );
        let (_, file) = self
            .create_fallback_file(file_id, login)
            .await
            .context(h!())?;
        let result = self
            .write_completed_upload(
                file_id,
                login,
                metadata,
                file,
                chunks,
                &mut artifacts,
            )
            .await;
        if !matches!(result, Ok(CompletedUploadWriteResult::Stored { .. })) {
            artifacts.cleanup().await.c(h!())?;
        }
        Ok((result.context(h!())?, artifacts))
    }

    fn fallback_path(&self, file_id: Uuid, login: &Uuid) -> PathBuf {
        self.upload_dir
            .join(PENDING_DIR)
            .join(login_dir(login))
            .join(format!(
                ".{file_id}.{}.fallback",
                self.config.max_size.unwrap_or(SIGINT_FILE_UPLOAD_MAX_BYTES)
            ))
    }

    async fn create_fallback_file(
        &self,
        file_id: Uuid,
        login: &Uuid,
    ) -> Result<(PathBuf, tokio::fs::File), AppError> {
        let admission = lifecycle::admit(
            &self.upload_dir,
            self.config.max_size.unwrap_or(SIGINT_FILE_UPLOAD_MAX_BYTES),
        )
        .await
        .c(h!())?;
        let file_path = self.fallback_path(file_id, login);
        let (file_path, file) = admission
            .run(move || {
                std::fs::create_dir_all(file_path.parent().c(h!())?).c(h!())?;
                let file = std::fs::File::options()
                    .create_new(true)
                    .write(true)
                    .open(&file_path)
                    .c(h!())?;
                Ok((file_path, file))
            })
            .await
            .c(h!())?;
        Ok((file_path, tokio::fs::File::from_std(file)))
    }

    async fn write_completed_upload<S>(
        &self,
        file_id: Uuid,
        login: &Uuid,
        metadata: TusUploadMetadata,
        mut file: tokio::fs::File,
        mut chunks: S,
        artifacts: &mut FallbackArtifacts,
    ) -> Result<CompletedUploadWriteResult, AppError>
    where
        S: Stream<Item = Result<web::Bytes, AppError>> + Unpin,
    {
        let mut size = 0_u64;
        let deadline =
            tokio::time::Instant::now() + self.config.pending_expires_in;
        while let Some(chunk) = tokio::time::timeout_at(deadline, chunks.next())
            .await
            .map_err(|_| AppError::BL {
                msg: "attachment upload expired".to_string(),
            })
            .context(h!())?
        {
            let chunk = chunk.context(h!())?;
            let Some(new_size) = size.checked_add(chunk.len() as u64) else {
                return Ok(CompletedUploadWriteResult::TooLarge);
            };
            if self.config.max_size.unwrap_or(SIGINT_FILE_UPLOAD_MAX_BYTES)
                < new_size
            {
                return Ok(CompletedUploadWriteResult::TooLarge);
            }
            file.write_all(&chunk).await.c(h!())?;
            size = new_size;
        }
        if size == 0 {
            return Ok(CompletedUploadWriteResult::Empty);
        }

        file.sync_all().await.c(h!())?;
        drop(file);
        self.finish_completed_upload(file_id, login, size, metadata, artifacts)
            .await
    }

    async fn finish_completed_upload(
        &self,
        file_id: Uuid,
        login: &Uuid,
        size: u64,
        metadata: TusUploadMetadata,
        artifacts: &mut FallbackArtifacts,
    ) -> Result<CompletedUploadWriteResult, AppError> {
        let temporary_path = self.fallback_path(file_id, login);
        let (completed_path, file_name) =
            self.file_path(file_id, login, size, false);
        let admission =
            lifecycle::admission_lock(&self.upload_dir).await.c(h!())?;
        artifacts.paths.push(completed_path.clone());
        let metadata = Self::serialize_metadata(&metadata).context(h!())?;
        let metadata_path = self.metadata_path(&completed_path);
        admission
            .run(move || {
                std::fs::create_dir_all(completed_path.parent().c(h!())?)
                    .c(h!())?;
                std::fs::rename(&temporary_path, &completed_path).c(h!())?;
                lifecycle::remove_empty_directory(
                    temporary_path.parent().c(h!())?,
                )
                .c(h!())?;
                std::fs::write(metadata_path, metadata).c(h!())?;
                Ok(())
            })
            .await
            .c(h!())?;
        Ok(CompletedUploadWriteResult::Stored {
            file_id,
            size,
            upload_url: format!("{}{}", self.prefix, file_name),
        })
    }

    async fn open_completed_file(
        &self,
        login: &uuid::Uuid,
        request_file: &str,
    ) -> Result<Option<TusUpload>, AppError> {
        let now = Utc::now();
        let Some((file_path, file_id, upload_length)) = self
            .parse_request_file_path(login, request_file, false)
            .await?
        else {
            return Ok(None);
        };
        match tokio::fs::symlink_metadata(&file_path).await {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => {
                return Err(anyhow::Error::from(error).context(h!()).into())
            }
        }
        let tus_upload = self
            .open_tus_upload(file_id, login, upload_length, file_path)
            .await
            .context(h!())?;
        if tus_upload.expires > now {
            Ok(Some(tus_upload))
        } else {
            lifecycle::remove_artifacts(
                &self.upload_dir,
                &tus_upload.file_path,
            )
            .await
            .c(h!())?;
            Ok(None)
        }
    }

    async fn open_tus_upload(
        &self,
        file_id: Uuid,
        login: &uuid::Uuid,
        upload_length: u64,
        file_path: PathBuf,
    ) -> Result<TusUpload, AppError> {
        let metadata = tokio::fs::metadata(&file_path).await.c(h!())?;
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?;
        let expires: DateTime<Utc> =
            (created + self.config.completed_expires_in).into();
        Ok(TusUpload {
            file_id,
            login: login.to_string(),
            file_path: file_path.clone(),
            upload_length,
            created: created.into(),
            expires,
            metadata: self.read_metadata(&file_path).await.c(h!())?,
        })
    }

    async fn process_head_request(
        &self,
        login: &uuid::Uuid,
        headers: &HeaderMap,
        request_file: &str,
    ) -> Result<HttpResponse, AppError> {
        if !has_supported_version(headers) {
            return Ok(
                self.build_status_response(StatusCode::PRECONDITION_FAILED)
            );
        }

        for pending in [true, false] {
            let Some((file_path, _file_id, upload_length)) = self
                .parse_request_file_path(login, request_file, pending)
                .await?
            else {
                continue;
            };
            match tokio::fs::symlink_metadata(&file_path).await {
                Ok(metadata) if metadata.is_file() => {
                    if self.has_expired(&metadata, pending).c(h!())? {
                        lifecycle::remove_artifacts(
                            &self.upload_dir,
                            &file_path,
                        )
                        .await
                        .c(h!())?;
                        return Ok(
                            self.build_status_response(StatusCode::NOT_FOUND)
                        );
                    }
                    let mut builder = HttpResponse::NoContent();
                    self.add_head_options_response_headers(&mut builder);
                    self.add_expires_header(&metadata, pending, &mut builder)
                        .context(h!())?;
                    builder.insert_header((
                        HEADER_NAME_UPLOAD_OFFSET,
                        metadata.len().to_string(),
                    ));
                    builder.insert_header((
                        HEADER_NAME_UPLOAD_LENGTH,
                        upload_length.to_string(),
                    ));
                    return Ok(builder.finish());
                }
                Ok(_) => {
                    return Ok(
                        self.build_status_response(StatusCode::NOT_FOUND)
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Ok(self.build_status_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                    ));
                }
            }
        }
        Ok(self.build_status_response(StatusCode::NOT_FOUND))
    }

    async fn process_patch_request(
        &self,
        login: &uuid::Uuid,
        headers: &HeaderMap,
        request_file: &str,
        payload: web::Payload,
        lock: Option<UploadLock>,
    ) -> Result<HttpResponse, AppError> {
        if !has_supported_version(headers) {
            return Ok(self.rejected_chunk_response(
                StatusCode::PRECONDITION_FAILED,
                "invalid_tus_version",
                None,
                None,
                None,
                None,
            ));
        }
        if headers.get(header::CONTENT_TYPE)
            != Some(&HEADER_VALUE_CONTENT_TYPE_PATCH)
        {
            return Ok(self.rejected_chunk_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_content_type",
                None,
                None,
                None,
                None,
            ));
        }

        let Some((file_path, file_id, upload_length)) = self
            .parse_request_file_path(login, request_file, true)
            .await?
        else {
            return Ok(self.rejected_chunk_response(
                StatusCode::NOT_FOUND,
                "invalid_upload_url",
                None,
                None,
                None,
                None,
            ));
        };
        let Some(upload_offset) = headers.get(HEADER_NAME_UPLOAD_OFFSET) else {
            return Ok(self.rejected_chunk_response(
                StatusCode::BAD_REQUEST,
                "missing_upload_offset",
                Some(file_id),
                Some(upload_length),
                None,
                None,
            ));
        };
        let Ok(upload_offset) = upload_offset
            .to_str()
            .ok()
            .and_then(|value| u64::from_str(value).ok())
            .ok_or(())
        else {
            return Ok(self.rejected_chunk_response(
                StatusCode::BAD_REQUEST,
                "invalid_upload_offset",
                Some(file_id),
                Some(upload_length),
                None,
                None,
            ));
        };
        log::info!(
            target: "tus_upload",
            "event=chunk_request_received file_id={file_id} upload_length={upload_length} upload_offset={upload_offset}"
        );
        if upload_offset > upload_length {
            return Ok(self.rejected_chunk_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "offset_exceeds_upload_length",
                Some(file_id),
                Some(upload_length),
                Some(upload_offset),
                None,
            ));
        }

        let mut file = match tokio::fs::File::options()
            .read(true)
            .append(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&file_path)
            .await
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.rejected_chunk_response(
                    StatusCode::NOT_FOUND,
                    "pending_upload_not_found",
                    Some(file_id),
                    Some(upload_length),
                    Some(upload_offset),
                    None,
                ));
            }
            Err(_) => {
                return Ok(self.rejected_chunk_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "pending_upload_open_failed",
                    Some(file_id),
                    Some(upload_length),
                    Some(upload_offset),
                    None,
                ));
            }
        };

        let metadata = file.metadata().await.c(h!())?;
        if !metadata.is_file() {
            return Ok(self.build_status_response(StatusCode::NOT_FOUND));
        }
        if self.has_expired(&metadata, true).c(h!())? {
            drop(file);
            lifecycle::remove_artifacts(&self.upload_dir, &file_path)
                .await
                .c(h!())?;
            return Ok(self.build_status_response(StatusCode::NOT_FOUND));
        }
        let mut builder = HttpResponse::NoContent();
        self.add_default_headers(&mut builder);
        self.add_expires_header(&metadata, true, &mut builder)
            .context(h!())?;
        let expires = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?
            + self.config.pending_expires_in;
        let upload_offset = match Self::write(
            &mut file,
            upload_offset,
            upload_length,
            expires,
            payload,
        )
        .await
        .context(h!())?
        {
            WriteResult::Conflict { current_offset } => {
                return Ok(self.rejected_chunk_response(
                    StatusCode::CONFLICT,
                    "upload_offset_conflict",
                    Some(file_id),
                    Some(upload_length),
                    Some(upload_offset),
                    Some(current_offset),
                ));
            }
            WriteResult::TooLarge { current_offset } => {
                return Ok(self.rejected_chunk_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "chunk_exceeds_upload_length",
                    Some(file_id),
                    Some(upload_length),
                    Some(upload_offset),
                    Some(current_offset),
                ));
            }
            WriteResult::Written(new_pos) => new_pos,
            WriteResult::Expired => {
                drop(file);
                lifecycle::remove_artifacts(&self.upload_dir, &file_path)
                    .await
                    .c(h!())?;
                return Ok(self.build_status_response(StatusCode::NOT_FOUND));
            }
        };
        builder.insert_header((
            HEADER_NAME_UPLOAD_OFFSET,
            upload_offset.to_string(),
        ));
        if upload_offset == upload_length {
            file.sync_all().await.c(h!())?;
            self.add_completed(
                file_id,
                login,
                file_path,
                upload_length,
                lock.c(h!())?,
            )
            .await
            .c(h!())?;
            self.add_expires_header(&metadata, false, &mut builder)
                .context(h!())?;
        }
        log::info!(
            target: "tus_upload",
            "event=chunk_written file_id={file_id} upload_length={upload_length} upload_offset={upload_offset} completed={}",
            upload_offset == upload_length
        );
        Ok(builder.finish())
    }

    async fn write(
        file: &mut tokio::fs::File,
        expected_offset: u64,
        upload_length: u64,
        expires: SystemTime,
        payload: web::Payload,
    ) -> Result<WriteResult, AppError> {
        let current_position =
            file.seek(std::io::SeekFrom::End(0)).await.c(h!())?;
        if expected_offset != current_position {
            return Ok(WriteResult::Conflict {
                current_offset: current_position,
            });
        }
        let result = Self::write_chunks(
            file,
            expected_offset,
            upload_length,
            expires,
            payload,
        )
        .await;
        file.flush().await.c(h!())?;
        result
    }

    async fn write_chunks(
        file: &mut tokio::fs::File,
        mut size: u64,
        upload_length: u64,
        expires: SystemTime,
        mut payload: web::Payload,
    ) -> Result<WriteResult, AppError> {
        let deadline = tokio::time::Instant::now()
            + expires
                .duration_since(SystemTime::now())
                .unwrap_or_default();
        loop {
            let chunk =
                match tokio::time::timeout_at(deadline, payload.next()).await {
                    Ok(Some(chunk)) => chunk.c(h!())?,
                    Ok(None) => return Ok(WriteResult::Written(size)),
                    Err(_) => return Ok(WriteResult::Expired),
                };
            let Some(new_size) = size.checked_add(chunk.len() as u64) else {
                return Ok(WriteResult::TooLarge {
                    current_offset: size,
                });
            };
            if new_size > upload_length {
                return Ok(WriteResult::TooLarge {
                    current_offset: size,
                });
            }
            file.write_all(&chunk).await.c(h!())?;
            size = new_size;
        }
    }

    async fn add_completed(
        &self,
        file_id: Uuid,
        login: &uuid::Uuid,
        file_path: PathBuf,
        upload_length: u64,
        lock: UploadLock,
    ) -> Result<(), AppError> {
        let (new_path, _file_name) =
            self.file_path(file_id, login, upload_length, false);
        let admission =
            lifecycle::admission_lock(&self.upload_dir).await.c(h!())?;
        let old_metadata_path = self.metadata_path(&file_path);
        let new_metadata_path = self.metadata_path(&new_path);
        admission
            .run(move || {
                std::fs::create_dir_all(new_path.parent().c(h!())?).c(h!())?;
                let _lock = lock;
                std::fs::rename(&file_path, &new_path).c(h!())?;
                #[cfg(test)]
                super::acceptance_tests::pause_promotion_for_test(file_id);
                if old_metadata_path.try_exists().c(h!())? {
                    std::fs::rename(old_metadata_path, new_metadata_path)
                        .c(h!())?;
                }
                lifecycle::remove_empty_directory(file_path.parent().c(h!())?)
                    .c(h!())?;
                Ok(())
            })
            .await
            .c(h!())?;
        Ok(())
    }

    async fn process_delete_request(
        &self,
        login: &uuid::Uuid,
        headers: &HeaderMap,
        request_file: &str,
    ) -> Result<HttpResponse, AppError> {
        if !has_supported_version(headers) {
            return Ok(
                self.build_status_response(StatusCode::PRECONDITION_FAILED)
            );
        }

        for pending in [true, false] {
            let Some((file_path, _file_id, _upload_length)) = self
                .parse_request_file_path(login, request_file, pending)
                .await?
            else {
                continue;
            };
            match tokio::fs::symlink_metadata(&file_path).await {
                Ok(_) => {
                    lifecycle::remove_artifacts(&self.upload_dir, &file_path)
                        .await
                        .c(h!())?;
                    let mut builder = HttpResponse::NoContent();
                    self.add_default_headers(&mut builder);
                    return Ok(builder.finish());
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(self.build_status_response(StatusCode::NOT_FOUND))
    }

    async fn process_post_request(
        &self,
        login: &uuid::Uuid,
        headers: &HeaderMap,
    ) -> Result<HttpResponse, AppError> {
        if !has_supported_version(headers) {
            return Ok(
                self.build_status_response(StatusCode::PRECONDITION_FAILED)
            );
        }
        let Some(upload_length) = headers.get(HEADER_NAME_UPLOAD_LENGTH) else {
            return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
        };
        let Some(upload_length) = upload_length
            .to_str()
            .ok()
            .filter(|value| {
                !value.is_empty()
                    && value.bytes().all(|byte| byte.is_ascii_digit())
            })
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
        };
        if upload_length == 0 {
            return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
        }
        if let Some(max_size) = self.config.max_size {
            if upload_length > max_size {
                return Ok(
                    self.build_status_response(StatusCode::PAYLOAD_TOO_LARGE)
                );
            }
        }

        let upload_metadata = match headers.get(HEADER_NAME_UPLOAD_METADATA) {
            Some(value)
                if value.as_bytes().len() as u64
                    > crate::config::SIGINT_FILE_UPLOAD_METADATA_MAX_BYTES =>
            {
                return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
            }
            Some(value) => match parse_upload_metadata(value) {
                Ok(value) => value,
                Err(_) => {
                    return Ok(
                        self.build_status_response(StatusCode::BAD_REQUEST)
                    )
                }
            },
            None => TusUploadMetadata::default(),
        };
        let file_id = Uuid::now_v7();
        let lock = UploadLock::acquire(&self.upload_dir, file_id)
            .await
            .c(h!())?;
        let admission = lifecycle::admit(&self.upload_dir, upload_length)
            .await
            .c(h!())?;
        let (file_path, file_name) =
            self.file_path(file_id, login, upload_length, true);
        let bytes = Self::serialize_metadata(&upload_metadata).context(h!())?;
        let metadata_path = self.metadata_path(&file_path);
        let metadata = admission
            .run(move || {
                let _lock = lock;
                std::fs::create_dir_all(file_path.parent().c(h!())?).c(h!())?;
                let file = std::fs::File::options()
                    .create_new(true)
                    .append(true)
                    .open(&file_path)
                    .c(h!())?;
                if let Err(error) = std::fs::write(metadata_path, bytes) {
                    std::fs::remove_file(&file_path).c(h!())?;
                    lifecycle::remove_empty_directory(
                        file_path.parent().c(h!())?,
                    )
                    .c(h!())?;
                    return Err(error).c(h!());
                }
                file.metadata().c(h!())
            })
            .await
            .c(h!())?;

        let mut builder = HttpResponse::Created();
        self.add_default_headers(&mut builder);
        self.add_expires_header(&metadata, true, &mut builder)
            .context(h!())?;
        builder.insert_header((
            header::LOCATION,
            format!("{}{}", self.prefix, file_name),
        ));
        log::info!(
            target: "tus_upload",
            "event=upload_created file_id={file_id} upload_length={upload_length}"
        );
        Ok(builder.finish())
    }

    async fn process_options_request(&self) -> Result<HttpResponse, AppError> {
        let mut builder = HttpResponse::NoContent();
        self.add_head_options_response_headers(&mut builder);
        Ok(builder.finish())
    }

    async fn owned_upload_exists(
        &self,
        login: &Uuid,
        request_file: &str,
    ) -> anyhow::Result<bool> {
        for state in [PENDING_DIR, COMPLETED_DIR] {
            let path = self
                .upload_dir
                .join(state)
                .join(login_dir(login))
                .join(request_file);
            match tokio::fs::symlink_metadata(path).await {
                Ok(metadata) if metadata.is_file() => return Ok(true),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).c(h!()),
            }
        }
        Ok(false)
    }

    async fn parse_request_file_path(
        &self,
        login: &uuid::Uuid,
        request_file: &str,
        pending: bool,
    ) -> Result<Option<(PathBuf, Uuid, u64)>, AppError> {
        let Some((file_id, upload_length)) = parse_request_file(request_file)
        else {
            return Ok(None);
        };

        let mut file_path = self.upload_dir.clone();
        file_path.push(if pending { PENDING_DIR } else { COMPLETED_DIR });
        file_path.push(login_dir(login));
        file_path.push(request_file);
        Ok(Some((file_path, file_id, upload_length)))
    }

    fn file_path(
        &self,
        file_id: Uuid,
        login: &uuid::Uuid,
        upload_length: u64,
        pending: bool,
    ) -> (PathBuf, String) {
        let mut file_path = self.upload_dir.clone();
        file_path.push(if pending { PENDING_DIR } else { COMPLETED_DIR });
        file_path.push(login_dir(login));
        let file_name = format!("{file_id}.{upload_length}");
        file_path.push(&file_name);
        (file_path, file_name)
    }

    fn serialize_metadata(
        metadata: &TusUploadMetadata,
    ) -> Result<Vec<u8>, AppError> {
        let bytes = serde_json::to_vec(metadata).c(h!())?;
        if bytes.len() as u64
            > crate::config::SIGINT_FILE_UPLOAD_METADATA_MAX_BYTES
        {
            return Err(AppError::BL {
                msg: "upload metadata is too large".to_string(),
            });
        }
        Ok(bytes)
    }

    async fn read_metadata(
        &self,
        file_path: &Path,
    ) -> Result<TusUploadMetadata, AppError> {
        let metadata_path = self.metadata_path(file_path);
        if !tokio::fs::try_exists(&metadata_path).await.c(h!())? {
            return Ok(TusUploadMetadata::default());
        }
        let file = tokio::fs::File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(metadata_path)
            .await
            .c(h!())?;
        if !file.metadata().await.c(h!())?.is_file() {
            return Err(AppError::BL {
                msg: "invalid upload metadata file".to_string(),
            });
        }
        let mut bytes = Vec::new();
        use tokio::io::AsyncReadExt;
        file.take(crate::config::SIGINT_FILE_UPLOAD_METADATA_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .c(h!())?;
        if bytes.len() as u64
            > crate::config::SIGINT_FILE_UPLOAD_METADATA_MAX_BYTES
        {
            return Err(AppError::BL {
                msg: "upload metadata is too large".to_string(),
            });
        }
        Ok(serde_json::from_slice(&bytes).c(h!())?)
    }

    fn metadata_path(&self, file_path: &Path) -> PathBuf {
        let mut metadata_path = file_path.as_os_str().to_os_string();
        metadata_path.push(".");
        metadata_path.push(METADATA_EXT);
        PathBuf::from(metadata_path)
    }

    fn expires_at_for_metadata(
        &self,
        metadata: &std::fs::Metadata,
        pending: bool,
    ) -> Result<DateTime<Utc>, AppError> {
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?;
        Ok((created + self.expires_in(pending)).into())
    }

    fn add_expires_header(
        &self,
        metadata: &std::fs::Metadata,
        pending: bool,
        builder: &mut actix_web::HttpResponseBuilder,
    ) -> Result<(), AppError> {
        let expires = self
            .expires_at_for_metadata(metadata, pending)
            .context(h!())?;
        builder.insert_header((
            HEADER_NAME_UPLOAD_EXPIRES,
            format_upload_expires(expires),
        ));
        Ok(())
    }

    fn expires_in(&self, pending: bool) -> Duration {
        if pending {
            self.config.pending_expires_in
        } else {
            self.config.completed_expires_in
        }
    }

    fn has_expired(
        &self,
        metadata: &std::fs::Metadata,
        pending: bool,
    ) -> anyhow::Result<bool> {
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?;
        Ok(created + self.expires_in(pending) <= SystemTime::now())
    }

    pub(super) async fn cleanup_expired(&self) -> anyhow::Result<()> {
        lifecycle::cleanup(
            &self.upload_dir,
            self.config.pending_expires_in,
            self.config.completed_expires_in,
        )
        .await
        .c(h!())
    }

    fn build_status_response(&self, status_code: StatusCode) -> HttpResponse {
        let mut builder = HttpResponse::build(status_code);
        self.add_default_headers(&mut builder);
        builder
            .insert_header((HEADER_NAME_TUS_VERSION, HEADER_VALUE_TUS_VERSION));
        builder.finish()
    }

    fn rejected_chunk_response(
        &self,
        status_code: StatusCode,
        reason: &'static str,
        file_id: Option<Uuid>,
        upload_length: Option<u64>,
        upload_offset: Option<u64>,
        current_offset: Option<u64>,
    ) -> HttpResponse {
        log::warn!(
            target: "tus_upload",
            "event=chunk_rejected status={} reason={reason} file_id={file_id:?} upload_length={upload_length:?} upload_offset={upload_offset:?} current_offset={current_offset:?}",
            status_code.as_u16()
        );
        let mut builder = HttpResponse::build(status_code);
        self.add_default_headers(&mut builder);
        if let Some(offset) = current_offset {
            builder
                .insert_header((HEADER_NAME_UPLOAD_OFFSET, offset.to_string()));
        }
        builder.finish()
    }

    fn add_default_headers(
        &self,
        builder: &mut actix_web::HttpResponseBuilder,
    ) {
        builder
            .insert_header((header::CACHE_CONTROL, HEADER_VALUE_CACHE_CONTROL));
        builder.insert_header((
            HEADER_NAME_TUS_RESUMABLE,
            HEADER_VALUE_TUS_RESUMABLE,
        ));
    }

    fn add_head_options_response_headers(
        &self,
        builder: &mut actix_web::HttpResponseBuilder,
    ) {
        self.add_default_headers(builder);
        builder
            .insert_header((HEADER_NAME_TUS_VERSION, HEADER_VALUE_TUS_VERSION));
        builder.insert_header((
            HEADER_NAME_TUS_EXTENSION,
            HEADER_VALUE_TUS_EXTENSION,
        ));
        if let Some(max_size) = self.config.max_size {
            builder.insert_header((
                HEADER_NAME_TUS_MAX_SIZE,
                max_size.to_string(),
            ));
        }
    }
}

fn parse_upload_metadata(
    upload_metadata: &HeaderValue,
) -> Result<TusUploadMetadata, AppError> {
    let upload_metadata =
        std::str::from_utf8(upload_metadata.as_bytes()).c(h!())?;
    let mut metadata = TusUploadMetadata::default();
    for kv in upload_metadata.split(',') {
        if !kv.is_ascii() {
            continue;
        }
        let (key, value) = kv.split_once(' ').unwrap_or((kv, ""));
        let value = base64::engine::general_purpose::STANDARD
            .decode(value)
            .ok()
            .and_then(|value| String::from_utf8(value).ok());
        match key {
            "filename" => metadata.filename = value,
            "filetype" => metadata.filetype = value,
            "name" => metadata.meta_name = value,
            "type" => metadata.meta_type = value,
            "relativePath" => metadata.relative_path = value,
            _ => {}
        }
    }
    Ok(metadata)
}

fn media_upload_input_from_tus_upload(upload: TusUpload) -> MediaUploadInput {
    MediaUploadInput {
        path: upload.file_path.display().to_string(),
        name: upload
            .metadata
            .filename
            .or(upload.metadata.meta_name)
            .or_else(|| {
                upload
                    .file_path
                    .file_name()
                    .and_then(|file_name| file_name.to_str())
                    .map(|file_name| file_name.to_string())
            }),
        content_type: upload.metadata.filetype.or(upload.metadata.meta_type),
    }
}

pub(super) fn login_dir(login: &uuid::Uuid) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(login.as_bytes())
}

pub(super) fn parse_request_file(request_file: &str) -> Option<(Uuid, u64)> {
    let (file_id, upload_length) = request_file.split_once('.')?;
    if upload_length.is_empty()
        || !upload_length.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((Uuid::try_parse(file_id).ok()?, upload_length.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::FromRequest;
    use futures_util::stream;

    // Regression for ECHO-3324: stale Uppy resume URLs must not revive expired uploads.
    #[tokio::test]
    async fn expired_completed_upload_is_unavailable_to_head_and_direct_submit()
    {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let mut handler = test_handler(&temp_dir);
        handler.config.completed_expires_in = Duration::ZERO;
        let (upload_url, file_path, upload_length) =
            create_test_completed_upload(&handler, &login).await;
        let request_file = upload_url.strip_prefix(&handler.prefix).unwrap();

        assert!(tokio::fs::try_exists(&file_path).await.unwrap());
        let error = handler
            .resolve_completed_uploads(
                &login,
                std::slice::from_ref(&upload_url),
            )
            .await
            .unwrap_err();
        let AppError::BL { msg } = error else {
            panic!("expected an unavailable upload validation error");
        };
        assert!(msg.contains(&upload_url));

        let response = handler
            .process_head_request(&login, &tus_headers(), request_file)
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!response.headers().contains_key(HEADER_NAME_UPLOAD_OFFSET));
        assert!(!response.headers().contains_key(HEADER_NAME_UPLOAD_LENGTH));
        assert!(!tokio::fs::try_exists(&file_path).await.unwrap());
        assert!(!tokio::fs::try_exists(handler.metadata_path(&file_path))
            .await
            .unwrap());
        assert_eq!(upload_length, 11);
    }

    // Regression for ECHO-3324: PATCH must not revive an expired pending upload.
    #[tokio::test]
    async fn expired_pending_upload_is_rejected_before_writing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let mut handler = test_handler(&temp_dir);
        handler.config.pending_expires_in = Duration::ZERO;
        let mut headers = tus_headers();
        headers
            .insert(HEADER_NAME_UPLOAD_LENGTH, HeaderValue::from_static("5"));
        let response = handler
            .process_post_request(&login, &headers)
            .await
            .unwrap();
        let upload_url = header_value(&response, header::LOCATION);
        let request_file = upload_url.strip_prefix(&handler.prefix).unwrap();
        let (file_path, _, _) = handler
            .parse_request_file_path(&login, request_file, true)
            .await
            .unwrap()
            .unwrap();

        headers.insert(header::CONTENT_TYPE, HEADER_VALUE_CONTENT_TYPE_PATCH);
        headers
            .insert(HEADER_NAME_UPLOAD_OFFSET, HeaderValue::from_static("0"));
        let response = handler
            .process_patch_request(
                &login,
                &headers,
                request_file,
                test_payload(b"image"),
                Some(test_upload_lock(&handler, request_file).await),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!tokio::fs::try_exists(&file_path).await.unwrap());
        assert!(!tokio::fs::try_exists(handler.metadata_path(&file_path))
            .await
            .unwrap());
    }

    // Regression for ECHO-3324: completed uploads use their own expiration TTL consistently.
    #[tokio::test]
    async fn fresh_completed_upload_is_resumable_and_available_to_direct_submit(
    ) {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let mut handler = test_handler(&temp_dir);
        handler.config.pending_expires_in = Duration::from_secs(60);
        handler.config.completed_expires_in = Duration::from_secs(120);
        let (upload_url, file_path, upload_length) =
            create_test_completed_upload(&handler, &login).await;
        let request_file = upload_url.strip_prefix(&handler.prefix).unwrap();
        let expires = handler
            .expires_at_for_metadata(
                &tokio::fs::metadata(&file_path).await.unwrap(),
                false,
            )
            .unwrap();
        let uploads = handler
            .resolve_completed_uploads(
                &login,
                std::slice::from_ref(&upload_url),
            )
            .await
            .unwrap();

        assert_eq!(uploads.len(), 1);
        assert_eq!(uploads[0].path, file_path.display().to_string());

        let response = handler
            .process_head_request(&login, &tus_headers(), request_file)
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_OFFSET),
            upload_length.to_string()
        );
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_LENGTH),
            upload_length.to_string()
        );
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_EXPIRES),
            expires.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
        );
    }

    // Regression for ECHO-3324: partial uploads stay resumable under the pending TTL.
    #[tokio::test]
    async fn fresh_partial_upload_reports_pending_expiration_and_completes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let mut handler = test_handler(&temp_dir);
        handler.config.pending_expires_in = Duration::from_secs(60);
        handler.config.completed_expires_in = Duration::from_secs(120);
        let upload_length = 11;
        let mut headers = tus_headers();
        headers
            .insert(HEADER_NAME_UPLOAD_LENGTH, HeaderValue::from_static("11"));
        let response = handler
            .process_post_request(&login, &headers)
            .await
            .unwrap();
        let upload_url = header_value(&response, header::LOCATION);
        let request_file = upload_url.strip_prefix(&handler.prefix).unwrap();
        let (file_path, _, _) = handler
            .parse_request_file_path(&login, request_file, true)
            .await
            .unwrap()
            .unwrap();
        let expires = handler
            .expires_at_for_metadata(
                &tokio::fs::metadata(&file_path).await.unwrap(),
                true,
            )
            .unwrap();

        headers.insert(header::CONTENT_TYPE, HEADER_VALUE_CONTENT_TYPE_PATCH);
        headers
            .insert(HEADER_NAME_UPLOAD_OFFSET, HeaderValue::from_static("0"));
        let response = handler
            .process_patch_request(
                &login,
                &headers,
                request_file,
                test_payload(b"image"),
                Some(test_upload_lock(&handler, request_file).await),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(header_value(&response, HEADER_NAME_UPLOAD_OFFSET), "5");

        let response = handler
            .process_head_request(&login, &tus_headers(), request_file)
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(header_value(&response, HEADER_NAME_UPLOAD_OFFSET), "5");
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_LENGTH),
            upload_length.to_string()
        );
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_EXPIRES),
            expires.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
        );

        headers
            .insert(HEADER_NAME_UPLOAD_OFFSET, HeaderValue::from_static("5"));
        let response = handler
            .process_patch_request(
                &login,
                &headers,
                request_file,
                test_payload(b" bytes"),
                Some(test_upload_lock(&handler, request_file).await),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_value(&response, HEADER_NAME_UPLOAD_OFFSET),
            upload_length.to_string()
        );
        let uploads = handler
            .resolve_completed_uploads(
                &login,
                std::slice::from_ref(&upload_url),
            )
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&uploads[0].path).await.unwrap(),
            b"image bytes"
        );
    }

    fn test_handler(temp_dir: &tempfile::TempDir) -> TusHandler {
        TusHandler::new(
            temp_dir.path().display().to_string(),
            "/api/sigint/file-upload/tus",
        )
    }

    async fn create_test_completed_upload(
        handler: &TusHandler,
        login: &Uuid,
    ) -> (String, PathBuf, u64) {
        let result = handler
            .create_completed_upload(
                login,
                TusUploadMetadata::default(),
                stream::iter([Ok(web::Bytes::from_static(b"image bytes"))]),
            )
            .await
            .unwrap();
        let CompletedUploadWriteResult::Stored {
            upload_url, size, ..
        } = result
        else {
            panic!("expected a stored fallback upload");
        };
        let request_file = upload_url.strip_prefix(&handler.prefix).unwrap();
        let (file_path, _, _) = handler
            .parse_request_file_path(login, request_file, false)
            .await
            .unwrap()
            .unwrap();
        (upload_url, file_path, size)
    }

    fn tus_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_NAME_TUS_RESUMABLE, HEADER_VALUE_TUS_RESUMABLE);
        headers
    }

    fn header_value(response: &HttpResponse, name: HeaderName) -> String {
        response
            .headers()
            .get(name)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    fn test_payload(bytes: &'static [u8]) -> web::Payload {
        let (request, mut payload) = actix_web::test::TestRequest::default()
            .set_payload(web::Bytes::from_static(bytes))
            .to_http_parts();
        web::Payload::from_request(&request, &mut payload)
            .into_inner()
            .unwrap()
    }

    async fn test_upload_lock(
        handler: &TusHandler,
        request_file: &str,
    ) -> UploadLock {
        let (file_id, _) = parse_request_file(request_file).unwrap();
        UploadLock::acquire(&handler.upload_dir, file_id)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn fallback_completion_without_caller_acceptance_removes_promoted_artifacts(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let handler = TusHandler::new(
            directory.path().display().to_string(),
            "/api/sigint/file-upload/tus",
        );
        let (sender, receiver) = tokio::sync::mpsc::channel(
            SIGINT_FILE_UPLOAD_FALLBACK_CHANNEL_CAPACITY,
        );
        let (respond, response) = tokio::sync::oneshot::channel();
        let (accept, accepted) = tokio::sync::oneshot::channel();
        let worker_handler = handler.clone();
        let worker = tokio::spawn(async move {
            worker_handler
                .run_fallback_upload(
                    login,
                    TusUploadMetadata::default(),
                    receiver,
                    respond,
                    accepted,
                )
                .await;
        });
        sender
            .send(FallbackUploadMessage::Chunk(Ok(web::Bytes::from_static(
                b"complete",
            ))))
            .await
            .unwrap();
        sender.send(FallbackUploadMessage::Complete).await.unwrap();
        let completed = handler
            .upload_dir
            .join(COMPLETED_DIR)
            .join(login_dir(&login));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_dir(&completed)
                .is_ok_and(|entries| entries.count() == 2)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("source and metadata were not promoted");
        drop(response);
        drop(accept);
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(fallback_pending_files(&handler, &login).await.is_empty());
        assert!(!completed.exists());
    }

    #[tokio::test]
    async fn fallback_upload_is_available_through_completed_url() {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let handler = TusHandler::new(
            temp_dir.path().display().to_string(),
            "/api/sigint/file-upload/tus",
        );
        let metadata = TusUploadMetadata {
            filename: Some("evidence.png".to_string()),
            filetype: Some("image/png".to_string()),
            ..TusUploadMetadata::default()
        };

        let result = handler
            .create_completed_upload(
                &login,
                metadata,
                stream::iter([Ok(web::Bytes::from_static(b"image bytes"))]),
            )
            .await
            .unwrap();
        let CompletedUploadWriteResult::Stored { upload_url, .. } = result
        else {
            panic!("expected a stored fallback upload");
        };
        let upload = handler
            .open_completed_url(&login, &upload_url)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            tokio::fs::read(upload.file_path).await.unwrap(),
            b"image bytes"
        );
        assert_eq!(upload.metadata.filename.as_deref(), Some("evidence.png"));
        assert_eq!(upload.metadata.filetype.as_deref(), Some("image/png"));
    }

    #[tokio::test]
    async fn fallback_upload_rejects_empty_file_and_removes_temporary_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let handler = TusHandler::new(
            temp_dir.path().display().to_string(),
            "/api/sigint/file-upload/tus",
        );

        let result = handler
            .create_completed_upload(
                &login,
                TusUploadMetadata::default(),
                stream::empty::<Result<web::Bytes, AppError>>(),
            )
            .await
            .unwrap();

        assert_eq!(result, CompletedUploadWriteResult::Empty);
        assert!(fallback_pending_files(&handler, &login).await.is_empty());
    }

    #[tokio::test]
    async fn fallback_upload_rejects_excess_bytes_and_removes_temporary_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let login = Uuid::new_v4();
        let mut handler = TusHandler::new(
            temp_dir.path().display().to_string(),
            "/api/sigint/file-upload/tus",
        );
        handler.config.max_size = Some(3);

        let result = handler
            .create_completed_upload(
                &login,
                TusUploadMetadata::default(),
                stream::iter([Ok(web::Bytes::from_static(b"four"))]),
            )
            .await
            .unwrap();

        assert_eq!(result, CompletedUploadWriteResult::TooLarge);
        assert!(fallback_pending_files(&handler, &login).await.is_empty());
    }

    async fn fallback_pending_files(
        handler: &TusHandler,
        login: &Uuid,
    ) -> Vec<PathBuf> {
        let directory =
            handler.upload_dir.join(PENDING_DIR).join(login_dir(login));
        let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            paths.push(entry.path());
        }
        paths
    }
}
