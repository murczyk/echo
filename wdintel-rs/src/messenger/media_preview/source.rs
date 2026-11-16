use super::cache;
use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Result};
use echo_media::ffmpeg::ProbeOptions;
use echo_media::{Formats, RemoteUrl};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Info {
    pub duration: f64,
}

pub(super) struct Input {
    pub value: echo_media::Input,
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
            value: echo_media::Input::file(&path).c(h!())?,
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
        value: remote_input(storage, &signed.uri().to_string()).c(h!())?,
        min_free,
    })
}

/// A pre-signed URL is only handed to ffmpeg when it points at the
/// configured S3 endpoint (scheme, host and port), which also selects the
/// `https,tls,tcp` or `http,tcp` protocol whitelist.
fn remote_input(
    storage: &crate::storage::S3Config,
    url: &str,
) -> Result<echo_media::Input> {
    let endpoint = storage.endpoint.trim();
    if endpoint.is_empty() {
        bail!("s3 endpoint must be configured for remote video preview")
    }
    let url = RemoteUrl::new(url, &[endpoint]).c(h!())?;
    Ok(echo_media::Input::Remote(url))
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
    let options = ProbeOptions {
        timeout: Duration::from_secs(
            MESSENGER_MEDIA_PREVIEW_PROBE_TIMEOUT_SECS,
        ),
        ..ProbeOptions::new(Formats::MOV)
    };
    let probe = crate::media_sandbox::ffmpeg()
        .c(h!())?
        .probe(&source.value, &options)
        .await
        .c(h!())?;
    let Some(duration) = probe.duration_secs() else {
        bail!("could not inspect video preview duration")
    };
    if duration > MESSENGER_MEDIA_PREVIEW_MAX_DURATION_SECS as f64 {
        bail!("video preview duration is outside supported bounds")
    }
    let info = Info { duration };
    cache.prepare_space(source.min_free).await.c(h!())?;
    cache.write_info(&info).await.c(h!())?;
    Ok(info)
}
