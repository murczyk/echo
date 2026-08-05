use crate::entities::sea_orm_active_enums::SigintInboxItemCallsignSource;
use crate::entities::{
    delta_kv, sigint_inbox_item, sigint_inbox_item_callsign,
};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use chrono::Utc;
use sea_orm::prelude::{Expr, Json};
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub const CALLSIGN_BACKFILL_WATERMARK_KEY: &str =
    "sigint_inbox_item_callsign_backfill_through_id";

pub async fn oneoff_backfill(
    mode: Mode,
    ps: &crate::OneoffBackfillInboxItemCallsignsPs,
) -> Result<(), AppError> {
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let batch_size = ps
        .batch_size
        .unwrap_or(crate::config::INBOX_ITEM_CALLSIGN_BACKFILL_BATCH_SIZE);
    let through_id = match ps.through_id {
        Some(through_id) => through_id,
        None => sigint_inbox_item::Entity::find()
            .select_only()
            .column_as(sigint_inbox_item::Column::Id.max(), "id")
            .into_tuple::<Option<i64>>()
            .one(&dbx)
            .await
            .c(h!())?
            .flatten()
            .unwrap_or(0),
    };
    let watermark = backfill_watermark(&dbx).await?;
    let mut after_id = ps.after_id.unwrap_or(watermark);
    let mut processed = 0_u64;
    let mut expected_rows = 0_usize;
    let system_login_id = crate::users::system_login_id(&dbx).await.c(h!())?;
    println!(
        "> backfilling inbox item callsigns after_id={after_id} through_id={through_id} batch_size={batch_size} dry_run={}",
        ps.dry_run
    );

    loop {
        let txn = dbx.begin().await.c(h!())?;
        let inbox_items = sigint_inbox_item::Entity::find()
            .select_only()
            .column(sigint_inbox_item::Column::Id)
            .column(sigint_inbox_item::Column::Callsigns)
            .column(sigint_inbox_item::Column::CallsignsAlg2)
            .filter(sigint_inbox_item::Column::Id.gt(after_id))
            .filter(sigint_inbox_item::Column::Id.lte(through_id))
            .filter(Expr::cust(
                r#"(
                    (
                        jsonb_typeof(callsigns) = 'array'
                        and callsigns <> '[]'::jsonb
                    )
                    or (
                        jsonb_typeof(callsigns_alg2) = 'array'
                        and callsigns_alg2 <> '[]'::jsonb
                    )
                )"#,
            ))
            .order_by_asc(sigint_inbox_item::Column::Id)
            .limit(batch_size)
            .lock_exclusive()
            .into_model::<LegacyInboxItemCallsigns>()
            .all(&txn)
            .await
            .c(h!())?;
        if inbox_items.is_empty() {
            txn.rollback().await.c(h!())?;
            break;
        }

        let mut expected_callsigns = Vec::with_capacity(inbox_items.len());
        for inbox_item in &inbox_items {
            let callsigns = from_legacy_values(
                inbox_item.callsigns.clone(),
                inbox_item.callsigns_alg2.clone(),
            )
            .map_err(|error| {
                AppError::BL {
                    msg: format!(
                        "invalid legacy callsigns for sigint_inbox_item_id={}: {error}",
                        inbox_item.id
                    ),
                }
            })?;
            let callsigns = callsigns.normalized();
            expected_rows += callsigns.primary.len() + callsigns.alg2.len();
            expected_callsigns.push((inbox_item.id, callsigns));
            after_id = inbox_item.id;
        }
        if !ps.dry_run {
            sync_backfill_batch(&txn, &expected_callsigns, system_login_id)
                .await?;
            let item_ids = expected_callsigns
                .iter()
                .map(|(inbox_item_id, _)| *inbox_item_id)
                .collect::<Vec<_>>();
            let loaded = load_by_item_ids(&txn, &item_ids).await?;
            for (inbox_item_id, expected_callsigns) in expected_callsigns {
                if loaded.get(&inbox_item_id).cloned().unwrap_or_default()
                    != expected_callsigns
                {
                    return Err(AppError::BL {
                        msg: format!(
                            "callsign verification failed for sigint_inbox_item_id={}",
                            inbox_item_id
                        ),
                    });
                }
            }
        }
        processed += inbox_items.len() as u64;
        if ps.dry_run {
            txn.rollback().await.c(h!())?;
        } else {
            txn.commit().await.c(h!())?;
            update_backfill_watermark(&dbx, after_id).await?;
        }
        println!(
            "> processed={processed} expected_rows={expected_rows} last_committed_id={after_id}"
        );
    }
    println!(
        "> inbox item callsign backfill complete: processed={processed} expected_rows={expected_rows} through_id={through_id}"
    );
    if !ps.dry_run {
        update_backfill_watermark(&dbx, through_id).await?;
    }
    Ok(())
}

async fn backfill_watermark<C>(dbx: &C) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    let value = delta_kv::Entity::find()
        .filter(delta_kv::Column::K.eq(CALLSIGN_BACKFILL_WATERMARK_KEY))
        .one(dbx)
        .await
        .c(h!())?
        .map(|value| serde_json::from_value::<i64>(value.v))
        .transpose()
        .c(h!())?;
    Ok(value.unwrap_or_default())
}

async fn update_backfill_watermark(
    dbx: &DatabaseConnection,
    watermark: i64,
) -> Result<(), AppError> {
    if watermark > backfill_watermark(dbx).await? {
        crate::kv::put_kv(dbx, CALLSIGN_BACKFILL_WATERMARK_KEY, watermark)
            .await?;
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InboxItemCallsigns {
    pub primary: Vec<String>,
    pub alg2: Vec<String>,
}

#[derive(FromQueryResult)]
struct LegacyInboxItemCallsigns {
    id: i64,
    callsigns: Option<Json>,
    callsigns_alg2: Option<Json>,
}

impl InboxItemCallsigns {
    fn normalized(mut self) -> Self {
        self.primary = crate::utils::uniq_via_btreeset(&self.primary);
        self.alg2 = crate::utils::uniq_via_btreeset(&self.alg2);
        self
    }

    pub fn effective(&self) -> Vec<String> {
        crate::utils::uniq_via_btreeset(
            &self
                .primary
                .iter()
                .chain(self.alg2.iter())
                .cloned()
                .collect::<Vec<_>>(),
        )
    }
}

pub fn from_legacy(
    inbox_item: &sigint_inbox_item::Model,
) -> Result<InboxItemCallsigns, AppError> {
    from_legacy_values(
        inbox_item.callsigns.clone(),
        inbox_item.callsigns_alg2.clone(),
    )
}

pub fn from_legacy_values(
    primary: Option<Json>,
    alg2: Option<Json>,
) -> Result<InboxItemCallsigns, AppError> {
    Ok(InboxItemCallsigns {
        primary: parse_legacy(primary)?,
        alg2: parse_legacy(alg2)?,
    })
}

pub fn sql_filter_condition(selected_callsigns: &[String]) -> String {
    let selected_callsigns = selected_callsigns
        .iter()
        .map(|callsign| format!("'{}'", callsign.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"(
exists (
    select 1
    from sigint_inbox_item_callsign siic
    where siic.sigint_inbox_item_id = sigint_inbox_item.id
      and not siic.deleted
      and siic.callsign in ({selected_callsigns})
)
or (
    sigint_inbox_item.id > coalesce((
        select nullif(dk.v #>> '{{}}', '')::bigint
        from delta_kv dk
        where dk.k = '{watermark_key}'
    ), 0)
    and
    not exists (
        select 1
        from sigint_inbox_item_callsign siic
        where siic.sigint_inbox_item_id = sigint_inbox_item.id
    )
    and (
        coalesce(sigint_inbox_item.callsigns, '[]'::jsonb) ?| array[{selected_callsigns}]
        or coalesce(sigint_inbox_item.callsigns_alg2, '[]'::jsonb) ?| array[{selected_callsigns}]
    )
)
    )"#,
        watermark_key = CALLSIGN_BACKFILL_WATERMARK_KEY,
    )
}

pub fn sql_exists_condition(inbox_alias: &str) -> String {
    format!(
        r#"(
exists (
    select 1
    from sigint_inbox_item_callsign siic
    where siic.sigint_inbox_item_id = {inbox_alias}.id
      and not siic.deleted
)
or (
    {inbox_alias}.id > coalesce((
        select nullif(dk.v #>> '{{}}', '')::bigint
        from delta_kv dk
        where dk.k = '{watermark_key}'
    ), 0)
    and
    not exists (
        select 1
        from sigint_inbox_item_callsign siic
        where siic.sigint_inbox_item_id = {inbox_alias}.id
    )
    and (
        (jsonb_typeof({inbox_alias}.callsigns) = 'array'
            and {inbox_alias}.callsigns <> '[]'::jsonb)
        or (jsonb_typeof({inbox_alias}.callsigns_alg2) = 'array'
            and {inbox_alias}.callsigns_alg2 <> '[]'::jsonb)
    )
)
        )"#,
        watermark_key = CALLSIGN_BACKFILL_WATERMARK_KEY,
    )
}

pub async fn sync<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
    callsigns: InboxItemCallsigns,
    actor_id: Uuid,
) -> Result<InboxItemCallsigns, AppError>
where
    C: ConnectionTrait,
{
    let callsigns = callsigns.normalized();
    lock_parent(dbx, sigint_inbox_item_id).await?;
    let existing = sigint_inbox_item_callsign::Entity::find()
        .filter(
            sigint_inbox_item_callsign::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(dbx)
        .await
        .c(h!())?;

    sync_source(
        dbx,
        actor_id,
        sigint_inbox_item_id,
        SigintInboxItemCallsignSource::Primary,
        &callsigns.primary,
        &existing,
    )
    .await?;
    sync_source(
        dbx,
        actor_id,
        sigint_inbox_item_id,
        SigintInboxItemCallsignSource::Alg2,
        &callsigns.alg2,
        &existing,
    )
    .await?;
    Ok(callsigns)
}

async fn sync_backfill_batch<C>(
    dbx: &C,
    expected_callsigns: &[(i64, InboxItemCallsigns)],
    actor_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let item_ids = expected_callsigns
        .iter()
        .map(|(inbox_item_id, _)| *inbox_item_id)
        .collect::<Vec<_>>();
    let existing = sigint_inbox_item_callsign::Entity::find()
        .filter(
            sigint_inbox_item_callsign::Column::SigintInboxItemId
                .is_in(item_ids),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let expected_by_item_id = expected_callsigns
        .iter()
        .map(|(inbox_item_id, callsigns)| (*inbox_item_id, callsigns))
        .collect::<HashMap<_, _>>();
    let missing_ids = existing
        .iter()
        .filter(|row| {
            !row.deleted
                && !expected_by_item_id
                    .get(&row.sigint_inbox_item_id)
                    .is_some_and(|callsigns| {
                        callsigns_contains(
                            callsigns,
                            &row.source,
                            &row.callsign,
                        )
                    })
        })
        .map(|row| row.id)
        .collect::<Vec<_>>();
    if !missing_ids.is_empty() {
        sigint_inbox_item_callsign::Entity::update_many()
            .col_expr(
                sigint_inbox_item_callsign::Column::Deleted,
                Expr::value(true),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedAt,
                Expr::value(Utc::now().naive_utc()),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedById,
                Expr::value(actor_id),
            )
            .filter(sigint_inbox_item_callsign::Column::Id.is_in(missing_ids))
            .exec(dbx)
            .await
            .c(h!())?;
    }

    let callsigns = expected_callsigns
        .iter()
        .flat_map(|(inbox_item_id, callsigns)| {
            callsign_active_models(*inbox_item_id, callsigns, actor_id)
        })
        .collect::<Vec<_>>();
    for callsigns in callsigns
        .chunks(crate::config::INBOX_ITEM_CALLSIGN_SYNC_INSERT_BATCH_SIZE)
    {
        sigint_inbox_item_callsign::Entity::insert_many(callsigns.to_vec())
            .on_conflict(
                sea_query::OnConflict::columns([
                    sigint_inbox_item_callsign::Column::SigintInboxItemId,
                    sigint_inbox_item_callsign::Column::Source,
                    sigint_inbox_item_callsign::Column::Callsign,
                ])
                .update_columns([
                    sigint_inbox_item_callsign::Column::Ordering,
                    sigint_inbox_item_callsign::Column::Deleted,
                    sigint_inbox_item_callsign::Column::DeletedAt,
                    sigint_inbox_item_callsign::Column::DeletedById,
                ])
                .to_owned(),
            )
            .exec_without_returning(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

fn callsigns_contains(
    callsigns: &InboxItemCallsigns,
    source: &SigintInboxItemCallsignSource,
    callsign: &str,
) -> bool {
    let callsigns = match source {
        SigintInboxItemCallsignSource::Primary => &callsigns.primary,
        SigintInboxItemCallsignSource::Alg2 => &callsigns.alg2,
    };
    callsigns.iter().any(|expected| expected == callsign)
}

fn callsign_active_models(
    sigint_inbox_item_id: i64,
    callsigns: &InboxItemCallsigns,
    actor_id: Uuid,
) -> Vec<sigint_inbox_item_callsign::ActiveModel> {
    callsigns
        .primary
        .iter()
        .enumerate()
        .map(|(ordering, callsign)| {
            callsign_active_model(
                sigint_inbox_item_id,
                callsign.clone(),
                SigintInboxItemCallsignSource::Primary,
                ordering as f64,
                actor_id,
            )
        })
        .chain(
            callsigns
                .alg2
                .iter()
                .enumerate()
                .map(|(ordering, callsign)| {
                    callsign_active_model(
                        sigint_inbox_item_id,
                        callsign.clone(),
                        SigintInboxItemCallsignSource::Alg2,
                        ordering as f64,
                        actor_id,
                    )
                }),
        )
        .collect()
}

fn callsign_active_model(
    sigint_inbox_item_id: i64,
    callsign: String,
    source: SigintInboxItemCallsignSource,
    ordering: f64,
    actor_id: Uuid,
) -> sigint_inbox_item_callsign::ActiveModel {
    sigint_inbox_item_callsign::ActiveModel {
        id: NotSet,
        sigint_inbox_item_id: Set(sigint_inbox_item_id),
        callsign: Set(callsign),
        source: Set(source),
        ordering: Set(ordering),
        created_at: NotSet,
        deleted_at: Set(None),
        deleted: Set(false),
        created_by_id: Set(actor_id),
        deleted_by_id: Set(None),
    }
}

pub async fn load_by_item_ids<C>(
    dbx: &C,
    item_ids: &[i64],
) -> Result<HashMap<i64, InboxItemCallsigns>, AppError>
where
    C: ConnectionTrait,
{
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let watermark = backfill_watermark(dbx).await?;
    let item_ids = crate::utils::uniq_via_btreeset(item_ids);
    let mut result = HashMap::new();
    for item_ids in
        item_ids.chunks(crate::config::INBOX_ITEM_CALLSIGN_LOAD_BATCH_SIZE)
    {
        let rows = sigint_inbox_item_callsign::Entity::find()
            .filter(
                sigint_inbox_item_callsign::Column::SigintInboxItemId
                    .is_in(item_ids.to_vec()),
            )
            .order_by_asc(sigint_inbox_item_callsign::Column::SigintInboxItemId)
            .order_by_asc(sigint_inbox_item_callsign::Column::Source)
            .order_by_asc(sigint_inbox_item_callsign::Column::Ordering)
            .order_by_asc(sigint_inbox_item_callsign::Column::Id)
            .all(dbx)
            .await
            .c(h!())?;
        let normalized_item_ids = rows
            .iter()
            .map(|row| row.sigint_inbox_item_id)
            .collect::<HashSet<_>>();
        for row in rows {
            if row.deleted {
                continue;
            }
            let callsigns: &mut InboxItemCallsigns =
                result.entry(row.sigint_inbox_item_id).or_default();
            match row.source {
                SigintInboxItemCallsignSource::Primary => {
                    callsigns.primary.push(row.callsign)
                }
                SigintInboxItemCallsignSource::Alg2 => {
                    callsigns.alg2.push(row.callsign)
                }
            }
        }
        let fallback_item_ids = item_ids
            .iter()
            .filter(|item_id| {
                **item_id > watermark && !normalized_item_ids.contains(item_id)
            })
            .copied()
            .collect::<Vec<_>>();
        load_legacy_by_item_ids(dbx, &fallback_item_ids, &mut result).await?;
    }
    Ok(result)
}

async fn load_legacy_by_item_ids<C>(
    dbx: &C,
    item_ids: &[i64],
    result: &mut HashMap<i64, InboxItemCallsigns>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if item_ids.is_empty() {
        return Ok(());
    }
    let rows = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::Callsigns)
        .column(sigint_inbox_item::Column::CallsignsAlg2)
        .filter(sigint_inbox_item::Column::Id.is_in(item_ids.to_vec()))
        .into_model::<LegacyInboxItemCallsigns>()
        .all(dbx)
        .await
        .c(h!())?;
    for row in rows {
        result.insert(
            row.id,
            from_legacy_values(row.callsigns, row.callsigns_alg2)?,
        );
    }
    Ok(())
}

async fn lock_parent<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let row = dbx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select id from sigint_inbox_item where id = $1 for update",
            [sigint_inbox_item_id.into()],
        ))
        .await
        .c(h!())?;
    if row.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn sync_source<C>(
    dbx: &C,
    actor_id: Uuid,
    sigint_inbox_item_id: i64,
    source: SigintInboxItemCallsignSource,
    desired: &[String],
    existing: &[sigint_inbox_item_callsign::Model],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let desired_callsigns = desired.iter().collect::<HashSet<_>>();
    let missing_ids = existing
        .iter()
        .filter(|row| {
            row.source == source
                && !row.deleted
                && !desired_callsigns.contains(&row.callsign)
        })
        .map(|row| row.id)
        .collect::<Vec<_>>();
    if !missing_ids.is_empty() {
        sigint_inbox_item_callsign::Entity::update_many()
            .col_expr(
                sigint_inbox_item_callsign::Column::Deleted,
                Expr::value(true),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedAt,
                Expr::value(Utc::now().naive_utc()),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedById,
                Expr::value(actor_id),
            )
            .filter(sigint_inbox_item_callsign::Column::Id.is_in(missing_ids))
            .exec(dbx)
            .await
            .c(h!())?;
    }

    for (ordering, callsign) in desired.iter().cloned().enumerate() {
        let ordering = ordering as f64;
        let existing = existing
            .iter()
            .find(|row| row.source == source && row.callsign == callsign);
        if let Some(existing) = existing {
            if !existing.deleted && existing.ordering == ordering {
                continue;
            }
            let mut existing = existing.clone().into_active_model();
            if existing.ordering.as_ref() != &ordering {
                existing.ordering = Set(ordering);
            }
            if *existing.deleted.as_ref() {
                existing.deleted = Set(false);
                existing.deleted_at = Set(None);
                existing.deleted_by_id = Set(None);
            }
            existing.update(dbx).await.c(h!())?;
        } else {
            sigint_inbox_item_callsign::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(sigint_inbox_item_id),
                callsign: Set(callsign),
                source: Set(source.clone()),
                ordering: Set(ordering),
                created_at: NotSet,
                deleted_at: Set(None),
                deleted: Set(false),
                created_by_id: Set(actor_id),
                deleted_by_id: Set(None),
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

fn parse_legacy(value: Option<Json>) -> Result<Vec<String>, AppError> {
    let value = value.map(serde_json::from_value).transpose().c(h!())?;
    Ok(value.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_callsigns_prefer_primary_order() {
        let callsigns = InboxItemCallsigns {
            primary: vec!["alpha".into(), "bravo".into()],
            alg2: vec!["bravo".into(), "charlie".into()],
        };
        assert_eq!(callsigns.effective(), vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn legacy_sources_keep_order_and_effective_union_deduplicates() {
        let callsigns = from_legacy_values(
            Some(serde_json::json!(["alpha", "bravo"])),
            Some(serde_json::json!(["bravo", "charlie"])),
        )
        .unwrap();
        assert_eq!(callsigns.primary, vec!["alpha", "bravo"]);
        assert_eq!(callsigns.alg2, vec!["bravo", "charlie"]);
        assert_eq!(callsigns.effective(), vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn callsign_filter_escapes_sql_literals() {
        let condition = sql_filter_condition(&["call'sign".to_string()]);
        assert!(condition.contains("'call''sign'"));
        assert_eq!(condition.matches("and not siic.deleted").count(), 1);
        assert!(condition.contains("callsigns_alg2"));
    }

    #[test]
    fn callsign_existence_fallback_requires_no_normalized_rows() {
        let condition = sql_exists_condition("sigint_inbox_item");
        assert!(condition.contains("not exists"));
        assert_eq!(condition.matches("and not siic.deleted").count(), 1);
    }
}
