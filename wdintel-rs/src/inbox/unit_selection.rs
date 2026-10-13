use super::unit_resolution::normalize_unit_label;
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_unit_selection, sigint_unit,
};
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, FromQueryResult,
    JoinType, QueryFilter, QuerySelect, RelationTrait, Statement,
};
use std::collections::HashMap;

#[derive(Clone, Debug, FromQueryResult)]
pub(crate) struct InboxUnitSelection {
    pub item_id: i64,
    pub unit_id: i64,
    pub unit_v2: Option<String>,
    pub unit: Option<String>,
    pub body_hash: String,
    pub source_body_hash: String,
}

pub(crate) async fn load_selections<C>(
    db: &C,
    item_ids: &[i64],
) -> anyhow::Result<HashMap<i64, InboxUnitSelection>>
where
    C: ConnectionTrait,
{
    let selections = sigint_inbox_item_unit_selection::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_unit_selection::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_unit_selection::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(
            sigint_inbox_item_unit_selection::Column::ItemId
                .is_in(item_ids.to_vec()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .column_as(
            Expr::cust("md5(coalesce(signal_message.body, ''))"),
            "source_body_hash",
        )
        .into_model::<InboxUnitSelection>()
        .all(db)
        .await
        .c(h!())?;
    Ok(selections
        .into_iter()
        .map(|selection| (selection.item_id, selection))
        .collect())
}

pub(crate) fn matches_source(
    selection: &InboxUnitSelection,
    unit_v2: Option<&str>,
    unit: Option<&str>,
) -> bool {
    selection.body_hash == selection.source_body_hash
        && normalize_unit_label(
            selection.unit_v2.as_deref().unwrap_or_default(),
        ) == normalize_unit_label(unit_v2.unwrap_or_default())
        && normalize_unit_label(selection.unit.as_deref().unwrap_or_default())
            == normalize_unit_label(unit.unwrap_or_default())
}

pub(crate) async fn store_selection<C>(
    db: &C,
    item: &crate::entities::sigint_inbox_item::Model,
    unit_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "insert into sigint_inbox_item_unit_selection (item_id, unit_id, unit_v2, unit, body_hash)
         select $1, $2, $3, $4, md5(coalesce(body, '')) from signal_message where id = $1
         on conflict (item_id) do update set unit_id = excluded.unit_id, unit_v2 = excluded.unit_v2,
             unit = excluded.unit, body_hash = excluded.body_hash",
        [item.id.into(), unit_id.into(), item.unit_v2.clone().into(), item.unit.clone().into()],
    )).await.c(h!())?;
    Ok(())
}

pub(crate) async fn restore_metadata<C>(
    db: &C,
    selection: &InboxUnitSelection,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::UnitV2,
            Expr::value(selection.unit_v2.clone()),
        )
        .col_expr(
            sigint_inbox_item::Column::Unit,
            Expr::value(selection.unit.clone()),
        )
        .filter(sigint_inbox_item::Column::Id.eq(selection.item_id))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn clear_selection<C>(
    db: &C,
    item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_unit_selection::Entity::delete_by_id(item_id)
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}
