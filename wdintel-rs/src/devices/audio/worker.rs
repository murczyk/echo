use super::*;
use crate::file_registry::entities::device_audio_ingest;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, QuerySelect, Set, TransactionTrait,
};

#[derive(Default)]
pub(super) struct CleanupHooks {
    #[cfg(test)]
    pub after_claim: Option<
        Arc<
            dyn Fn() -> futures_util::future::BoxFuture<
                    'static,
                    anyhow::Result<()>,
                > + Send
                + Sync,
        >,
    >,
}

pub(super) async fn run_cleanup_nofail(
    runtime: Arc<DeviceAudioRuntime>,
    cancellation: tokio_util::sync::CancellationToken,
) {
    loop {
        if let Err(error) = cleanup_once(&runtime).await {
            log::warn!("device audio cleanup iteration failed: {error:#}");
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(DEVICE_AUDIO_CLEANUP_INTERVAL) => {}
        }
    }
}

pub(super) async fn cleanup_once(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    cleanup_with_hooks(runtime, &CleanupHooks::default())
        .await
        .c(h!())
}

pub(super) async fn cleanup_with_hooks(
    runtime: &DeviceAudioRuntime,
    hooks: &CleanupHooks,
) -> anyhow::Result<()> {
    runtime.file_database().c(h!())?;
    content::cleanup_cache(runtime).await.c(h!())?;
    cleanup_namespaces(runtime).await.c(h!())?;
    let candidates = cleanup_candidates(runtime).await.c(h!())?;
    let mut first_error = None;
    for attempt in candidates {
        let id = attempt.id;
        match cleanup_attempt(runtime, &attempt, hooks).await {
            Ok(outcome) => {
                record_outcome(runtime, outcome);
                log::info!(
                    "device audio cleanup: ingest_id={id}, outcome={outcome}"
                );
            }
            Err(error) => {
                record_outcome(runtime, "failed");
                log::warn!("device audio cleanup failed: ingest_id={id}, error={error:#}");
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn record_outcome(runtime: &DeviceAudioRuntime, outcome: &'static str) {
    if let Some(metrics) = &runtime.metrics {
        metrics.record_device_audio_cleanup(outcome);
    }
}

async fn cleanup_namespaces(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    let mut scan = runtime.namespace_scan.lock().await;
    if scan.is_none() {
        *scan = match tokio::fs::read_dir(
            runtime.storage_dir.join("device-audio-tus"),
        )
        .await
        {
            Ok(scan) => Some(scan),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(())
            }
            Err(error) => return Err(error).c(h!()),
        };
    }
    for _ in 0..DEVICE_AUDIO_CLEANUP_BATCH {
        let Some(entry) = scan.as_mut().c(h!())?.next_entry().await.c(h!())?
        else {
            *scan = None;
            break;
        };
        if !entry.file_type().await.c(h!())?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(device_id) = Uuid::parse_str(name) else {
            continue;
        };
        if device_id.to_string() != name {
            continue;
        }
        upload::handler(runtime, device_id)
            .c(h!())?
            .cleanup_expired()
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn cleanup_candidates(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<Vec<device_audio_ingest::Model>> {
    use device_audio_ingest::{Column as C, Entity as E};
    let db = runtime.file_database().c(h!())?;
    let now = Utc::now();
    let cutoff = now
        - chrono::Duration::from_std(DEVICE_AUDIO_ABANDONED_HEARTBEAT)
            .c(h!())?;
    let limit = DEVICE_AUDIO_CLEANUP_BATCH / 3;
    let mut candidates = E::find()
        .filter(C::Status.eq("ready"))
        .filter(C::SourceConsumedAt.is_null())
        .order_by_asc(C::CreatedAt)
        .order_by_asc(C::Id)
        .limit(DEVICE_AUDIO_CLEANUP_BATCH - limit * 2)
        .all(db)
        .await
        .c(h!())?;
    candidates.extend(
        E::find()
            .filter(C::Status.is_in(["finalizing", "storing"]))
            .filter(C::HeartbeatAt.lte(cutoff))
            .order_by_asc(C::HeartbeatAt)
            .order_by_asc(C::Id)
            .limit(limit)
            .all(db)
            .await
            .c(h!())?,
    );
    candidates.extend(
        E::find()
            .filter(C::Status.eq("deleting"))
            .filter(C::NextCleanupAt.lte(now))
            .order_by_asc(C::NextCleanupAt)
            .order_by_asc(C::Id)
            .limit(limit)
            .all(db)
            .await
            .c(h!())?,
    );
    Ok(candidates)
}

fn busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<AppError>(),
            Some(AppError::ServiceUnavailable { .. })
        )
    })
}

async fn cleanup_source(
    runtime: &DeviceAudioRuntime,
    candidate: &device_audio_ingest::Model,
) -> anyhow::Result<
    Option<(
        crate::sigint::file_upload::tus::TusUpload,
        impl Send + Sync + 'static,
    )>,
> {
    let handler = upload::handler(runtime, candidate.device_id).c(h!())?;
    let Some(source) = handler
        .open_completed_url(&candidate.tus_owner_id, &candidate.tus_upload_ref)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let guard =
        crate::sigint::file_upload::lock_uploaded_source(&source.file_path)
            .await
            .c(h!())?
            .ok_or_else(|| anyhow::anyhow!("invalid audio source path"))
            .c(h!())?;
    Ok(Some((source, guard)))
}

async fn cleanup_attempt(
    runtime: &DeviceAudioRuntime,
    candidate: &device_audio_ingest::Model,
    hooks: &CleanupHooks,
) -> anyhow::Result<&'static str> {
    let source = match cleanup_source(runtime, candidate).await {
        Ok(source) => source,
        Err(error) if busy(&error) => return Ok("deferred"),
        Err(error) => return Err(error).c(h!()),
    };
    let claim = if candidate.status == "ready" {
        if !query::confirmed_terminal(runtime, candidate.id)
            .await
            .c(h!())?
        {
            return Ok("deferred");
        }
        None
    } else {
        let Some(claim) = remove_abandoned(runtime, candidate.id, hooks)
            .await
            .c(h!())?
        else {
            return Ok("deferred");
        };
        Some(claim)
    };
    if let Some((source, guard)) = source {
        drop(guard);
        ingest::consume_source(runtime, candidate.id, &source.file_path)
            .await
            .c(h!())?;
    } else {
        query::record_consumed(runtime, candidate.id)
            .await
            .c(h!())?;
    }
    if let Some(claim) = claim {
        schedule_rescan(runtime, &claim).await.c(h!())?;
        Ok("object_deleted")
    } else {
        Ok("source_consumed")
    }
}

async fn remove_abandoned(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
    hooks: &CleanupHooks,
) -> anyhow::Result<Option<device_audio_ingest::Model>> {
    let store = runtime.byte_store().c(h!())?;
    let Some(claim) = claim_deleting(runtime, id).await.c(h!())? else {
        return Ok(None);
    };
    hooks.after_claim().await;
    if !confirm_claim(runtime, &claim).await.c(h!())? {
        return Ok(None);
    }
    if !crate::transcription::service::may_delete(
        &runtime.dbx,
        &claim.storage_key,
    )
    .await
    {
        return Ok(None);
    }
    store.operator.delete(&claim.storage_key).await.c(h!())?;
    Ok(Some(claim))
}

impl CleanupHooks {
    async fn after_claim(&self) {
        #[cfg(test)]
        if let Some(hook) = &self.after_claim {
            if let Err(error) = hook().await {
                log::warn!(
                    "device audio cleanup claim response unknown: {error:#}"
                );
            }
        }
    }
}

async fn claim_deleting(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
) -> anyhow::Result<Option<device_audio_ingest::Model>> {
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let attempt = query::locked_attempt(&transaction, id).await.c(h!())?;
    if query::own_ready(&transaction, &attempt)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(None);
    }
    let now = Utc::now();
    let eligible = match attempt.status.as_str() {
        "finalizing" | "storing" => {
            attempt.heartbeat_at
                <= now
                    - chrono::Duration::from_std(
                        DEVICE_AUDIO_ABANDONED_HEARTBEAT,
                    )
                    .c(h!())?
        }
        "deleting" => attempt.next_cleanup_at.is_some_and(|due| due <= now),
        _ => false,
    };
    if !eligible {
        return Ok(None);
    }
    let mut attempt = attempt.into_active_model();
    attempt.status = Set("deleting".into());
    attempt.cleanup_token = Set(Some(Uuid::new_v4()));
    attempt.next_cleanup_at = Set(Some(
        (now + chrono::Duration::from_std(DEVICE_AUDIO_CLEANUP_INTERVAL)
            .c(h!())?)
        .fixed_offset(),
    ));
    let attempt = attempt.update(&transaction).await.c(h!())?;
    if let Err(error) = transaction.commit().await {
        log::warn!("device audio cleanup claim acknowledgment unknown: ingest_id={id}, error={error:#}");
    }
    Ok(Some(attempt))
}

async fn confirm_claim(
    runtime: &DeviceAudioRuntime,
    claim: &device_audio_ingest::Model,
) -> anyhow::Result<bool> {
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let attempt = query::locked_attempt(&transaction, claim.id)
        .await
        .c(h!())?;
    if query::own_ready(&transaction, &attempt)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(false);
    }
    let confirmed = attempt.status == "deleting"
        && attempt.cleanup_token == claim.cleanup_token;
    transaction.commit().await.c(h!())?;
    Ok(confirmed)
}

async fn schedule_rescan(
    runtime: &DeviceAudioRuntime,
    claim: &device_audio_ingest::Model,
) -> anyhow::Result<()> {
    let next = Utc::now()
        + chrono::Duration::from_std(DEVICE_AUDIO_TOMBSTONE_RESCAN).c(h!())?;
    let token = claim
        .cleanup_token
        .ok_or_else(|| anyhow::anyhow!("missing cleanup fence"))
        .c(h!())?;
    device_audio_ingest::Entity::update_many()
        .col_expr(
            device_audio_ingest::Column::NextCleanupAt,
            next.fixed_offset().into(),
        )
        .filter(device_audio_ingest::Column::Id.eq(claim.id))
        .filter(device_audio_ingest::Column::Status.eq("deleting"))
        .filter(device_audio_ingest::Column::CleanupToken.eq(token))
        .exec(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    Ok(())
}
