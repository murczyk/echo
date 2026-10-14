use super::*;
use sha2::{Digest, Sha256};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Clone, Copy, Debug)]
pub(super) struct SourceFingerprint {
    pub size_bytes: u64,
    pub sha256: [u8; 32],
}

pub(super) struct PreparedSource {
    pub fingerprint: SourceFingerprint,
    pub bytes: actix_web::web::Bytes,
    pub admission: Arc<OwnedSemaphorePermit>,
}

pub(super) async fn prepare_source(
    path: PathBuf,
    size: u64,
    admission: Arc<OwnedSemaphorePermit>,
) -> anyhow::Result<PreparedSource> {
    validate_size(size).c(h!())?;
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let file = std::fs::File::open(path).c(h!())?;
        let mut bytes = Vec::with_capacity(usize::try_from(size).c(h!())?);
        file.take(size + 1).read_to_end(&mut bytes).c(h!())?;
        if bytes.len() as u64 != size {
            return Err(DeviceAudioMediaError::InvalidAudio {
                reason: "source length changed after upload completion"
                    .to_string(),
            }
            .into());
        }
        Ok(PreparedSource {
            fingerprint: SourceFingerprint {
                size_bytes: size,
                sha256: Sha256::digest(&bytes).into(),
            },
            bytes: bytes.into(),
            admission,
        })
    })
    .await
    .c(h!())?
}

pub(super) async fn store_and_verify(
    runtime: Arc<DeviceAudioRuntime>,
    key: String,
    source: PreparedSource,
) -> anyhow::Result<()> {
    validate_size(source.fingerprint.size_bytes).c(h!())?;
    runtime.byte_store().c(h!())?;
    tokio::spawn(async move {
        let store = runtime.byte_store().c(h!())?;
        let PreparedSource {
            bytes,
            fingerprint,
            admission,
        } = source;
        let _admission = admission;
        crate::storage::upload_encrypted_to_s3_with_operator(
            &Some(store.operator.clone()),
            &store.config,
            &store.strongbox_key,
            &key,
            bytes,
        )
        .await
        .c(h!())?;
        let permit = runtime
            .decrypt_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| unavailable("audio decryption is unavailable"))
            .c(h!())?;
        verified_content_with_permit(runtime, key, fingerprint, permit)
            .await
            .c(h!())?;
        Ok(())
    })
    .await
    .c(h!())?
}

pub(super) async fn verified_content(
    runtime: Arc<DeviceAudioRuntime>,
    key: String,
    expected: SourceFingerprint,
) -> anyhow::Result<Vec<u8>> {
    validate_size(expected.size_bytes).c(h!())?;
    runtime.byte_store().c(h!())?;
    let permit = runtime
        .playback_decrypt_permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| unavailable("audio decryption is busy"))
        .c(h!())?;
    verified_content_with_permit(runtime, key, expected, permit)
        .await
        .c(h!())
}

pub(super) async fn verified_content_with_permit(
    runtime: Arc<DeviceAudioRuntime>,
    key: String,
    expected: SourceFingerprint,
    permit: OwnedSemaphorePermit,
) -> anyhow::Result<Vec<u8>> {
    tokio::spawn(async move {
        let store = runtime.byte_store().c(h!())?;
        let permit = Arc::new(permit);
        let plaintext = crate::storage::download_and_decrypt_with_admission(
            &store.operator,
            &store.config,
            &store.strongbox_key,
            &key,
            DEVICE_AUDIO_DOWNLOAD_TIMEOUT,
            DEVICE_AUDIO_MAX_CIPHERTEXT_BYTES,
            permit.clone(),
        )
        .await
        .c(h!())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let sha256: [u8; 32] = Sha256::digest(&plaintext).into();
            if plaintext.len() as u64 != expected.size_bytes
                || sha256 != expected.sha256
            {
                anyhow::bail!(
                    "authenticated audio does not match the original source"
                );
            }
            Ok(plaintext)
        })
        .await
        .c(h!())?
    })
    .await
    .c(h!())?
}

fn validate_size(size: u64) -> anyhow::Result<()> {
    if size == 0 || size > DEVICE_AUDIO_MAX_BYTES {
        return Err(DeviceAudioMediaError::InvalidAudio {
            reason: "source must contain between 1 byte and 100 MiB"
                .to_string(),
        }
        .into());
    }
    Ok(())
}
