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
pub struct ThumbnailOptions<'a> {
    /// The `-vf` chain, e.g. a scale filter, plus `thumbnail=N` for video.
    pub filter: &'a str,
    pub formats: Formats,
    pub timeout: Duration,
    /// Largest JPEG accepted (also its `RLIMIT_FSIZE`); `None` for no cap.
    pub max_bytes: Option<u64>,
    pub threads: u32,
}

impl<'a> ThumbnailOptions<'a> {
    pub fn new(filter: &'a str) -> Self {
        Self {
            filter,
            formats: Formats::THUMBNAIL,
            timeout: ECHO_MEDIA_THUMBNAIL_TIMEOUT,
            max_bytes: None,
            threads: ECHO_MEDIA_THUMBNAIL_THREADS,
        }
    }
}

impl Ffmpeg {
    /// One JPEG frame from the first video stream, published atomically at
    /// `output` with mode `0600`. Returns its size.
    pub async fn thumbnail(
        &self,
        input: &Input,
        output: &Path,
        options: &ThumbnailOptions<'_>,
    ) -> Result<u64> {
        let staged = Staged::new(output, ECHO_MEDIA_THUMBNAIL_FILE_NAME)?;
        let args = Args::ffmpeg()
            .threads(options.threads)
            .input(input, options.formats)
            .args(["-map", "0:v:0", "-vf", options.filter])
            .args(["-frames:v", "1", "-an", "-sn", "-dn"])
            .threads(options.threads)
            .args(["-f", "image2", "-c:v", "mjpeg"])
            .output(staged.file());
        let spec = self.spec(Job {
            program: Program::Ffmpeg,
            input,
            args,
            timeout: options.timeout,
            file_size: options.max_bytes,
            write_dir: Some(staged.dir()),
            capture_stdout: false,
        });
        process::run(spec).await?;
        staged
            .publish(Expect {
                max_bytes: options.max_bytes,
                magic: Some(ECHO_MEDIA_JPEG_MAGIC),
            })
            .await
    }
}
