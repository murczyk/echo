//! Shared persistence helpers for conversation uploads.

use super::{formats, types::AiAgentUploadItem};
use crate::entities::ai_agent_upload;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
use uuid::Uuid;

pub(crate) fn item(upload: &ai_agent_upload::Model) -> AiAgentUploadItem {
    AiAgentUploadItem {
        id: upload.id.to_string(),
        conversation_id: upload.conversation_id.map(|id| id.to_string()),
        request_id: upload.request_id.map(|id| id.to_string()),
        file_name: upload.file_name.clone(),
        content_type: upload.content_type.clone(),
        size_bytes: upload.size_bytes,
        state: upload.state.clone(),
        is_image: formats::is_image(&upload.extension),
        chunk_count: upload.chunk_count,
        last_error: upload.last_error.clone(),
        created_at: upload.created_at.and_utc().timestamp_millis(),
    }
}

pub(crate) async fn owned<C: ConnectionTrait>(
    db: &C,
    human_login_id: Uuid,
    id: Uuid,
) -> Result<ai_agent_upload::Model, AppError> {
    ai_agent_upload::Entity::find_by_id(id)
        .filter(ai_agent_upload::Column::HumanLoginId.eq(human_login_id))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Serializes capacity checks for one owner's uploads (creation and binding).
pub(crate) async fn lock_owner(
    txn: &sea_orm::DatabaseTransaction,
    human_login_id: Uuid,
) -> anyhow::Result<()> {
    txn.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtext($1))",
        [format!("ai_agent_upload:{human_login_id}").into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

/// Removes the stored original and preview. Chunks cascade with the row.
pub(crate) async fn delete_objects(env: &Env, upload: &ai_agent_upload::Model) {
    for key in std::iter::once(&upload.storage_key).chain(&upload.preview_key) {
        crate::sigint::unit::attachment::delete_stored_asset_best_effort(
            env, key,
        )
        .await;
    }
}

/// Deletes a draft only if it is still unsent at deletion time, so a
/// concurrent send cannot lose an accepted attachment.
pub(crate) async fn delete_draft(
    env: &Env,
    upload: &ai_agent_upload::Model,
) -> anyhow::Result<bool> {
    let deleted = ai_agent_upload::Entity::delete_many()
        .filter(ai_agent_upload::Column::Id.eq(upload.id))
        .filter(ai_agent_upload::Column::RequestId.is_null())
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if deleted.rows_affected == 0 {
        return Ok(false);
    }
    delete_objects(env, upload).await;
    Ok(true)
}
