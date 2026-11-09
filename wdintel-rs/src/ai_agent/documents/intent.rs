//! Whether a new request builds a document. A Fast or Balanced request that
//! does gets the document tier's time budget (`reasoning::resolve`): filling
//! a template needs an outline, several Echo searches and a script run.

use crate::entities::{ai_agent_document, ai_agent_upload};
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
};
use uuid::Uuid;

const TEMPLATE_EXTENSION: &str = "docx";
/// Lower-case word stems of a request about a document or report.
const DOCUMENT_WORDS: &[&str] = &[
    "звіт",
    "документ",
    "шаблон",
    "зразк",
    "зразок",
    "аналогічн",
    "docx",
    "word",
    "ворд",
    "файл",
];

pub(crate) fn mentions_document(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    DOCUMENT_WORDS.iter().any(|word| prompt.contains(word))
}

/// True when the user has a document open, attaches a .docx to this message,
/// or asks about a document in a conversation that already has a .docx
/// upload or a generated document.
pub(crate) async fn is_document_request(
    db: &impl ConnectionTrait,
    human_login_id: Uuid,
    conversation_id: Option<Uuid>,
    prompt: &str,
    upload_ids: &[String],
    has_document_target: bool,
) -> anyhow::Result<bool> {
    if has_document_target {
        return Ok(true);
    }
    let current: Vec<Uuid> = upload_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();
    let docx_uploads = || {
        ai_agent_upload::Entity::find()
            .filter(ai_agent_upload::Column::HumanLoginId.eq(human_login_id))
            .filter(ai_agent_upload::Column::Extension.eq(TEMPLATE_EXTENSION))
    };
    if !current.is_empty()
        && docx_uploads()
            .filter(ai_agent_upload::Column::Id.is_in(current))
            .count(db)
            .await
            .c(h!())?
            > 0
    {
        return Ok(true);
    }
    let Some(conversation_id) = conversation_id else {
        return Ok(false);
    };
    if !mentions_document(prompt) {
        return Ok(false);
    }
    let earlier_template = docx_uploads()
        .filter(ai_agent_upload::Column::ConversationId.eq(conversation_id))
        .count(db)
        .await
        .c(h!())?
        > 0;
    Ok(earlier_template
        || ai_agent_document::Entity::find()
            .filter(
                ai_agent_document::Column::ConversationId.eq(conversation_id),
            )
            .count(db)
            .await
            .c(h!())?
            > 0)
}
