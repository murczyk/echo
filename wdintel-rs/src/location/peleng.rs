use crate::entities::sigint_peleng;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::types::InboxMapItem;
use crate::types::ShortContext;
use crate::utils::orm::ArrayColumnOps;
use chrono::NaiveDateTime;
use milgeo_rs::coordinates::Coords;
use sea_orm::*;
use std::collections::BTreeMap;

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

pub async fn insert_pelengs<'a, 'async_trait, C>(
    coords: Vec<Coords>,
    inbox_item_id: i64,
    ts: NaiveDateTime,
    txn: &'a C,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    for c in coords {
        sigint_peleng::ActiveModel {
            id: NotSet,
            source_inbox_item_id: Set(inbox_item_id),
            lat: Set(c.lat),
            lng: Set(c.lng),
            settlement: NotSet,
            locality_direction: NotSet,
            distance_m: NotSet,
            country_code: NotSet,
            deleted: NotSet,
            created_at: Set(ts),
            updated_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
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

pub async fn collect_inbox_item_pelengs(
    messages: &Vec<InboxMapItem>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<i64, Vec<sigint_peleng::Model>>> {
    let mut item_ids = vec![];
    let mut sigint_pelengs = vec![];
    for item in messages {
        let id = item.id;
        if item.coords.is_none() {
            continue;
        }
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
