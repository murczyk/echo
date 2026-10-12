use super::source::Info;
use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Result};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub(super) struct Entry {
    pub root: PathBuf,
    id: String,
}

pub(super) struct Lock(std::fs::File);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(super) struct Temporary(pub PathBuf);

pub(super) struct TemporaryDirectory(pub PathBuf);

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Entry {
    #[cfg(test)]
    pub fn for_test(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            id: "0123456789abcdef".to_string(),
        }
    }

    pub fn new(env: &Env, media: &signal_message_media::Model) -> Result<Self> {
        let storage = env.config.s3_config.as_ref().c(h!())?;
        let identity = serde_json::to_vec(&(
            &storage.s3_endpoint,
            &storage.s3_bucket,
            crate::messenger::media::media_object_key(media),
            media.size_bytes,
            media.is_encrypted,
        ))
        .c(h!())?;
        Ok(Self {
            root: crate::messenger::media_cache::media_cache_dir(&env.config)
                .join(MESSENGER_MEDIA_PREVIEW_DIR_NAME),
            id: format!("{:x}", Sha256::digest(identity)),
        })
    }

    pub fn path(&self, suffix: &str) -> PathBuf {
        self.root.join(format!("{}.{suffix}", self.id))
    }

    pub async fn ensure_root(&self) -> Result<()> {
        let mut directory = fs::DirBuilder::new();
        directory
            .recursive(true)
            .mode(MESSENGER_MEDIA_CACHE_DIR_MODE);
        directory.create(&self.root).await.c(h!())
    }

    pub async fn read_info(&self) -> Result<Option<Info>> {
        let data = match fs::read(self.path("json")).await {
            Ok(data) => data,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => return Err(error).c(h!()),
        };
        Ok(Some(serde_json::from_slice(&data).c(h!())?))
    }

    pub async fn write_info(&self, info: &Info) -> Result<()> {
        self.ensure_root().await.c(h!())?;
        let temporary =
            Temporary(self.path(&format!("{}.tmp", uuid::Uuid::new_v4())));
        let mut file = create_private_file(&temporary.0).await.c(h!())?;
        file.write_all(&serde_json::to_vec(info).c(h!())?)
            .await
            .c(h!())?;
        file.flush().await.c(h!())?;
        fs::rename(&temporary.0, self.path("json")).await.c(h!())
    }

    pub async fn lock(&self, index: u32) -> Result<Option<Lock>> {
        self.ensure_root().await.c(h!())?;
        let shard = (u32::from_str_radix(&self.id[..8], 16).c(h!())? ^ index)
            % MESSENGER_MEDIA_PREVIEW_LOCK_SHARDS;
        try_lock(&self.root.join(format!("entry-{shard}.lock"))).await
    }

    pub async fn cached_segment(
        &self,
        index: u32,
    ) -> Result<Option<actix_files::NamedFile>> {
        match actix_files::NamedFile::open_async(
            self.path(&format!("{index}.ts")),
        )
        .await
        {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).c(h!()),
        }
    }

    pub async fn slot(&self) -> Result<Option<Lock>> {
        self.ensure_root().await.c(h!())?;
        for index in 0..MESSENGER_MEDIA_PREVIEW_CONCURRENCY {
            if let Some(lock) =
                try_lock(&self.root.join(format!("slot-{index}.lock")))
                    .await
                    .c(h!())?
            {
                return Ok(Some(lock));
            }
        }
        Ok(None)
    }

    pub async fn prepare_space(&self, min_free: u64) -> Result<()> {
        let headroom = MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES
            * MESSENGER_MEDIA_PREVIEW_WINDOW_SEGMENTS as u64
            * MESSENGER_MEDIA_PREVIEW_CONCURRENCY as u64;
        let min_free = min_free.saturating_add(headroom);
        let Some(_lock) =
            try_lock(&self.root.join("cleanup.lock")).await.c(h!())?
        else {
            return Err(super::Busy.into());
        };
        let mut files = self.cache_files().await.c(h!())?;
        files.sort_unstable();
        let mut size: u64 = files.iter().map(|(_, size, _)| size).sum();
        for (modified, length, path) in files {
            let expired = modified.elapsed().unwrap_or_default().as_secs()
                > MESSENGER_MEDIA_PREVIEW_CACHE_TTL_SECS;
            if !expired
                && size.saturating_add(headroom)
                    <= MESSENGER_MEDIA_PREVIEW_CACHE_MAX_BYTES
                && fs2::available_space(&self.root).c(h!())? >= min_free
            {
                break;
            }
            match fs::remove_file(path).await {
                Ok(()) => size = size.saturating_sub(length),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).c(h!()),
            }
        }
        if fs2::available_space(&self.root).c(h!())? < min_free {
            bail!("video preview storage free-space floor reached")
        }
        Ok(())
    }

    async fn cache_files(
        &self,
    ) -> Result<Vec<(std::time::SystemTime, u64, PathBuf)>> {
        let mut entries = fs::read_dir(&self.root).await.c(h!())?;
        let mut files = Vec::new();
        while let Some(entry) = entries.next_entry().await.c(h!())? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.ends_with(".work")
                || name.ends_with(".ts")
                || name.ends_with(".json")
                || name.ends_with(".tmp"))
            {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error).c(h!()),
            };
            if name.ends_with(".work") {
                if metadata
                    .modified()
                    .c(h!())?
                    .elapsed()
                    .unwrap_or_default()
                    .as_secs()
                    > MESSENGER_MEDIA_PREVIEW_CACHE_TTL_SECS
                {
                    match fs::remove_dir_all(entry.path()).await {
                        Ok(()) => {}
                        Err(error) if error.kind() == ErrorKind::NotFound => {}
                        Err(error) => return Err(error).c(h!()),
                    }
                }
                continue;
            }
            if name.ends_with(".tmp")
                && metadata
                    .modified()
                    .c(h!())?
                    .elapsed()
                    .unwrap_or_default()
                    .as_secs()
                    < MESSENGER_MEDIA_PREVIEW_CACHE_TTL_SECS
            {
                continue;
            }
            files.push((
                metadata.modified().c(h!())?,
                metadata.len(),
                entry.path(),
            ));
        }
        Ok(files)
    }
}

pub(super) async fn try_lock(path: &Path) -> Result<Option<Lock>> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .c(h!())?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(Lock(file))),
            Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error).c(h!()),
        }
    })
    .await
    .c(h!())?
    .c(h!())
}

pub(super) async fn create_private_file(path: &Path) -> Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
        .c(h!())
}
