use super::{
    extract::Verified,
    storage::{hex, Client},
};
use crate::{devices::config::*, h, types::ShortContext};
use anyhow::{ensure, Context, Result};
use std::{fs::File, io::SeekFrom};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(super) async fn store(
    client: &Client,
    key: &str,
    file: &File,
    bytes: &Verified,
) -> Result<()> {
    let size = file.metadata().c(h!())?.len();
    let upload = client.create(key, &bytes.sha256).await.context(h!())?;
    let result = async {
        let parts = parts(client, key, &upload, file, size)
            .await
            .context(h!())?;
        client.complete(key, &upload, &parts).await.context(h!())?;
        verify(client, key, size, &bytes.sha256).await.context(h!())
    }
    .await;
    if result.is_err() {
        let _ = client.abort(key, &upload).await;
    }
    result
}

async fn parts(
    client: &Client,
    key: &str,
    upload: &str,
    file: &File,
    mut remaining: u64,
) -> Result<Vec<(u32, String)>> {
    let mut file = tokio::fs::File::from_std(file.try_clone().c(h!())?);
    file.seek(SeekFrom::Start(0)).await.c(h!())?;
    let mut parts = Vec::new();
    while remaining > 0 || parts.is_empty() {
        ensure!(
            parts.len() < DEVICE_FILE_ARCHIVE_S3_MAX_PARTS as usize,
            "archive multipart limit"
        );
        let count = remaining.min(DEVICE_FILE_ARCHIVE_S3_CHUNK_BYTES) as usize;
        let mut bytes = vec![0; count];
        file.read_exact(&mut bytes).await.c(h!())?;
        let number = (parts.len() + 1) as u32;
        let etag = client
            .part(key, upload, number, bytes)
            .await
            .context(h!())?;
        parts.push((number, etag));
        remaining -= count as u64;
    }
    ensure!(
        file.read(&mut [0]).await.c(h!())? == 0,
        "archive encoded output grew"
    );
    Ok(parts)
}

pub(super) async fn verify(
    client: &Client,
    key: &str,
    size: u64,
    sha256: &[u8],
) -> Result<()> {
    let metadata = client.head(key).await.context(h!())?.c(h!())?;
    ensure!(
        metadata.size == size && metadata.source_sha256 == hex(sha256),
        "archive S3 output identity mismatch"
    );
    Ok(())
}
