use self::types::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::Env;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{delete, post, put};
use futures::future::try_join_all;
use sea_orm::*;

pub mod modify;
pub mod ordering;
pub mod types;
pub mod worker;

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
    for (tag, keywords) in tags {
        let keywords = keywords
            .into_iter()
            .map(|tag_keyword| TagKeyword {
                tag_keyword_id: tag_keyword.tag_keyword_id,
                is_positive: tag_keyword.is_positive,
                is_regex: tag_keyword.is_regex,
                keyword: tag_keyword.keyword,
                keyword_forms: tag_keyword.keyword_forms,
            })
            .collect();
        res.push((
            tag.id,
            Tag {
                label: tag.label.clone(),
                extra: tag.extra,
                ord: tag.ord,
                keywords: Some(keywords),
            },
        ));
    }
    Ok(Json(res))
}

#[post("/api/tags/{tag_id}/keywords")]
async fn add_tag_keywords(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
    req: Json<Vec<TagKeywordAddReq>>,
) -> Result<Json<Vec<TagKeyword>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let tag_id = path.0;

    let _tag = tag::Entity::find_by_id(tag_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let keywords_task = req.0.into_iter().map(
        async |r| -> anyhow::Result<tag_keyword::ActiveModel> {
            let TagKeywordAddReq {
                is_positive,
                is_regex,
                keyword,
                keyword_forms,
            } = r;

            if is_regex {
                let _ = regex::Regex::new(&keyword).c(h!())?;
            }

            let mut keyword_forms: Vec<String> =
                keyword_forms.unwrap_or_default();
            if keyword_forms.is_empty() {
                keyword_forms =
                    crate::nlp::token_lexemes(&env.rq.clone(), &keyword)
                        .await
                        .c(h!())?;
            } else {
                for pattern in &keyword_forms {
                    let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
                }
            }

            let model = tag_keyword::ActiveModel {
                tag_id: Set(tag_id),
                is_positive: Set(is_positive),
                is_regex: Set(is_regex),
                keyword: Set(keyword),
                keyword_forms: Set(keyword_forms),
                ..Default::default()
            };
            Ok(model)
        },
    );

    let tag_keywords_to_insert = try_join_all(keywords_task).await.c(h!())?;

    let res = tag_keyword::Entity::insert_many(tag_keywords_to_insert)
        .exec_with_returning_many(&env.dbx)
        .await
        .c(h!())?;

    expire_tag_keyword_regex_cache(tag_id, &env.tag_keyword_regex_cache);

    let tag_keywords: Vec<TagKeyword> = res
        .into_iter()
        .map(|x| TagKeyword {
            tag_keyword_id: x.tag_keyword_id,
            is_positive: x.is_positive,
            is_regex: x.is_regex,
            keyword: x.keyword,
            keyword_forms: x.keyword_forms,
        })
        .collect();

    Ok(Json(tag_keywords))
}

fn expire_tag_keyword_regex_cache(
    tag_id: i64,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) {
    let mut cache = tag_keyword_regex_cache.write().unwrap();
    cache.keywords_regex_per_tag.remove(&tag_id);
}

#[delete("/api/tags/{tag_id}/keywords/{tag_keyword_id}")]
async fn delete_tag_keyword(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64, i64)>,
) -> Result<(), AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let tag_id = path.0;
    let tag_keyword_id = path.1;

    let tag_keyword = tag_keyword::Entity::find_by_id(tag_keyword_id)
        .filter(tag_keyword::Column::TagId.eq(tag_id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    tag_keyword.delete(&env.dbx).await.c(h!())?;
    expire_tag_keyword_regex_cache(tag_id, &env.tag_keyword_regex_cache);

    Ok(())
}

#[put("/api/tags/{tag_id}/keywords/{tag_keyword_id}")]
async fn update_tag_keyword(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64, i64)>,
    req: Json<TagKeywordAddReq>,
) -> Result<(), AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let tag_id = path.0;
    let tag_keyword_id = path.1;

    let tag_keyword = tag_keyword::Entity::find_by_id(tag_keyword_id)
        .filter(tag_keyword::Column::TagId.eq(tag_id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut tag_keyword = tag_keyword.into_active_model();
    let TagKeywordAddReq {
        is_positive,
        is_regex,
        keyword,
        keyword_forms,
    } = req.0;
    if is_regex {
        let _ = regex::Regex::new(keyword.as_str()).c(h!())?;
    }

    let mut keyword_forms: Vec<String> = keyword_forms.unwrap_or_default();
    if keyword_forms.is_empty() {
        keyword_forms = crate::nlp::token_lexemes(&env.rq.clone(), &keyword)
            .await
            .c(h!())?;
    } else {
        for pattern in &keyword_forms {
            let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
        }
    }

    tag_keyword.is_positive = Set(is_positive);
    tag_keyword.keyword = Set(keyword);
    tag_keyword.keyword_forms = Set(keyword_forms);

    tag_keyword.update(&env.dbx).await.c(h!())?;
    expire_tag_keyword_regex_cache(tag_id, &env.tag_keyword_regex_cache);

    Ok(())
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
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId.eq(req.message_id),
        )
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
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId.eq(req.message_id),
        )
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
