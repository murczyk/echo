//! High-level, sandboxed ffmpeg/ffprobe jobs.

mod args;
mod audio;
mod framecrc;
mod hls;
mod input;
mod output;
mod probe;
mod remux;
mod thumbnail;

pub use audio::{
    AudioImage, AudioImageOptions, DecodeOptions, DecodeReport, Rendition,
    RenditionOptions, RenditionReport,
};
pub use hls::{HlsOptions, HlsSegments};
pub use input::{Formats, Input, LocalFile, RemoteUrl};
pub use probe::{Probe, ProbeFormat, ProbeOptions, ProbeStream};
pub use remux::RemuxOptions;
pub use thumbnail::ThumbnailOptions;

use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::limits::*;
use crate::process::Spec;
use crate::sandbox::{Limits, Policy, SandboxMode};
use args::Args;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Binary locations and sandbox mode shared by every job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaConfig {
    /// Absolute path to ffmpeg; jobs never search `PATH` themselves.
    pub ffmpeg_bin: PathBuf,
    /// Absolute path to ffprobe; jobs never search `PATH` themselves.
    pub ffprobe_bin: PathBuf,
    pub sandbox_mode: SandboxMode,
}

impl MediaConfig {
    /// Find `ffmpeg` and `ffprobe` on `PATH` once, resolved to canonical
    /// absolute paths (e.g. `/usr/bin/ffmpeg`, or Homebrew's Cellar path on
    /// macOS), with the platform's default sandbox mode.
    pub fn from_path() -> Result<Self> {
        Ok(Self {
            ffmpeg_bin: find_program(ECHO_MEDIA_FFMPEG_NAME)?,
            ffprobe_bin: find_program(ECHO_MEDIA_FFPROBE_NAME)?,
            sandbox_mode: SandboxMode::default(),
        })
    }
}

/// The first executable `name` in an absolute `PATH` entry, canonicalized.
/// Relative entries (`.`, empty) are skipped so the working directory can
/// never supply a binary.
pub fn find_program(name: &str) -> Result<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
        .and_then(|found| found.canonicalize().ok())
        .ok_or_else(|| {
            MediaError::rejected(format!("{name} was not found on PATH"))
        })
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    })
}

/// Entry point for every ffmpeg and ffprobe job. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Ffmpeg {
    config: MediaConfig,
}

#[derive(Clone, Copy)]
enum Program {
    Ffmpeg,
    Ffprobe,
}

/// What one job may touch besides its input.
struct Job<'a> {
    program: Program,
    input: &'a Input,
    args: Args,
    timeout: Duration,
    file_size: Option<u64>,
    write_dir: Option<&'a Path>,
    capture_stdout: bool,
}

impl Ffmpeg {
    /// [`Ffmpeg::new`] with [`MediaConfig::from_path`].
    pub fn from_path() -> Result<Self> {
        Self::new(MediaConfig::from_path()?)
    }

    pub fn new(config: MediaConfig) -> Result<Self> {
        for binary in [&config.ffmpeg_bin, &config.ffprobe_bin] {
            if !binary.is_absolute() || !binary.is_file() {
                return Err(MediaError::rejected(format!(
                    "media binary {} must be an absolute path to a file",
                    binary.display()
                )));
            }
        }
        Ok(Self { config })
    }

    pub fn config(&self) -> &MediaConfig {
        &self.config
    }

    fn spec(&self, job: Job<'_>) -> Spec {
        let program = match job.program {
            Program::Ffmpeg => &self.config.ffmpeg_bin,
            Program::Ffprobe => &self.config.ffprobe_bin,
        };
        let mut policy = job.input.grant(Policy::for_programs(&[program]));
        if let Some(dir) = job.write_dir {
            policy = policy.write_dir(dir);
        }
        let policy = policy.limits(Limits {
            file_size: job.file_size,
        });
        Spec {
            program: program.clone(),
            args: job.args.into_vec(),
            policy,
            mode: self.config.sandbox_mode,
            timeout: job.timeout,
            capture_stdout: job.capture_stdout,
            redact: job.input.secrets(),
        }
    }
}

/// Options that apply to remote inputs only.
fn remote_options(args: Args, input: &Input) -> Args {
    match input {
        Input::File(_) => args,
        Input::Remote(_) => args
            .arg("-rw_timeout")
            .arg(ECHO_MEDIA_HLS_RW_TIMEOUT_MICROS.to_string()),
    }
}

fn absolute_dir(path: &Path) -> Result<&Path> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(MediaError::rejected(format!(
            "{} must be an absolute directory",
            path.display()
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_programs_on_path_as_absolute_paths() {
        let sh = find_program("sh").unwrap();
        assert!(sh.is_absolute(), "{sh:?}");
        assert_eq!(sh, sh.canonicalize().unwrap());
        assert!(find_program("echo-media-no-such-program").is_err());
    }
}
