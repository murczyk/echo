use anyhow::{Context, Result};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::h;

pub(crate) struct Options<'a> {
    pub binary: &'a str,
    pub filter: &'a str,
    pub timeout: Duration,
    pub max_bytes: Option<u64>,
    pub local_media_only: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("Thumbnail decoder could not produce a valid JPEG")]
pub(crate) struct InvalidMedia;

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
    let temporary = tempfile::Builder::new()
        .prefix("thumbnail.tmp-")
        .suffix(".jpg")
        .tempfile_in(directory)
        .context(h!())?;
    let status = tokio::time::timeout(
        options.timeout,
        command(input, temporary.path(), options).status(),
    )
    .await
    .context(h!())?
    .context(h!())?;
    if !status.success() {
        return Err(InvalidMedia).context(h!());
    }
    let metadata = fs::metadata(temporary.path()).await.context(h!())?;
    if metadata.len() == 0
        || options
            .max_bytes
            .is_some_and(|limit| metadata.len() > limit)
    {
        return Err(InvalidMedia).context(h!());
    }
    let mut file = fs::File::open(temporary.path()).await.context(h!())?;
    let mut magic = [0u8; 3];
    if file.read_exact(&mut magic).await.is_err() || magic != [0xff, 0xd8, 0xff]
    {
        return Err(InvalidMedia).context(h!());
    }
    fs::set_permissions(
        temporary.path(),
        std::fs::Permissions::from_mode(0o600),
    )
    .await
    .context(h!())?;
    fs::rename(temporary.path(), output).await.context(h!())?;
    Ok(())
}

pub(crate) fn command(
    input: &Path,
    output: &Path,
    options: &Options<'_>,
) -> Command {
    let mut command = Command::new(options.binary);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .args(["-nostdin", "-y", "-hide_banner", "-loglevel", "error"]);
    if options.local_media_only {
        command.args([
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            crate::config::THUMBNAIL_LOCAL_FORMAT_WHITELIST,
        ]);
    }
    command
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-vf", options.filter])
        .args([
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-threads",
            "1",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
        ]);
    if let Some(max_bytes) = options.max_bytes {
        command.arg("-fs").arg(max_bytes.to_string());
    }
    command.arg(output);
    command
}
