//! Bounds on every job: timeouts, output byte caps and thread counts. Callers override them through job options.

use std::time::Duration;

/// Decoder stderr kept per process; older bytes are drained and dropped.
pub const ECHO_MEDIA_STDERR_TAIL_BYTES: usize = 64 * 1024;

pub const ECHO_MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

pub const ECHO_MEDIA_THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(120);
pub const ECHO_MEDIA_THUMBNAIL_THREADS: u32 = 1;

pub const ECHO_MEDIA_REMUX_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub const ECHO_MEDIA_HLS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const ECHO_MEDIA_HLS_THREADS: u32 = 2;
pub const ECHO_MEDIA_HLS_SEGMENT_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const ECHO_MEDIA_HLS_RW_TIMEOUT_MICROS: u64 = 10_000_000;

pub const ECHO_MEDIA_AUDIO_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const ECHO_MEDIA_AUDIO_PROGRESS_TIMEOUT: Duration =
    Duration::from_secs(5 * 60);
pub const ECHO_MEDIA_AUDIO_THREADS: u32 = 1;
pub const ECHO_MEDIA_AUDIO_FRAMECRC_BYTES: usize = 64 * 1024;
pub const ECHO_MEDIA_AUDIO_RENDITION_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const ECHO_MEDIA_AUDIO_IMAGE_MAX_BYTES: u64 = 1024 * 1024;
pub const ECHO_MEDIA_AUDIO_IMAGE_TIMEOUT: Duration = Duration::from_secs(120);
