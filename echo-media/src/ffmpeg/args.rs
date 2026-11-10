//! The only place that builds ffmpeg and ffprobe argv.

use super::input::{Formats, Input};
use std::ffi::OsString;
use std::path::Path;

const FFMPEG_PREAMBLE: &[&str] =
    &["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
const FFPROBE_PREAMBLE: &[&str] = &["-hide_banner", "-loglevel", "error"];
const STDOUT: &str = "pipe:1";

#[derive(Debug, Default)]
pub(crate) struct Args(Vec<OsString>);

impl Args {
    pub(crate) fn ffmpeg() -> Self {
        Self::default().args(FFMPEG_PREAMBLE)
    }

    pub(crate) fn ffprobe() -> Self {
        Self::default().args(FFPROBE_PREAMBLE)
    }

    pub(crate) fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.0.push(arg.into());
        self
    }

    pub(crate) fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.0.extend(args.into_iter().map(Into::into));
        self
    }

    /// `-threads` for the next input or output.
    pub(crate) fn threads(self, threads: u32) -> Self {
        self.arg("-threads").arg(threads.to_string())
    }

    /// Protocol and demuxer allowlists, then `-i`. Options for this input
    /// (seek, probe sizes) must be added before calling this.
    pub(crate) fn input(self, input: &Input, formats: Formats) -> Self {
        self.args(["-protocol_whitelist", input.protocols()])
            .args(["-format_whitelist", formats.as_str()])
            .arg("-i")
            .arg(input.argument())
    }

    /// An output file. Paths are always absolute, so ffmpeg never reads a
    /// protocol prefix from them.
    pub(crate) fn output(self, path: &Path) -> Self {
        debug_assert!(path.is_absolute());
        self.arg(path.as_os_str())
    }

    pub(crate) fn stdout(self) -> Self {
        self.arg(STDOUT)
    }

    pub(crate) fn into_vec(self) -> Vec<OsString> {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_always_carries_both_allowlists_before_dash_i() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("source");
        std::fs::write(&file, b"x").unwrap();
        let input = Input::file(&file).unwrap();
        let args = Args::ffmpeg()
            .threads(1)
            .input(&input, Formats::VIDEO)
            .output(&dir.path().join("out.jpg"))
            .into_vec();
        let args: Vec<_> =
            args.iter().map(|arg| arg.to_string_lossy()).collect();
        let at = |flag: &str| args.iter().position(|arg| arg == flag).unwrap();
        assert!(at("-protocol_whitelist") < at("-i"));
        assert!(at("-format_whitelist") < at("-i"));
        assert_eq!(args[at("-protocol_whitelist") + 1], "file");
        assert_eq!(args[at("-format_whitelist") + 1], Formats::VIDEO.as_str());
        assert!(args[at("-i") + 1].starts_with("file:/"));
        assert!(args.contains(&"-nostdin".into()));
    }
}
