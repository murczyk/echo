//! Proves that the sandboxed decoder works on a known-good WAV before any
//! upload is decoded. `media_failure` turns a failed media job into a
//! permanent `InvalidAudio`, so a broken sandbox or ffmpeg install must stop
//! finalization instead of rejecting every upload it sees.

use super::{decode_options, probe_options};
use crate::devices::audio::{
    unavailable, DEVICE_AUDIO_MEDIA_CHECK_RATE, DEVICE_AUDIO_MEDIA_CHECK_RETRY,
    DEVICE_AUDIO_MEDIA_CHECK_SAMPLES,
};
use crate::h;
use crate::types::ShortContext;
use echo_media::{Ffmpeg, Input, MediaError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const WAV_HEADER_BYTES: u32 = 44;
const WAV_SAMPLE_BYTES: u32 = 2;

#[derive(Default)]
pub(in crate::devices::audio) struct MediaCheck {
    passed: AtomicBool,
    failed_at: tokio::sync::Mutex<Option<Instant>>,
}

/// Fails with a retryable `ServiceUnavailable` until the self-check passes.
/// After a failure the check reruns at most once per retry interval.
pub(in crate::devices::audio) async fn ensure_media_ready(
    check: &MediaCheck,
) -> anyhow::Result<()> {
    if check.passed.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut failed_at = check.failed_at.lock().await;
    if check.passed.load(Ordering::Acquire) {
        return Ok(());
    }
    if failed_at.is_some_and(|at| at.elapsed() < DEVICE_AUDIO_MEDIA_CHECK_RETRY)
    {
        return Err(unavailable("audio decoder self-check failed")).c(h!());
    }
    match run().await {
        Ok(()) => {
            check.passed.store(true, Ordering::Release);
            *failed_at = None;
            log::info!("device audio media self-check passed");
            Ok(())
        }
        Err(error) => {
            *failed_at = Some(Instant::now());
            log::error!("device audio media self-check failed: {error:#}");
            Err(unavailable("audio decoder self-check failed")).c(h!())
        }
    }
}

/// Waits until the self-check passes; `false` if cancelled first.
pub(in crate::devices::audio) async fn wait_until_ready(
    check: &MediaCheck,
    cancellation: &CancellationToken,
) -> bool {
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return false,
            result = ensure_media_ready(check) => if result.is_ok() {
                return true;
            },
        }
        tokio::select! {
            _ = cancellation.cancelled() => return false,
            _ = tokio::time::sleep(DEVICE_AUDIO_MEDIA_CHECK_RETRY) => {}
        }
    }
}

/// Probes and fully decodes a silent WAV with the same jobs and options
/// as `probe_owned`, from the system temp directory like the finalizer.
async fn run() -> anyhow::Result<()> {
    let directory = tempfile::tempdir().c(h!())?;
    let source = directory.path().join("self-check.wav");
    tokio::fs::write(&source, silent_wav()).await.c(h!())?;
    let media = Ffmpeg::shared().c(h!())?;
    let input = Input::file(&source).c(h!())?;
    let metadata = media
        .probe(&input, &probe_options())
        .await
        .map_err(failure)?;
    anyhow::ensure!(
        metadata.format_name() == Some("wav"),
        "self-check probe did not recognise the WAV"
    );
    let report = media
        .decode_verify(&input, &decode_options(DEVICE_AUDIO_MEDIA_CHECK_RATE)?)
        .await
        .map_err(failure)?;
    anyhow::ensure!(
        report.duration_us > 0,
        "self-check decode produced no audio"
    );
    Ok(())
}

/// Keeps the sanitized decoder stderr that `Display` leaves out.
fn failure(error: MediaError) -> anyhow::Error {
    anyhow::anyhow!("{error:?}")
}

/// Mono 16-bit PCM silence behind a canonical RIFF header.
pub(super) fn silent_wav() -> Vec<u8> {
    let rate = DEVICE_AUDIO_MEDIA_CHECK_RATE;
    let data = DEVICE_AUDIO_MEDIA_CHECK_SAMPLES * WAV_SAMPLE_BYTES;
    let mut wav = Vec::with_capacity((WAV_HEADER_BYTES + data) as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(WAV_HEADER_BYTES - 8 + data).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * WAV_SAMPLE_BYTES).to_le_bytes());
    wav.extend_from_slice(&(WAV_SAMPLE_BYTES as u16).to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav.resize((WAV_HEADER_BYTES + data) as usize, 0);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::audio::DeviceAudioMediaError;
    use crate::error::AppError;

    #[tokio::test]
    async fn media_self_check_passes_with_the_sandboxed_decoder() {
        let check = MediaCheck::default();
        ensure_media_ready(&check).await.unwrap();
        assert!(check.passed.load(Ordering::Acquire));
        assert!(wait_until_ready(&check, &CancellationToken::new()).await);
    }

    #[tokio::test]
    async fn media_self_check_failure_is_retryable_not_invalid_audio() {
        let check = MediaCheck::default();
        *check.failed_at.lock().await = Some(Instant::now());
        let error = ensure_media_ready(&check).await.unwrap_err();
        assert!(error.chain().any(|cause| matches!(
            cause.downcast_ref::<AppError>(),
            Some(AppError::ServiceUnavailable { .. })
        )));
        assert!(error.downcast_ref::<DeviceAudioMediaError>().is_none());
        assert!(!check.passed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn media_self_check_wait_stops_on_cancellation() {
        let check = MediaCheck::default();
        *check.failed_at.lock().await = Some(Instant::now());
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(!wait_until_ready(&check, &cancellation).await);
    }
}
