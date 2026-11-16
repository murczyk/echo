use super::{
    unavailable, DeviceAudioMediaError, DeviceAudioRuntime,
    DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT, DEVICE_AUDIO_FFMPEG_THREADS,
    DEVICE_AUDIO_MAX_JS_TIMESTAMP_MS, DEVICE_AUDIO_MIN_TIMESTAMP_US,
    DEVICE_AUDIO_RENDITION_RATE,
};
use crate::devices::upload_finalization::resources::{
    self, OperationGuard, ResourceGuard, ResourceKind,
};
use crate::h;
use crate::types::ShortContext;
use chrono::{DateTime, Utc};
use echo_media::ffmpeg::{
    DecodeOptions, Probe, ProbeOptions, Rendition, RenditionOptions,
};
use echo_media::{Formats, Input, MediaError};
use std::future::Future;
use std::path::Path;

#[derive(Debug)]
pub(super) struct ProbedAudio {
    pub duration_us: i64,
    pub mime_type: &'static str,
    pub recording_ended_at: DateTime<Utc>,
}

pub(super) async fn probe(
    runtime: &DeviceAudioRuntime,
    source: &Path,
    start: DateTime<Utc>,
) -> anyhow::Result<ProbedAudio> {
    probe_with_admission(runtime, source, start, None).await
}

pub(super) async fn probe_with_admission(
    runtime: &DeviceAudioRuntime,
    source: &Path,
    start: DateTime<Utc>,
    admission: Option<OperationGuard>,
) -> anyhow::Result<ProbedAudio> {
    checked_recording_end(start, 1).c(h!())?;
    let slot = if admission.is_some() {
        runtime
            .finalization_slot(ResourceKind::Decode)
            .await
            .c(h!())?
    } else {
        None
    };
    probe_with_resources(runtime, source, start, admission, slot)
        .await
        .c(h!())
}

pub(super) async fn probe_with_resources(
    runtime: &DeviceAudioRuntime,
    source: &Path,
    start: DateTime<Utc>,
    admission: Option<OperationGuard>,
    slot: Option<ResourceGuard>,
) -> anyhow::Result<ProbedAudio> {
    checked_recording_end(start, 1).c(h!())?;
    let permit = runtime
        .probe_permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| unavailable("audio decoder is unavailable"))
        .c(h!())?;
    let source = source.to_path_buf();
    resources::spawn_child_task(async move {
        let _guards = (permit, slot, admission);
        probe_owned(&source, start).await
    })
    .await
    .c(h!())?
    .c(h!())
}

async fn probe_owned(
    source: &Path,
    start: DateTime<Utc>,
) -> anyhow::Result<ProbedAudio> {
    let metadata = media_metadata(source).await.c(h!())?;
    let mime_type = match metadata.format_name() {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        _ => return Err(DeviceAudioMediaError::UnsupportedMedia.into()),
    };
    let stream = metadata
        .first("audio")
        .ok_or_else(|| invalid("файл не містить аудіопотоку"))
        .c(h!())?;
    let sample_rate = match (stream.channels, stream.sample_rate()) {
        (Some(channels), Some(rate)) if channels > 0 => rate,
        _ => return Err(invalid("некоректні параметри аудіопотоку")),
    };
    let options = DecodeOptions {
        formats: Formats::AUDIO,
        threads: ffmpeg_threads().c(h!())?,
        progress_timeout: DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT,
        ..DecodeOptions::new(sample_rate)
    };
    let input = Input::file(source).c(h!())?;
    let media = crate::media_sandbox::ffmpeg().c(h!())?;
    let report = until_shutdown(media.decode_verify(&input, &options))
        .await
        .c(h!())?;
    Ok(ProbedAudio {
        duration_us: report.duration_us,
        mime_type,
        recording_ended_at: checked_recording_end(start, report.duration_us)
            .c(h!())?,
    })
}

/// Format and stream metadata. The probe accepts every audio demuxer on
/// `Formats::AUDIO` so a FLAC or Ogg upload is reported as unsupported
/// rather than invalid; only WAV and MP3 are decoded afterwards.
async fn media_metadata(source: &Path) -> anyhow::Result<Probe> {
    let options = ProbeOptions {
        timeout: DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT,
        ..ProbeOptions::new(Formats::AUDIO)
    };
    let input = Input::file(source).c(h!())?;
    let media = crate::media_sandbox::ffmpeg().c(h!())?;
    until_shutdown(media.probe(&input, &options)).await.c(h!())
}

pub(super) async fn source_channels(source: &Path) -> anyhow::Result<u32> {
    media_metadata(source)
        .await
        .c(h!())?
        .first("audio")
        .and_then(|stream| stream.channels)
        .filter(|channels| *channels > 0)
        .ok_or_else(|| invalid("файл не містить аудіопотоку"))
        .c(h!())
}

/// Writes an MP3 rendition or a wave/spectrogram PNG of a WAV/MP3 original
/// to `output`, decoding the whole source as `probe` does.
pub(super) async fn render(
    source: &Path,
    output: &Path,
    rendition: Rendition<'_>,
) -> anyhow::Result<()> {
    let options = RenditionOptions {
        formats: Formats::AUDIO,
        threads: ffmpeg_threads().c(h!())?,
        sample_rate: DEVICE_AUDIO_RENDITION_RATE.parse().c(h!())?,
        progress_timeout: DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT,
        ..RenditionOptions::new(rendition)
    };
    let input = Input::file(source).c(h!())?;
    until_shutdown(
        crate::media_sandbox::ffmpeg()
            .c(h!())?
            .audio_rendition(&input, output, &options),
    )
    .await
    .c(h!())?;
    Ok(())
}

fn ffmpeg_threads() -> anyhow::Result<u32> {
    DEVICE_AUDIO_FFMPEG_THREADS.parse().c(h!())
}

/// Runs a sandboxed media job until it finishes or finalization shuts down.
/// Dropping the job on shutdown kills its process group.
async fn until_shutdown<T>(
    job: impl Future<Output = Result<T, MediaError>>,
) -> anyhow::Result<T> {
    let shutdown = resources::shutdown_cancellation();
    anyhow::ensure!(!shutdown.is_cancelled(), "finalization shutdown");
    tokio::select! {
        result = job => result.map_err(media_failure),
        _ = shutdown.cancelled() => Err(anyhow::anyhow!("finalization shutdown")),
    }
}

/// Input that can never decode becomes `InvalidAudio`; timeouts, a stalled
/// decoder and environment failures stay operational errors.
fn media_failure(error: MediaError) -> anyhow::Error {
    if error.is_terminal() {
        log::warn!("device audio media process failed: {error}");
        invalid(
            "повне декодування або визначення формату завершилося з помилкою",
        )
    } else {
        error.into()
    }
}

fn invalid(reason: &str) -> anyhow::Error {
    DeviceAudioMediaError::InvalidAudio {
        reason: reason.to_string(),
    }
    .into()
}

pub(super) fn checked_recording_end(
    start: DateTime<Utc>,
    duration_us: i64,
) -> anyhow::Result<DateTime<Utc>> {
    if duration_us <= 0 {
        return Err(invalid("тривалість аудіо повинна бути додатною"));
    }
    let end = start
        .checked_add_signed(chrono::Duration::microseconds(duration_us))
        .ok_or_else(|| {
            invalid("час завершення виходить за підтримуваний діапазон")
        })
        .c(h!())?;
    for instant in [start, end] {
        if instant.timestamp_micros() < DEVICE_AUDIO_MIN_TIMESTAMP_US
            || instant.timestamp_millis().unsigned_abs()
                > DEVICE_AUDIO_MAX_JS_TIMESTAMP_MS as u64
        {
            return Err(invalid(
                "час запису виходить за підтримуваний діапазон",
            ));
        }
    }
    Ok(end)
}

#[cfg(test)]
mod tests;
