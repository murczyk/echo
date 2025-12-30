use crate::config::get_assets_folder;
use crate::config::S3_MEDIA_ROOT_PREFIX;
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_files::NamedFile;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use log::error;
use log::{info, warn};
use opendal::Operator;
use rand::Rng;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;
use strong_box::{Key, StaticStrongBox, StrongBox};
use uuid::Uuid;

pub async fn serve_assets(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: web::Data<Env>,
) -> Result<impl Responder, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Basic")
        .await
        .c(h!())?;

    let filename = req.match_info().query("filename");
    let path: PathBuf = match filename.parse() {
        Ok(path) => path,
        Err(e) => {
            error!("bad filename {filename}: {e:#?}");
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
            warn!("unexpected filename format: {filename}, expected UUID + '.' + extension");
            filename.to_string()
        }
    };
    match crate::messenger::media::fetch_media_bytes_by_key(&env, &id).await {
        Ok(body) => Ok(HttpResponse::Ok()
            .content_type("application/octet-stream")
            .body(body)),
        Err(e) => {
            error!("failed to load asset from s3: {e:#?}");
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
        Self {
            bucket: config.s3_bucket.clone(),
            region: config.s3_region.clone(),
            endpoint: config.s3_endpoint.clone(),
            access_key_id: config.s3_access_key_id.clone(),
            secret_access_key: config.s3_secret_access_key.clone(),
            prefix: S3_MEDIA_ROOT_PREFIX.to_string(),
        }
    }
}

impl S3Config {
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
