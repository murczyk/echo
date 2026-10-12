use super::cache;
use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Info {
    pub duration: f64,
}

#[derive(Deserialize)]
struct Probe {
    format: ProbeFormat,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: String,
}

pub(super) struct Input {
    pub value: OsString,
    pub min_free: u64,
}

pub(super) async fn input(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<Input> {
    let config =
        crate::messenger::media_local_cache::configured_config_best_effort(
            &env.config,
            &env.dbx,
        )
        .await;
    let min_free = config
        .messenger_media_cache
        .as_ref()
        .map(|config| config.min_free_space_bytes)
        .unwrap_or(MESSENGER_MEDIA_PREVIEW_MIN_FREE_BYTES);
    if let Some(path) =
        crate::messenger::media_local_cache::ready_original(&config, media)
            .await
            .c(h!())?
    {
        return Ok(Input {
            value: path.into_os_string(),
            min_free,
        });
    }
    if media.is_encrypted {
        bail!("encrypted media needs local decryption before preview")
    }
    let storage = env.s3_config.as_ref().c(h!())?;
    let key =
        storage.prefixed_key(&crate::messenger::media::media_object_key(media));
    let signed = env
        .s3
        .as_ref()
        .c(h!())?
        .presign_read(
            &key,
            Duration::from_secs(MESSENGER_MEDIA_PREVIEW_SOURCE_TTL_SECS),
        )
        .await
        .c(h!())?;
    Ok(Input {
        value: signed.uri().to_string().into(),
        min_free,
    })
}

pub(super) fn input_options(command: &mut Command) {
    command.args([
        "-threads",
        MESSENGER_MEDIA_PREVIEW_VIDEO_THREADS,
        "-protocol_whitelist",
        "file,http,https,tcp,tls",
        "-format_whitelist",
        "mov",
        "-rw_timeout",
        MESSENGER_MEDIA_PREVIEW_SOURCE_TIMEOUT_MICROS,
    ]);
}

pub(super) async fn info(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<Info> {
    let cache = cache::Entry::new(env, media).c(h!())?;
    if let Some(info) = cache.read_info().await.c(h!())? {
        return Ok(info);
    }
    let _lock = cache
        .lock(u32::MAX)
        .await
        .c(h!())?
        .ok_or(super::Busy)
        .c(h!())?;
    if let Some(info) = cache.read_info().await.c(h!())? {
        return Ok(info);
    }
    let _slot = cache.slot().await.c(h!())?.ok_or(super::Busy).c(h!())?;
    let source = input(env, media).await.c(h!())?;
    let mut command = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFPROBE_BIN);
    input_options(&mut command);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            "-i",
        ])
        .arg(source.value)
        .kill_on_drop(true)
        .stderr(Stdio::null());
    let output = tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_PREVIEW_PROBE_TIMEOUT_SECS),
        command.output(),
    )
    .await
    .c(h!())?
    .c(h!())?;
    if !output.status.success() {
        bail!("could not inspect video preview duration")
    }
    let probe: Probe = serde_json::from_slice(&output.stdout).c(h!())?;
    let duration: f64 = probe.format.duration.parse().c(h!())?;
    if !duration.is_finite()
        || duration <= 0.0
        || duration > MESSENGER_MEDIA_PREVIEW_MAX_DURATION_SECS as f64
    {
        bail!("video preview duration is outside supported bounds")
    }
    let info = Info { duration };
    cache.prepare_space(source.min_free).await.c(h!())?;
    cache.write_info(&info).await.c(h!())?;
    Ok(info)
}
