use super::rer::filter_report_comments;
use crate::entities::*;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr},
    ColumnTrait, DatabaseConnection, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) async fn load_comments(
    db: &DatabaseConnection,
    item_ids: &[i64],
    blacklist: &[String],
) -> anyhow::Result<BTreeMap<i64, Vec<String>>> {
    let mut comments = BTreeMap::<i64, Vec<String>>::new();
    for comment in
        crate::sigint::comments::find_rer_report_comments(db, item_ids)
            .await
            .c(h!())?
    {
        comments
            .entry(comment.source_message_id)
            .or_default()
            .push(comment.comment);
    }
    Ok(comments
        .into_iter()
        .map(|(id, comments)| (id, filter_report_comments(comments, blacklist)))
        .collect())
}

pub(super) async fn load_items(
    db: &DatabaseConnection,
    item_ids: &[i64],
    blacklist: &[String],
) -> anyhow::Result<
    Vec<(sigint_inbox_item::Model, signal_message::Model, Vec<String>)>,
> {
    let excluded = sigint_inbox_item_tag::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::Tag.def(),
        )
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .is_in(item_ids.to_vec()),
        )
        .filter(
            Expr::col((tag::Entity, tag::Column::Label))
                .ilike(crate::config::RER_REPORT_OTHER_TAG_LABEL),
        )
        .select_only()
        .column(sigint_inbox_item_tag::Column::SigintInboxItemId)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut comments = load_comments(db, item_ids, blacklist).await.c(h!())?;
    let items = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.is_in(item_ids.to_vec()))
        .find_also_related(signal_message::Entity)
        .all(db)
        .await
        .c(h!())?;
    Ok(items
        .into_iter()
        .filter_map(|(item, message)| {
            let message = message.filter(|message| !message.deleted)?;
            let comments = comments.remove(&item.id)?;
            if excluded.contains(&item.id) || comments.is_empty() {
                return None;
            }
            Some((item, message, comments))
        })
        .collect())
}
