use self::types::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::{EventMsg, EventType};
use crate::types::Env;
use crate::types::*;
use actix_web::web::Json;
use actix_web::{delete, get, post, put};
use futures::future::try_join_all;
use sea_orm::*;
use sea_query::{Expr, IntoCondition};

pub mod modify;
pub mod ordering;
pub mod types;
pub mod worker;

fn map_tag_keyword(model: tag_keyword::Model) -> TagKeyword {
    TagKeyword {
        tag_keyword_id: model.tag_keyword_id,
        is_regex: model.is_regex,
        keyword: model.keyword,
        keyword_forms: model.keyword_forms,
        keyword_negative_forms: model.keyword_negative_forms,
    }
}

fn map_tag_admin(
    tag: tag::Model,
    keywords: Vec<tag_keyword::Model>,
) -> TagAdmin {
    TagAdmin {
        tag_id: tag.id,
        label: tag.label,
        extra: tag.extra,
        ord: tag.ord,
        enabled: tag.enabled,
        keywords: keywords.into_iter().map(map_tag_keyword).collect(),
    }
}

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
        let keywords = keywords.into_iter().map(map_tag_keyword).collect();
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

#[post("/api/admin/tags/list")]
async fn admin_list_tags(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<TagAdmin>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let tags = tag::Entity::find()
        .order_by_asc(tag::Column::Ord)
        .order_by_asc(tag::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let keywords = tags
        .load_many(tag_keyword::Entity, &env.dbx)
        .await
        .c(h!())?;

    let res = tags
        .into_iter()
        .zip(keywords.into_iter())
        .map(|(tag, keywords)| map_tag_admin(tag, keywords))
        .collect();

    Ok(Json(res))
}

#[post("/api/admin/tags")]
async fn create_tag(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<TagUpsertReq>,
) -> Result<Json<TagAdmin>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let req = req.0;
    let tag = tag::ActiveModel {
        label: Set(req.label),
        extra: Set(req.extra),
        ord: Set(req.ord),
        enabled: Set(req.enabled),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    expire_tags_to_predict_cache(&env.tag_keyword_regex_cache);

    Ok(Json(map_tag_admin(tag, vec![])))
}

#[put("/api/admin/tags/{tag_id}")]
async fn update_tag(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
    req: Json<TagUpsertReq>,
) -> Result<Json<TagAdmin>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let tag_id = path.0;

    let req = req.0;
    let tag = tag::Entity::find_by_id(tag_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut tag = tag.into_active_model();
    tag.label = Set(req.label);
    tag.extra = Set(req.extra);
    tag.ord = Set(req.ord);
    tag.enabled = Set(req.enabled);

    let tag = tag.update(&env.dbx).await.c(h!())?;
    expire_tags_to_predict_cache(&env.tag_keyword_regex_cache);
    let keywords = tag
        .find_related(tag_keyword::Entity)
        .all(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(map_tag_admin(tag, keywords)))
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
                is_regex,
                keyword,
                keyword_forms,
                keyword_negative_forms,
            } = r;

            let mut keyword_forms: Vec<String> =
                keyword_forms.unwrap_or_default();
            let keyword_negative_forms =
                keyword_negative_forms.unwrap_or_default();
            if keyword_forms.is_empty() && keyword_negative_forms.is_empty() {
                keyword_forms =
                    crate::nlp::token_lexemes(&env.rq.clone(), &keyword)
                        .await
                        .c(h!())?;
            }

            if is_regex {
                for pattern in &keyword_forms {
                    let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
                }
                for pattern in &keyword_negative_forms {
                    let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
                }
            }

            let model = tag_keyword::ActiveModel {
                tag_id: Set(tag_id),
                is_regex: Set(is_regex),
                keyword: Set(keyword),
                keyword_forms: Set(keyword_forms),
                keyword_negative_forms: Set(keyword_negative_forms),
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

    let tag_keywords: Vec<TagKeyword> =
        res.into_iter().map(map_tag_keyword).collect();

    Ok(Json(tag_keywords))
}

fn expire_tag_keyword_regex_cache(
    tag_id: i64,
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) {
    let mut cache = tag_keyword_regex_cache.write().unwrap();
    cache.keywords_regex_per_tag.remove(&tag_id);
}

fn expire_tags_to_predict_cache(
    tag_keyword_regex_cache: &Arc<RwLock<TagKeywordRegexCache>>,
) {
    let mut cache = tag_keyword_regex_cache.write().unwrap();
    cache.tags_to_predict = Default::default();
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
        is_regex,
        keyword,
        keyword_forms,
        keyword_negative_forms,
    } = req.0;

    let mut keyword_forms: Vec<String> = keyword_forms.unwrap_or_default();
    let keyword_negative_forms = keyword_negative_forms.unwrap_or_default();
    if keyword_forms.is_empty() && keyword_negative_forms.is_empty() {
        keyword_forms = crate::nlp::token_lexemes(&env.rq.clone(), &keyword)
            .await
            .c(h!())?;
    }
    if is_regex {
        for pattern in &keyword_forms {
            let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
        }
        for pattern in &keyword_negative_forms {
            let _ = regex::Regex::new(pattern.as_str()).c(h!())?;
        }
    }

    tag_keyword.is_regex = Set(is_regex);
    tag_keyword.keyword = Set(keyword);
    tag_keyword.keyword_forms = Set(keyword_forms);
    tag_keyword.keyword_negative_forms = Set(keyword_negative_forms);

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
        .filter(sigint_inbox_item_tag::Column::Login.eq(Some(user_id.clone())))
        .filter(sigint_inbox_item_tag::Column::Model.is_null())
        .one(&txn)
        .await
        .c(h!())?;

    let mut attached_tag: sigint_inbox_item_tag::ActiveModel;
    if let Some(model) = tag {
        attached_tag = model.into();
        attached_tag.confidence = Set(TAG_MAXIMUM_CONFIDENCE);
        attached_tag.model = Set(None);
        attached_tag.update(&txn).await.c(h!())?;
    } else {
        attached_tag = sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(inbox.id),
            tag_id: Set(req.tag_id),
            login: Set(Some(user_id.clone())),
            model: Set(None),
            ..Default::default()
        };
        attached_tag.insert(&txn).await.c(h!())?;
    }

    txn.commit().await.c(h!())?;

    let event = EventMsg::new(EventType::ETInboxChanged(inbox.id));
    fanout(&mut env.redis.clone(), event).await.c(h!())?;
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
        .filter(sigint_inbox_item_tag::Column::Login.eq(Some(user_id.clone())))
        .filter(sigint_inbox_item_tag::Column::Model.is_null())
        .one(&txn)
        .await
        .c(h!())?;
    if let Some(tag) = tag_option {
        let attached_tag: sigint_inbox_item_tag::ActiveModel = tag.into();
        attached_tag.delete(&txn).await.c(h!())?;
        txn.commit().await.c(h!())?;

        let event = EventMsg::new(EventType::ETInboxChanged(inbox.id));
        fanout(&mut env.redis.clone(), event).await.c(h!())?;

        return Ok(Json(()));
    }

    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[get("/api/tags/{tag_id}/model-errors")]
async fn get_inbox_message_model_errors(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
) -> Result<Json<Vec<TagModelError>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let tag_id = path.0;
    let query = sigint_inbox_tag_model_error::Entity::find()
        .filter(sigint_inbox_tag_model_error::Column::TagId.eq(tag_id))
        .inner_join(sigint_inbox_item::Entity)
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage
                .def()
                .on_condition(|_left, right| {
                    Expr::col((right, signal_message::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def().on_condition(
                |_left, right| {
                    Expr::col((right, sigint_post::Column::Deleted))
                        .eq(false)
                        .into_condition()
                },
            ),
        );

    let txn: DatabaseTransaction = env.dbx.begin().await.c(h!())?;

    let errors = query
        .select_only()
        .column(sigint_inbox_tag_model_error::Column::Id)
        .column(sigint_inbox_tag_model_error::Column::SigintInboxItemId)
        .column(sigint_inbox_tag_model_error::Column::Model)
        .column(sigint_inbox_tag_model_error::Column::ModelLogin)
        .column(sigint_inbox_tag_model_error::Column::Confidence)
        .column(sigint_inbox_tag_model_error::Column::RemovedByLogin)
        .column(sigint_inbox_tag_model_error::Column::RemovedAt)
        .column(signal_message::Column::Body)
        .column(signal_message::Column::Timestamp)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Coords)
        .column(sigint_inbox_item::Column::PostId)
        .column(sigint_inbox_item::Column::Datetime)
        .column_as(sigint_inbox_item::Column::LocationV2, "location_v2")
        .column_as(sigint_post::Column::Name, "post_name")
        .into_model::<TagModelErrorQueryDesc>()
        .all(&txn)
        .await
        .c(h!())?;

    let models: Vec<_> = errors
        .into_iter()
        .map(|item| TagModelError {
            id: item.id,
            sigint_inbox_item_id: item.sigint_inbox_item_id,
            model: item.model,
            model_login: item.model_login,
            confidence: item.confidence,
            removed_by_login: item.removed_by_login,
            removed_at: item.removed_at.timestamp_millis(),
            body: item.body,
            timestamp: item.timestamp.map(|ts| ts.and_utc().timestamp_millis()),
            coords: item.coords,
            freq: item.freq,
            post_id: item.post_id,
            datetime: item.datetime.map(|ts| ts.and_utc().timestamp_millis()),
            location_v2: item.location_v2,
            post_name: item.post_name,
        })
        .collect();

    Ok(Json(models))
}

#[post("/api/tags/tag-model-error")]
async fn inbox_message_tags_model_error(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InboxMessageTagModelErrorReq>,
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

    let bot_tags = sigint_inbox_item_tag::Entity::find()
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId.eq(req.message_id),
        )
        .filter(sigint_inbox_item_tag::Column::TagId.eq(req.tag_id))
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .all(&txn)
        .await
        .c(h!())?;

    if bot_tags.is_empty() {
        txn.commit().await.c(h!())?;
        return Ok(Json(()));
    }

    let mut error_records = vec![];
    for tag in bot_tags.iter() {
        let model_name = tag
            .model
            .clone()
            .unwrap_or_else(|| "unknown-model".to_string());
        info!(
            "bot tag removal requested: tag_id={} model={} confidence={:.3} by user={} (sigint_inbox_item={})",
            tag.tag_id, model_name, tag.confidence, user_id, tag.sigint_inbox_item_id
        );
        error_records.push(sigint_inbox_tag_model_error::ActiveModel {
            sigint_inbox_item_id: Set(tag.sigint_inbox_item_id),
            tag_id: Set(tag.tag_id),
            model: Set(model_name),
            model_login: Set(tag.login.clone()),
            confidence: Set(tag.confidence),
            removed_by_login: Set(user_id.clone()),
            ..Default::default()
        });
    }

    if !error_records.is_empty() {
        sigint_inbox_tag_model_error::Entity::insert_many(error_records)
            .exec(&txn)
            .await
            .c(h!())?;
    }

    for tag in bot_tags {
        let active: sigint_inbox_item_tag::ActiveModel = tag.into();
        active.delete(&txn).await.c(h!())?;
    }

    txn.commit().await.c(h!())?;
    let event = EventMsg::new(EventType::ETInboxChanged(inbox.id));
    fanout(&mut env.redis.clone(), event).await.c(h!())?;
    Ok(Json(()))
}
