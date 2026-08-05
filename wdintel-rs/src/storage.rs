use crate::config::get_assets_folder;
use crate::config::S3_MEDIA_ROOT_PREFIX;
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::types::error;
use crate::types::{info, warn};
use crate::types::{Env, ShortContext};
use crate::users::ensure_basic_role;
use actix_files::NamedFile;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use opendal::Operator;
use rand::Rng;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use strong_box::{Key, StaticStrongBox, StrongBox};
use tokio::io::AsyncReadExt;
use tokio::sync::Semaphore;
use uuid::Uuid;

static WHOLE_OBJECT_DECRYPT_SEMAPHORE: LazyLock<Arc<Semaphore>> = LazyLock::new(
    || {
        Arc::new(Semaphore::new(
            crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_CONCURRENT_OPERATIONS,
        ))
    },
);
static SMALL_OBJECT_DECRYPT_SEMAPHORE: LazyLock<Arc<Semaphore>> = LazyLock::new(
    || {
        Arc::new(Semaphore::new(
            crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_CONCURRENT_SMALL_OPERATIONS,
        ))
    },
);

struct PlaintextUploadWriter {
    writer: Option<opendal::Writer>,
    remote_key: String,
}

impl PlaintextUploadWriter {
    fn new(writer: opendal::Writer, remote_key: String) -> Self {
        Self {
            writer: Some(writer),
            remote_key,
        }
    }

    fn writer(&mut self) -> &mut opendal::Writer {
        self.writer.as_mut().expect("plaintext writer is open")
    }

    async fn abort(&mut self) -> opendal::Result<()> {
        let result = self.writer().abort().await;
        if result.is_ok() {
            self.writer.take();
        }
        result
    }

    async fn close(&mut self) -> opendal::Result<()> {
        let result = self.writer().close().await;
        if result.is_ok() {
            self.writer.take();
        }
        result.map(|_| ())
    }
}

impl Drop for PlaintextUploadWriter {
    fn drop(&mut self) {
        let Some(mut writer) = self.writer.take() else {
            return;
        };
        let remote_key = self.remote_key.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            warn!(
                "could not schedule cancellation cleanup for plaintext upload {remote_key}: no Tokio runtime"
            );
            return;
        };
        drop(runtime.spawn(async move {
            if let Err(error) = writer.abort().await {
                warn!(
                    "failed to abort cancelled plaintext upload for {remote_key}: {error:#?}"
                );
            }
        }));
    }
}

pub async fn serve_assets(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: web::Data<Env>,
) -> Result<impl Responder, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;

    let filename = req.match_info().query("filename");
    let path: PathBuf = match filename.parse() {
        Ok(path) => path,
        Err(e) => {
            error!("bad filename {filename}: {:#?}", e);
            return Ok(HttpResponse::NotFound().body("Asset not found"));
        }
    };
    let local_path = PathBuf::from(get_assets_folder(&env.config)).join(&path);

    // 1. Attempt to serve from local storage
    if local_path.exists() && local_path.is_file() {
        if let Ok(named_file) = NamedFile::open(local_path) {
            return Ok(named_file.into_response(&req));
        }
    }

    // 2. Fallback: Attempt to read from S3
    let file_id = PathBuf::from(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .and_then(|f| Uuid::from_str(f.as_str()).ok());
    let id = match file_id {
        Some(id) => {
            let m_ext = PathBuf::from(filename)
                .extension()
                .map(|s| s.to_string_lossy().to_string());
            let key = nested_object_key(&id);
            match m_ext {
                None => key,
                Some(ext) => format!("{key}.{ext}"),
            }
        }
        None => {
            warn!(
                "unexpected filename format: {filename}, expected UUID + '.' + extension"
            );
            filename.to_string()
        }
    };
    match crate::messenger::media::fetch_media_bytes_by_key(&env, &id).await {
        Ok(body) => Ok(HttpResponse::Ok()
            .content_type("application/octet-stream")
            .body(body)),
        Err(error @ AppError::ServiceUnavailable { .. }) => Err(error),
        Err(e) => {
            error!("failed to load asset from s3: {:#?}", e);
            Ok(HttpResponse::NotFound().body("Asset not found"))
        }
    }
}

/// S3 configuration parameters
#[derive(Debug, Clone)]
pub struct S3Config {
    pub bucket: String,
    pub region: String,
    pub endpoint: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
}

impl From<&crate::config::S3Config> for S3Config {
    fn from(config: &crate::config::S3Config) -> Self {
        Self::with_prefix(config, S3_MEDIA_ROOT_PREFIX.to_string())
    }
}

impl S3Config {
    pub fn with_prefix(
        config: &crate::config::S3Config,
        prefix: String,
    ) -> Self {
        Self {
            bucket: config.s3_bucket.clone(),
            region: config.s3_region.clone(),
            endpoint: config.s3_endpoint.clone(),
            access_key_id: config.s3_access_key_id.clone(),
            secret_access_key: config.s3_secret_access_key.clone(),
            prefix,
        }
    }

    /// Returns a key with the configured prefix applied.
    pub fn prefixed_key(&self, rel_path: &str) -> String {
        join_paths(&self.prefix, rel_path)
    }

    /// Basic check whether a bucket is configured.
    pub fn is_configured(&self) -> bool {
        !self.bucket.trim().is_empty()
    }
}

/// Build an S3 operator from configuration
pub fn build_s3_operator(config: &S3Config) -> Result<Operator, AppError> {
    use opendal::services::S3;
    if config.bucket.trim().is_empty() {
        return Err(AppError::BL {
            msg: "s3 bucket is not configured".to_string(),
        });
    }
    let mut b = S3::default().bucket(&config.bucket);
    if !config.region.trim().is_empty() {
        b = b.region(&config.region);
    }
    if !config.endpoint.trim().is_empty() {
        b = b.endpoint(&config.endpoint);
    }
    if !config.access_key_id.trim().is_empty() {
        b = b.access_key_id(&config.access_key_id);
    }
    if !config.secret_access_key.trim().is_empty() {
        b = b.secret_access_key(&config.secret_access_key);
    }
    // Add OpenDAL retry layer: 3 retries with exponential backoff to soften S3 throttling
    let retry = opendal::layers::RetryLayer::new()
        .with_min_delay(Duration::from_secs(1))
        .with_factor(2.0)
        .with_jitter()
        .with_max_times(3)
        .with_notify(|_err: &opendal::Error, _dur: Duration| {});
    let op = Operator::new(b)
        .map_err(|e| AppError::BL {
            msg: format!("s3 store build error: {e}"),
        })?
        .layer(retry)
        .finish();
    Ok(op)
}

/// Decode a base64-encoded encryption key
pub fn key_from_b64(s: &str) -> Result<Key, AppError> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .c(h!())?;
    let arr: [u8; 32] =
        raw.as_slice().try_into().map_err(|_| AppError::BL {
            msg: "strongbox key must be 32 bytes when base64-decoded".into(),
        })?;
    Ok(Key::from(Box::new(arr)))
}

/// Join S3 prefix with path
pub fn join_paths(prefix: &str, path: &str) -> String {
    let mut p = String::new();
    if !prefix.is_empty() {
        p.push_str(prefix.trim_matches('/'));
        p.push('/');
    }
    p.push_str(path.trim_start_matches('/'));
    p
}

fn aad(bucket: &str, key: &str) -> String {
    format!("{bucket}/{key}")
}

/// Upload encrypted data to S3
/// Returns (bucket, remote_key) on success
pub async fn upload_encrypted_to_s3_with_operator(
    op: &Option<Operator>,
    config: &S3Config,
    strongbox_key_b64: &str,
    rel_path: &str,
    data: &[u8],
) -> Result<(), AppError> {
    let Some(op) = op else {
        warn!("S3 not configured, failed to write!");
        return Ok(());
    };
    let remote_key = config.prefixed_key(rel_path);
    let key = key_from_b64(strongbox_key_b64)?;
    let sb = StaticStrongBox::new(key.clone(), vec![key]);
    let ciphertext = sb
        .encrypt(data, aad(&config.bucket, &remote_key).as_bytes())
        .map_err(|err| AppError::BL {
            msg: format!("failed to encrypt payload for {remote_key}: {err}"),
        })?;
    op.write(&remote_key, ciphertext).await.c(h!())?;
    info!("stored to {}: {}", config.bucket.clone(), remote_key);
    Ok(())
}

pub async fn upload_plaintext_file_to_s3_with_operator(
    op: &Option<Operator>,
    config: &S3Config,
    rel_path: &str,
    file: tokio::fs::File,
    expected_size: u64,
) -> Result<(), AppError> {
    let Some(op) = op else {
        return Err(AppError::BL {
            msg: "S3 is not configured for plaintext media upload".to_string(),
        });
    };
    let remote_key = config.prefixed_key(rel_path);
    let writer = op
        .writer_with(&remote_key)
        .chunk(crate::config::MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES)
        .await
        .c(h!())?;
    let mut writer = PlaintextUploadWriter::new(writer, remote_key.clone());
    let written = match write_plaintext_file(
        writer.writer(),
        file,
        expected_size,
    )
    .await
    {
        Ok(written) => written,
        Err(err) => {
            if let Err(abort_err) = writer.abort().await {
                warn!(
                    "failed to abort plaintext upload for {remote_key}: {abort_err:#?}"
                );
            }
            return Err(err);
        }
    };
    if written != expected_size {
        if let Err(abort_err) = writer.abort().await {
            warn!(
                "failed to abort plaintext upload for {remote_key}: {abort_err:#?}"
            );
        }
        return Err(AppError::BL {
            msg: format!(
                "plaintext upload source changed for {remote_key}: expected {expected_size} bytes, read {written}"
            ),
        });
    }
    if let Err(err) = writer.close().await.c(h!()) {
        if let Err(abort_err) = writer.abort().await {
            warn!(
                "failed to abort plaintext upload for {remote_key}: {abort_err:#?}"
            );
        }
        return Err(err.into());
    }
    let uploaded_size = match op.stat(&remote_key).await {
        Ok(metadata) => metadata.content_length(),
        Err(err) => {
            delete_failed_plaintext_upload(op, &remote_key).await;
            return Err(anyhow::Error::from(err).context(h!()).into());
        }
    };
    if uploaded_size != expected_size {
        delete_failed_plaintext_upload(op, &remote_key).await;
        return Err(AppError::BL {
            msg: format!(
                "plaintext upload verification failed for {remote_key}: expected {expected_size} bytes, stored {uploaded_size}"
            ),
        });
    }
    info!("stored plaintext to {}: {}", config.bucket, remote_key);
    Ok(())
}

pub async fn upload_plaintext_to_s3_with_operator(
    op: &Option<Operator>,
    config: &S3Config,
    rel_path: &str,
    data: Vec<u8>,
) -> Result<(), AppError> {
    let Some(op) = op else {
        return Err(AppError::BL {
            msg: "S3 is not configured for plaintext media upload".to_string(),
        });
    };
    let remote_key = config.prefixed_key(rel_path);
    let writer = op
        .writer_with(&remote_key)
        .chunk(crate::config::MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES)
        .await
        .c(h!())?;
    let mut writer = PlaintextUploadWriter::new(writer, remote_key.clone());
    let data = bytes::Bytes::from(data);
    if let Err(error) = write_plaintext_bytes(writer.writer(), data).await {
        if let Err(abort_error) = writer.abort().await {
            warn!(
                "failed to abort plaintext upload for {remote_key}: {abort_error:#?}"
            );
        }
        return Err(error);
    }
    if let Err(error) = writer.close().await.c(h!()) {
        if let Err(abort_error) = writer.abort().await {
            warn!(
                "failed to abort plaintext upload for {remote_key}: {abort_error:#?}"
            );
        }
        return Err(error.into());
    }
    info!("stored plaintext to {}: {}", config.bucket, remote_key);
    Ok(())
}

async fn delete_failed_plaintext_upload(op: &Operator, remote_key: &str) {
    if let Err(err) = op.delete(remote_key).await {
        warn!(
            "failed to delete unverified plaintext upload {remote_key}: {err:#?}"
        );
    }
}

async fn write_plaintext_bytes(
    writer: &mut opendal::Writer,
    data: bytes::Bytes,
) -> Result<(), AppError> {
    let chunk_size =
        crate::config::MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES;
    for offset in (0..data.len()).step_by(chunk_size) {
        let end = offset.saturating_add(chunk_size).min(data.len());
        writer.write(data.slice(offset..end)).await.c(h!())?;
    }
    Ok(())
}

async fn write_plaintext_file(
    writer: &mut opendal::Writer,
    file: tokio::fs::File,
    expected_size: u64,
) -> Result<u64, AppError> {
    let read_limit = expected_size.checked_add(1).ok_or(AppError::BL {
        msg: "plaintext upload read limit overflowed".to_string(),
    })?;
    let mut stream = tokio_util::io::ReaderStream::with_capacity(
        file.take(read_limit),
        crate::config::MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES,
    );
    let mut written = 0_u64;
    while let Some(chunk) = futures_util::TryStreamExt::try_next(&mut stream)
        .await
        .c(h!())?
    {
        written = written
            .checked_add(u64::try_from(chunk.len()).c(h!())?)
            .ok_or(AppError::BL {
                msg: "plaintext upload byte count overflowed".to_string(),
            })?;
        writer.write(chunk).await.c(h!())?;
    }
    Ok(written)
}

/// Download data from S3 and decrypt it with StrongBox
pub async fn download_and_decrypt_from_s3_with_operator(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    strongbox_key_b64: &str,
    rel_path: &str,
) -> Result<Vec<u8>, AppError> {
    let (Some(op), Some(config)) = (op, config) else {
        warn!("S3 not configured, failed to write!");
        return Ok(vec![]);
    };
    let remote_key = config.prefixed_key(rel_path);
    let key = key_from_b64(strongbox_key_b64)?;
    let sb = StaticStrongBox::new(key.clone(), vec![key]);
    let encrypted = op.read(&remote_key).await.c(h!())?.to_vec();
    sb.decrypt(&encrypted, aad(&config.bucket, &remote_key).as_bytes())
        .map_err(|err| AppError::BL {
            msg: format!("failed to decrypt s3 object {remote_key}: {err}"),
        })
}

pub async fn download_and_decrypt_messenger_media_from_s3_with_operator(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    strongbox_key_b64: &str,
    rel_path: &str,
) -> Result<Vec<u8>, AppError> {
    download_and_decrypt_messenger_media_from_s3_with_operator_inner(
        op,
        config,
        strongbox_key_b64,
        rel_path,
        None,
        crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_SIZE_BYTES,
    )
    .await
}

pub async fn download_and_decrypt_messenger_media_from_s3_with_operator_timeout(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    strongbox_key_b64: &str,
    rel_path: &str,
    download_timeout: Duration,
) -> Result<Vec<u8>, AppError> {
    download_and_decrypt_messenger_media_from_s3_with_operator_inner(
        op,
        config,
        strongbox_key_b64,
        rel_path,
        Some(download_timeout),
        crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_SIZE_BYTES,
    )
    .await
}

pub async fn download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    strongbox_key_b64: &str,
    rel_path: &str,
    download_timeout: Duration,
    max_size: u64,
) -> Result<Vec<u8>, AppError> {
    download_and_decrypt_messenger_media_from_s3_with_operator_inner(
        op,
        config,
        strongbox_key_b64,
        rel_path,
        Some(download_timeout),
        max_size,
    )
    .await
}

async fn download_and_decrypt_messenger_media_from_s3_with_operator_inner(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    strongbox_key_b64: &str,
    rel_path: &str,
    download_timeout: Option<Duration>,
    max_size: u64,
) -> Result<Vec<u8>, AppError> {
    let (Some(op), Some(config)) = (op, config) else {
        warn!("S3 not configured, failed to write!");
        return Ok(vec![]);
    };
    let remote_key = config.prefixed_key(rel_path);
    let key = key_from_b64(strongbox_key_b64)?;
    let sb = StaticStrongBox::new(key.clone(), vec![key]);
    let object_size =
        s3_object_size_with_limit(op, &remote_key, max_size).await?;
    let decrypt_permit = if object_size
        > crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_SEMAPHORE_MIN_SIZE_BYTES
    {
        WHOLE_OBJECT_DECRYPT_SEMAPHORE
            .clone()
            .try_acquire_owned()
            .map_err(|_| whole_object_decrypt_busy_error())?
    } else {
        tokio::time::timeout(
            Duration::from_secs(
                crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_SMALL_QUEUE_TIMEOUT_SECS,
            ),
            SMALL_OBJECT_DECRYPT_SEMAPHORE.clone().acquire_owned(),
        )
        .await
        .map_err(|_| whole_object_decrypt_busy_error())?
        .map_err(|_| whole_object_decrypt_busy_error())?
    };
    let download =
        download_s3_object_with_known_size(op, &remote_key, object_size);
    let encrypted = match download_timeout {
        Some(download_timeout) => tokio::time::timeout(download_timeout, download)
            .await
            .map_err(|_| AppError::AnyhowError {
                source: anyhow::anyhow!(
                    "timed out downloading s3 object {remote_key} after {download_timeout:?}"
                ),
            })??,
        None => download.await?,
    };
    let object_aad = aad(&config.bucket, &remote_key);
    tokio::task::spawn_blocking(move || {
        let _decrypt_permit = decrypt_permit;
        sb.decrypt(&encrypted, object_aad.as_bytes())
            .map_err(|err| AppError::BL {
                msg: format!("failed to decrypt s3 object {remote_key}: {err}"),
            })
    })
    .await
    .c(h!())?
}

fn whole_object_decrypt_busy_error() -> AppError {
    AppError::ServiceUnavailable {
        msg: "whole-object media decryption is busy; retry later".to_string(),
        retry_after_secs:
            crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_BUSY_RETRY_AFTER_SECS,
    }
}

#[cfg(test)]
async fn download_s3_object_with_size_limit(
    op: &Operator,
    remote_key: &str,
    max_size: u64,
) -> Result<Vec<u8>, AppError> {
    let object_size =
        s3_object_size_with_limit(op, remote_key, max_size).await?;
    download_s3_object_with_known_size(op, remote_key, object_size).await
}

async fn s3_object_size_with_limit(
    op: &Operator,
    remote_key: &str,
    max_size: u64,
) -> Result<u64, AppError> {
    let object_size = match op.stat(remote_key).await {
        Ok(metadata) => metadata.content_length(),
        Err(error) if error.kind() == opendal::ErrorKind::NotFound => {
            return Err(missing_encrypted_s3_object_error(remote_key));
        }
        Err(error) => {
            return Err(anyhow::Error::from(error).context(h!()).into());
        }
    };
    if object_size > max_size {
        return Err(AppError::BL {
            msg: format!(
                "encrypted s3 object {remote_key} is too large for whole-object decryption: size {object_size}, limit {max_size}"
            ),
        });
    }
    Ok(object_size)
}

async fn download_s3_object_with_known_size(
    op: &Operator,
    remote_key: &str,
    object_size: u64,
) -> Result<Vec<u8>, AppError> {
    if object_size == 0 {
        return Ok(Vec::new());
    }
    let data = match op.read_with(remote_key).range(0..object_size).await {
        Ok(data) => data,
        Err(error) if error.kind() == opendal::ErrorKind::NotFound => {
            return Err(missing_encrypted_s3_object_error(remote_key));
        }
        Err(error) => {
            return Err(anyhow::Error::from(error).context(h!()).into());
        }
    };
    let downloaded_size = u64::try_from(data.len()).c(h!())?;
    if downloaded_size != object_size {
        return Err(AppError::BL {
            msg: format!(
                "encrypted s3 object {remote_key} changed while downloading: expected {object_size} bytes, read {downloaded_size}"
            ),
        });
    }
    Ok(data.to_vec())
}

fn missing_encrypted_s3_object_error(remote_key: &str) -> AppError {
    AppError::BL {
        msg: format!("encrypted s3 object {remote_key} does not exist"),
    }
}

pub async fn stat_s3_object_size_with_operator(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    rel_path: &str,
) -> Result<Option<u64>, AppError> {
    let (Some(op), Some(config)) = (op, config) else {
        warn!("S3 not configured, failed to stat!");
        return Ok(None);
    };
    let remote_key = config.prefixed_key(rel_path);
    let metadata = op.stat(&remote_key).await.c(h!())?;
    Ok(Some(metadata.content_length()))
}

pub async fn stream_s3_object_range_with_operator(
    op: &Option<Operator>,
    config: &Option<S3Config>,
    rel_path: &str,
    range: std::ops::Range<u64>,
) -> Result<opendal::FuturesBytesStream, AppError> {
    let op = op.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let config = config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let remote_key = config.prefixed_key(rel_path);
    op.reader(&remote_key)
        .await
        .c(h!())?
        .into_bytes_stream(range)
        .await
        .c(h!())
        .map_err(Into::into)
}

/// Check if encryption prerequisites are satisfied
pub fn is_s3_encryption_ready(config: &S3Config, strongbox_key: &str) -> bool {
    !config.bucket.trim().is_empty()
        && !config.access_key_id.trim().is_empty()
        && !config.secret_access_key.trim().is_empty()
        && !strongbox_key.trim().is_empty()
}

/// Build a public-style URL using endpoint/bucket/key
pub fn object_url(config: &S3Config, key: &str) -> String {
    let endpoint = config.endpoint.trim_end_matches('/');
    let trimmed_key = key.trim_start_matches('/');
    format!("{endpoint}/{}/{}", config.bucket, trimmed_key)
}

/// Build object key path using a 5-char prefix folder and the UUID-like filename.
/// Returns a path relative to the configured S3 prefix.
pub fn nested_object_key(id: &Uuid) -> String {
    let prefix = id.to_string().chars().take(5).collect::<String>();
    format!("{prefix}/{id}")
}

pub fn plaintext_media_object_key(id: &Uuid) -> String {
    format!("{}.plaintext", nested_object_key(id))
}

pub fn plaintext_media_migration_marker_object_key(id: &Uuid) -> String {
    format!("{}.plaintext-migration-grace", nested_object_key(id))
}

/// Generate a random 32-byte key encoded as base64 for StrongBox usage.
pub fn generate_strongbox_key_b64() -> String {
    use base64::Engine;
    let mut buf = [0u8; 32];
    rand::rng().fill(&mut buf);
    base64::engine::general_purpose::STANDARD.encode(buf)
}

pub fn mk_media_url(m: &signal_message_media::Model) -> String {
    format!("/api/messenger/media/{}", m.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;
    use opendal::services::Memory;

    fn memory_config() -> S3Config {
        S3Config {
            bucket: "test".to_string(),
            region: String::new(),
            endpoint: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            prefix: "media".to_string(),
        }
    }

    #[tokio::test]
    async fn plaintext_range_stream_reads_only_requested_bytes() {
        let op = Operator::new(Memory::default()).unwrap().finish();
        op.write("media/object", "0123456789").await.unwrap();

        let mut stream = stream_s3_object_range_with_operator(
            &Some(op),
            &Some(memory_config()),
            "object",
            2..6,
        )
        .await
        .unwrap();
        let mut data = Vec::new();
        while let Some(chunk) = stream.try_next().await.unwrap() {
            data.extend_from_slice(&chunk);
        }

        assert_eq!(data, b"2345");
    }

    #[test]
    fn plaintext_media_key_does_not_replace_encrypted_object() {
        let id =
            Uuid::parse_str("019f7ec5-e60d-7e23-b4e7-b605ba6dcfff").unwrap();

        assert_eq!(
            plaintext_media_object_key(&id),
            "019f7/019f7ec5-e60d-7e23-b4e7-b605ba6dcfff.plaintext"
        );
        assert_eq!(
            plaintext_media_migration_marker_object_key(&id),
            "019f7/019f7ec5-e60d-7e23-b4e7-b605ba6dcfff.plaintext-migration-grace"
        );
    }

    #[tokio::test]
    async fn plaintext_file_upload_streams_into_operator() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("upload.bin");
        tokio::fs::write(&path, b"plaintext upload").await.unwrap();
        let file = tokio::fs::File::open(path).await.unwrap();
        let op = Operator::new(Memory::default()).unwrap().finish();

        upload_plaintext_file_to_s3_with_operator(
            &Some(op.clone()),
            &memory_config(),
            "object",
            file,
            16,
        )
        .await
        .unwrap();

        assert_eq!(
            op.read("media/object").await.unwrap().to_vec(),
            b"plaintext upload"
        );
    }

    #[tokio::test]
    async fn plaintext_file_upload_stops_after_first_excess_byte() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("growing-upload.bin");
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let file = tokio::fs::File::open(path).await.unwrap();
        let op = Operator::new(Memory::default()).unwrap().finish();

        let error = upload_plaintext_file_to_s3_with_operator(
            &Some(op.clone()),
            &memory_config(),
            "oversized-object",
            file,
            5,
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            AppError::BL { msg } if msg.contains("expected 5 bytes, read 6")
        ));
    }

    #[tokio::test]
    async fn encrypted_object_download_rejects_size_over_limit() {
        let op = Operator::new(Memory::default()).unwrap().finish();
        op.write("object", "0123456789").await.unwrap();

        let error = download_s3_object_with_size_limit(&op, "object", 9)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::BL { msg } if msg.contains("size 10, limit 9")
        ));
        assert_eq!(
            download_s3_object_with_size_limit(&op, "object", 10)
                .await
                .unwrap(),
            b"0123456789"
        );
    }

    #[tokio::test]
    async fn missing_encrypted_object_is_a_terminal_error() {
        let op = Operator::new(Memory::default()).unwrap().finish();

        let error = download_s3_object_with_size_limit(&op, "missing", 10)
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            AppError::BL { msg } if msg.contains("does not exist")
        ));
    }

    #[tokio::test]
    async fn unrestricted_download_ignores_messenger_decryption_limit() {
        let op = Operator::new(Memory::default()).unwrap().finish();
        let config = memory_config();
        let strongbox_key = generate_strongbox_key_b64();
        let plaintext_size = usize::try_from(
            crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_SEMAPHORE_MIN_SIZE_BYTES,
        )
        .unwrap()
            + 1;
        let plaintext = vec![7_u8; plaintext_size];
        upload_encrypted_to_s3_with_operator(
            &Some(op.clone()),
            &config,
            &strongbox_key,
            "object",
            &plaintext,
        )
        .await
        .unwrap();
        let _messenger_permits = WHOLE_OBJECT_DECRYPT_SEMAPHORE
            .clone()
            .acquire_many_owned(
                u32::try_from(
                    crate::config::MESSENGER_MEDIA_WHOLE_OBJECT_DECRYPT_MAX_CONCURRENT_OPERATIONS,
                )
                .unwrap(),
            )
            .await
            .unwrap();

        let error = download_and_decrypt_messenger_media_from_s3_with_operator(
            &Some(op.clone()),
            &Some(config.clone()),
            &strongbox_key,
            "object",
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::ServiceUnavailable { .. }));

        let downloaded = download_and_decrypt_from_s3_with_operator(
            &Some(op),
            &Some(config),
            &strongbox_key,
            "object",
        )
        .await
        .unwrap();
        assert_eq!(downloaded, plaintext);
    }

    #[tokio::test]
    async fn plaintext_bytes_upload_streams_multiple_chunks() {
        let size =
            crate::config::MESSENGER_MEDIA_PLAINTEXT_UPLOAD_CHUNK_SIZE_BYTES
                + 17;
        let data = (0..size)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let op = Operator::new(Memory::default()).unwrap().finish();

        upload_plaintext_to_s3_with_operator(
            &Some(op.clone()),
            &memory_config(),
            "object",
            data.clone(),
        )
        .await
        .unwrap();

        assert_eq!(op.read("media/object").await.unwrap().to_vec(), data);
    }
}
