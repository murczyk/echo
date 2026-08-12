use crate::entities::sigint_inbox_item_tag;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::types::{InboxMessage, InboxMessageTag};
use crate::types::info;
use crate::types::ShortContext;
use itertools::{EitherOrBoth, Itertools};
use sea_orm::*;
use std::collections::BTreeSet;

pub async fn upsert_tags(
    login: &uuid::Uuid,
    inbox_item_id: i64,
    inbox_message: &InboxMessage,
    txn: &impl ConnectionTrait,
) -> Result<(), AppError> {
    if inbox_message.inbox_tags.is_none() && inbox_message.tags.is_none() {
        return Ok(());
    }

    let tags: Vec<sigint_inbox_item_tag::Model> =
        sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq(inbox_item_id),
            )
            .order_by_asc(sigint_inbox_item_tag::Column::TagId)
            .all(txn)
            .await
            .c(h!())?;

    if let Some(inbox_tags) = &inbox_message.inbox_tags {
        for entry in itertools::merge_join_by(
            tags,
            inbox_tags.iter().sorted_by_key(|x| x.tag_id),
            |a, b| a.tag_id.cmp(&b.tag_id),
        ) {
            upsert_tag_by_item(login, inbox_item_id, entry, txn)
                .await
                .c(h!())?;
        }
    } else {
        let tag_ids: BTreeSet<i64> = inbox_message
            .tags
            .as_ref()
            .map(|items| items.iter().cloned().collect())
            .unwrap_or_default();
        for entry in
            itertools::merge_join_by(tags, tag_ids, |a, b| a.tag_id.cmp(b))
        {
            upsert_tag_by_id(login, inbox_item_id, entry, txn)
                .await
                .c(h!())?;
        }
    }

    Ok(())
}

async fn upsert_tag_by_item(
    login: &uuid::Uuid,
    message_id: i64,
    entry: EitherOrBoth<sigint_inbox_item_tag::Model, &InboxMessageTag>,
    txn: &impl ConnectionTrait,
) -> Result<(), AppError> {
    let is_system_login = *login == crate::users::system_login_id(txn).await?;
    match entry {
        EitherOrBoth::Left(tag_to_remove) => {
            remove_tag(login, message_id, txn, tag_to_remove)
                .await
                .c(h!())?
        }
        EitherOrBoth::Right(tag_to_add) => {
            let mut new_tag = sigint_inbox_item_tag::ActiveModel {
                tag_id: Set(tag_to_add.tag_id),
                sigint_inbox_item_id: Set(message_id),
                login_id: Set(Some(login.to_owned())),
                ..Default::default()
            };
            if is_system_login {
                new_tag.confidence = Set(tag_to_add.confidence);
                new_tag.model = Set(tag_to_add.model.clone());
            }
            new_tag.insert(txn).await.c(h!())?;
        }
        EitherOrBoth::Both(tag, new_values) => {
            if is_system_login {
                let mut tag = tag.into_active_model();
                tag.confidence = Set(new_values.confidence);
                tag.model = Set(new_values.model.clone());
                tag.login_id = Set(Some(*login));
                tag.update(txn).await.c(h!())?;
            } else if tag.confidence != new_values.confidence {
                let mut tag = tag.into_active_model();
                tag.login_id = Set(Some(*login));
                tag.confidence = Set(new_values.confidence);
                tag.update(txn).await.c(h!())?;
            }
        }
    };
    Ok(())
}

async fn upsert_tag_by_id(
    login: &uuid::Uuid,
    message_id: i64,
    entry: EitherOrBoth<sigint_inbox_item_tag::Model, i64>,
    txn: &impl ConnectionTrait,
) -> Result<(), AppError> {
    match entry {
        EitherOrBoth::Left(tag_to_remove) => {
            remove_tag(login, message_id, txn, tag_to_remove)
                .await
                .c(h!())?
        }
        EitherOrBoth::Right(tag_to_add) => {
            let new_tag = sigint_inbox_item_tag::ActiveModel {
                tag_id: Set(tag_to_add),
                sigint_inbox_item_id: Set(message_id),
                login_id: Set(Some(login.to_owned())),
                ..Default::default()
            };
            new_tag.insert(txn).await.c(h!())?;
        }
        _ => {}
    };
    Ok(())
}

async fn remove_tag(
    login: &uuid::Uuid,
    message_id: i64,
    txn: &impl ConnectionTrait,
    tag_to_remove: sigint_inbox_item_tag::Model,
) -> Result<(), AppError> {
    if let Some(model) = &tag_to_remove.model {
        let tag_id = tag_to_remove.tag_id;
        let confidence = tag_to_remove.confidence;
        info!(
            "suggested tag_id={tag_id} is being removed by user={login} (sigint_inbox_item={message_id}, model={model}, confidence={confidence:.2})"
        );
    }
    tag_to_remove.delete(txn).await.c(h!())?;
    Ok(())
}
