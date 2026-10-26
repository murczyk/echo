use super::inference::Decision;
use crate::{
    entities::{sigint_inbox_item, signal_message},
    h,
    types::ShortContext,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    EntityTrait, QueryFilter,
};

fn analysis_text(decision: &Decision) -> String {
    std::iter::once(decision.description.as_str())
        .chain(decision.quotes.iter().map(String::as_str))
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) async fn append_analysis<C: ConnectionTrait>(
    db: &C,
    message_id: i64,
    decision: &Decision,
) -> anyhow::Result<()> {
    let analysis = analysis_text(decision);
    if analysis.is_empty() {
        return Ok(());
    }
    let message = signal_message::Entity::find_by_id(message_id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let body = match message.body.as_deref() {
        Some(body) if !body.is_empty() => format!("{body}\n\n{analysis}"),
        _ => analysis,
    };
    let no_headers_body =
        if crate::system_settings::sigint_comment_parsing_enabled(db)
            .await
            .c(h!())?
        {
            crate::sigint::parser::extract_text_without_top_comment(&body)
                .c(h!())?
        } else {
            crate::rer_importer::body_noheader::extract_text(&body).c(h!())?
        };
    signal_message::ActiveModel {
        id: Set(message_id),
        body: Set(Some(body)),
        ..Default::default()
    }
    .update(db)
    .await
    .c(h!())?;
    sigint_inbox_item::Entity::update_many()
        .set(sigint_inbox_item::ActiveModel {
            body_noheader: Set(Some(
                serde_json::to_value(no_headers_body).c(h!())?,
            )),
            ..Default::default()
        })
        .filter(sigint_inbox_item::Column::Id.eq(message_id))
        .exec(db)
        .await
        .c(h!())?;
    crate::sigint::worker::incoming_message_after_insert(db, message_id)
        .await
        .c(h!())?;
    Ok(())
}
