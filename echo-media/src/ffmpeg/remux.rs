use super::args::Args;
use super::input::{Formats, Input};
use super::output::{Expect, Staged};
use super::{Ffmpeg, Job, Program};
use crate::constants::*;
use crate::error::Result;
use crate::limits::*;
use crate::process;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct RemuxOptions<'a> {
    pub formats: Formats,
    pub timeout: Duration,
    /// Largest output accepted; also the `RLIMIT_FSIZE` of the process.
    pub max_bytes: u64,
    /// Video bitstream filter, e.g. `h264_metadata=level=auto`.
    pub video_bsf: Option<&'a str>,
}

impl RemuxOptions<'_> {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            formats: Formats::MOV,
            timeout: ECHO_MEDIA_REMUX_TIMEOUT,
            max_bytes,
            video_bsf: Some(ECHO_MEDIA_REMUX_VIDEO_BSF),
        }
    }
}

impl Ffmpeg {
    /// Stream-copy the first video and audio stream into an MP4 with the
    /// `moov` atom first, published atomically at `output`. Returns its size.
    pub async fn remux_mp4_faststart(
        &self,
        input: &Input,
        output: &Path,
        options: &RemuxOptions<'_>,
    ) -> Result<u64> {
        let staged = Staged::new(output, ECHO_MEDIA_REMUX_FILE_NAME)?;
        let mut args = Args::ffmpeg()
            .input(input, options.formats)
            .args(["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]);
        if let Some(bsf) = options.video_bsf {
            args = args.args(["-bsf:v", bsf]);
        }
        let args = args
            .args(["-movflags", "+faststart", "-f", "mp4"])
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
                magic: None,
            })
            .await
    }
}
