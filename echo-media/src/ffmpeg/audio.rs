use super::args::Args;
use super::framecrc::Framecrc;
use super::input::{Formats, Input};
use super::output::{Expect, Staged};
use super::{Ffmpeg, Job, Program};
use crate::constants::*;
use crate::error::Result;
use crate::limits::*;
use crate::process;
use std::path::Path;
use std::time::Duration;

/// Options for [`Ffmpeg::decode_verify`].
#[derive(Debug, Clone, Copy)]
pub struct DecodeOptions {
    pub formats: Formats,
    /// PCM rate of the verification stream; use the probed source rate.
    pub sample_rate: u32,
    pub threads: u32,
    /// Fail when no decoded packet is reported for this long.
    pub progress_timeout: Duration,
    pub timeout: Duration,
}

impl DecodeOptions {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            formats: Formats::WAV_MP3,
            sample_rate,
            threads: ECHO_MEDIA_AUDIO_THREADS,
            progress_timeout: ECHO_MEDIA_AUDIO_PROGRESS_TIMEOUT,
            timeout: ECHO_MEDIA_AUDIO_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeReport {
    pub duration_us: i64,
}

/// What [`Ffmpeg::audio_rendition`] produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rendition<'a> {
    Mp3 { channels: u32, quality: u32 },
    Wave { filter: &'a str },
    Spectrogram { filter: &'a str },
}

#[derive(Debug, Clone, Copy)]
pub struct RenditionOptions<'a> {
    pub kind: Rendition<'a>,
    pub formats: Formats,
    pub threads: u32,
    pub sample_rate: u32,
    pub max_bytes: u64,
    pub progress_timeout: Duration,
    pub timeout: Duration,
}

impl<'a> RenditionOptions<'a> {
    pub fn new(kind: Rendition<'a>) -> Self {
        let max_bytes = match kind {
            Rendition::Mp3 { .. } => ECHO_MEDIA_AUDIO_RENDITION_MAX_BYTES,
            _ => ECHO_MEDIA_AUDIO_IMAGE_MAX_BYTES,
        };
        Self {
            kind,
            formats: Formats::WAV_MP3,
            threads: ECHO_MEDIA_AUDIO_THREADS,
            sample_rate: ECHO_MEDIA_AUDIO_RENDITION_RATE,
            max_bytes,
            progress_timeout: ECHO_MEDIA_AUDIO_PROGRESS_TIMEOUT,
            timeout: ECHO_MEDIA_AUDIO_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenditionReport {
    pub bytes: u64,
    pub duration_us: i64,
}

/// What [`Ffmpeg::audio_image`] draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioImage {
    Wave,
    Spectrogram,
}

#[derive(Debug, Clone, Copy)]
pub struct AudioImageOptions {
    pub kind: AudioImage,
    pub formats: Formats,
    pub threads: u32,
    pub max_bytes: u64,
    pub timeout: Duration,
}

impl AudioImageOptions {
    pub fn new(kind: AudioImage) -> Self {
        Self {
            kind,
            formats: Formats::AUDIO,
            threads: ECHO_MEDIA_AUDIO_THREADS,
            max_bytes: ECHO_MEDIA_AUDIO_IMAGE_MAX_BYTES,
            timeout: ECHO_MEDIA_AUDIO_IMAGE_TIMEOUT,
        }
    }
}

impl Ffmpeg {
    /// Fully decode the first audio stream with `-xerror -err_detect
    /// explode`; fails on any decoding error. Returns the decoded duration.
    pub async fn decode_verify(
        &self,
        input: &Input,
        options: &DecodeOptions,
    ) -> Result<DecodeReport> {
        let args = strict_decoder(Args::ffmpeg(), options.threads)
            .input(input, options.formats)
            .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-f", "null", "-"]);
        let args =
            verification_output(args, options.threads, options.sample_rate)
                .args(["-map_metadata", "-1", "-bsf:a", "setts=ts=N"])
                .args(["-f", "framecrc"])
                .stdout();
        let spec = self.spec(Job {
            program: Program::Ffmpeg,
            input,
            args,
            timeout: options.timeout,
            file_size: Some(0),
            write_dir: None,
            capture_stdout: true,
        });
        let duration_us = run_framecrc(spec, options.progress_timeout).await?;
        Ok(DecodeReport { duration_us })
    }

    /// An MP3 rendition or a waveform/spectrogram PNG, published atomically
    /// at `output`, while the whole input is verified as in `decode_verify`.
    pub async fn audio_rendition(
        &self,
        input: &Input,
        output: &Path,
        options: &RenditionOptions<'_>,
    ) -> Result<RenditionReport> {
        let staged = Staged::new(output, ECHO_MEDIA_AUDIO_RENDITION_FILE_NAME)?;
        let args = strict_decoder(Args::ffmpeg(), options.threads)
            .input(input, options.formats);
        let args = rendition_args(args, options)
            .threads(options.threads)
            .output(staged.file());
        let args =
            verification_output(args, options.threads, options.sample_rate)
                .args(["-f", "framecrc"])
                .stdout();
        let spec = self.spec(Job {
            program: Program::Ffmpeg,
            input,
            args,
            timeout: options.timeout,
            file_size: Some(options.max_bytes),
            write_dir: Some(staged.dir()),
            capture_stdout: true,
        });
        let duration_us = run_framecrc(spec, options.progress_timeout).await?;
        let magic = match options.kind {
            Rendition::Mp3 { .. } => None,
            _ => Some(ECHO_MEDIA_PNG_MAGIC),
        };
        let bytes = staged
            .publish(Expect {
                max_bytes: Some(options.max_bytes),
                magic,
            })
            .await?;
        Ok(RenditionReport { bytes, duration_us })
    }

    /// A waveform or spectrogram PNG of any supported audio, published
    /// atomically at `output`. Replaces `milgeo-audio-wave`.
    pub async fn audio_image(
        &self,
        input: &Input,
        output: &Path,
        options: &AudioImageOptions,
    ) -> Result<u64> {
        let staged = Staged::new(output, ECHO_MEDIA_AUDIO_IMAGE_FILE_NAME)?;
        let filter = match options.kind {
            AudioImage::Wave => ECHO_MEDIA_AUDIO_WAVE_FILTER,
            AudioImage::Spectrogram => ECHO_MEDIA_AUDIO_SPECTROGRAM_FILTER,
        };
        let args = Args::ffmpeg()
            .threads(options.threads)
            .input(input, options.formats)
            .args(["-filter_complex", filter, "-frames:v", "1", "-an"])
            .threads(options.threads)
            .args(["-f", "image2", "-c:v", "png"])
            .output(staged.file());
        let spec = self.spec(Job {
            program: Program::Ffmpeg,
            input,
            args,
            timeout: options.timeout,
            file_size: Some(options.max_bytes),
            write_dir: Some(staged.dir()),
            capture_stdout: false,
        });
        process::run(spec).await?;
        staged
            .publish(Expect {
                max_bytes: Some(options.max_bytes),
                magic: Some(ECHO_MEDIA_PNG_MAGIC),
            })
            .await
    }
}

/// Decoder threads plus fail-on-first-error flags, before `-i`.
fn strict_decoder(args: Args, threads: u32) -> Args {
    let threads = threads.to_string();
    args.args(["-threads", &threads, "-filter_threads", &threads])
        .args(["-filter_complex_threads", &threads])
        .args(["-xerror", "-err_detect", "explode"])
}

/// The PCM stream whose framecrc lines prove the whole input decoded.
fn verification_output(args: Args, threads: u32, sample_rate: u32) -> Args {
    args.args(["-map", "0:a:0", "-vn", "-c:a", "pcm_s16le"])
        .threads(threads)
        .args(["-ar", &sample_rate.to_string()])
}

fn rendition_args(args: Args, options: &RenditionOptions<'_>) -> Args {
    match options.kind {
        Rendition::Mp3 { channels, quality } => args
            .args(["-map", "0:a:0", "-vn", "-c:a", "libmp3lame"])
            .args(["-q:a", &quality.to_string()])
            .args(["-ar", &options.sample_rate.to_string()])
            .args(["-ac", &channels.to_string(), "-f", "mp3"]),
        Rendition::Wave { filter } | Rendition::Spectrogram { filter } => args
            .args(["-filter_complex", filter, "-frames:v", "1", "-an"])
            .args(["-f", "image2", "-c:v", "png"]),
    }
}

async fn run_framecrc(
    spec: process::Spec,
    progress_timeout: Duration,
) -> Result<i64> {
    let mut framecrc = Framecrc::default();
    process::run_with(spec, Some(progress_timeout), |chunk| {
        framecrc.consume(chunk)
    })
    .await?;
    framecrc.finish()
}
