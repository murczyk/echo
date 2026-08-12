use crate::entities::{
    login, palitra_geometry, palitra_highlight_blacklist, palitra_point,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::prelude::Expr;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationTrait, Set,
};

pub async fn load_labels<C>(
    dbx: &C,
    palitra_ids: Vec<i64>,
) -> Result<Vec<(i64, String)>, AppError>
where
    C: ConnectionTrait,
{
    Ok(palitra_highlight_blacklist::Entity::find()
        .filter(
            palitra_highlight_blacklist::Column::PalitraId.eq_any(palitra_ids),
        )
        .select_only()
        .column(palitra_highlight_blacklist::Column::PalitraId)
        .column(palitra_highlight_blacklist::Column::NormalizedLabel)
        .into_tuple::<(i64, String)>()
        .all(dbx)
        .await
        .c(h!())?)
}

pub async fn list_entries<C>(
    dbx: &C,
    palitra_id: i64,
) -> Result<
    Vec<(palitra_highlight_blacklist::Model, Option<login::Model>)>,
    AppError,
>
where
    C: ConnectionTrait,
{
    Ok(palitra_highlight_blacklist::Entity::find()
        .filter(palitra_highlight_blacklist::Column::PalitraId.eq(palitra_id))
        .order_by_asc(palitra_highlight_blacklist::Column::NormalizedLabel)
        .order_by_asc(palitra_highlight_blacklist::Column::Id)
        .find_also_related(login::Entity)
        .all(dbx)
        .await
        .c(h!())?)
}

pub async fn find_current_label<C>(
    dbx: &C,
    palitra_id: i64,
    normalized_label: &str,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(palitra_point::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            palitra_point::Relation::PalitraGeometry.def(),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(Expr::cust_with_values(
            "lower(btrim(\"palitra_point\".\"label\")) = $1",
            [normalized_label.to_string()],
        ))
        .select_only()
        .column(palitra_point::Column::Label)
        .into_tuple::<Option<String>>()
        .one(dbx)
        .await
        .c(h!())?
        .flatten())
}

pub async fn upsert_entry<C>(
    dbx: &C,
    palitra_id: i64,
    created_by_login_id: uuid::Uuid,
    label: String,
    normalized_label: String,
) -> Result<palitra_highlight_blacklist::Model, AppError>
where
    C: ConnectionTrait,
{
    Ok(palitra_highlight_blacklist::Entity::insert(
        palitra_highlight_blacklist::ActiveModel {
            palitra_id: Set(palitra_id),
            label: Set(label),
            normalized_label: Set(normalized_label),
            created_by_login_id: Set(created_by_login_id),
            ..Default::default()
        },
    )
    .on_conflict(
        OnConflict::columns([
            palitra_highlight_blacklist::Column::PalitraId,
            palitra_highlight_blacklist::Column::NormalizedLabel,
        ])
        .update_column(palitra_highlight_blacklist::Column::Label)
        .to_owned(),
    )
    .exec_with_returning(dbx)
    .await
    .c(h!())?)
}

pub async fn login_name<C>(
    dbx: &C,
    login_id: uuid::Uuid,
) -> Result<String, AppError>
where
    C: ConnectionTrait,
{
    login::Entity::find_by_id(login_id)
        .select_only()
        .column(login::Column::Login)
        .into_tuple()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn delete_entry<C>(
    dbx: &C,
    palitra_id: i64,
    blacklist_entry_id: i64,
) -> Result<u64, AppError>
where
    C: ConnectionTrait,
{
    Ok(palitra_highlight_blacklist::Entity::delete_many()
        .filter(palitra_highlight_blacklist::Column::Id.eq(blacklist_entry_id))
        .filter(palitra_highlight_blacklist::Column::PalitraId.eq(palitra_id))
        .exec(dbx)
        .await
        .c(h!())?
        .rows_affected)
}
