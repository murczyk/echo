use crate::entities::{
    login, palitra, palitra_geometry, palitra_highlight_blacklist,
    palitra_point, sigint_inbox_item_point_token, signal_message,
    signal_message_group,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::prelude::Expr;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait, Set,
};

pub async fn counts_by_palitra_ids<C>(
    dbx: &C,
    palitra_ids: Vec<i64>,
) -> Result<Vec<(i64, i64)>, AppError>
where
    C: ConnectionTrait,
{
    if palitra_ids.is_empty() {
        return Ok(vec![]);
    }

    Ok(palitra_highlight_blacklist::Entity::find()
        .filter(
            palitra_highlight_blacklist::Column::PalitraId.eq_any(palitra_ids),
        )
        .select_only()
        .column(palitra_highlight_blacklist::Column::PalitraId)
        .expr_as(
            Expr::col(palitra_highlight_blacklist::Column::Id).count(),
            "count",
        )
        .group_by(palitra_highlight_blacklist::Column::PalitraId)
        .into_tuple::<(i64, i64)>()
        .all(dbx)
        .await
        .c(h!())?)
}

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

pub async fn resolve_names<C>(
    dbx: &C,
    palitra_ids: &[i64],
) -> Result<Vec<(i64, String)>, AppError>
where
    C: ConnectionTrait,
{
    Ok(palitra::Entity::find()
        .filter(palitra::Column::Id.eq_any(palitra_ids))
        .filter(palitra::Column::Deleted.eq(false))
        .select_only()
        .column(palitra::Column::Id)
        .column(palitra::Column::Name)
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

pub async fn find_historical_label<C>(
    dbx: &C,
    login_id: uuid::Uuid,
    source_message_id: i64,
    palitra_id: i64,
    normalized_label: &str,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait,
{
    let visible_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, &login_id)
            .await
            .c(h!())?;
    let source_is_visible = signal_message::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Id.eq(source_message_id))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message_group::Column::GroupMasterKey.eq_any(visible_groups),
        )
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if !source_is_visible {
        return Ok(None);
    }

    let rows = sigint_inbox_item_point_token::Entity::find()
        .filter(
            sigint_inbox_item_point_token::Column::SigintInboxItemId
                .eq(source_message_id),
        )
        .filter(sigint_inbox_item_point_token::Column::PalitraId.eq(palitra_id))
        .all(dbx)
        .await
        .c(h!())?;

    for row in rows {
        let points = serde_json::from_value::<
            Vec<crate::rer_importer::highlight::CNPoint>,
        >(row.point_tokens)
        .c(h!())?;
        if let Some(point) = points.into_iter().find(|point| {
            point.etalon.trim().to_lowercase() == normalized_label
        }) {
            return Ok(Some(point.etalon.trim().to_string()));
        }
    }
    Ok(None)
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
