use super::{
    extract::Verified,
    manifest::{Limits, Manifest, Member},
};
use crate::{
    devices::config::DEVICE_FILE_ARCHIVE_PROTOCOL_MAX_BYTES, h,
    types::ShortContext,
};
use anyhow::{ensure, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Serialize, Deserialize)]
pub(super) struct Request {
    pub source_key: String,
    pub source_size: u64,
    pub source_sha256: [u8; 32],
    pub source_encrypted: bool,
    pub output_prefix: String,
    pub key: [u8; 32],
    pub storage: crate::storage::S3Config,
    pub scratch: std::path::PathBuf,
    pub limits: Limits,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Output {
    pub member: Member,
    pub object_key: Option<String>,
    pub bytes: Option<Verified>,
    pub encrypted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Event {
    Manifest {
        manifest: Manifest,
    },
    Result {
        outputs: Vec<Output>,
    },
    Failed {
        reason: String,
        limit: Option<String>,
    },
}

#[derive(Serialize, Deserialize)]
pub(super) enum Command {
    Admit,
}

pub(super) fn read<T: DeserializeOwned>(input: &mut impl Read) -> Result<T> {
    let mut header = [0; 4];
    input.read_exact(&mut header).c(h!())?;
    let length = u32::from_be_bytes(header) as usize;
    ensure!(
        length > 0 && length <= DEVICE_FILE_ARCHIVE_PROTOCOL_MAX_BYTES,
        "archive frame limit"
    );
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).c(h!())?;
    serde_json::from_slice(&bytes).c(h!())
}

pub(super) fn write(
    output: &mut impl Write,
    value: &impl Serialize,
) -> Result<()> {
    let bytes = serde_json::to_vec(value).c(h!())?;
    ensure!(
        bytes.len() <= DEVICE_FILE_ARCHIVE_PROTOCOL_MAX_BYTES,
        "archive frame limit"
    );
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .c(h!())?;
    output.write_all(&bytes).c(h!())?;
    output.flush().c(h!())
}

pub(super) async fn receive<T: DeserializeOwned>(
    input: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Result<T> {
    use tokio::io::AsyncReadExt;
    let length = input.read_u32().await.c(h!())? as usize;
    ensure!(
        length > 0 && length <= DEVICE_FILE_ARCHIVE_PROTOCOL_MAX_BYTES,
        "archive frame limit"
    );
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).await.c(h!())?;
    serde_json::from_slice(&bytes).c(h!())
}

pub(super) async fn send(
    output: &mut (impl tokio::io::AsyncWrite + Unpin),
    value: &impl Serialize,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut frame = Vec::new();
    write(&mut frame, value)?;
    output.write_all(&frame).await.c(h!())?;
    output.flush().await.c(h!())
}
