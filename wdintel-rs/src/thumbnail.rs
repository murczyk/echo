//! JPEG thumbnails through the sandboxed `echo-media` ffmpeg wrapper.

use anyhow::{Context, Result};
use echo_media::ffmpeg::ThumbnailOptions;
use echo_media::Input;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;
use tokio::fs;

use crate::h;

pub(crate) struct Options<'a> {
    pub filter: &'a str,
    pub timeout: Duration,
    pub max_bytes: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
#[error("Thumbnail decoder could not produce a valid JPEG")]
pub(crate) struct InvalidMedia;

/// Writes one JPEG frame of `input` to `output` (mode `0600`, published
/// atomically). Fails with [`InvalidMedia`] when retrying cannot help.
pub(crate) async fn generate(
    input: &Path,
    output: &Path,
    options: &Options<'_>,
) -> Result<()> {
    let directory = output.parent().context(h!())?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .await
        .context(h!())?;
    fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .await
        .context(h!())?;
    let thumbnail = ThumbnailOptions {
        timeout: options.timeout,
        max_bytes: options.max_bytes,
        ..ThumbnailOptions::new(options.filter)
    };
    let result = match Input::file(input) {
        Ok(input) => {
            crate::media_sandbox::ffmpeg()?
                .thumbnail(&input, output, &thumbnail)
                .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.is_terminal() => {
            log::debug!(
                "thumbnail rejected input={}: {error:#?}",
                input.display()
            );
            Err(InvalidMedia).context(h!())
        }
        Err(error) => Err(error).context(h!()),
    }
}
