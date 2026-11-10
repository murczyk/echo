//! Shared fixtures. Fixtures are generated with the system ffmpeg outside
//! the sandbox; only the code under test runs sandboxed.
#![allow(dead_code)]

use echo_media::ffmpeg::find_program;
use echo_media::{Ffmpeg, MediaConfig, SandboxMode};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub const SECRET_MARKER: &[u8] = b"ECHO-MEDIA-SECRET-MARKER";

/// `ECHO_MEDIA_TEST_SANDBOX=best-effort` runs the suite on Linux kernels
/// without Landlock. Elsewhere (macOS) the platform default is best effort.
pub fn sandbox_mode() -> SandboxMode {
    match std::env::var("ECHO_MEDIA_TEST_SANDBOX").as_deref() {
        Ok("best-effort") => SandboxMode::BestEffort,
        _ => SandboxMode::default(),
    }
}

pub fn ffmpeg() -> Ffmpeg {
    Ffmpeg::new(MediaConfig {
        sandbox_mode: sandbox_mode(),
        ..MediaConfig::from_path().unwrap()
    })
    .unwrap()
}

/// The ffmpeg found on `PATH`, for fixtures and control runs.
pub fn ffmpeg_bin() -> PathBuf {
    find_program("ffmpeg").unwrap()
}

pub fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

/// The system ffmpeg, unsandboxed, detached from the terminal. Without
/// `-nostdin` and a null stdin, interactive ffmpeg switches the tty to
/// no-echo mode; parallel tests then restore each other's saved state and
/// leave the console without echo.
pub fn ffmpeg_command() -> std::process::Command {
    let mut command = std::process::Command::new(ffmpeg_bin());
    command.stdin(std::process::Stdio::null()).args([
        "-nostdin",
        "-hide_banner",
        "-y",
    ]);
    command
}

/// Run the system ffmpeg (unsandboxed) to create a fixture.
pub fn generate(dir: &Path, name: &str, args: &[&str]) -> PathBuf {
    let path = dir.join(name);
    let status = ffmpeg_command()
        .args(["-loglevel", "error"])
        .args(args)
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success(), "fixture {name} failed");
    path
}

/// 3 s H.264/AAC MP4 with the `moov` atom at the end (no faststart).
pub fn video(dir: &Path, name: &str) -> PathBuf {
    generate(
        dir,
        name,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-f",
            "mp4",
        ],
    )
}

pub fn wav(dir: &Path, name: &str) -> PathBuf {
    generate(
        dir,
        name,
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-ar",
            "44100",
            "-f",
            "wav",
        ],
    )
}

pub fn mp3(dir: &Path, name: &str) -> PathBuf {
    generate(
        dir,
        name,
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "libmp3lame",
            "-f",
            "mp3",
        ],
    )
}

pub fn opus(dir: &Path, name: &str) -> PathBuf {
    generate(
        dir,
        name,
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "libopus",
            "-f",
            "ogg",
        ],
    )
}

pub fn image(dir: &Path, name: &str, codec: &str, format: &str) -> PathBuf {
    generate(
        dir,
        name,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x480:rate=1",
            "-frames:v",
            "1",
            "-c:v",
            codec,
            "-f",
            format,
        ],
    )
}

/// Like [`image`], for names ffmpeg's image2 muxer would expand (`%d`).
pub fn image_named(dir: &Path, name: &str, codec: &str) -> PathBuf {
    let generated = image(dir, ".fixture", codec, "image2");
    let path = dir.join(name);
    std::fs::rename(generated, &path).unwrap();
    path
}

pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A directory the sandbox never grants: a valid MPEG-TS video (the
/// classic HLS segment) and a text file carrying `SECRET_MARKER`.
pub struct Secrets {
    pub dir: tempfile::TempDir,
    pub video: PathBuf,
    pub text: PathBuf,
}

pub fn secrets() -> Secrets {
    let dir = tempfile::tempdir().unwrap();
    let video = generate(
        dir.path(),
        "secret.ts",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "mpegts",
        ],
    );
    let text = write(dir.path(), "secret.txt", SECRET_MARKER);
    Secrets { dir, video, text }
}

/// A TCP listener that counts every connection it receives.
pub struct Canary {
    pub port: u16,
    hits: Arc<AtomicUsize>,
}

impl Canary {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stream.is_ok() {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        Self { port, hits }
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

/// Whether the file at `path` contains `needle`.
pub fn contains(path: &Path, needle: &[u8]) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
        .unwrap_or(false)
}
