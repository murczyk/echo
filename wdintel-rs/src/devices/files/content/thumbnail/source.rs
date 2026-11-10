use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use super::super::read::authorize_published_snapshot;
use super::super::repository::PublishedContent;
use super::{Failure, Target};
use crate::devices::config::*;
use crate::h;
use crate::types::{Env, ShortContext};

#[derive(Debug, thiserror::Error)]
#[error("Device thumbnail source failed integrity verification")]
struct InvalidSource;

pub(super) async fn generate(
    env: &Env,
    actor: Uuid,
    target: Target,
    source: &PublishedContent,
    image: bool,
    destination: &Path,
) -> Result<u64, Failure> {
    authorize(env, actor, target, source).await?;
    let temporary = tempfile::Builder::new()
        .prefix("source-")
        .tempfile_in(destination.parent().ok_or(Failure::Transient)?)
        .map_err(|_| Failure::Transient)?;
    let prepared = tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_THUMBNAIL_SOURCE_TIMEOUT_SECS),
        prepare(env, source, &temporary),
    )
    .await;
    match prepared {
        Ok(Ok(())) => {}
        Ok(Err(error)) if error.downcast_ref::<InvalidSource>().is_some() => {
            return Err(Failure::Terminal)
        }
        _ => return Err(Failure::Transient),
    }
    authorize(env, actor, target, source).await?;
    let result = crate::thumbnail::generate(
        temporary.path(),
        destination,
        &crate::thumbnail::Options {
            filter: if image {
                DEVICE_FILE_THUMBNAIL_IMAGE_FILTER
            } else {
                DEVICE_FILE_THUMBNAIL_VIDEO_FILTER
            },
            timeout: Duration::from_secs(
                DEVICE_FILE_THUMBNAIL_FFMPEG_TIMEOUT_SECS,
            ),
            max_bytes: Some(DEVICE_FILE_THUMBNAIL_MAX_BYTES),
        },
    )
    .await;
    if let Err(error) = result {
        return Err(
            if error
                .downcast_ref::<crate::thumbnail::InvalidMedia>()
                .is_some()
            {
                Failure::Terminal
            } else {
                Failure::Transient
            },
        );
    }
    authorize(env, actor, target, source).await?;
    let bytes = super::read_jpeg(destination)
        .await
        .map_err(|_| Failure::Terminal)?;
    Ok(bytes.len() as u64)
}

async fn authorize(
    env: &Env,
    actor: Uuid,
    target: Target,
    source: &PublishedContent,
) -> Result<(), Failure> {
    use actix_web::ResponseError;
    authorize_published_snapshot(env, actor, target, source)
        .await
        .map_err(|error| {
            if error.status_code().is_server_error() {
                Failure::Transient
            } else {
                Failure::Access
            }
        })
}

async fn prepare(
    env: &Env,
    source: &PublishedContent,
    temporary: &tempfile::NamedTempFile,
) -> Result<()> {
    let size = u64::try_from(source.source_size_bytes).context(h!())?;
    if size == 0
        || size > DEVICE_FILE_THUMBNAIL_SOURCE_MAX_BYTES
        || source.source_sha256.len() != 32
    {
        return Err(InvalidSource).context(h!());
    }
    let mut destination = File::from_std(temporary.reopen().context(h!())?);
    let mut verifier = Verifier::new(size);
    if let Some(mut retained) = super::super::local_cache::open(
        env,
        &source.object_key,
        size,
        source.is_encrypted,
        0,
    )
    .await
    {
        let mut buffer = vec![0u8; DEVICE_FILE_CONTENT_STREAM_CHUNK_BYTES];
        loop {
            let count = retained.read(&mut buffer).await.context(h!())?;
            if count == 0 {
                break;
            }
            verifier
                .write(&mut destination, &buffer[..count])
                .await
                .context(h!())?;
        }
    } else if source.is_encrypted {
        let bytes = decrypted(env, source).await.context(h!())?;
        verifier
            .write(&mut destination, &bytes)
            .await
            .context(h!())?;
    } else {
        write_remote(env, source, &mut destination, &mut verifier)
            .await
            .context(h!())?;
    }
    verifier.finish(&source.source_sha256).context(h!())?;
    destination.flush().await.context(h!())?;
    Ok(())
}

async fn write_remote(
    env: &Env,
    source: &PublishedContent,
    destination: &mut File,
    verifier: &mut Verifier,
) -> Result<()> {
    let mut config = env.s3_config.clone().context(h!())?;
    config.prefix.clear();
    let metadata = env
        .s3
        .as_ref()
        .context(h!())?
        .stat(&config.prefixed_key(&source.object_key))
        .await
        .context(h!())?;
    if metadata.content_length() != verifier.expected {
        return Err(InvalidSource).context(h!());
    }
    let mut stream = crate::storage::stream_s3_object_range_with_operator(
        &env.s3,
        &Some(config),
        &source.object_key,
        0..verifier.expected,
    )
    .await
    .c(h!())?;
    while let Some(bytes) = stream.try_next().await.context(h!())? {
        verifier.write(destination, &bytes).await.context(h!())?;
    }
    Ok(())
}

async fn decrypted(env: &Env, source: &PublishedContent) -> Result<Vec<u8>> {
    let mut config = env.s3_config.clone().context(h!())?;
    config.prefix.clear();
    let key = &env.config.s3_config.as_ref().context(h!())?.strongbox_key;
    crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
        &env.s3, &Some(config), key, &source.object_key,
        Duration::from_secs(DEVICE_FILE_THUMBNAIL_SOURCE_TIMEOUT_SECS),
        DEVICE_FILE_THUMBNAIL_SOURCE_MAX_BYTES + 1024 * 1024,
    ).await.c(h!())
}

struct Verifier {
    expected: u64,
    written: u64,
    hash: Sha256,
}

impl Verifier {
    fn new(expected: u64) -> Self {
        Self {
            expected,
            written: 0,
            hash: Sha256::new(),
        }
    }

    async fn write(&mut self, file: &mut File, bytes: &[u8]) -> Result<()> {
        self.written = self
            .written
            .checked_add(bytes.len() as u64)
            .ok_or(InvalidSource)
            .context(h!())?;
        if self.written > self.expected {
            return Err(InvalidSource).context(h!());
        }
        self.hash.update(bytes);
        file.write_all(bytes).await.context(h!())?;
        Ok(())
    }

    fn finish(self, expected_hash: &[u8]) -> Result<()> {
        if self.written != self.expected
            || self.hash.finalize()[..] != *expected_hash
        {
            return Err(InvalidSource).context(h!());
        }
        Ok(())
    }
}

pub(super) fn image_kind(source: &PublishedContent) -> Option<bool> {
    let mime = source
        .mime_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let extension = source
        .name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .or(source.extension.as_deref())
        .unwrap_or("")
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if mime == "image/svg+xml" {
        return None;
    }
    if mime.starts_with("audio/") {
        return None;
    }
    if mime.starts_with("image/") {
        return Some(true);
    }
    if mime.starts_with("video/") {
        return Some(false);
    }
    if matches!(mime.as_str(), "application/mp4" | "application/x-matroska") {
        return Some(false);
    }
    match extension.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" | "png" | "webp" | "bmp" | "gif"
        | "avif" | "heic" | "heif" | "tif" | "tiff" | "ico" => Some(true),
        "mp4" | "m4v" | "f4v" | "mov" | "webm" | "mkv" | "avi" | "mpeg"
        | "mpg" | "vob" | "wmv" | "asf" | "flv" | "3gp" | "3g2" | "m2ts"
        | "ogv" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn thumbnail_source_integrity_rejects_overrun_short_read_and_wrong_hash(
    ) {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let mut file = File::from_std(temporary.reopen().unwrap());
        let mut overrun = Verifier::new(3);
        assert!(overrun.write(&mut file, b"long").await.is_err());
        assert_eq!(file.metadata().await.unwrap().len(), 0);
        let mut short = Verifier::new(5);
        short.write(&mut file, b"four").await.unwrap();
        assert!(short.finish(&Sha256::digest(b"four")).is_err());
        let mut wrong = Verifier::new(4);
        wrong.write(&mut file, b"four").await.unwrap();
        assert!(wrong.finish(&Sha256::digest(b"nope")).is_err());
        let mut valid = Verifier::new(4);
        valid.write(&mut file, b"four").await.unwrap();
        valid.finish(&Sha256::digest(b"four")).unwrap();
    }
}
