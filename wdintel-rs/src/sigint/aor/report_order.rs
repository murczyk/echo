use crate::entities::{
    area_of_responsibility, area_of_responsibility_report_order,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use chrono::Utc;
use sea_orm::{
    ActiveValue::NotSet, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct AorReportOrderRow {
    pub aor_id: i64,
    pub aor_name: String,
    pub order_for_report: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AorReportOrderUpdate {
    pub aor_id: i64,
    pub order_for_report: f64,
}

pub async fn list_effective_report_order(
    dbx: &DatabaseConnection,
    organism_id: Option<i64>,
) -> Result<Vec<AorReportOrderRow>, AppError> {
    let aors = report_order_aors(dbx).await.c(h!())?;
    let global_orders = report_orders_by_aor_id(dbx, None).await.c(h!())?;
    let scoped_orders = match organism_id {
        Some(organism_id) => report_orders_by_aor_id(dbx, Some(organism_id))
            .await
            .c(h!())?,
        None => BTreeMap::new(),
    };

    let mut rows = aors
        .into_iter()
        .map(|aor| {
            let order_for_report = scoped_orders
                .get(&aor.id)
                .or_else(|| global_orders.get(&aor.id))
                .copied()
                .unwrap_or(aor.order_for_report_legacy);
            AorReportOrderRow {
                aor_id: aor.id,
                aor_name: aor.name,
                order_for_report,
            }
        })
        .collect::<Vec<_>>();

    rows.sort_by(|left, right| {
        left.order_for_report
            .total_cmp(&right.order_for_report)
            .then_with(|| left.aor_name.cmp(&right.aor_name))
            .then_with(|| left.aor_id.cmp(&right.aor_id))
    });
    Ok(rows)
}

pub async fn effective_report_order_map(
    dbx: &DatabaseConnection,
    organism_id: Option<i64>,
) -> Result<BTreeMap<i64, f64>, AppError> {
    Ok(list_effective_report_order(dbx, organism_id)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| (row.aor_id, row.order_for_report))
        .collect())
}

pub async fn update_report_order(
    dbx: &DatabaseConnection,
    updated_by: &str,
    organism_id: Option<i64>,
    items: &[AorReportOrderUpdate],
) -> Result<Vec<AorReportOrderRow>, AppError> {
    let aor_ids = unique_aor_ids(items)?;
    let txn = dbx.begin().await.c(h!())?;
    ensure_aor_ids_are_editable(&txn, &aor_ids).await.c(h!())?;

    let mut delete_query =
        area_of_responsibility_report_order::Entity::delete_many();
    delete_query = match organism_id {
        Some(organism_id) => delete_query.filter(
            area_of_responsibility_report_order::Column::OrganismId
                .eq(organism_id),
        ),
        None => delete_query.filter(
            area_of_responsibility_report_order::Column::OrganismId.is_null(),
        ),
    };
    delete_query.exec(&txn).await.c(h!())?;

    if !items.is_empty() {
        let now = Utc::now().naive_utc();
        let rows = items.iter().map(|item| {
            area_of_responsibility_report_order::ActiveModel {
                id: NotSet,
                area_of_responsibility_id: Set(item.aor_id),
                organism_id: Set(organism_id),
                order_for_report: Set(item.order_for_report),
                updated_by: Set(Some(updated_by.to_string())),
                updated_at: Set(now),
                created_at: Set(now),
            }
        });
        area_of_responsibility_report_order::Entity::insert_many(rows)
            .exec(&txn)
            .await
            .c(h!())?;
    }

    txn.commit().await.c(h!())?;
    Ok(list_effective_report_order(dbx, organism_id)
        .await
        .c(h!())?)
}

async fn report_order_aors<C>(
    dbx: &C,
) -> Result<Vec<area_of_responsibility::Model>, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    Ok(area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .filter(area_of_responsibility::Column::IsDefault.eq(false))
        .order_by_asc(area_of_responsibility::Column::Name)
        .all(dbx)
        .await
        .c(h!())?)
}

async fn report_orders_by_aor_id<C>(
    dbx: &C,
    organism_id: Option<i64>,
) -> Result<BTreeMap<i64, f64>, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let mut query = area_of_responsibility_report_order::Entity::find();
    query = match organism_id {
        Some(organism_id) => query.filter(
            area_of_responsibility_report_order::Column::OrganismId
                .eq(organism_id),
        ),
        None => query.filter(
            area_of_responsibility_report_order::Column::OrganismId.is_null(),
        ),
    };
    Ok(query
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|order| (order.area_of_responsibility_id, order.order_for_report))
        .collect())
}

fn unique_aor_ids(
    items: &[AorReportOrderUpdate],
) -> Result<Vec<i64>, AppError> {
    let mut ids = items.iter().map(|item| item.aor_id).collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != items.len() {
        return Err(AppError::BL {
            msg: "Список порядку вкладок містить дублікати смуг".to_string(),
        });
    }
    Ok(ids)
}

async fn ensure_aor_ids_are_editable<C>(
    dbx: &C,
    aor_ids: &[i64],
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    if aor_ids.is_empty() {
        return Ok(());
    }
    let count = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.is_in(aor_ids.to_vec()))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .filter(area_of_responsibility::Column::IsDefault.eq(false))
        .count(dbx)
        .await
        .c(h!())?;
    if count != aor_ids.len() as u64 {
        return Err(AppError::BL {
            msg: "Список порядку вкладок містить невідому або недоступну смугу"
                .to_string(),
        });
    }
    Ok(())
}
