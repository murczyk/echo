use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::Env;
use crate::types::*;
use crate::config::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod ordering;
pub mod types;
pub mod modify;

#[post("/api/tags/tags-list")]
async fn tags_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<(i64, Tag)>>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;

    let tags = ordering::collect_tags_list(&user_id, &env.dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for tag in tags {
        res.push((
            tag.id,
            Tag {
                label: tag.label.clone(),
                extra: tag.extra,
                ord: tag.ord,
            },
        ));
    }
    Ok(Json(res))
}

#[post("/api/tags/tags-add")]
async fn inbox_message_tags_add(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessageTagsAddReq>,
) -> Result<Json<()>, AppError> {
    let user_id: String = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;

    let txn: DatabaseTransaction = env.dbx.begin().await.c(h!())?;

    let inbox = sigint_inbox_item::Entity::find_by_id(req.message_id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let tag = sigint_inbox_item_tag::Entity::find()
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(req.message_id))
        .filter(sigint_inbox_item_tag::Column::TagId.eq(req.tag_id))
        .one(&txn)
        .await
        .c(h!())?;

    let login = Some(user_id.clone());
    let mut attached_tag: sigint_inbox_item_tag::ActiveModel;
    if let Some(model) = tag {
        attached_tag = model.into();
        attached_tag.confidence = Set(TAG_MAXIMUM_CONFIDENCE);
        attached_tag.login = Set(login);
        attached_tag.update(&txn).await.c(h!())?;
    } else {
        attached_tag = sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(inbox.id),
            tag_id: Set(req.tag_id),
            login: Set(login),
            ..Default::default()
        };
        attached_tag.insert(&txn).await.c(h!())?;
    }
 
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/tags/tags-rm")]
async fn inbox_message_tags_rm(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessageTagsRmReq>,
) -> Result<Json<()>, AppError> {
    let user_id: String = user.id().c(h!())?;

    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;

    let txn: DatabaseTransaction = env.dbx.begin().await.c(h!())?;

    let inbox = sigint_inbox_item::Entity::find_by_id(req.message_id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let tag_option = sigint_inbox_item_tag::Entity::find()
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(req.message_id))
        .filter(sigint_inbox_item_tag::Column::TagId.eq(req.tag_id))
        .one(&txn)
        .await
        .c(h!())?;
    if let Some(tag) = tag_option {
        if let Some(model) = &tag.model {
            let tag_id = req.tag_id;
            let message_id = inbox.id;
            let confidence = tag.confidence;
            info!("suggested tag_id={tag_id} is being removed by user={user_id} (sigint_inbox_item={message_id}, model={model}, confidence={confidence:.2})");
        }

        let attached_tag: sigint_inbox_item_tag::ActiveModel = tag.into();
        attached_tag.delete(&txn).await.c(h!())?;
    }

    txn.commit().await.c(h!())?;
    Ok(Json(()))
}
