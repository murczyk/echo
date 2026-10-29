use super::{
    unavailable, DeviceAudioMediaError, DeviceAudioRuntime,
    DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT, DEVICE_AUDIO_DECODER_STDERR_BYTES,
    DEVICE_AUDIO_FFMPEG_THREADS, DEVICE_AUDIO_MAX_JS_TIMESTAMP_MS,
    DEVICE_AUDIO_MICROSECONDS_PER_SECOND, DEVICE_AUDIO_MIN_TIMESTAMP_US,
    DEVICE_AUDIO_PROBE_OUTPUT_BYTES, DEVICE_AUDIO_PROCESS_READ_BYTES,
};
use crate::devices::upload_finalization::resources::{
    self, OperationGuard, ResourceGuard, ResourceKind,
};
use crate::h;
use crate::types::ShortContext;
use chrono::{DateTime, Utc};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::Instant;

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

#[derive(Debug)]
struct ProcessOutput {
    stdout: Vec<u8>,
    duration_us: Option<i64>,
}

async fn run_media_process(
    mut command: Command,
    decode: bool,
    timeout: Duration,
) -> anyhow::Result<ProcessOutput> {
    let shutdown = resources::shutdown_cancellation();
    anyhow::ensure!(!shutdown.is_cancelled(), "finalization shutdown");
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .c(h!())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("missing decoder stderr"))
        .c(h!())?;
    let stderr = resources::spawn_child_task(capture_stderr(stderr));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("missing decoder stdout"))
        .c(h!())?;
    let output = tokio::select! {
        result = read_output(stdout, decode, timeout) => result,
        _ = shutdown.cancelled() => Err(anyhow::anyhow!("finalization shutdown")),
    };
    if output.is_err() {
        let _ = child.start_kill();
    }
    let deadline = output
        .as_ref()
        .map_or_else(|_| Instant::now() + timeout, |(_, last)| *last + timeout);
    let status = tokio::select! {
        status = tokio::time::timeout_at(deadline, child.wait()) => {
            match status {
                Ok(status) => status.c(h!())?,
                Err(error) => {
                    let _ = child.start_kill();
                    child.wait().await.c(h!())?;
                    stderr.await.c(h!())?.c(h!())?;
                    return Err(error).c(h!());
                }
            }
        }
        _ = shutdown.cancelled() => {
            let _ = child.start_kill();
            child.wait().await.c(h!())?
        }
    };
    let stderr = stderr.await.c(h!())?.c(h!())?;
    let (output, _) = output.c(h!())?;
    if !status.success() {
        log::warn!("device audio media process failed: status={status}, stderr_bytes={}", stderr.len());
        return Err(invalid(
            "повне декодування або визначення формату завершилося з помилкою",
        ));
    }
    Ok(output)
}

async fn probe_owned(
    source: &Path,
    start: DateTime<Utc>,
) -> anyhow::Result<ProbedAudio> {
    let metadata = media_metadata(source).await.c(h!())?;
    let mime_type = match metadata
        .format
        .as_ref()
        .map(|format| format.format_name.as_str())
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        _ => return Err(DeviceAudioMediaError::UnsupportedMedia.into()),
    };
    let stream = metadata
        .streams
        .first()
        .ok_or_else(|| invalid("файл не містить аудіопотоку"))
        .c(h!())?;
    if stream.codec_type != "audio"
        || stream.channels == 0
        || stream.sample_rate.parse::<u32>().unwrap_or(0) == 0
    {
        return Err(invalid("некоректні параметри аудіопотоку"));
    }
    let output = run_media_process(
        decoder_command(source, &stream.sample_rate),
        true,
        DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT,
    )
    .await
    .c(h!())?;
    let duration_us = output
        .duration_us
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("тривалість аудіо повинна бути додатною"))
        .c(h!())?;
    Ok(ProbedAudio {
        duration_us,
        mime_type,
        recording_ended_at: checked_recording_end(start, duration_us)
            .c(h!())?,
    })
}

async fn media_metadata(source: &Path) -> anyhow::Result<ProbeMetadata> {
    let mut command = Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=format_name:stream=codec_type,sample_rate,channels",
            "-of",
            "json",
        ])
        .arg(source);
    let output = run_media_process(
        command,
        false,
        DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT,
    )
    .await
    .c(h!())?;
    serde_json::from_slice(&output.stdout).c(h!())
}

pub(super) async fn source_channels(source: &Path) -> anyhow::Result<u32> {
    media_metadata(source)
        .await
        .c(h!())?
        .streams
        .first()
        .map(|stream| stream.channels)
        .filter(|channels| *channels > 0)
        .ok_or_else(|| invalid("файл не містить аудіопотоку"))
        .c(h!())
}

pub(super) async fn run_decoder(command: Command) -> anyhow::Result<()> {
    run_media_process(command, true, DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT)
        .await
        .c(h!())?;
    Ok(())
}

fn decoder_command(source: &Path, sample_rate: &str) -> Command {
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-filter_threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-filter_complex_threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-xerror",
            "-err_detect",
            "explode",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "null",
            "-",
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_s16le",
            "-threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-ar",
        ])
        .arg(sample_rate)
        .args([
            "-map_metadata",
            "-1",
            "-bsf:a",
            "setts=ts=N",
            "-f",
            "framecrc",
            "pipe:1",
        ]);
    command
}

#[derive(serde::Deserialize)]
struct ProbeMetadata {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(serde::Deserialize)]
struct ProbeStream {
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    sample_rate: String,
    #[serde(default)]
    channels: u32,
}

#[derive(serde::Deserialize)]
struct ProbeFormat {
    format_name: String,
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

async fn capture_stderr(
    mut stream: impl AsyncRead + Unpin,
) -> anyhow::Result<Vec<u8>> {
    let mut tail = Vec::new();
    let mut buffer = [0_u8; DEVICE_AUDIO_PROCESS_READ_BYTES];
    loop {
        let length = stream.read(&mut buffer).await.c(h!())?;
        if length == 0 {
            return Ok(tail);
        }
        let drop_bytes = (tail.len() + length)
            .saturating_sub(DEVICE_AUDIO_DECODER_STDERR_BYTES);
        tail.drain(..drop_bytes);
        tail.extend_from_slice(&buffer[..length]);
    }
}

async fn read_output(
    mut stream: impl AsyncRead + Unpin,
    decode: bool,
    timeout: Duration,
) -> anyhow::Result<(ProcessOutput, Instant)> {
    let mut output = OutputProgress::new(decode);
    let mut buffer = [0_u8; DEVICE_AUDIO_PROCESS_READ_BYTES];
    loop {
        let length = tokio::time::timeout_at(
            output.last_progress + timeout,
            stream.read(&mut buffer),
        )
        .await
        .c(h!())?
        .c(h!())?;
        if length == 0 {
            if decode && !output.bytes.is_empty() {
                return Err(invalid("декодування не було завершене"));
            }
            let duration_us = output.duration_us().c(h!())?;
            return Ok((
                ProcessOutput {
                    stdout: output.bytes,
                    duration_us,
                },
                output.last_progress,
            ));
        }
        output.consume(&buffer[..length]).c(h!())?;
    }
}

struct OutputProgress {
    decode: bool,
    bytes: Vec<u8>,
    time_base: Option<(u128, u128)>,
    ticks: u128,
    last_progress: Instant,
}

impl OutputProgress {
    fn new(decode: bool) -> Self {
        Self {
            decode,
            bytes: Vec::new(),
            time_base: None,
            ticks: 0,
            last_progress: Instant::now(),
        }
    }

    fn consume(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        if self.bytes.len() + bytes.len() > DEVICE_AUDIO_PROBE_OUTPUT_BYTES {
            return Err(anyhow::anyhow!(
                "media process output exceeds diagnostic budget"
            ));
        }
        self.bytes.extend_from_slice(bytes);
        if !self.decode {
            self.last_progress = Instant::now();
            return Ok(());
        }
        while let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n')
        {
            let line: Vec<_> = self.bytes.drain(..=end).collect();
            let line = std::str::from_utf8(&line).c(h!())?.trim();
            self.packet(line).c(h!())?;
        }
        Ok(())
    }

    fn packet(&mut self, line: &str) -> anyhow::Result<()> {
        if let Some(value) = line.strip_prefix("#tb 0:") {
            let (numerator, denominator) = value
                .trim()
                .split_once('/')
                .ok_or_else(|| anyhow::anyhow!("invalid decoded time base"))
                .c(h!())?;
            let time_base = (
                numerator.parse::<u128>().c(h!())?,
                denominator.parse::<u128>().c(h!())?,
            );
            if time_base.0 == 0
                || time_base.1 == 0
                || self.time_base.is_some_and(|previous| previous != time_base)
            {
                return Err(invalid(
                    "некоректна часова база декодованого потоку",
                ));
            }
            self.time_base = Some(time_base);
        } else if !line.starts_with('#') && !line.is_empty() {
            let fields: Vec<_> = line.split(',').map(str::trim).collect();
            if fields.len() != 6 || fields[0] != "0" || self.time_base.is_none()
            {
                return Err(anyhow::anyhow!(
                    "invalid decoded packet statistics"
                ));
            }
            let ticks = fields[3].parse::<u128>().c(h!())?;
            let size = fields[4].parse::<u64>().c(h!())?;
            if ticks == 0 || size == 0 {
                return Err(invalid("порожній декодований пакет"));
            }
            self.ticks = self
                .ticks
                .checked_add(ticks)
                .ok_or_else(|| {
                    invalid(
                        "тривалість аудіо виходить за підтримуваний діапазон",
                    )
                })
                .c(h!())?;
            self.last_progress = Instant::now();
        }
        Ok(())
    }

    fn duration_us(&self) -> anyhow::Result<Option<i64>> {
        if !self.decode {
            return Ok(None);
        }
        let (numerator, denominator) = self
            .time_base
            .ok_or_else(|| invalid("відсутня часова база декодованого потоку"))
            .c(h!())?;
        let duration = self
            .ticks
            .checked_mul(numerator)
            .and_then(|duration| {
                duration.checked_mul(u128::from(
                    DEVICE_AUDIO_MICROSECONDS_PER_SECOND,
                ))
            })
            .and_then(|duration| duration.checked_add(denominator / 2))
            .ok_or_else(|| {
                invalid("тривалість аудіо виходить за підтримуваний діапазон")
            })
            .c(h!())?
            / denominator;
        Ok(Some(
            i64::try_from(duration)
                .map_err(|_| {
                    invalid(
                        "тривалість аудіо виходить за підтримуваний діапазон",
                    )
                })
                .c(h!())?,
        ))
    }
}

#[cfg(test)]
mod tests;
