use super::{
    error::Failure,
    extract::{self, Meter},
    manifest,
    protocol::{self, Command, Event, Output, Request},
    storage::Client,
    upload,
};
use crate::{devices::config::*, h, types::ShortContext};
use anyhow::{ensure, Context, Result};
use futures_util::TryStreamExt;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
use strong_box::StrongBox;
use tokio::io::AsyncWriteExt;

pub(crate) fn main_if_requested() -> Option<Result<()>> {
    if std::env::args().nth(1).as_deref() != Some("--device-archive-helper") {
        return None;
    }
    Some(main())
}

fn main() -> Result<()> {
    let _ = crate::ring::default_provider().install_default();
    let request: Request = protocol::read(&mut std::io::stdin().lock())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || loop {
        match protocol::read::<Command>(&mut std::io::stdin().lock()) {
            Ok(command) => {
                if sender.send(command).is_err() {
                    return;
                }
            }
            Err(_) => std::process::exit(1),
        }
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .c(h!())?;
    let result = runtime.block_on(execute(request, receiver));
    if let Err(error) = &result {
        let (reason, limit) = super::error::classify(error);
        let _ = protocol::write(
            &mut std::io::stdout().lock(),
            &Event::Failed {
                reason: reason.unwrap_or("temporary_storage").into(),
                limit: limit.map(str::to_owned),
            },
        );
    }
    runtime.shutdown_background();
    result
}

async fn execute(
    request: Request,
    commands: std::sync::mpsc::Receiver<Command>,
) -> Result<()> {
    let _lock = lock(&request.scratch)?;
    super::error::require(
        fs2::available_space(&request.scratch).c(h!())?
            > request
                .source_size
                .saturating_mul(if request.source_encrypted { 2 } else { 1 })
                .saturating_add(DEVICE_FILE_ARCHIVE_FREE_FLOOR_BYTES),
        Failure::Limit("scratch"),
    )?;
    let mut source = stage(&request).await.context(h!())?;
    let limits = request.limits.clone();
    let parsed = tokio::task::spawn_blocking(move || {
        let manifest = manifest::read_metered(
            &mut source,
            request.source_size,
            &limits,
            |_, _| Ok(()),
        )?;
        Ok::<_, anyhow::Error>((source, manifest))
    });
    let (source, manifest) = tokio::time::timeout(
        std::time::Duration::from_secs(DEVICE_FILE_ARCHIVE_PREFLIGHT_SECONDS),
        parsed,
    )
    .await
    .c(h!())?
    .c(h!())??;
    protocol::write(
        &mut std::io::stdout().lock(),
        &Event::Manifest {
            manifest: manifest::Manifest {
                members: manifest.members.clone(),
                records: manifest.records,
                metadata_bytes: manifest.metadata_bytes,
            },
        },
    )?;
    ensure!(
        matches!(commands.recv().c(h!())?, Command::Admit),
        "archive admission missing"
    );
    let client = Client::new(&request.storage)?;
    let mut outputs = Vec::with_capacity(manifest.members.len());
    let mut source = source;
    for member in manifest.members {
        if member.directory {
            outputs.push(Output {
                member,
                object_key: None,
                bytes: None,
                encrypted: false,
            });
            continue;
        }
        let key = format!("{}{}", request.output_prefix, uuid::Uuid::new_v4());
        let path = request.scratch.join("member");
        let mut output = open(&path)?;
        let mut meter = LocalMeter {
            path: &request.scratch,
            remaining: member.size,
        };
        let bytes =
            extract::inflate(&mut source, &mut output, &member, &mut meter)
                .context(h!())?;
        let encrypted = encode(
            &mut output,
            bytes.size,
            &request.key,
            &format!("{}/{}", request.storage.bucket, key),
        )?;
        upload::store(&client, &key, &output, &bytes)
            .await
            .context(h!())?;
        outputs.push(Output {
            member,
            object_key: Some(key),
            bytes: Some(bytes),
            encrypted,
        });
    }
    protocol::write(&mut std::io::stdout().lock(), &Event::Result { outputs })
}

pub(super) fn open(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .c(h!())
}

pub(super) fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path.join("lock"))
        .c(h!())?;
    fs2::FileExt::try_lock_exclusive(&file).c(h!())?;
    Ok(file)
}

async fn stage(request: &Request) -> Result<File> {
    ensure!(
        request.source_size <= DEVICE_FILE_ARCHIVE_SOURCE_MAX_BYTES,
        "source size limit"
    );
    let storage =
        crate::storage::build_s3_operator(&request.storage).c(h!())?;
    let metadata = storage.stat(&request.source_key).await.c(h!())?;
    let max = request.source_size
        + if request.source_encrypted {
            DEVICE_FILE_ARCHIVE_ENCRYPTION_OVERHEAD_MAX_BYTES
        } else {
            0
        };
    ensure!(
        metadata.content_length() <= max,
        "encoded source size limit"
    );
    let mut input = storage
        .reader(&request.source_key)
        .await
        .c(h!())?
        .into_bytes_stream(0..metadata.content_length())
        .await
        .c(h!())?;
    let raw = open(&request.scratch.join("raw"))?;
    let mut raw = tokio::fs::File::from_std(raw);
    let mut digest = Sha256::new();
    while let Some(bytes) = input.try_next().await.c(h!())? {
        ensure!(
            fs2::available_space(&request.scratch).c(h!())?
                > DEVICE_FILE_ARCHIVE_FREE_FLOOR_BYTES,
            "scratch space exhausted"
        );
        raw.write_all(&bytes).await.c(h!())?;
        digest.update(&bytes);
    }
    raw.flush().await.c(h!())?;
    let mut raw = raw.into_std().await;
    raw.rewind().c(h!())?;
    if !request.source_encrypted {
        super::error::require(
            raw.metadata().c(h!())?.len() == request.source_size
                && <[u8; 32]>::from(digest.finalize()) == request.source_sha256,
            Failure::Integrity,
        )?;
        return Ok(raw);
    }
    let mut source = open(&request.scratch.join("source"))?;
    super::legacy_reader::decrypt(
        raw,
        &request.key,
        format!("{}/{}", request.storage.bucket, request.source_key).as_bytes(),
        request.source_size,
        &request.source_sha256,
        &mut source,
    )
    .map_err(|error| {
        if error.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(io.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT))
        }) {
            error
        } else {
            Failure::Integrity.into()
        }
    })?;
    source.rewind().c(h!())?;
    Ok(source)
}

struct LocalMeter<'a> {
    path: &'a Path,
    remaining: u64,
}
impl Meter for LocalMeter<'_> {
    fn reserve(&mut self, wanted: u64) -> Result<u64> {
        super::error::require(
            fs2::available_space(self.path).c(h!())?
                > DEVICE_FILE_ARCHIVE_FREE_FLOOR_BYTES,
            Failure::Limit("scratch"),
        )?;
        Ok(wanted.min(self.remaining))
    }
    fn settle(&mut self, used: u64) -> Result<()> {
        self.remaining = self.remaining.checked_sub(used).c(h!())?;
        Ok(())
    }
}

fn encode(
    output: &mut File,
    size: u64,
    key: &[u8; 32],
    aad: &str,
) -> Result<bool> {
    if size > DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES {
        return Ok(false);
    }
    output.rewind().c(h!())?;
    let mut probe =
        vec![0; size.min(DEVICE_FILE_CONTENT_PROBE_SIZE_BYTES as u64) as usize];
    output.read_exact(&mut probe).c(h!())?;
    if crate::messenger::media::device_content_probe_is_excluded_video(&probe) {
        return Ok(false);
    }
    output.rewind().c(h!())?;
    let mut plain = vec![0; size as usize];
    output.read_exact(&mut plain).c(h!())?;
    let key = strong_box::Key::from(Box::new(*key));
    let encoded = strong_box::StaticStrongBox::new(key.clone(), vec![key])
        .encrypt(&plain, aad.as_bytes())
        .c(h!())?;
    ensure!(
        encoded.len() as u64
            <= size + DEVICE_FILE_ARCHIVE_ENCRYPTION_OVERHEAD_MAX_BYTES,
        "archive encryption overhead"
    );
    output.rewind().c(h!())?;
    output.write_all(&encoded).c(h!())?;
    output.set_len(encoded.len() as u64).c(h!())?;
    output.sync_all().c(h!())?;
    Ok(true)
}
