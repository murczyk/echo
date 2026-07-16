use crate::config::SIGINT_MESSAGE_MAX_ATTACHMENTS;
use crate::error::AppError;
use crate::messenger::media::MediaUploadInput;
use crate::types::*;
use actix_web::http::header::{HeaderMap, HeaderName, HeaderValue};
use actix_web::http::{header, Method, StatusCode};
use actix_web::{web, HttpResponse};
use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
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
const HEADER_VALUE_TUS_VERSION: HeaderValue = HeaderValue::from_static("1.0.0");
const HEADER_NAME_TUS_RESUMABLE: HeaderName =
    HeaderName::from_static("tus-resumable");
const HEADER_VALUE_TUS_RESUMABLE: HeaderValue =
    HeaderValue::from_static("1.0.0");
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
    upload_dir: PathBuf,
    config: TusConfig,
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

enum WriteResult {
    Conflict,
    TooLarge,
    Written(u64),
}

impl Default for TusConfig {
    fn default() -> TusConfig {
        TusConfig {
            max_size: Some(2 * 1024 * 1024 * 1024),
            pending_expires_in: Duration::from_secs(4 * 3600),
            completed_expires_in: Duration::from_secs(8 * 3600),
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
        login: &str,
        method: &Method,
        headers: &HeaderMap,
        request_file: Option<String>,
        payload: web::Payload,
    ) -> Result<HttpResponse, AppError> {
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
        login: &str,
        upload_url: &str,
    ) -> Result<Option<TusUpload>, AppError> {
        let Some(request_file) = upload_url.strip_prefix(&self.prefix) else {
            return Ok(None);
        };
        self.open_completed_file(login, request_file).await
    }

    pub async fn resolve_completed_uploads(
        &self,
        login: &str,
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

    pub async fn open_completed_file(
        &self,
        login: &str,
        request_file: &str,
    ) -> Result<Option<TusUpload>, AppError> {
        let now = Utc::now();
        let Some((file_path, file_id, upload_length)) = self
            .parse_request_file_path(login, request_file, false)
            .await?
        else {
            return Ok(None);
        };
        let tus_upload = self
            .open_tus_upload(file_id, login, upload_length, file_path)
            .await?;
        if tus_upload.expires > now {
            Ok(Some(tus_upload))
        } else {
            Ok(None)
        }
    }

    async fn open_tus_upload(
        &self,
        file_id: Uuid,
        login: &str,
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
        login: &str,
        headers: &HeaderMap,
        request_file: &str,
    ) -> Result<HttpResponse, AppError> {
        if !self.is_valid_protocol_version(headers) {
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
            match tokio::fs::metadata(file_path).await {
                Ok(metadata) if metadata.is_file() => {
                    let mut builder = HttpResponse::NoContent();
                    self.add_head_options_response_headers(&mut builder);
                    self.add_expires_header(&metadata, &mut builder)?;
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
                    return Ok(self.build_status_response(StatusCode::NOT_FOUND))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Ok(self.build_status_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                    ))
                }
            }
        }
        Ok(self.build_status_response(StatusCode::NOT_FOUND))
    }

    async fn process_patch_request(
        &self,
        login: &str,
        headers: &HeaderMap,
        request_file: &str,
        payload: web::Payload,
    ) -> Result<HttpResponse, AppError> {
        if !self.is_valid_protocol_version(headers) {
            return Ok(
                self.build_status_response(StatusCode::PRECONDITION_FAILED)
            );
        }
        if headers.get(header::CONTENT_TYPE)
            != Some(&HEADER_VALUE_CONTENT_TYPE_PATCH)
        {
            return Ok(
                self.build_status_response(StatusCode::UNSUPPORTED_MEDIA_TYPE)
            );
        }

        let Some((file_path, file_id, upload_length)) = self
            .parse_request_file_path(login, request_file, true)
            .await?
        else {
            return Ok(self.build_status_response(StatusCode::NOT_FOUND));
        };
        let Some(upload_offset) = headers.get(HEADER_NAME_UPLOAD_OFFSET) else {
            return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
        };
        let upload_offset =
            u64::from_str(upload_offset.to_str().c(h!())?).c(h!())?;
        if upload_offset > upload_length {
            return Ok(
                self.build_status_response(StatusCode::PAYLOAD_TOO_LARGE)
            );
        }

        let mut file = match tokio::fs::File::options()
            .read(true)
            .append(true)
            .open(&file_path)
            .await
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.build_status_response(StatusCode::NOT_FOUND))
            }
            Err(_) => {
                return Ok(self
                    .build_status_response(StatusCode::INTERNAL_SERVER_ERROR))
            }
        };

        let metadata = file.metadata().await.c(h!())?;
        let mut builder = HttpResponse::NoContent();
        self.add_default_headers(&mut builder);
        self.add_expires_header(&metadata, &mut builder)?;
        let upload_offset =
            match Self::write(&mut file, upload_offset, upload_length, payload)
                .await?
            {
                WriteResult::Conflict => {
                    return Ok(self.build_status_response(StatusCode::CONFLICT))
                }
                WriteResult::TooLarge => {
                    return Ok(self
                        .build_status_response(StatusCode::PAYLOAD_TOO_LARGE))
                }
                WriteResult::Written(new_pos) => new_pos,
            };
        builder.insert_header((
            HEADER_NAME_UPLOAD_OFFSET,
            upload_offset.to_string(),
        ));
        if upload_offset == upload_length {
            file.sync_all().await.c(h!())?;
            self.add_completed(file_id, login, file_path, upload_length)
                .await
                .c(h!())?;
        }
        Ok(builder.finish())
    }

    async fn write(
        file: &mut tokio::fs::File,
        expected_offset: u64,
        upload_length: u64,
        mut payload: web::Payload,
    ) -> Result<WriteResult, AppError> {
        let current_position =
            file.seek(std::io::SeekFrom::End(0)).await.c(h!())?;
        if expected_offset != current_position {
            return Ok(WriteResult::Conflict);
        }
        let mut size = expected_offset;
        while let Some(chunk) = payload.next().await {
            let chunk = chunk
                .map_err(|e| AppError::AnyhowError { source: e.into() })?;
            let Some(new_size) = size.checked_add(chunk.len() as u64) else {
                return Ok(WriteResult::TooLarge);
            };
            if new_size > upload_length {
                return Ok(WriteResult::TooLarge);
            }
            file.write_all(&chunk).await.c(h!())?;
            size = new_size;
        }
        file.flush().await.c(h!())?;
        Ok(WriteResult::Written(file.stream_position().await.c(h!())?))
    }

    async fn add_completed(
        &self,
        file_id: Uuid,
        login: &str,
        file_path: PathBuf,
        upload_length: u64,
    ) -> Result<(), AppError> {
        let (new_path, _file_name) = self
            .create_file_path(file_id, login, upload_length, false)
            .await?;
        tokio::fs::rename(&file_path, &new_path).await.c(h!())?;
        let old_metadata_path = self.metadata_path(&file_path);
        let new_metadata_path = self.metadata_path(&new_path);
        if tokio::fs::try_exists(&old_metadata_path).await.c(h!())? {
            tokio::fs::rename(old_metadata_path, new_metadata_path)
                .await
                .c(h!())?;
        }
        Ok(())
    }

    async fn process_delete_request(
        &self,
        login: &str,
        headers: &HeaderMap,
        request_file: &str,
    ) -> Result<HttpResponse, AppError> {
        if !self.is_valid_protocol_version(headers) {
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
            match tokio::fs::remove_file(&file_path).await {
                Ok(()) => {
                    let _ =
                        tokio::fs::remove_file(self.metadata_path(&file_path))
                            .await;
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
        login: &str,
        headers: &HeaderMap,
    ) -> Result<HttpResponse, AppError> {
        if !self.is_valid_protocol_version(headers) {
            return Ok(
                self.build_status_response(StatusCode::PRECONDITION_FAILED)
            );
        }
        let Some(upload_length) = headers.get(HEADER_NAME_UPLOAD_LENGTH) else {
            return Ok(self.build_status_response(StatusCode::BAD_REQUEST));
        };
        let upload_length =
            u64::from_str(upload_length.to_str().c(h!())?).c(h!())?;
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

        let file_id = Uuid::now_v7();
        let (file_path, file_name) = self
            .create_file_path(file_id, login, upload_length, true)
            .await?;
        let file = tokio::fs::File::options()
            .create_new(true)
            .append(true)
            .open(&file_path)
            .await
            .c(h!())?;
        let metadata = file.metadata().await.c(h!())?;
        if let Some(upload_metadata) = headers.get(HEADER_NAME_UPLOAD_METADATA)
        {
            self.write_metadata(&file_path, upload_metadata)
                .await
                .c(h!())?;
        }

        let mut builder = HttpResponse::Created();
        self.add_default_headers(&mut builder);
        self.add_expires_header(&metadata, &mut builder)?;
        builder.insert_header((
            header::LOCATION,
            format!("{}{}", &self.prefix, &file_name),
        ));
        Ok(builder.finish())
    }

    async fn process_options_request(&self) -> Result<HttpResponse, AppError> {
        let mut builder = HttpResponse::NoContent();
        self.add_head_options_response_headers(&mut builder);
        Ok(builder.finish())
    }

    fn is_valid_protocol_version(&self, headers: &HeaderMap) -> bool {
        headers.get(HEADER_NAME_TUS_RESUMABLE)
            == Some(&HEADER_VALUE_TUS_RESUMABLE)
    }

    async fn parse_request_file_path(
        &self,
        login: &str,
        request_file: &str,
        pending: bool,
    ) -> Result<Option<(PathBuf, Uuid, u64)>, AppError> {
        let Some((file_id, upload_length)) = request_file.split_once('.')
        else {
            return Ok(None);
        };
        let Ok(file_id) = Uuid::try_parse(file_id) else {
            return Ok(None);
        };
        let Ok(upload_length) = u64::from_str(upload_length) else {
            return Ok(None);
        };

        let mut file_path = self.upload_dir.clone();
        file_path.push(if pending { PENDING_DIR } else { COMPLETED_DIR });
        file_path.push(login_dir(login));
        tokio::fs::create_dir_all(&file_path).await.c(h!())?;
        file_path.push(request_file);
        Ok(Some((file_path, file_id, upload_length)))
    }

    async fn create_file_path(
        &self,
        file_id: Uuid,
        login: &str,
        upload_length: u64,
        pending: bool,
    ) -> Result<(PathBuf, String), AppError> {
        let mut file_path = self.upload_dir.clone();
        file_path.push(if pending { PENDING_DIR } else { COMPLETED_DIR });
        file_path.push(login_dir(login));
        tokio::fs::create_dir_all(&file_path).await.c(h!())?;
        let file_name = format!("{file_id}.{upload_length}");
        file_path.push(&file_name);
        Ok((file_path, file_name))
    }

    async fn write_metadata(
        &self,
        file_path: &Path,
        upload_metadata: &HeaderValue,
    ) -> Result<(), AppError> {
        let metadata = parse_upload_metadata(upload_metadata).c(h!())?;
        let bytes = serde_json::to_vec(&metadata).c(h!())?;
        tokio::fs::write(self.metadata_path(file_path), bytes)
            .await
            .c(h!())?;
        Ok(())
    }

    async fn read_metadata(
        &self,
        file_path: &Path,
    ) -> Result<TusUploadMetadata, AppError> {
        let metadata_path = self.metadata_path(file_path);
        if !tokio::fs::try_exists(&metadata_path).await.c(h!())? {
            return Ok(TusUploadMetadata::default());
        }
        let bytes = tokio::fs::read(metadata_path).await.c(h!())?;
        Ok(serde_json::from_slice(&bytes).c(h!())?)
    }

    fn metadata_path(&self, file_path: &Path) -> PathBuf {
        let mut metadata_path = file_path.as_os_str().to_os_string();
        metadata_path.push(".");
        metadata_path.push(METADATA_EXT);
        PathBuf::from(metadata_path)
    }

    fn add_expires_header(
        &self,
        metadata: &std::fs::Metadata,
        builder: &mut actix_web::HttpResponseBuilder,
    ) -> Result<SystemTime, AppError> {
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?;
        let expires: DateTime<Utc> =
            (created + self.config.pending_expires_in).into();
        builder.insert_header((
            HEADER_NAME_UPLOAD_EXPIRES,
            expires.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        ));
        Ok(created)
    }

    fn build_status_response(&self, status_code: StatusCode) -> HttpResponse {
        let mut builder = HttpResponse::build(status_code);
        self.add_default_headers(&mut builder);
        builder
            .insert_header((HEADER_NAME_TUS_VERSION, HEADER_VALUE_TUS_VERSION));
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

fn login_dir(login: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(login.as_bytes())
}
