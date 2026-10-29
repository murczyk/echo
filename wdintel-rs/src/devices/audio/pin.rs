use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use anyhow::{ensure, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::DeviceAudioRuntime;
use crate::devices::upload_finalization::query::JobRecord;
use crate::sigint::file_upload::{lifecycle::UploadLock, tus::TusUpload};
use crate::{h, types::ShortContext};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AudioPin {
    version: u32,
    pub job_id: Uuid,
    pub pin_token: Uuid,
    pub source_identity: String,
    pub actor_id: Uuid,
    pub expected_size: u64,
    directory_device: u64,
    directory_inode: u64,
    source_device: u64,
    source_inode: u64,
}

pub(super) struct LockedSource {
    lock: UploadLock,
    directory: File,
    pins: File,
    name: String,
    marker: AudioPin,
}

pub(crate) fn audio_device(root: &Path) -> Option<Uuid> {
    if root.file_name()? != "file_upload_tus"
        || root.parent()?.parent()?.file_name()? != "device-audio-tus"
    {
        return None;
    }
    let name = root.parent()?.file_name()?.to_str()?;
    Uuid::parse_str(name)
        .ok()
        .filter(|id| id.to_string() == name)
}

pub(crate) fn protects(root: &Path, upload: Uuid) -> Result<bool> {
    if audio_device(root).is_none() {
        return Ok(false);
    }
    if read_marker(root, upload).c(h!())?.is_some() {
        return Ok(true);
    }
    let proof = root.join("locks").join(upload.to_string());
    match std::fs::symlink_metadata(proof) {
        Ok(metadata) => Ok(!metadata.is_file() || metadata.len() != 0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).c(h!()),
    }
}

pub(crate) fn read_marker(
    root: &Path,
    upload: Uuid,
) -> Result<Option<AudioPin>> {
    if audio_device(root).is_none() {
        return Ok(None);
    }
    let path = root.join("pins").join(format!("{upload}.json"));
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None)
        }
        Err(error) => return Err(error).c(h!()),
    };
    Ok(Some(decode_marker(&file).c(h!())?))
}

fn decode_marker(file: &File) -> Result<AudioPin> {
    let metadata = file.metadata().c(h!())?;
    let limit = crate::config::DEVICE_UPLOAD_FINALIZATION_AUDIO_PIN_MAX_BYTES;
    ensure!(
        metadata.is_file() && metadata.len() > 0 && metadata.len() <= limit,
        "invalid audio finalization pin"
    );
    let mut bytes = vec![0; usize::try_from(metadata.len()).c(h!())?];
    file.read_exact_at(&mut bytes, 0).c(h!())?;
    let marker: AudioPin = serde_json::from_slice(&bytes).c(h!())?;
    ensure!(
        marker.version == 1
            && marker.expected_size > 0
            && marker.expected_size <= super::DEVICE_AUDIO_MAX_BYTES,
        "invalid audio finalization pin"
    );
    Ok(marker)
}

fn orphan_proof(
    file: &File,
    pin: Option<&AudioPin>,
) -> Result<Option<AudioPin>> {
    let length = file.metadata().c(h!())?.len();
    if length == 0 {
        return Ok(None);
    }
    match decode_marker(file) {
        Ok(proof) => Ok(Some(proof)),
        Err(error) => {
            let Some(pin) = pin else {
                return Err(error);
            };
            let expected = serde_json::to_vec(pin).c(h!())?;
            ensure!(
                length <= expected.len() as u64,
                "audio orphan proof changed"
            );
            let mut bytes = vec![0; usize::try_from(length).c(h!())?];
            file.read_exact_at(&mut bytes, 0).c(h!())?;
            let written = bytes
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(bytes.len());
            ensure!(
                bytes[..written] == expected[..written]
                    && bytes[written..].iter().all(|byte| *byte == 0),
                "audio orphan proof changed"
            );
            Ok(Some(pin.clone()))
        }
    }
}

impl AudioPin {
    pub(crate) fn matches(&self, job: &JobRecord) -> bool {
        self.job_id == job.id
            && Some(self.pin_token) == job.pin_token
            && self.source_identity == job.source_identity
            && self.actor_id == job.created_by_login_id
            && i64::try_from(self.expected_size).ok()
                == Some(job.source_size_bytes)
    }
}

pub(super) fn source_path(
    runtime: &DeviceAudioRuntime,
    device: Uuid,
    actor: Uuid,
    upload: Uuid,
    size: u64,
) -> PathBuf {
    runtime
        .storage_dir
        .join("device-audio-tus")
        .join(device.to_string())
        .join("file_upload_tus/completed")
        .join(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(actor.as_bytes()),
        )
        .join(format!("{upload}.{size}"))
}

impl LockedSource {
    pub(super) async fn orphan(
        runtime: &DeviceAudioRuntime,
        device: Uuid,
        upload: Uuid,
    ) -> Result<Option<Self>> {
        let root = runtime
            .storage_dir
            .join("device-audio-tus")
            .join(device.to_string())
            .join("file_upload_tus");
        let lock = UploadLock::acquire(&root, upload).await.c(h!())?;
        let root_fd = open_directory(&root).c(h!())?;
        validate_lock(&root_fd, &lock, upload).c(h!())?;
        let pins =
            open_in(&root_fd, "pins", libc::O_RDONLY | libc::O_DIRECTORY)
                .c(h!())?;
        let pin =
            match open_in(&pins, &format!("{upload}.json"), libc::O_RDONLY) {
                Ok(file) => Some(decode_marker(&file).c(h!())?),
                Err(error) if missing(&error) => None,
                Err(error) => return Err(error).c(h!()),
            };
        let proof = orphan_proof(lock.file(), pin.as_ref()).c(h!())?;
        if let (Some(pin), Some(proof)) = (&pin, &proof) {
            ensure!(pin == proof, "audio orphan ownership proof changed");
        }
        let Some(marker) = pin.or(proof) else {
            return Ok(None);
        };
        ensure!(
            marker.source_identity == format!("{device}/{upload}"),
            "audio orphan identity changed"
        );
        let path = source_path(
            runtime,
            device,
            marker.actor_id,
            upload,
            marker.expected_size,
        );
        let directory = open_directory(path.parent().c(h!())?).c(h!())?;
        let metadata = directory.metadata().c(h!())?;
        ensure!(
            metadata.dev() == marker.directory_device
                && metadata.ino() == marker.directory_inode,
            "audio orphan directory changed"
        );
        let source = Self {
            lock,
            directory,
            pins,
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .c(h!())?
                .to_owned(),
            marker,
        };
        Ok(Some(source))
    }

    pub(super) fn accept(
        source: &TusUpload,
        lock: UploadLock,
        device: Uuid,
        actor: Uuid,
    ) -> Result<Self> {
        let parent = source.file_path.parent().c(h!())?;
        let root = parent.parent().and_then(Path::parent).c(h!())?;
        let root_fd = open_directory(root).c(h!())?;
        validate_lock(&root_fd, &lock, source.file_id).c(h!())?;
        let directory = open_directory(parent).c(h!())?;
        let name = source
            .file_path
            .file_name()
            .and_then(|name| name.to_str())
            .c(h!())?
            .to_owned();
        let file = open_in(&directory, &name, libc::O_RDONLY).c(h!())?;
        let metadata = file.metadata().c(h!())?;
        ensure!(
            metadata.is_file() && metadata.len() == source.upload_length,
            "audio source changed before acceptance"
        );
        file.sync_all().c(h!())?;
        directory.sync_all().c(h!())?;
        open_directory(parent.parent().c(h!())?)
            .c(h!())?
            .sync_all()
            .c(h!())?;
        std::fs::create_dir_all(root.join("pins")).c(h!())?;
        let pins =
            open_in(&root_fd, "pins", libc::O_RDONLY | libc::O_DIRECTORY)
                .c(h!())?;
        let parent_metadata = directory.metadata().c(h!())?;
        let marker = AudioPin {
            version: 1,
            job_id: Uuid::now_v7(),
            pin_token: Uuid::new_v4(),
            source_identity: format!("{device}/{}", source.file_id),
            actor_id: actor,
            expected_size: source.upload_length,
            directory_device: parent_metadata.dev(),
            directory_inode: parent_metadata.ino(),
            source_device: metadata.dev(),
            source_inode: metadata.ino(),
        };
        let accepted = Self {
            lock,
            directory,
            pins,
            name,
            marker,
        };
        accepted.persist(source.file_id).c(h!())?;
        open_in(&root_fd, "locks", libc::O_RDONLY | libc::O_DIRECTORY)
            .c(h!())?
            .sync_all()
            .c(h!())?;
        for parent in root.ancestors().take(4) {
            open_directory(parent).c(h!())?.sync_all().c(h!())?;
        }
        Ok(accepted)
    }

    fn persist(&self, upload: Uuid) -> Result<()> {
        let bytes = serde_json::to_vec(&self.marker).c(h!())?;
        let temporary = format!(".{upload}.{}.tmp", self.marker.pin_token);
        let mut file = open_in(
            &self.pins,
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .c(h!())?;
        file.write_all(&bytes).c(h!())?;
        file.sync_all().c(h!())?;
        let from = std::ffi::CString::new(temporary).c(h!())?;
        let to = std::ffi::CString::new(format!("{upload}.json")).c(h!())?;
        // Both names are server-generated and relative to the held pin directory.
        let result = unsafe {
            libc::renameat(
                self.pins.as_raw_fd(),
                from.as_ptr(),
                self.pins.as_raw_fd(),
                to.as_ptr(),
            )
        };
        ensure!(result == 0, std::io::Error::last_os_error());
        self.pins.sync_all().c(h!())?;
        self.lock.file().set_len(bytes.len() as u64).c(h!())?;
        self.lock.file().write_all_at(&bytes, 0).c(h!())?;
        self.lock.file().sync_all().c(h!())
    }

    pub(super) fn marker(&self) -> &AudioPin {
        &self.marker
    }

    pub(super) fn release_unaccepted(&self) -> Result<()> {
        let upload = self.marker.source_identity.split_once('/').c(h!())?.1;
        unlink_in(&self.pins, &format!("{upload}.json")).c(h!())?;
        self.pins.sync_all().c(h!())?;
        self.lock.file().set_len(0).c(h!())?;
        self.lock.file().sync_all().c(h!())
    }

    pub(super) async fn recover(
        runtime: &DeviceAudioRuntime,
        job: &JobRecord,
    ) -> Result<Self> {
        let upload = job
            .source_identity
            .split_once('/')
            .c(h!())?
            .1
            .parse::<Uuid>()
            .c(h!())?;
        let path = source_path(
            runtime,
            job.device_id,
            job.created_by_login_id,
            upload,
            u64::try_from(job.source_size_bytes).c(h!())?,
        );
        ensure!(
            path.strip_prefix(&runtime.storage_dir).c(h!())?.to_str()
                == job.source_locator.as_deref(),
            "audio finalization source locator mismatch"
        );
        let parent = path.parent().c(h!())?;
        let root = parent.parent().and_then(Path::parent).c(h!())?;
        let lock = UploadLock::acquire(root, upload).await.c(h!())?;
        let root_fd = open_directory(root).c(h!())?;
        validate_lock(&root_fd, &lock, upload).c(h!())?;
        let marker = decode_marker(lock.file()).c(h!())?;
        ensure!(marker.matches(job), "audio finalization ownership mismatch");
        let directory = open_directory(parent).c(h!())?;
        let metadata = directory.metadata().c(h!())?;
        ensure!(
            metadata.dev() == marker.directory_device
                && metadata.ino() == marker.directory_inode,
            "audio source directory changed"
        );
        let pins =
            open_in(&root_fd, "pins", libc::O_RDONLY | libc::O_DIRECTORY)
                .c(h!())?;
        let accepted = Self {
            lock,
            directory,
            pins,
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .c(h!())?
                .to_owned(),
            marker,
        };
        let pin = accepted.read_pin(upload).c(h!())?;
        if let Some(pin) = pin {
            ensure!(pin == accepted.marker, "audio finalization pin changed");
        } else {
            ensure!(matches!(job.status,
                crate::devices::upload_finalization::types::FinalizationStatus::FinalizationCompleted
                | crate::devices::upload_finalization::types::FinalizationStatus::FinalizationFailed)
                && accepted.open_source().c(h!())?.is_none(), "audio finalization pin missing");
        }
        Ok(accepted)
    }

    fn read_pin(&self, upload: Uuid) -> Result<Option<AudioPin>> {
        match open_in(&self.pins, &format!("{upload}.json"), libc::O_RDONLY) {
            Ok(file) => Ok(Some(decode_marker(&file).c(h!())?)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(error).c(h!()),
        }
    }

    pub(super) fn open_source(&self) -> Result<Option<File>> {
        let file = match open_in(&self.directory, &self.name, libc::O_RDONLY) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error).c(h!()),
        };
        let metadata = file.metadata().c(h!())?;
        ensure!(
            metadata.is_file()
                && metadata.dev() == self.marker.source_device
                && metadata.ino() == self.marker.source_inode
                && metadata.len() == self.marker.expected_size,
            "audio accepted source changed"
        );
        Ok(Some(file))
    }

    pub(super) fn remove_source(&self) -> Result<()> {
        let _source = self.open_source().c(h!())?;
        self.retain_directory().c(h!())?;
        unlink_in(&self.directory, &self.name).c(h!())?;
        unlink_in(&self.directory, &format!("{}.json", self.name)).c(h!())?;
        self.directory.sync_all().c(h!())?;
        let upload = self.marker.source_identity.split_once('/').c(h!())?.1;
        unlink_in(&self.pins, &format!("{upload}.json")).c(h!())?;
        self.pins.sync_all().c(h!())
    }

    pub(super) fn clear_released_proof(&self) -> Result<()> {
        let upload = self.marker.source_identity.split_once('/').c(h!())?.1;
        ensure!(
            self.open_source().c(h!())?.is_none()
                && self.read_pin(upload.parse().c(h!())?).c(h!())?.is_none(),
            "released audio source or pin still exists"
        );
        self.lock.file().set_len(0).c(h!())?;
        self.lock.file().sync_all().c(h!())
    }

    fn retain_directory(&self) -> Result<()> {
        // Cleanup recovery needs this inode even after the last source is gone.
        let anchor = open_in(
            &self.directory,
            crate::config::DEVICE_UPLOAD_FINALIZATION_AUDIO_DIRECTORY_ANCHOR,
            libc::O_WRONLY | libc::O_CREAT,
        )
        .c(h!())?;
        ensure!(
            anchor.metadata().c(h!())?.is_file(),
            "invalid audio directory anchor"
        );
        anchor.sync_all().c(h!())?;
        self.directory.sync_all().c(h!())
    }
}

fn open_directory(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .c(h!())
}

fn validate_lock(root: &File, lock: &UploadLock, upload: Uuid) -> Result<()> {
    let directory =
        open_in(root, "locks", libc::O_RDONLY | libc::O_DIRECTORY).c(h!())?;
    let named = open_in(&directory, &upload.to_string(), libc::O_RDONLY)
        .c(h!())?
        .metadata()
        .c(h!())?;
    let held = lock.file().metadata().c(h!())?;
    ensure!(
        named.dev() == held.dev() && named.ino() == held.ino(),
        "audio upload lock directory changed"
    );
    Ok(())
}

fn open_in(directory: &File, name: &str, flags: i32) -> Result<File> {
    let name = std::ffi::CString::new(name).c(h!())?;
    // openat returns a newly owned descriptor; the held directory anchors renames.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600,
        )
    };
    ensure!(descriptor >= 0, std::io::Error::last_os_error());
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn unlink_in(directory: &File, name: &str) -> Result<()> {
    let name = std::ffi::CString::new(name).c(h!())?;
    // Unlink only this basename in the directory retained by the upload owner.
    let result =
        unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error).c(h!());
        }
    }
    Ok(())
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
