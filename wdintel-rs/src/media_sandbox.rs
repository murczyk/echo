//! Whether echo-media jobs run sandboxed, from `media_sandbox_enabled` in
//! the active system settings, read once at startup: changing it needs a
//! restart. Off unless enabled and its self-check passes. Every wdintel-rs
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
const FAILURE_REASON_MAX_CHARS: usize = 2000;

static MODE: OnceLock<SandboxMode> = OnceLock::new();

fn mode_for(enabled: bool) -> SandboxMode {
    if enabled {
        SandboxMode::default()
    } else {
        SandboxMode::Disabled
    }
}

/// Reads `media_sandbox_enabled` from the active settings and sets the mode
/// for the life of the process; later calls are ignored. Never chosen keeps
/// the sandbox off and warns, so existing deployments notice they decode
/// media unisolated.
/// With the sandbox enabled, a failed self-check does not stop startup: it
/// logs the error, keeps the sandbox off and records the failure in the
/// settings, so the admin UI shows it. Otherwise a broken sandbox would fail
/// every media job, and device audio would reject each upload as invalid.
pub async fn init<C>(dbx: &C) -> anyhow::Result<()>
where
    C: sea_orm::ConnectionTrait,
{
    if MODE.get().is_some() {
        return Ok(());
    }
    let settings = crate::system_settings::get_active_system_settings(dbx)
        .await
        .c(h!())?;
    let enabled = match settings.as_ref().and_then(|s| s.media_sandbox_enabled)
    {
        None => {
            log::warn!(
                "media_sandbox_enabled is not set in system settings: \
                 echo-media sandbox is disabled, ffmpeg and ffprobe decode \
                 media without isolation; enable «Пісочниця для обробки \
                 медіа» in admin system settings and restart to apply it"
            );
            false
        }
        Some(false) => {
            log::info!("echo-media sandbox enabled: false");
            false
        }
        Some(true) => {
            log::info!("echo-media sandbox enabled: true");
            let settings_id = settings.as_ref().map(|s| s.id);
            start_sandbox(dbx, settings_id).await
        }
    };
    let _ = MODE.set(mode_for(enabled));
    Ok(())
}

/// Whether the sandbox passed its self-check; a failure is recorded in
/// settings row `settings_id`.
async fn start_sandbox<C>(dbx: &C, settings_id: Option<i64>) -> bool
where
    C: sea_orm::ConnectionTrait,
{
    let checked = match Ffmpeg::shared() {
        Ok(media) => self_check(&media.with_sandbox_mode(mode_for(true))).await,
        Err(error) => Err(failure(error)),
    };
    let Err(error) = checked else {
        log::info!("echo-media sandbox self-check passed");
        return true;
    };
    log::error!(
        "echo-media sandbox failed to start, media jobs run without \
         isolation and media_sandbox_enabled is set to false: {error:?}"
    );
    let Some(settings_id) = settings_id else {
        return false;
    };
    let reason = failure_reason(&error);
    if let Err(error) = crate::system_settings::record_media_sandbox_failure(
        dbx,
        settings_id,
        &reason,
    )
    .await
    {
        log::error!("failed to record echo-media sandbox failure: {error:?}");
    }
    false
}

/// The root cause for the admin UI, bounded so decoder stderr cannot bloat
/// the settings row.
fn failure_reason(error: &anyhow::Error) -> String {
    error
        .root_cause()
        .to_string()
        .chars()
        .take(FAILURE_REASON_MAX_CHARS)
        .collect()
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
