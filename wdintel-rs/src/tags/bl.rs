use crate::error::AppError;
use crate::tags::query;
use crate::tags::types::{TagAdmin, TagUpsertReq};
use sea_orm::ConnectionTrait;

pub async fn list_global_tags<C>(db: &C) -> Result<Vec<TagAdmin>, AppError>
where
    C: ConnectionTrait,
{
    let tags = query::list_global_tags(db).await?;
    Ok(map_tag_admin_entries(tags))
}

pub async fn create_global_tag<C>(
    db: &C,
    req: TagUpsertReq,
) -> Result<TagAdmin, AppError>
where
    C: ConnectionTrait,
{
    let tag = query::insert_global_tag(db, req).await?;
    Ok(crate::tags::map_tag_admin(tag, vec![]))
}

pub async fn update_global_tag<C>(
    db: &C,
    tag_id: i64,
    req: TagUpsertReq,
) -> Result<TagAdmin, AppError>
where
    C: ConnectionTrait,
{
    let (tag, keywords) = query::update_global_tag(db, tag_id, req).await?;
    Ok(crate::tags::map_tag_admin(tag, keywords))
}

pub async fn list_current_organism_tags<C>(
    db: &C,
    login: &str,
) -> Result<Vec<TagAdmin>, AppError>
where
    C: ConnectionTrait,
{
    let organism_id = current_user_required_organism_id(db, login).await?;
    let tags = query::list_organism_tags(db, organism_id, true).await?;
    Ok(map_tag_admin_entries(tags))
}

pub async fn list_admin_organism_tags<C>(
    db: &C,
    organism_id: i64,
) -> Result<Vec<TagAdmin>, AppError>
where
    C: ConnectionTrait,
{
    query::ensure_organism_exists(db, organism_id).await?;
    let tags = query::list_organism_tags(db, organism_id, false).await?;
    Ok(map_tag_admin_entries(tags))
}

pub async fn create_organism_tag<C>(
    db: &C,
    req: TagUpsertReq,
) -> Result<TagAdmin, AppError>
where
    C: ConnectionTrait,
{
    let organism_id = required_owner_organism_id(&req)?;
    query::ensure_organism_exists(db, organism_id).await?;
    let tag = query::insert_organism_tag(db, req, organism_id).await?;
    Ok(crate::tags::map_tag_admin(tag, vec![]))
}

pub async fn update_organism_tag<C>(
    db: &C,
    tag_id: i64,
    req: TagUpsertReq,
) -> Result<TagAdmin, AppError>
where
    C: ConnectionTrait,
{
    let organism_id = required_owner_organism_id(&req)?;
    query::ensure_organism_exists(db, organism_id).await?;
    let (tag, keywords) =
        query::update_organism_tag(db, tag_id, req, organism_id).await?;
    Ok(crate::tags::map_tag_admin(tag, keywords))
}

pub async fn disable_organism_tag<C>(
    db: &C,
    tag_id: i64,
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    let tag = query::disable_organism_tag(db, tag_id).await?;
    Ok(tag.id)
}

async fn current_user_required_organism_id<C>(
    db: &C,
    login: &str,
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    query::current_user_organism_id(db, login)
        .await?
        .ok_or_else(|| AppError::Forbidden("user has no organism".to_string()))
}

fn required_owner_organism_id(req: &TagUpsertReq) -> Result<i64, AppError> {
    req.owner_organism_id.ok_or_else(|| AppError::BL {
        msg: "owner_organism_id is required".to_string(),
    })
}

fn map_tag_admin_entries(
    tags: Vec<(
        crate::entities::tag::Model,
        Vec<crate::entities::tag_keyword::Model>,
    )>,
) -> Vec<TagAdmin> {
    tags.into_iter()
        .map(|(tag, keywords)| crate::tags::map_tag_admin(tag, keywords))
        .collect()
}
