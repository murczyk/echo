use crate::entities::{login, organism, tag, tag_keyword};
use crate::error::AppError;
use crate::h;
use crate::tags::types::TagUpsertReq;
use crate::types::*;
use sea_orm::*;

pub async fn current_user_organism_id<C>(
    db: &C,
    login: &str,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    login::Entity::find_by_id(login.to_string())
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
}

pub async fn ensure_organism_exists<C>(
    db: &C,
    organism_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    organism::Entity::find_by_id(organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(())
}

pub async fn ensure_global_tag<C>(
    db: &C,
    tag_id: i64,
) -> Result<tag::Model, AppError>
where
    C: ConnectionTrait,
{
    tag::Entity::find_by_id(tag_id)
        .filter(tag::Column::OwnerOrganismId.is_null())
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn ensure_accessible_tag<C>(
    db: &C,
    tag_id: i64,
    owner_organism_id: Option<i64>,
) -> Result<tag::Model, AppError>
where
    C: ConnectionTrait,
{
    tag::Entity::find_by_id(tag_id)
        .filter(accessible_tag_condition(owner_organism_id))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn list_organism_tags<C>(
    db: &C,
    organism_id: i64,
    enabled_only: bool,
) -> Result<Vec<(tag::Model, Vec<tag_keyword::Model>)>, AppError>
where
    C: ConnectionTrait,
{
    let tags = tag::Entity::find()
        .filter(tag::Column::OwnerOrganismId.eq(organism_id))
        .apply_if(enabled_only.then_some(()), |q, _| {
            q.filter(tag::Column::Enabled.eq(true))
        })
        .order_by_asc(tag::Column::Ord)
        .order_by_asc(tag::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let keywords = tags.load_many(tag_keyword::Entity, db).await.c(h!())?;

    Ok(tags.into_iter().zip(keywords.into_iter()).collect())
}

pub async fn insert_organism_tag<C>(
    db: &C,
    req: TagUpsertReq,
    organism_id: i64,
) -> Result<tag::Model, AppError>
where
    C: ConnectionTrait,
{
    Ok(tag::ActiveModel {
        label: Set(req.label),
        extra: Set(req.extra),
        ord: Set(req.ord),
        enabled: Set(req.enabled),
        is_palitra: Set(req.is_palitra),
        owner_organism_id: Set(Some(organism_id)),
        ..Default::default()
    }
    .insert(db)
    .await
    .c(h!())?)
}

pub async fn update_organism_tag<C>(
    db: &C,
    tag_id: i64,
    req: TagUpsertReq,
    organism_id: i64,
) -> Result<(tag::Model, Vec<tag_keyword::Model>), AppError>
where
    C: ConnectionTrait,
{
    let tag = tag::Entity::find_by_id(tag_id)
        .filter(tag::Column::OwnerOrganismId.is_not_null())
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut tag = tag.into_active_model();
    tag.label = Set(req.label);
    tag.extra = Set(req.extra);
    tag.ord = Set(req.ord);
    tag.enabled = Set(req.enabled);
    tag.is_palitra = Set(req.is_palitra);
    tag.owner_organism_id = Set(Some(organism_id));

    let tag = tag.update(db).await.c(h!())?;
    let keywords = tag
        .find_related(tag_keyword::Entity)
        .all(db)
        .await
        .c(h!())?;

    Ok((tag, keywords))
}

pub async fn disable_organism_tag<C>(
    db: &C,
    tag_id: i64,
) -> Result<tag::Model, AppError>
where
    C: ConnectionTrait,
{
    let tag = tag::Entity::find_by_id(tag_id)
        .filter(tag::Column::OwnerOrganismId.is_not_null())
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut tag = tag.into_active_model();
    tag.enabled = Set(false);
    Ok(tag.update(db).await.c(h!())?)
}

fn accessible_tag_condition(owner_organism_id: Option<i64>) -> Condition {
    let condition =
        Condition::any().add(tag::Column::OwnerOrganismId.is_null());
    if let Some(owner_organism_id) = owner_organism_id {
        condition.add(tag::Column::OwnerOrganismId.eq(owner_organism_id))
    } else {
        condition
    }
}
