use super::args::Args;
use super::input::{Formats, Input};
use super::{absolute_dir, remote_options, Ffmpeg, Job, Program};
use crate::constants::*;
use crate::error::Result;
use crate::limits::*;
use crate::process::{self, Running};
use std::path::Path;
use std::time::Duration;

/// Which part of the source to encode: segments numbered from `index`,
/// starting `start` seconds in and lasting `length` seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HlsSegments {
    pub index: u32,
    pub start: f64,
    pub length: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct HlsOptions<'a> {
    pub formats: Formats,
    pub video_filter: &'a str,
    pub video_maxrate: &'a str,
    pub threads: u32,
    pub segment_secs: f64,
    /// Per-segment `RLIMIT_FSIZE`.
    pub segment_max_bytes: u64,
    pub timeout: Duration,
}

impl Default for HlsOptions<'_> {
    fn default() -> Self {
        Self {
            formats: Formats::MOV,
            video_filter: ECHO_MEDIA_HLS_VIDEO_FILTER,
            video_maxrate: ECHO_MEDIA_HLS_VIDEO_MAXRATE,
            threads: ECHO_MEDIA_HLS_THREADS,
            segment_secs: ECHO_MEDIA_HLS_SEGMENT_SECS,
            segment_max_bytes: ECHO_MEDIA_HLS_SEGMENT_MAX_BYTES,
            timeout: ECHO_MEDIA_HLS_TIMEOUT,
        }
    }
}

impl Ffmpeg {
    /// Start encoding H.264/AAC HLS segments `N.ts` into `out_dir`, which is
    /// the only directory the process may write. The caller polls the
    /// directory and the returned process; dropping it kills the encoder.
    pub fn hls_segments(
        &self,
        input: &Input,
        out_dir: &Path,
        segments: HlsSegments,
        options: &HlsOptions<'_>,
    ) -> Result<Running> {
        let out_dir = absolute_dir(out_dir)?;
        let args = Args::ffmpeg().threads(options.threads);
        let args = remote_options(args, input)
            .args(["-analyzeduration", "1", "-probesize", "32768"])
            .args(["-fpsprobesize", "0"])
            .args(["-ss", &segments.start.to_string()])
            .input(input, options.formats);
        let args = encoder_args(args, segments, options);
        let args = muxer_args(args, out_dir, segments, options);
        process::spawn(self.spec(Job {
            program: Program::Ffmpeg,
            input,
            args,
            timeout: options.timeout,
            file_size: Some(options.segment_max_bytes),
            write_dir: Some(out_dir),
            capture_stdout: false,
        }))
    }
}

fn encoder_args(
    args: Args,
    segments: HlsSegments,
    options: &HlsOptions<'_>,
) -> Args {
    let audio_end = (segments.length - 1024.0 / 48000.0).max(0.0);
    args.args(["-t", &segments.length.to_string()])
        .args(["-map", "0:v:0", "-map", "0:a:0?"])
        .args(["-vf", options.video_filter, "-filter_threads", "1"])
        .args(["-c:v", "libx264"])
        .threads(options.threads)
        .args(["-preset", "veryfast", "-tune", "zerolatency", "-crf", "23"])
        .args(["-maxrate", options.video_maxrate])
        .args(["-bufsize", options.video_maxrate])
        .args(["-pix_fmt", "yuv420p", "-g", "30", "-sc_threshold", "0"])
        .args(["-c:a", "aac", "-b:a", "128k", "-ar", "48000"])
        .args(["-output_ts_offset", &segments.start.to_string()])
        .arg("-af")
        .arg(format!(
            "aresample=48000,atrim=end={audio_end},asetpts=PTS+1024"
        ))
}

fn muxer_args(
    args: Args,
    out_dir: &Path,
    segments: HlsSegments,
    options: &HlsOptions<'_>,
) -> Args {
    args.args(["-avoid_negative_ts", "disabled", "-muxdelay", "0"])
        .args(["-f", "hls", "-hls_time", &options.segment_secs.to_string()])
        .args(["-hls_playlist_type", "vod"])
        .args(["-hls_flags", "temp_file+independent_segments"])
        .args(["-start_number", &segments.index.to_string()])
        .arg("-hls_segment_filename")
        .arg(out_dir.join(ECHO_MEDIA_HLS_SEGMENT_PATTERN))
        .output(&out_dir.join(ECHO_MEDIA_HLS_PLAYLIST_NAME))
}
