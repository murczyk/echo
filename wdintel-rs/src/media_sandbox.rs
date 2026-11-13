//! Whether echo-media jobs run sandboxed, from `media_sandbox_enabled` in
//! config.toml, read once at startup. Off unless enabled. Every wdintel-rs
//! media job takes its `Ffmpeg` from [`ffmpeg`].

use crate::h;
use crate::types::ShortContext;
use echo_media::ffmpeg::{DecodeOptions, ProbeOptions};
use echo_media::{Ffmpeg, Formats, Input, MediaError, SandboxMode};
use std::sync::OnceLock;

const SELF_CHECK_RATE: u32 = 8000;
const SELF_CHECK_SAMPLES: u32 = 800;
const WAV_HEADER_BYTES: u32 = 44;
const WAV_SAMPLE_BYTES: u32 = 2;

static MODE: OnceLock<SandboxMode> = OnceLock::new();

fn mode_for(enabled: bool) -> SandboxMode {
    if enabled {
        SandboxMode::default()
    } else {
        SandboxMode::Disabled
    }
}

/// Sets the mode for the life of the process; later calls are ignored.
/// With the sandbox enabled, a failed self-check stops startup: otherwise a
/// broken sandbox would fail every media job, and device audio would reject
/// each upload as invalid.
pub async fn init(enabled: bool) -> anyhow::Result<()> {
    if MODE.set(mode_for(enabled)).is_err() {
        return Ok(());
    }
    log::info!("echo-media sandbox enabled: {enabled}");
    if enabled {
        self_check(&ffmpeg().c(h!())?).await.c(h!())?;
        log::info!("echo-media sandbox self-check passed");
    }
    Ok(())
}

/// The process-wide `Ffmpeg` in the configured sandbox mode.
pub fn ffmpeg() -> echo_media::Result<Ffmpeg> {
    let mode = MODE.get().copied().unwrap_or(SandboxMode::Disabled);
    Ok(Ffmpeg::shared()?.with_sandbox_mode(mode))
}

/// Probes and fully decodes a silent WAV in the sandbox, from the system
/// temp directory like device audio finalization.
async fn self_check(media: &Ffmpeg) -> anyhow::Result<()> {
    let directory = tempfile::tempdir().c(h!())?;
    let source = directory.path().join("self-check.wav");
    tokio::fs::write(&source, silent_wav()).await.c(h!())?;
    let input = Input::file(&source).c(h!())?;
    let probe = media
        .probe(&input, &ProbeOptions::new(Formats::AUDIO))
        .await
        .map_err(failure)?;
    anyhow::ensure!(
        probe.format_name() == Some("wav"),
        "sandbox self-check probe did not recognise the WAV"
    );
    let report = media
        .decode_verify(&input, &DecodeOptions::new(SELF_CHECK_RATE))
        .await
        .map_err(failure)?;
    anyhow::ensure!(
        report.duration_us > 0,
        "sandbox self-check decode produced no audio"
    );
    Ok(())
}

/// Keeps the sanitized decoder stderr that `Display` leaves out.
fn failure(error: MediaError) -> anyhow::Error {
    anyhow::anyhow!("echo-media sandbox self-check failed: {error:?}")
}

/// Mono 16-bit PCM silence behind a canonical RIFF header.
fn silent_wav() -> Vec<u8> {
    let rate = SELF_CHECK_RATE;
    let data = SELF_CHECK_SAMPLES * WAV_SAMPLE_BYTES;
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

    #[test]
    fn sandbox_is_off_unless_enabled() {
        assert_eq!(mode_for(false), SandboxMode::Disabled);
        assert_eq!(mode_for(true), SandboxMode::default());
        assert_ne!(mode_for(true), SandboxMode::Disabled);
    }

    /// Leaves the process-wide mode alone, so parallel tests keep the
    /// default (sandbox off).
    #[tokio::test]
    async fn self_check_passes_in_the_sandbox() {
        let media = Ffmpeg::shared().unwrap().with_sandbox_mode(mode_for(true));
        self_check(&media).await.unwrap();
    }
}
