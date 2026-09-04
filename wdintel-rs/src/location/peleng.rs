use crate::entities::{sigint_inbox_item, sigint_peleng};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::types::InboxMapItem;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use milgeo_rs::coordinates::Coords;
use sea_orm::{prelude::Expr, sea_query::SimpleExpr, *};
use std::collections::BTreeMap;
use uuid::Uuid;

pub async fn delete_inbox_pelengs<'a, 'async_trait, C>(
    inbox_item_id: i64,
    txn: &'a C,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    sigint_peleng::Entity::delete_many()
        .filter(sigint_peleng::Column::SourceInboxItemId.eq(inbox_item_id))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn reset_inbox_pelengs<'a, 'async_trait, C>(
    inbox_item_id: i64,
    txn: &'a C,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let pelengs = sigint_peleng::Entity::find()
        .filter(sigint_peleng::Column::SourceInboxItemId.eq(inbox_item_id))
        .all(txn)
        .await
        .c(h!())?;
    for p in pelengs {
        let mut p = p.into_active_model();
        p.country_code = Set(None);
        p.settlement = Set(None);
        p.distance_m = Set(None);
        p.locality_direction = Set(None);
        p.update(txn).await.c(h!())?;
    }
    Ok(())
}

pub fn coord_matches_peleng_bounds(
    coord: &Coords,
    peleng_bounds: Option<&crate::system_settings::PelengBounds>,
) -> bool {
    peleng_bounds
        .map(|peleng_bounds| peleng_bounds.contains(coord.lat, coord.lng))
        .unwrap_or(true)
}

pub fn filter_coords_by_peleng_bounds(
    coords: Vec<Coords>,
    peleng_bounds: Option<&crate::system_settings::PelengBounds>,
) -> Vec<Coords> {
    coords
        .into_iter()
        .filter(|coord| coord_matches_peleng_bounds(coord, peleng_bounds))
        .collect()
}

pub async fn filter_allowed_peleng_coords<'a, 'async_trait, C>(
    coords: Vec<Coords>,
    txn: &'a C,
) -> Result<Vec<Coords>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let peleng_bounds = crate::system_settings::get_active_peleng_bounds(txn)
        .await
        .c(h!())?;
    Ok(filter_coords_by_peleng_bounds(
        coords,
        peleng_bounds.as_ref(),
    ))
}

pub async fn insert_pelengs<'a, 'async_trait, C>(
    coords: Vec<Coords>,
    inbox_item_id: i64,
    source_inbox_item_uuid: Option<Uuid>,
    ts: NaiveDateTime,
    pelengation_object: Option<String>,
    txn: &'a C,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let coords = filter_allowed_peleng_coords(coords, txn).await.c(h!())?;
    if coords.is_empty() {
        return Ok(());
    }

    let mut peleng_ids = Vec::with_capacity(coords.len());
    for coord in coords {
        let peleng = sigint_peleng::ActiveModel {
            id: NotSet,
            source_inbox_item_id: Set(inbox_item_id),
            source_inbox_item_uuid: Set(source_inbox_item_uuid),
            lat: Set(coord.lat),
            lng: Set(coord.lng),
            settlement: NotSet,
            locality_direction: NotSet,
            distance_m: NotSet,
            country_code: NotSet,
            pelengation_object: Set(pelengation_object.clone()),
            deleted: NotSet,
            created_at: Set(ts),
            updated_at: NotSet,
            battle_line_distance: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
        peleng_ids.push(peleng.id);
    }
    crate::battle_line::peleng_distance::fill_new_peleng_distances(
        txn,
        &peleng_ids,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn collect_inbox_pelengs(
    inbox_item_ids: Vec<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<sigint_peleng::Model>> {
    sigint_peleng::Entity::find()
        .filter(sigint_peleng::Column::SourceInboxItemId.eq_any(inbox_item_ids))
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())
}

pub fn inbox_item_has_active_peleng_exists() -> SimpleExpr {
    Expr::exists(
        sigint_peleng::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(Expr::col(sigint_peleng::Column::SourceInboxItemId).equals(
                (sigint_inbox_item::Entity, sigint_inbox_item::Column::Id),
            ))
            .filter(sigint_peleng::Column::Deleted.eq(false))
            .into_query(),
    )
}

pub async fn collect_inbox_item_pelengs(
    messages: &Vec<InboxMapItem>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<i64, Vec<sigint_peleng::Model>>> {
    let mut item_ids = vec![];
    let mut sigint_pelengs = vec![];
    for item in messages {
        let id = item.id;
        item_ids.push(id);
        if item_ids.len() > 1000 {
            let pelengs = collect_inbox_pelengs(item_ids, dbx).await.c(h!())?;
            sigint_pelengs.push(pelengs);
            item_ids = vec![];
        }
    }
    sigint_pelengs.push(collect_inbox_pelengs(item_ids, dbx).await.c(h!())?);

    let mut pelengs_map = BTreeMap::<i64, Vec<sigint_peleng::Model>>::new();
    for peleng in sigint_pelengs.into_iter().flat_map(|s| s.into_iter()) {
        pelengs_map
            .entry(peleng.source_inbox_item_id)
            .or_default()
            .push(peleng);
    }
    Ok(pelengs_map)
}
