use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use actix_files::NamedFile;
use actix_identity::Identity;
use actix_web::http::{header, Method, StatusCode};
use actix_web::{web, HttpRequest, HttpResponse, ResponseError};
use anyhow::Result;
use futures_util::{StreamExt, TryStreamExt};
use opendal::{ErrorKind, Operator};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Semaphore};

use crate::config::{
    Config, DOC_MEDIA_CACHE_CONTROL, DOC_MEDIA_DEFAULT_DIR,
    DOC_MEDIA_DOWNLOAD_TIMEOUT_SECS, DOC_MEDIA_EXTENSIONS,
    DOC_MEDIA_LOCK_SLOTS, DOC_MEDIA_MAX_CONCURRENT_DOWNLOADS,
    DOC_MEDIA_RETRY_AFTER_SECS, DOC_MEDIA_STORAGE_PREFIX,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, Mode, ShortContext};

pub struct DocMedia {
    root: PathBuf,
    storage: Option<Operator>,
    locks: Vec<Mutex<()>>,
    downloads: Arc<Semaphore>,
}

impl DocMedia {
    pub fn new(config: &Config, mode: Mode) -> Self {
        let root = config
            .doc_media_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if mode == Mode::Live {
                    PathBuf::from(DOC_MEDIA_DEFAULT_DIR)
                } else {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../wdintel-web/.doc-media")
                }
            });
        let storage = config.s3_config.as_ref().and_then(|config| {
            let storage = crate::storage::S3Config::with_prefix(config, String::new());
            match crate::storage::build_s3_operator(&storage) {
                Ok(storage) => Some(storage.layer(
                    opendal::layers::TimeoutLayer::new().with_timeout(Duration::from_secs(DOC_MEDIA_DOWNLOAD_TIMEOUT_SECS)),
                )),
                Err(_) => {
                    log::warn!("Documentation media S3 is unavailable; packaged files remain available");
                    None
                }
            }
        });
        if storage.is_none() {
            log::warn!("Documentation media has no S3 fallback configured");
        }
        Self {
            root,
            storage,
            locks: (0..DOC_MEDIA_LOCK_SLOTS).map(|_| Mutex::new(())).collect(),
            downloads: Arc::new(Semaphore::new(
                DOC_MEDIA_MAX_CONCURRENT_DOWNLOADS,
            )),
        }
    }

    async fn serve(
        &self,
        request: &HttpRequest,
        path: &str,
        b2_only: bool,
    ) -> Result<HttpResponse> {
        let relative = media_path(path).c(h!())?;
        let key = format!("{DOC_MEDIA_STORAGE_PREFIX}/{path}");
        if b2_only {
            return self.serve_remote(request, &key, &relative).await.c(h!());
        }
        if let Some(file) = self.local_file(&relative).await.c(h!())? {
            return Ok(file.into_response(request));
        }
        let mut hash = DefaultHasher::new();
        relative.hash(&mut hash);
        let _lock = self.locks[hash.finish() as usize % self.locks.len()]
            .lock()
            .await;
        if let Some(file) = self.local_file(&relative).await.c(h!())? {
            return Ok(file.into_response(request));
        }
        tokio::time::timeout(
            Duration::from_secs(DOC_MEDIA_DOWNLOAD_TIMEOUT_SECS),
            self.download(&key, &relative),
        )
        .await
        .map_err(|_| unavailable())
        .c(h!())?
        .c(h!())?;
        Ok(self
            .local_file(&relative)
            .await
            .c(h!())?
            .c(h!())?
            .into_response(request))
    }

    async fn local_file(&self, relative: &Path) -> Result<Option<NamedFile>> {
        let path = checked_local_path(&self.root, relative, false)
            .await
            .c(h!())?;
        match NamedFile::open_async(path).await {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(None)
            }
            Err(error) => Err(error).c(h!()),
        }
    }

    fn storage(&self) -> Result<&Operator> {
        self.storage.as_ref().ok_or_else(unavailable).c(h!())
    }

    async fn download(&self, key: &str, relative: &Path) -> Result<()> {
        let _permit = self.downloads.acquire().await.c(h!())?;
        let storage = self.storage().c(h!())?;
        let metadata =
            storage.stat(key).await.map_err(storage_error).c(h!())?;
        let expected_size = metadata.content_length();
        let mut reader = storage.reader_with(key);
        if let Some(etag) = metadata.etag() {
            reader = reader.if_match(etag);
        }
        let mut stream = reader
            .await
            .map_err(storage_error)
            .c(h!())?
            .into_bytes_stream(..)
            .await
            .map_err(storage_error)
            .c(h!())?;
        let path = checked_local_path(&self.root, relative, true)
            .await
            .c(h!())?;
        let temporary =
            tempfile::NamedTempFile::new_in(path.parent().c(h!())?).c(h!())?;
        let mut file = tokio::fs::File::from_std(temporary.reopen().c(h!())?);
        let mut received = 0u64;
        while let Some(bytes) =
            stream.try_next().await.map_err(|_| unavailable()).c(h!())?
        {
            received += bytes.len() as u64;
            file.write_all(&bytes).await.c(h!())?;
        }
        anyhow::ensure!(
            received == expected_size,
            "Incomplete documentation media download"
        );
        file.flush().await.c(h!())?;
        file.sync_all().await.c(h!())?;
        drop(file);
        temporary
            .persist(&path)
            .map_err(|error| error.error)
            .c(h!())?;
        Ok(())
    }

    async fn serve_remote(
        &self,
        request: &HttpRequest,
        key: &str,
        relative: &Path,
    ) -> Result<HttpResponse> {
        let permit = self
            .downloads
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable())
            .c(h!())?;
        let storage = self.storage().c(h!())?;
        let metadata =
            storage.stat(key).await.map_err(storage_error).c(h!())?;
        let size = metadata.content_length();
        let etag = metadata.etag().map(str::to_owned);
        let modified = metadata.last_modified().map(|date| {
            header::HttpDate::from(std::time::SystemTime::from(date))
                .to_string()
        });
        let mut response = HttpResponse::Ok();
        response.content_type(
            mime_guess::from_path(relative)
                .first_or_octet_stream()
                .as_ref(),
        );
        if let Some(etag) = &etag {
            response.insert_header((header::ETAG, etag.as_str()));
        }
        if let Some(modified) = &modified {
            response.insert_header((header::LAST_MODIFIED, modified.as_str()));
        }
        if not_modified(request, etag.as_deref(), modified.as_deref()) {
            return Ok(response.status(StatusCode::NOT_MODIFIED).finish());
        }
        let range =
            remote_range(request, size, etag.as_deref(), modified.as_deref());
        let Some((start, end, partial)) = range else {
            return Ok(response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .insert_header((
                    header::CONTENT_RANGE,
                    format!("bytes */{size}"),
                ))
                .finish());
        };
        if partial {
            response.status(StatusCode::PARTIAL_CONTENT).insert_header((
                header::CONTENT_RANGE,
                format!("bytes {start}-{}/{size}", end - 1),
            ));
        }
        response
            .insert_header((header::CONTENT_LENGTH, (end - start).to_string()));
        if request.method() == Method::HEAD || size == 0 {
            return Ok(response.finish());
        }
        let mut reader = storage.reader_with(key);
        if let Some(etag) = metadata.etag() {
            reader = reader.if_match(etag);
        }
        let stream = reader
            .await
            .map_err(storage_error)
            .c(h!())?
            .into_bytes_stream(start..end)
            .await
            .map_err(storage_error)
            .c(h!())?;
        Ok(response.streaming(stream.map(move |bytes| {
            let _permit = &permit;
            bytes.map_err(|_| {
                actix_web::error::ErrorServiceUnavailable(
                    "Documentation media download failed",
                )
            })
        })))
    }
}

fn not_modified(
    request: &HttpRequest,
    etag: Option<&str>,
    modified: Option<&str>,
) -> bool {
    if let Some(value) = request.headers().get(header::IF_NONE_MATCH) {
        return value.to_str().ok().is_some_and(|value| {
            value.split(',').any(|value| {
                let value = value.trim();
                value == "*"
                    || etag.is_some_and(|etag| {
                        value.trim_start_matches("W/")
                            == etag.trim_start_matches("W/")
                    })
            })
        });
    }
    request
        .headers()
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|value| value.to_str().ok())
        .zip(modified)
        .is_some_and(|(requested, modified)| {
            requested
                .parse::<header::HttpDate>()
                .ok()
                .zip(modified.parse::<header::HttpDate>().ok())
                .is_some_and(|(requested, modified)| modified <= requested)
        })
}

fn remote_range(
    request: &HttpRequest,
    size: u64,
    etag: Option<&str>,
    modified: Option<&str>,
) -> Option<(u64, u64, bool)> {
    use header::Header;
    if request.method() == Method::HEAD {
        return Some((0, size, false));
    }
    if let Some(condition) = request.headers().get(header::IF_RANGE) {
        let condition = condition.to_str().ok();
        if condition != etag && condition != modified {
            return Some((0, size, false));
        }
    }
    match header::Range::parse(request) {
        Ok(header::Range::Bytes(ranges)) if ranges.len() == 1 => ranges[0]
            .to_satisfiable_range(size)
            .map(|(start, end)| (start, end + 1, true)),
        _ => Some((0, size, false)),
    }
}

fn media_path(path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    let allowed_root =
        path.starts_with("docs/releases/") || path.starts_with("docs/static/");
    let extension = relative
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !allowed_root
        || path.contains(['\\', '\0'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || !DOC_MEDIA_EXTENSIONS.contains(&extension.as_str())
    {
        return Err(AppError::NotFound).c(h!());
    }
    Ok(relative.to_owned())
}

async fn checked_local_path(
    root: &Path,
    relative: &Path,
    create: bool,
) -> Result<PathBuf> {
    if create {
        tokio::fs::create_dir_all(root).await.c(h!())?;
    }
    let mut path = root.to_owned();
    for component in relative.components() {
        path.push(component);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_symlink() => {
                return Err(AppError::NotFound).c(h!())
            }
            Ok(metadata)
                if path != root.join(relative) && !metadata.is_dir() =>
            {
                return Err(AppError::NotFound).c(h!())
            }
            Ok(metadata)
                if path == root.join(relative) && !metadata.is_file() =>
            {
                return Err(AppError::NotFound).c(h!())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create && path != root.join(relative) {
                    tokio::fs::create_dir_all(&path).await.c(h!())?;
                }
            }
            Err(error) => return Err(error).c(h!()),
        }
    }
    Ok(path)
}

fn unavailable() -> AppError {
    AppError::ServiceUnavailable {
        msg: "Documentation media storage is unavailable".into(),
        retry_after_secs: DOC_MEDIA_RETRY_AFTER_SECS,
    }
}

fn storage_error(error: opendal::Error) -> AppError {
    if error.kind() == ErrorKind::NotFound {
        AppError::NotFound
    } else {
        unavailable()
    }
}

#[actix_web::route(
    "/doc-media/{storage_key:.*}",
    method = "GET",
    method = "HEAD"
)]
pub async fn serve(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<String>,
) -> HttpResponse {
    let result: Result<HttpResponse> = async {
        let identity =
            identity.as_ref().ok_or(AppError::Unauthenticated).c(h!())?;
        crate::users::ensure_basic_role(&env.dbx, identity)
            .await
            .c(h!())?;
        let settings =
            crate::system_settings::get_active_system_settings(&env.dbx)
                .await
                .c(h!())?;
        let b2_only = settings
            .and_then(|settings| settings.doc_media_serve_from_b2)
            .unwrap_or(false);
        env.doc_media
            .serve(&request, path.as_str(), b2_only)
            .await
            .c(h!())
    }
    .await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => AppError::from(error).error_response(),
    };
    for (name, value) in [
        (header::CACHE_CONTROL, DOC_MEDIA_CACHE_CONTROL),
        (header::CONTENT_ENCODING, "identity"),
        (header::ACCEPT_RANGES, "bytes"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        ),
    ] {
        response
            .headers_mut()
            .insert(name, header::HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests;
