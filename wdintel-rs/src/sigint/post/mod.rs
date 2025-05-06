use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use sea_orm::*;

use self::types::*;

pub mod types;

/// Get post id from db by post name
pub async fn get_post_id<'a, 'async_trait, C>(
    txn: &'a C,
    post_name: &Option<String>,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if let Some(post_name) = post_name {
        let post_name = post_name.trim().to_uppercase();
        if post_name.is_empty() {
            return Ok(None);
        }

        let post_id = sigint_post::Entity::find()
            .filter(sigint_post::Column::Name.eq(post_name))
            .one(txn)
            .await
            .context(h!())?
            .map(|post| post.id);

        return Ok(post_id);
    }
    Ok(None)
}

/// Get post id from db by post name, if not exists, create a new one
pub async fn get_or_create_post_id<C>(
    txn: &C,
    post_name: &Option<String>,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    if let Some(id) = get_post_id(txn, post_name).await? {
        return Ok(Some(id));
    }

    let Some(name) = post_name else {
        return Ok(None);
    };

    // Insert a new post with the given name
    let new_post = sigint_post::ActiveModel {
        name: Set(name.clone()),
        ..Default::default()
    };

    let inserted = new_post.insert(txn).await?;
    Ok(Some(inserted.id))
}

#[post("/api/sigint/posts")]
pub async fn post_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListPostsReq>,
) -> Result<Json<Vec<Post>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await?;

    let posts = sigint_post::Entity::find()
        .filter(sigint_post::Column::Deleted.eq(false))
        .order_by(
            sigint_post::Column::Name,
            if let Some(sort_by) = &req.sort_by {
                match sort_by {
                    ListPostsSortBy::PostNameDesc => Order::Desc,
                    ListPostsSortBy::PostNameAsc => Order::Asc,
                }
            } else {
                Order::Desc
            },
        )
        .all(&env.dbx)
        .await
        .context(h!())?;

    let mut posts_res = vec![];
    for post in posts {
        posts_res.push(Post {
            id: post.id,
            name: post.name,
            origin: post.origin,
            description: post.description,
            deleted: post.deleted,
            created_at: post.created_at.and_utc().timestamp_millis(),
        });
    }
    Ok(Json(posts_res))
}

#[post("/api/sigint/post/create")]
pub async fn create_post(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePostReq>,
) -> Result<Json<Post>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let post = sigint_post::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        origin: NotSet,
        description: Set(req.description.clone()),
        deleted: NotSet,
        created_at: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    Ok(Json(Post {
        id: post.id,
        name: post.name,
        origin: post.origin,
        description: post.description,
        deleted: post.deleted,
        created_at: post.created_at.and_utc().timestamp_millis(),
    }))
}

#[post("/api/sigint/post/update")]
pub async fn update_post(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdatePostReq>,
) -> Result<Json<Post>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let post_obj = sigint_post::Entity::find()
        .filter(sigint_post::Column::Id.eq(req.id))
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    let mut post_model = post_obj.into_active_model();

    if let Some(name) = req.name.clone() {
        post_model.name = Set(name);
    }
    if req.description.is_some() {
        post_model.description = Set(req.description.clone());
    }
    if let Some(deleted) = req.deleted.clone() {
        post_model.deleted = Set(deleted);
    }

    let post = post_model.update(&env.dbx).await.context(h!())?;

    Ok(Json(Post {
        id: post.id,
        name: post.name,
        origin: post.origin,
        description: post.description,
        deleted: post.deleted,
        created_at: post.created_at.and_utc().timestamp_millis(),
    }))
}

#[post("/api/sigint/post/delete")]
pub async fn delete_post(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeletePostReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let post_obj = sigint_post::Entity::find()
        .filter(sigint_post::Column::Id.eq(req.id.clone()))
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let mut post_model = post_obj.into_active_model();
    post_model.deleted = Set(true);
    post_model.update(&env.dbx).await.context(h!())?;
    Ok(Json(()))
}
