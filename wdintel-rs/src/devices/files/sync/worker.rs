use super::{
    DEVICE_FILE_SYNC_SESSION_EXPIRY_BATCH_SIZE,
    DEVICE_FILE_SYNC_SESSION_EXPIRY_POLL_SECS,
};
use crate::file_registry::entities::{
    file_sync_session,
    sea_orm_active_enums::{FileSyncSessionMode, FileSyncSessionStatus},
};
use crate::types::Env;
use anyhow::Context;
use chrono::Utc;
use sea_orm::sea_query::{LockBehavior, LockType};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) async fn run_nofail(
    env: Arc<Env>,
    cancellation_token: CancellationToken,
) {
    log::info!("device_file_sync_session_expiry_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            break;
        }
        let sleep = match run_tick(env.as_ref()).await {
            Ok(true) => continue,
            Ok(false) => std::time::Duration::from_secs(
                DEVICE_FILE_SYNC_SESSION_EXPIRY_POLL_SECS,
            ),
            Err(error) => {
                log::error!(
                    "device_file_sync_session_expiry_worker failed: {error:#}"
                );
                std::time::Duration::from_secs(
                    DEVICE_FILE_SYNC_SESSION_EXPIRY_POLL_SECS,
                )
            }
        };
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(sleep) => {}
        }
    }
}

pub(in crate::devices) async fn run_tick(env: &Env) -> anyhow::Result<bool> {
    let file_db = env
        .file_registry_db()
        .context("file registry database is unavailable")?
        .connection();
    let transaction = file_db.begin().await.context("begin expiry tick")?;
    let sessions = file_sync_session::Entity::find()
        .filter(
            file_sync_session::Column::Mode.eq(FileSyncSessionMode::Explicit),
        )
        .filter(
            file_sync_session::Column::Status.eq(FileSyncSessionStatus::Open),
        )
        .filter(file_sync_session::Column::ExpiresAt.lte(Utc::now()))
        .order_by_asc(file_sync_session::Column::ExpiresAt)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .limit(DEVICE_FILE_SYNC_SESSION_EXPIRY_BATCH_SIZE)
        .all(&transaction)
        .await
        .context("claim expired file sync sessions")?;
    let expired = !sessions.is_empty();
    for session in sessions {
        let mut session = session.into_active_model();
        session.status = Set(FileSyncSessionStatus::Expired);
        session.updated_at = Set(Utc::now().fixed_offset());
        session
            .update(&transaction)
            .await
            .context("expire file sync session")?;
    }
    transaction.commit().await.context("commit expiry tick")?;
    Ok(expired)
}
