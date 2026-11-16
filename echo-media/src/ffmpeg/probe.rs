use super::args::Args;
use super::input::{Formats, Input};
use super::{remote_options, Ffmpeg, Job, Program};
use crate::constants::*;
use crate::error::{MediaError, Result};
use crate::limits::*;
use crate::process;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct ProbeOptions {
    pub formats: Formats,
    pub timeout: Duration,
    /// ffprobe JSON kept before the probe fails with `OutputLimit`.
    pub max_output_bytes: usize,
}

impl ProbeOptions {
    pub fn new(formats: Formats) -> Self {
        Self {
            formats,
            timeout: ECHO_MEDIA_PROBE_TIMEOUT,
            max_output_bytes: ECHO_MEDIA_PROBE_OUTPUT_BYTES,
        }
    }
}

/// The subset of `ffprobe -of json` output Echo uses.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct Probe {
    #[serde(default)]
    pub streams: Vec<ProbeStream>,
    pub format: Option<ProbeFormat>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct ProbeStream {
    pub index: Option<u32>,
    pub codec_type: Option<String>,
    pub codec_name: Option<String>,
    pub pix_fmt: Option<String>,
    pub sample_rate: Option<String>,
    pub channels: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct ProbeFormat {
    pub format_name: Option<String>,
    pub duration: Option<String>,
}

impl Probe {
    /// The first stream of `codec_type` (`video`, `audio`, ...).
    pub fn first(&self, codec_type: &str) -> Option<&ProbeStream> {
        self.streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some(codec_type))
    }

    /// Container duration in seconds, when finite and positive.
    pub fn duration_secs(&self) -> Option<f64> {
        let duration = self.format.as_ref()?.duration.as_deref()?;
        let duration: f64 = duration.parse().ok()?;
        (duration.is_finite() && duration > 0.0).then_some(duration)
    }

    pub fn format_name(&self) -> Option<&str> {
        self.format.as_ref()?.format_name.as_deref()
    }
}

impl ProbeStream {
    pub fn sample_rate(&self) -> Option<u32> {
        self.sample_rate
            .as_deref()?
            .parse()
            .ok()
            .filter(|rate| *rate > 0)
    }
}

impl Ffmpeg {
    /// Stream and container metadata (`ffprobe -show_entries`).
    pub async fn probe(
        &self,
        input: &Input,
        options: &ProbeOptions,
    ) -> Result<Probe> {
        let args = Args::ffprobe()
            .args(["-show_entries", ECHO_MEDIA_PROBE_SHOW_ENTRIES])
            .args(["-of", "json"]);
        let args = remote_options(args, input).input(input, options.formats);
        let spec = self.spec(Job {
            program: Program::Ffprobe,
            input,
            args,
            timeout: options.timeout,
            file_size: Some(0),
            write_dir: None,
            capture_stdout: true,
        });
        let output = process::capture(spec, options.max_output_bytes).await?;
        serde_json::from_slice(&output.stdout).map_err(|error| {
            MediaError::invalid(format!("unreadable ffprobe output: {error}"))
        })
    }
}
