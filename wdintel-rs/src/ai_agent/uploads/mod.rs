//! Documents and images attached to AI chat conversations.
//!
//! See `README.md` in this directory for formats, limits and lifecycle.

pub mod agent_api;
pub mod api;
pub(crate) mod context;
mod extraction;
pub(crate) mod formats;
mod image;
mod store;
pub(crate) use store::item as store_item;
pub mod types;
pub mod worker;

#[cfg(test)]
mod tests;

use crate::config::{
    AI_AGENT_UPLOAD_MAX_PER_CONVERSATION, AI_AGENT_UPLOAD_MAX_PER_REQUEST,
};
use crate::entities::ai_agent_upload;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    sea_query::Expr, ColumnTrait, Condition, DatabaseTransaction, EntityTrait,
    PaginatorTrait, QueryFilter, QuerySelect,
};
use uuid::Uuid;

/// Attaches the composer's draft uploads to a newly created request.
/// Runs inside the request transaction so a failed send leaves drafts intact.
pub(crate) async fn bind_to_request(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    conversation_id: Uuid,
    request_id: Uuid,
    upload_ids: &[String],
) -> Result<(), AppError> {
    if upload_ids.is_empty() {
        return Ok(());
    }
    if upload_ids.len() > AI_AGENT_UPLOAD_MAX_PER_REQUEST {
        return Err(AppError::BL {
            msg: format!(
                "До одного повідомлення можна додати не більше {AI_AGENT_UPLOAD_MAX_PER_REQUEST} файлів"
            ),
        });
    }
    let ids = upload_ids
        .iter()
        .map(|id| super::access::parse_uuid(id))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()
        .c(h!())?;
    store::lock_owner(txn, human_login_id).await.c(h!())?;
    let drafts = ai_agent_upload::Entity::find()
        .filter(ai_agent_upload::Column::Id.is_in(ids.iter().copied()))
        .filter(ai_agent_upload::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_upload::Column::RequestId.is_null())
        .filter(
            Condition::any()
                .add(ai_agent_upload::Column::ConversationId.is_null())
                .add(
                    ai_agent_upload::Column::ConversationId.eq(conversation_id),
                ),
        )
        .lock_exclusive()
        .all(txn)
        .await
        .c(h!())?;
    if drafts.len() != ids.len() {
        return Err(AppError::BL {
            msg: "Деякі файли недоступні або вже надіслані".to_string(),
        });
    }
    let bound = ai_agent_upload::Entity::find()
        .filter(ai_agent_upload::Column::ConversationId.eq(conversation_id))
        .filter(ai_agent_upload::Column::RequestId.is_not_null())
        .count(txn)
        .await
        .c(h!())?;
    if bound + ids.len() as u64 > AI_AGENT_UPLOAD_MAX_PER_CONVERSATION {
        return Err(AppError::BL {
            msg: format!(
                "У розмові може бути не більше {AI_AGENT_UPLOAD_MAX_PER_CONVERSATION} файлів"
            ),
        });
    }
    ai_agent_upload::Entity::update_many()
        .col_expr(
            ai_agent_upload::Column::ConversationId,
            Expr::value(conversation_id),
        )
        .col_expr(ai_agent_upload::Column::RequestId, Expr::value(request_id))
        .col_expr(
            ai_agent_upload::Column::UpdatedAt,
            Expr::value(chrono::Utc::now().naive_utc()),
        )
        .filter(ai_agent_upload::Column::Id.is_in(ids))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}
