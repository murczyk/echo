use super::{super::DeviceAudioRuntime, Claim};
use crate::{h, types::ShortContext};
use std::{path::PathBuf, sync::Arc};

pub(super) struct Materialized {
    pub path: PathBuf,
    _directory: tempfile::TempDir,
}

pub(super) async fn materialize(
    runtime: Arc<DeviceAudioRuntime>,
    claim: &Claim,
) -> anyhow::Result<Materialized> {
    runtime.byte_store().c(h!())?;
    let source = super::query::source(
        runtime.file_database().c(h!())?,
        claim.target,
        false,
    )
    .await
    .c(h!())?
    .ok_or_else(|| anyhow::anyhow!("audio source missing"))
    .c(h!())?;
    anyhow::ensure!(
        super::query::matches_source(&source, claim),
        "audio source changed"
    );
    let permit = runtime
        .asr_materialization_permits
        .clone()
        .acquire_owned()
        .await
        .c(h!())?;
    let bytes = super::super::storage::verified_content_with_permit(
        runtime,
        source.storage_key,
        super::super::storage::SourceFingerprint {
            size_bytes: claim.source.size_bytes.try_into().c(h!())?,
            sha256: claim.source.sha256,
        },
        permit,
    )
    .await
    .c(h!())?;
    let directory = tempfile::tempdir().c(h!())?;
    let extension = if source.mime_type == "audio/mpeg" {
        "mp3"
    } else {
        "wav"
    };
    let path = directory
        .path()
        .join(format!("{}.{}", claim.token.attempt_id, extension));
    tokio::fs::write(&path, bytes).await.c(h!())?;
    Ok(Materialized {
        path,
        _directory: directory,
    })
}
