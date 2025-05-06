use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::Env;
use crate::types::*;
use crate::utils::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

pub mod ordering;
pub mod types;

#[post("/api/tags/tags-list")]
async fn tags_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<(i64, Tag)>>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;

    let tags = ordering::collect_tags_list(&user_id, &env.dbx).await?;
    let mut res = vec![];
    for tag in tags {
        res.push((
            tag.id,
            Tag {
                label: tag.label.clone(),
                extra: tag.extra.clone(),
                ord: tag.ord.clone(),
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
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

    let inbox = sigint_inbox_item::Entity::find_by_id(req.message_id)
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut tag_ids: Vec<i64> = from_m_val_vec(inbox.tags.clone())?;
    tag_ids.push(req.tag_id);
    let mut inbox: sigint_inbox_item::ActiveModel = inbox.into();
    inbox.tags = Set(Some(serde_json::to_value(tag_ids).context(h!())?));
    inbox.update(&env.dbx).await?;
    Ok(Json(()))
}

#[post("/api/tags/tags-rm")]
async fn inbox_message_tags_rm(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessageTagsRmReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;

    let inbox = sigint_inbox_item::Entity::find_by_id(req.message_id)
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut tag_ids: Vec<i64> = from_m_val_vec(inbox.tags.clone())?;
    tag_ids.retain(|&x| x != req.tag_id);
    let mut inbox: sigint_inbox_item::ActiveModel = inbox.into();
    inbox.tags = Set(Some(serde_json::to_value(tag_ids).context(h!())?));
    inbox.update(&env.dbx).await?;
    Ok(Json(()))
}
