//! Private per-job output directories. ffmpeg writes only inside one; the
//! result is validated, made `0600` and renamed into place by the parent.

use crate::constants::*;
use crate::error::{MediaError, Result};
use anyhow::Context;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use tokio::io::AsyncReadExt;

pub(crate) struct Staged {
    dir: TempDir,
    file: PathBuf,
    target: PathBuf,
}

/// What a finished output must look like.
pub(crate) struct Expect<'a> {
    pub max_bytes: Option<u64>,
    pub magic: Option<&'a [u8]>,
}

impl Staged {
    /// Stage `target` (absolute; its parent is created `0700` if missing)
    /// as `file_name` inside a fresh private directory next to it.
    pub(crate) fn new(target: &Path, file_name: &str) -> Result<Self> {
        let parent = target
            .parent()
            .filter(|_| target.is_absolute() && target.file_name().is_some())
            .ok_or_else(|| {
                MediaError::rejected("output must be an absolute file path")
            })?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(ECHO_MEDIA_OUTPUT_DIR_MODE)
            .create(parent)
            .context("create output directory")?;
        let dir = tempfile::Builder::new()
            .prefix(ECHO_MEDIA_JOB_DIR_PREFIX)
            .tempdir_in(parent)
            .context("create job directory")?;
        Ok(Self {
            file: dir.path().join(file_name),
            dir,
            target: target.to_path_buf(),
        })
    }

    pub(crate) fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub(crate) fn file(&self) -> &Path {
        &self.file
    }

    /// Validate the staged file and move it to the target. Returns its size.
    pub(crate) async fn publish(self, expect: Expect<'_>) -> Result<u64> {
        let metadata = tokio::fs::symlink_metadata(&self.file)
            .await
            .map_err(|_| MediaError::invalid("no output was produced"))?;
        let size = metadata.len();
        if !metadata.file_type().is_file() || size == 0 {
            return Err(MediaError::invalid("output is empty"));
        }
        if expect.max_bytes.is_some_and(|max| size > max) {
            return Err(MediaError::OutputLimit);
        }
        if let Some(magic) = expect.magic {
            check_magic(&self.file, magic).await?;
        }
        let mode = std::fs::Permissions::from_mode(ECHO_MEDIA_OUTPUT_FILE_MODE);
        tokio::fs::set_permissions(&self.file, mode)
            .await
            .context("set output mode")?;
        tokio::fs::rename(&self.file, &self.target)
            .await
            .context("publish output")?;
        Ok(size)
    }
}

async fn check_magic(path: &Path, magic: &[u8]) -> Result<()> {
    let mut file = tokio::fs::File::open(path).await.context("open output")?;
    let mut head = vec![0u8; magic.len()];
    if file.read_exact(&mut head).await.is_err() || head != magic {
        return Err(MediaError::invalid("output has an unexpected format"));
    }
    Ok(())
}
