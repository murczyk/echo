use crate::config::{
    FAILED_INBOX_UNIT_BACKFILL_BATCH_PAUSE_MS,
    FAILED_INBOX_UNIT_BACKFILL_BATCH_SIZE, FAILED_INBOX_UNIT_RETENTION_DAYS,
    FAILED_INBOX_UNIT_WORKER_BATCH_SIZE,
    FAILED_INBOX_UNIT_WORKER_ERROR_SLEEP_SECS,
    FAILED_INBOX_UNIT_WORKER_SLEEP_SECS, INBOX_ITEM_UNIT_REPROCESS_BATCH_SIZE,
    INBOX_ITEM_UNIT_SYNC_INSERT_BATCH_SIZE,
    INBOX_ITEM_UNIT_SYNC_QUERY_BATCH_SIZE,
};
use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
use crate::entities::{
    failed_inbox_unit, orbit_unit, orbit_unit_echelon, orbit_unit_sigint_unit,
    sigint_inbox_item, sigint_inbox_item_network, sigint_inbox_item_unit,
    sigint_network, sigint_network_unit, sigint_unit, sigint_unit_label,
    signal_message,
};
use crate::{h, orbit};
use anyhow::Context;
use chrono::{Duration, NaiveDateTime, Utc};
use indicatif::ProgressBar;
use itertools::Itertools;
use log::{debug, info, warn};
use sea_orm::sea_query::{Expr, LockBehavior, LockType};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseConnection, EntityTrait, IntoActiveModel,
    JoinType, ModelTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
    QueryTrait, RelationTrait, TransactionTrait,
};
use std::collections::BTreeSet;
use std::time::Duration as StdDuration;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
enum StructuralResolution {
    Resolved(i64),
    NoMatch,
    Blocked(String),
}

pub(crate) fn normalize_unit_label(value: &str) -> String {
    value.split_whitespace().join(" ").trim().to_lowercase()
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Copy)]
enum UnitTextSource {
    UnitV2,
    Unit,
}

#[derive(Debug, Clone)]
struct UnitTextCandidate {
    text: String,
    source: UnitTextSource,
    is_fallback: bool,
}

#[derive(Debug, Clone)]
struct UnitTextResolution {
    text: String,
    sigint_unit_id: Option<i64>,
    is_fallback: bool,
}

fn resolution_texts(value: &str) -> Vec<(String, bool)> {
    let parsed = crate::unit::parse_library_unit(&value.to_string());
    let original = value.trim().to_string();
    if parsed.is_empty() {
        return vec![(original, false)];
    }
    let has_original = parsed.iter().any(|value| {
        normalize_unit_label(value) == normalize_unit_label(&original)
    });
    let mut texts = parsed.into_iter().map(|text| (text, false)).collect_vec();
    if !has_original {
        texts.push((original, true));
    }
    texts
}

fn unit_text_candidates(
    unit_v2: Option<&str>,
    unit: Option<&str>,
) -> Vec<UnitTextCandidate> {
    let (source, texts): (UnitTextSource, Vec<(String, bool)>) =
        if let Some(unit_v2) = nonempty(unit_v2) {
            (
                UnitTextSource::UnitV2,
                unit_v2.split(',').flat_map(resolution_texts).collect_vec(),
            )
        } else if let Some(unit) = nonempty(unit) {
            (UnitTextSource::Unit, vec![(unit.to_string(), false)])
        } else {
            return Vec::new();
        };

    texts
        .into_iter()
        .filter(|(text, _)| !text.is_empty())
        .map(|(text, is_fallback)| UnitTextCandidate {
            text,
            source,
            is_fallback,
        })
        .unique_by(|candidate| normalize_unit_label(&candidate.text))
        .collect_vec()
}

fn normalize_structural_text(value: &str) -> String {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .join(" ")
}

fn contains_structural_segment(value: &str, segment: &str) -> bool {
    let value = format!(" {} ", normalize_structural_text(value));
    let segment = format!(" {} ", normalize_structural_text(segment));
    value.contains(&segment)
}

async fn structural_candidates<C>(
    db: &C,
    unit_v2: &str,
) -> anyhow::Result<Vec<(orbit_unit::Model, orbit_unit_echelon::Model)>>
where
    C: ConnectionTrait,
{
    let segments = crate::unit::parse_library_unit_segments(unit_v2)
        .into_iter()
        .map(|segment| normalize_unit_label(&segment))
        .filter(|segment| !segment.is_empty())
        .unique()
        .collect_vec();
    if segments.is_empty() {
        return Ok(Vec::new());
    }
    let words = segments
        .iter()
        .flat_map(|segment| {
            segment
                .split(|character: char| !character.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .map(str::to_string)
        })
        .unique()
        .collect_vec();

    let mut query = orbit_unit::Entity::find()
        .find_also_related(orbit_unit_echelon::Entity)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::GenerativeUnitNameFull.is_not_null());
    for word in words {
        query = query.filter(
            orbit_unit::Column::GenerativeUnitNameFull
                .ilike(format!("%{word}%")),
        );
    }

    Ok(query
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|(unit, echelon)| echelon.map(|echelon| (unit, echelon)))
        .filter(|(unit, _)| {
            unit.generative_unit_name_full
                .as_deref()
                .is_some_and(|full_name| {
                    segments.iter().all(|segment| {
                        contains_structural_segment(full_name, segment)
                    })
                })
        })
        .collect())
}

async fn sigint_unit_ids_for_orbit<C>(
    db: &C,
    orbit_unit_id: Uuid,
    active_only: bool,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    let mut query = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false));
    if active_only {
        query = query.filter(sigint_unit::Column::Active.eq(true));
    }
    query
        .select_only()
        .column(orbit_unit_sigint_unit::Column::SigintUnitId)
        .distinct()
        .into_tuple::<i64>()
        .all(db)
        .await
        .context(h!())
}

async fn resolve_structurally<C>(
    db: &C,
    unit_v2: &str,
) -> anyhow::Result<StructuralResolution>
where
    C: ConnectionTrait,
{
    let candidates = structural_candidates(db, unit_v2).await.context(h!())?;
    if candidates.is_empty() {
        return Ok(StructuralResolution::NoMatch);
    }

    let candidates = candidates
        .into_iter()
        .filter_map(|(unit, echelon)| {
            orbit::echo_echelon(&echelon.key)
                .map(|echelon| (unit, echelon.index()))
        })
        .collect_vec();
    let Some(highest_echelon) =
        candidates.iter().map(|(_, echelon)| *echelon).max()
    else {
        return Ok(StructuralResolution::Blocked(format!(
            "no supported ORBIT echelon for unit_v2={unit_v2:?}",
        )));
    };
    let candidates = candidates
        .into_iter()
        .filter(|(_, echelon)| *echelon == highest_echelon)
        .map(|(unit, _)| unit)
        .collect_vec();
    if candidates.len() != 1 {
        return Ok(StructuralResolution::Blocked(format!(
            "Multiple ORBIT unit matches at the same echelon for unit_v2={unit_v2:?}: {:?}",
            candidates.iter().map(|unit| unit.unit_id).collect_vec()
        )));
    }

    let orbit_unit_id = candidates[0].unit_id;
    let sigint_unit_ids = sigint_unit_ids_for_orbit(db, orbit_unit_id, false)
        .await
        .context(h!())?;
    if sigint_unit_ids.len() != 1 {
        return Ok(StructuralResolution::Blocked(format!(
            "ORBIT unit {orbit_unit_id} matched unit_v2={unit_v2:?}, but has {} non-suppressed SIGINT links",
            sigint_unit_ids.len()
        )));
    }
    Ok(StructuralResolution::Resolved(sigint_unit_ids[0]))
}

async fn resolve_by_label<C>(db: &C, value: &str) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let normalized = normalize_unit_label(value);
    if normalized.is_empty() {
        return Ok(None);
    }
    let sigint_unit_ids = sigint_unit_label::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit_label::Relation::SigintUnit.def(),
        )
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(sigint_unit_label.label), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalized],
        ))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit_label::Column::SigintUnitId)
        .distinct()
        .into_tuple::<i64>()
        .all(db)
        .await
        .context(h!())?;
    if sigint_unit_ids.len() > 1 {
        warn!("Multiple SIGINT unit labels match value={value:?}");
        return Ok(None);
    }
    Ok(sigint_unit_ids.into_iter().next())
}

pub(crate) async fn resolve_sigint_unit_id<C>(
    db: &C,
    unit_v2: Option<&str>,
    unit: Option<&str>,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    if let Some(unit_v2) = nonempty(unit_v2) {
        match resolve_structurally(db, unit_v2).await.context(h!())? {
            StructuralResolution::Resolved(sigint_unit_id) => {
                return Ok(Some(sigint_unit_id));
            }
            StructuralResolution::Blocked(reason) => {
                let sigint_unit_id =
                    resolve_by_label(db, unit_v2).await.context(h!())?;
                if let Some(sigint_unit_id) = sigint_unit_id {
                    debug!(
                        "{reason}; resolved unit_v2={unit_v2:?} by SIGINT unit label to sigint_unit_id={sigint_unit_id}"
                    );
                } else {
                    warn!("{reason}; no SIGINT unit label fallback matched");
                }
                return Ok(sigint_unit_id);
            }
            StructuralResolution::NoMatch => {
                return resolve_by_label(db, unit_v2).await.context(h!());
            }
        }
    }
    match nonempty(unit) {
        Some(unit) => resolve_by_label(db, unit).await.context(h!()),
        None => Ok(None),
    }
}

async fn resolve_unit_text_candidates<C>(
    db: &C,
    unit_v2: Option<&str>,
    unit: Option<&str>,
) -> anyhow::Result<Vec<UnitTextResolution>>
where
    C: ConnectionTrait,
{
    let mut resolved = Vec::new();
    for candidate in unit_text_candidates(unit_v2, unit) {
        let sigint_unit_id = if candidate.is_fallback {
            resolve_by_label(db, &candidate.text).await.context(h!())?
        } else {
            match candidate.source {
                UnitTextSource::UnitV2 => {
                    resolve_sigint_unit_id(db, Some(&candidate.text), None)
                        .await
                        .context(h!())?
                }
                UnitTextSource::Unit => {
                    resolve_sigint_unit_id(db, None, Some(&candidate.text))
                        .await
                        .context(h!())?
                }
            }
        };
        resolved.push(UnitTextResolution {
            text: candidate.text,
            sigint_unit_id,
            is_fallback: candidate.is_fallback,
        });
    }
    Ok(resolved)
}

async fn mark_failure_resolved<C>(
    db: &C,
    inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    failed_inbox_unit::Entity::update_many()
        .col_expr(failed_inbox_unit::Column::Deleted, Expr::value(true))
        .col_expr(
            failed_inbox_unit::Column::DeletedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item_id))
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .exec(db)
        .await
        .context(h!())?;
    Ok(())
}

async fn upsert_failure<C>(
    db: &C,
    inbox_item_id: i64,
    unit_txt: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let normalized_unit_txt = normalize_unit_label(unit_txt);
    let existing = failed_inbox_unit::Entity::find()
        .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item_id))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(failed_inbox_unit.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalized_unit_txt.clone()],
        ))
        .order_by_asc(failed_inbox_unit::Column::Id)
        .one(db)
        .await
        .context(h!())?;
    let group_metadata = failed_inbox_unit::Entity::find()
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(failed_inbox_unit.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalized_unit_txt],
        ))
        .order_by_desc(failed_inbox_unit::Column::IsBadData)
        .order_by_desc(failed_inbox_unit::Column::Id)
        .one(db)
        .await
        .context(h!())?;
    let (is_bad_data, note) = group_metadata
        .as_ref()
        .or(existing.as_ref())
        .map(|failure| (failure.is_bad_data, failure.note.clone()))
        .unwrap_or_default();
    let Some(existing) = existing else {
        failed_inbox_unit::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            deleted: Set(false),
            is_bad_data: Set(is_bad_data),
            inbox_item_id: Set(inbox_item_id),
            unit_txt: Set(unit_txt.trim().to_string()),
            deleted_at: Set(None),
            note: Set(note),
        }
        .insert(db)
        .await
        .context(h!())?;
        return Ok(());
    };

    let mut existing = existing.into_active_model();
    existing.deleted = Set(false);
    existing.deleted_at = Set(None);
    existing.unit_txt = Set(unit_txt.trim().to_string());
    existing.is_bad_data = Set(is_bad_data);
    existing.note = Set(note);
    existing.update(db).await.context(h!())?;
    Ok(())
}

async fn replace_parsed_unit_links<C>(
    db: &C,
    inbox_item_id: i64,
    sigint_unit_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_unit::Entity::delete_many()
        .filter(sigint_inbox_item_unit::Column::ItemId.eq(inbox_item_id))
        .filter(
            sigint_inbox_item_unit::Column::Kind
                .eq(SigintInboxItemUnitKind::Parsed),
        )
        .exec(db)
        .await
        .context(h!())?;

    let unit_links = sigint_unit_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|sigint_unit_id| sigint_inbox_item_unit::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            item_id: Set(inbox_item_id),
            unit_id: Set(sigint_unit_id),
            kind: Set(SigintInboxItemUnitKind::Parsed),
        })
        .collect_vec();
    if !unit_links.is_empty() {
        sigint_inbox_item_unit::Entity::insert_many(unit_links)
            .exec_without_returning(db)
            .await
            .context(h!())?;
    }
    Ok(())
}

async fn network_unit_links<C>(
    db: &C,
    inbox_item_ids: &[i64],
) -> anyhow::Result<Vec<(i64, i64)>>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(inbox_item_ids.to_vec()),
        )
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintInboxItemId)
        .column(sigint_network_unit::Column::UnitId)
        .distinct()
        .into_tuple::<(i64, i64)>()
        .all(db)
        .await
        .context(h!())
}

pub(crate) async fn sync_network_unit_links<C>(
    db: &C,
    inbox_item_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for inbox_item_ids in
        inbox_item_ids.chunks(INBOX_ITEM_UNIT_SYNC_QUERY_BATCH_SIZE)
    {
        sigint_inbox_item_unit::Entity::delete_many()
            .filter(
                sigint_inbox_item_unit::Column::ItemId
                    .is_in(inbox_item_ids.to_vec()),
            )
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Network),
            )
            .exec(db)
            .await
            .context(h!())?;
        let unit_links = network_unit_links(db, inbox_item_ids)
            .await
            .context(h!())?
            .into_iter()
            .map(|(item_id, unit_id)| sigint_inbox_item_unit::ActiveModel {
                id: NotSet,
                created_at: NotSet,
                item_id: Set(item_id),
                unit_id: Set(unit_id),
                kind: Set(SigintInboxItemUnitKind::Network),
            })
            .collect_vec();
        for unit_links in
            unit_links.chunks(INBOX_ITEM_UNIT_SYNC_INSERT_BATCH_SIZE)
        {
            sigint_inbox_item_unit::Entity::insert_many(unit_links.to_vec())
                .exec_without_returning(db)
                .await
                .context(h!())?;
        }
    }
    Ok(())
}

pub(crate) async fn resolve_and_sync_inbox_item<C>(
    db: &C,
    inbox_item_id: i64,
    unit_v2: Option<&str>,
    unit: Option<&str>,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let resolved_unit_texts = resolve_unit_text_candidates(db, unit_v2, unit)
        .await
        .context(h!())?;
    let sigint_unit_ids = resolved_unit_texts
        .iter()
        .filter_map(|resolution| resolution.sigint_unit_id)
        .collect_vec();
    replace_parsed_unit_links(db, inbox_item_id, &sigint_unit_ids)
        .await
        .context(h!())?;

    if resolved_unit_texts.is_empty() {
        failed_inbox_unit::Entity::delete_many()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item_id))
            .exec(db)
            .await
            .context(h!())?;
    } else {
        mark_failure_resolved(db, inbox_item_id)
            .await
            .context(h!())?;
        for resolution in resolved_unit_texts {
            if resolution.sigint_unit_id.is_none() && !resolution.is_fallback {
                upsert_failure(db, inbox_item_id, &resolution.text)
                    .await
                    .context(h!())?;
            }
        }
    }
    Ok(sigint_unit_ids.into_iter().next())
}

pub(crate) async fn mark_failures_pending_for_text<C>(
    db: &C,
    unit_txt: &str,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let result = failed_inbox_unit::Entity::update_many()
        .col_expr(failed_inbox_unit::Column::Deleted, Expr::value(true))
        .col_expr(
            failed_inbox_unit::Column::DeletedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .filter(failed_inbox_unit::Column::IsBadData.eq(false))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(failed_inbox_unit.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalize_unit_label(unit_txt)],
        ))
        .exec(db)
        .await
        .context(h!())?;
    Ok(result.rows_affected)
}

pub(crate) async fn reprocess_inbox_items_for_text<C>(
    db: &C,
    unit_txt: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let normalized_unit_txt = normalize_unit_label(unit_txt);
    let mut last_id = None;
    loop {
        let items = sigint_inbox_item::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintInboxItemUnit.def(),
            )
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Parsed),
            )
            .filter(Expr::cust_with_values(
                "exists (select 1 from regexp_split_to_table(coalesce(nullif(btrim(sigint_inbox_item.unit_v2), ''), sigint_inbox_item.unit), ',') as unit_part(unit_txt) where lower(regexp_replace(btrim(unit_part.unit_txt), '[[:space:]]+', ' ', 'g')) = $1)",
                vec![normalized_unit_txt.clone()],
            ))
            .apply_if(last_id, |query, last_id| {
                query.filter(sigint_inbox_item::Column::Id.gt(last_id))
            })
            .order_by_asc(sigint_inbox_item::Column::Id)
            .distinct()
            .limit(INBOX_ITEM_UNIT_REPROCESS_BATCH_SIZE)
            .all(db)
            .await
            .context(h!())?;
        if items.is_empty() {
            break;
        }
        for item in items {
            last_id = Some(item.id);
            resolve_and_sync_inbox_item(
                db,
                item.id,
                item.unit_v2.as_deref(),
                item.unit.as_deref(),
            )
            .await
            .context(h!())?;
        }
    }
    Ok(())
}

async fn verify_pending_failure<C>(
    db: &C,
    failure: failed_inbox_unit::Model,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let Some(inbox_item) =
        sigint_inbox_item::Entity::find_by_id(failure.inbox_item_id)
            .one(db)
            .await
            .context(h!())?
    else {
        failure.delete(db).await.context(h!())?;
        return Ok(());
    };
    let failure_id = failure.id;
    resolve_and_sync_inbox_item(
        db,
        inbox_item.id,
        inbox_item.unit_v2.as_deref(),
        inbox_item.unit.as_deref(),
    )
    .await
    .context(h!())?;
    match failed_inbox_unit::Entity::find_by_id(failure_id)
        .one(db)
        .await
        .context(h!())?
    {
        Some(failure) if failure.deleted => {
            failure.delete(db).await.context(h!())?;
        }
        Some(_) => {
            warn!(
                "Reactivated unresolved inbox unit failure id={} inbox_item_id={} after verification failed",
                failure_id, inbox_item.id
            );
        }
        None => {}
    }
    Ok(())
}

pub(crate) async fn run_failed_inbox_unit_worker_once(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let transaction = db.begin().await.context(h!())?;
    let cleanup_before = Utc::now().naive_utc()
        - Duration::days(FAILED_INBOX_UNIT_RETENTION_DAYS);
    failed_inbox_unit::Entity::delete_many()
        .filter(failed_inbox_unit::Column::Deleted.eq(true))
        .filter(failed_inbox_unit::Column::DeletedAt.lte(cleanup_before))
        .exec(&transaction)
        .await
        .context(h!())?;

    let failures = failed_inbox_unit::Entity::find()
        .filter(failed_inbox_unit::Column::Deleted.eq(true))
        .filter(failed_inbox_unit::Column::IsBadData.eq(false))
        .order_by_asc(failed_inbox_unit::Column::DeletedAt)
        .order_by_asc(failed_inbox_unit::Column::Id)
        .limit(FAILED_INBOX_UNIT_WORKER_BATCH_SIZE)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .all(&transaction)
        .await
        .context(h!())?;
    for failure in failures {
        verify_pending_failure(&transaction, failure)
            .await
            .context(h!())?;
    }
    transaction.commit().await.context(h!())?;
    Ok(())
}

pub(crate) async fn failed_inbox_unit_worker_nofail(db: DatabaseConnection) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("failed_inbox_unit_worker");
        if let Err(error) = run_failed_inbox_unit_worker_once(&db).await {
            warn!("Failed inbox unit verification worker error: {error:#?}");
            tokio::time::sleep(StdDuration::from_secs(
                FAILED_INBOX_UNIT_WORKER_ERROR_SLEEP_SECS,
            ))
            .await;
            continue;
        }
        tokio::time::sleep(StdDuration::from_secs(
            FAILED_INBOX_UNIT_WORKER_SLEEP_SECS,
        ))
        .await;
    }
}

pub(crate) async fn backfill_inbox_unit_links(
    db: &DatabaseConnection,
    start_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    progress: Option<&ProgressBar>,
) -> anyhow::Result<u64> {
    if start_ts >= till_ts {
        anyhow::bail!("start_ts must be earlier than till_ts");
    }
    let mut last_id = 0_i64;
    let mut processed = 0_u64;
    loop {
        let items = sigint_inbox_item::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .filter(sigint_inbox_item::Column::Id.gt(last_id))
            .filter(signal_message::Column::CreatedAt.gte(start_ts))
            .filter(signal_message::Column::CreatedAt.lt(till_ts))
            .order_by_asc(sigint_inbox_item::Column::Id)
            .limit(FAILED_INBOX_UNIT_BACKFILL_BATCH_SIZE)
            .all(db)
            .await
            .context(h!())?;
        if items.is_empty() {
            break;
        }
        let item_ids = items.iter().map(|item| item.id).collect_vec();
        for item in &items {
            resolve_and_sync_inbox_item(
                db,
                item.id,
                item.unit_v2.as_deref(),
                item.unit.as_deref(),
            )
            .await
            .context(h!())?;
            processed += 1;
            if let Some(progress) = progress {
                progress.inc(1);
            }
        }
        sync_network_unit_links(db, &item_ids).await.context(h!())?;
        last_id = items.last().unwrap().id;
        info!(
            "backfilled inbox unit links batch: processed={processed}, last_inbox_item_id={last_id}"
        );
        if let Some(progress) = progress {
            progress.set_message(format!("last inbox item {last_id}"));
        }
        if items.len()
            == usize::try_from(FAILED_INBOX_UNIT_BACKFILL_BATCH_SIZE)
                .context(h!())?
        {
            tokio::time::sleep(StdDuration::from_millis(
                FAILED_INBOX_UNIT_BACKFILL_BATCH_PAUSE_MS,
            ))
            .await;
        }
    }
    Ok(processed)
}

pub(crate) async fn count_inbox_unit_link_backfill_items(
    db: &DatabaseConnection,
    start_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> anyhow::Result<u64> {
    if start_ts >= till_ts {
        anyhow::bail!("start_ts must be earlier than till_ts");
    }
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::CreatedAt.gte(start_ts))
        .filter(signal_message::Column::CreatedAt.lt(till_ts))
        .count(db)
        .await
        .context(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn unique_unit_label() -> String {
        let number = Utc::now().timestamp_micros().unsigned_abs() % 8_000_000
            + 1_000_000;
        format!("{number} омсбр")
    }

    fn unique_unit_labels() -> [String; 2] {
        let number = Utc::now().timestamp_micros().unsigned_abs() % 7_000_000
            + 1_000_000;
        [format!("{number} омсбр"), format!("{} омсбр", number + 1)]
    }

    async fn insert_orbit_unit(
        db: &DatabaseConnection,
        generative_unit_name_full: &str,
        operational_unit_name_full: Option<&str>,
        echelon_key: &str,
        sigint_unit_ids: &[i64],
    ) -> Uuid {
        let echelon = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq(echelon_key))
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let unit_id = Uuid::new_v4();
        let now = Utc::now().naive_utc();
        orbit_unit::ActiveModel {
            unit_id: Set(unit_id),
            operational_unit_name_full: Set(
                operational_unit_name_full.map(str::to_string)
            ),
            generative_unit_name_full: Set(Some(
                generative_unit_name_full.to_string(),
            )),
            unit_echelon_id: Set(Some(echelon.id)),
            deleted: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        for sigint_unit_id in sigint_unit_ids {
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(unit_id),
                sigint_unit_id: Set(*sigint_unit_id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            }
            .insert(db)
            .await
            .unwrap();
        }
        unit_id
    }

    async fn delete_orbit_units(db: &DatabaseConnection, unit_ids: Vec<Uuid>) {
        orbit_unit::Entity::delete_many()
            .filter(orbit_unit::Column::UnitId.is_in(unit_ids))
            .exec(db)
            .await
            .unwrap();
    }

    async fn insert_inbox_item(
        db: &DatabaseConnection,
        unit_v2: Option<&str>,
        unit: Option<&str>,
        sigint_unit_id: Option<i64>,
    ) -> sigint_inbox_item::Model {
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                unit_v2: Set(unit_v2.map(str::to_string)),
                unit: Set(unit.map(str::to_string)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if let Some(sigint_unit_id) = sigint_unit_id {
            sigint_inbox_item_unit::ActiveModel {
                item_id: Set(inbox_item.id),
                unit_id: Set(sigint_unit_id),
                kind: Set(SigintInboxItemUnitKind::Parsed),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
        inbox_item
    }

    async fn unit_ids_for_kind(
        db: &DatabaseConnection,
        inbox_item_id: i64,
        kind: SigintInboxItemUnitKind,
    ) -> Vec<i64> {
        sigint_inbox_item_unit::Entity::find()
            .filter(sigint_inbox_item_unit::Column::ItemId.eq(inbox_item_id))
            .filter(sigint_inbox_item_unit::Column::Kind.eq(kind))
            .order_by_asc(sigint_inbox_item_unit::Column::UnitId)
            .select_only()
            .column(sigint_inbox_item_unit::Column::UnitId)
            .into_tuple::<i64>()
            .all(db)
            .await
            .unwrap()
    }

    #[test]
    fn normalizes_case_and_whitespace() {
        assert_eq!(
            normalize_unit_label("  1 МСБ\n 123 омсбр "),
            "1 мсб 123 омсбр"
        );
    }

    #[test]
    fn structural_segments_match_only_complete_words() {
        assert!(contains_structural_segment("1 омсбр / 20 ЗВА", "1 ОМСБР"));
        assert!(!contains_structural_segment("11 омсбр", "1 омсбр"));
    }

    #[test]
    fn unit_text_candidates_split_unit_v2_and_prefer_it_over_unit() {
        assert_eq!(
            unit_text_candidates(Some(" 1 мсб, 2 мсб, 1 мсб "), Some("raw"))
                .into_iter()
                .map(|candidate| candidate.text)
                .collect_vec(),
            vec!["1 мсб", "2 мсб"]
        );
        assert_eq!(
            unit_text_candidates(Some(" "), Some(" raw "))
                .into_iter()
                .map(|candidate| candidate.text)
                .collect_vec(),
            vec!["raw"]
        );
    }

    #[test]
    fn resolution_texts_keeps_original_label_as_fallback() {
        assert_eq!(
            resolution_texts("  власний тег 123 омсбр  "),
            vec![
                ("123 омсбр".to_string(), false),
                ("власний тег 123 омсбр".to_string(), true)
            ]
        );
        assert_eq!(
            resolution_texts("123 ОМСБР"),
            vec![("123 омсбр".to_string(), false)]
        );
    }

    #[tokio::test]
    #[serial]
    async fn inactive_exact_label_matching_normalizes_case_and_whitespace() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(unit.id),
            label: Set("  Власний   Тег  ".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some("власний\nтег"), None)
                .await
                .unwrap(),
            Some(unit.id)
        );
        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some("власний тег зайве"), None)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some("333 мсб власний тег"), None)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    #[serial]
    async fn comma_separated_unit_v2_syncs_each_text_independently() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let first_label = format!("multi-first-{}", Uuid::new_v4());
        let second_label = format!("multi-second-{}", Uuid::new_v4());
        let missing_label = format!("multi-missing-{}", Uuid::new_v4());
        for (unit, label) in [(&first, &first_label), (&second, &second_label)]
        {
            sigint_unit_label::ActiveModel {
                sigint_unit_id: Set(unit.id),
                label: Set(label.to_string()),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        let item = insert_inbox_item(
            &env.dbx,
            Some(&format!(" {first_label}, {missing_label}, {second_label} ")),
            None,
            None,
        )
        .await;

        resolve_and_sync_inbox_item(
            &env.dbx,
            item.id,
            item.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                item.id,
                SigintInboxItemUnitKind::Parsed,
            )
            .await,
            vec![first.id, second.id]
        );
        let failures = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(item.id))
            .filter(failed_inbox_unit::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(
            normalize_unit_label(&failures[0].unit_txt),
            normalize_unit_label(&missing_label)
        );
    }

    #[tokio::test]
    #[serial]
    async fn resolved_parser_texts_do_not_queue_unresolved_fallback() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let labels = unique_unit_labels();
        for (unit, label) in [(&first, &labels[0]), (&second, &labels[1])] {
            sigint_unit_label::ActiveModel {
                sigint_unit_id: Set(unit.id),
                label: Set(label.clone()),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        let unit_v2 = labels.join(" та ");
        let item =
            insert_inbox_item(&env.dbx, Some(&unit_v2), None, None).await;

        resolve_and_sync_inbox_item(
            &env.dbx,
            item.id,
            item.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        let mut expected = vec![first.id, second.id];
        expected.sort();
        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                item.id,
                SigintInboxItemUnitKind::Parsed,
            )
            .await,
            expected
        );
        assert!(failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(item.id))
            .filter(failed_inbox_unit::Column::Deleted.eq(false))
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn reprocessing_preserves_archived_failure_metadata() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let label = format!("archived-failure-{}", Uuid::new_v4());
        let first = insert_inbox_item(&env.dbx, Some(&label), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            first.id,
            first.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        let failure = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(first.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut failure = failure.into_active_model();
        failure.is_bad_data = Set(true);
        failure.note = Set("keep this note".to_string());
        failure.update(&env.dbx).await.unwrap();

        resolve_and_sync_inbox_item(
            &env.dbx,
            first.id,
            first.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        let second =
            insert_inbox_item(&env.dbx, Some(&label), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            second.id,
            second.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        let failures = failed_inbox_unit::Entity::find()
            .filter(
                failed_inbox_unit::Column::InboxItemId
                    .is_in([first.id, second.id]),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().all(|failure| failure.is_bad_data));
        assert!(failures
            .iter()
            .all(|failure| failure.note == "keep this note"));
    }

    #[tokio::test]
    #[serial]
    async fn structural_matching_prefers_inactive_unit_at_highest_echelon() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let battalion = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let brigade = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let label = unique_unit_label();
        let battalion_orbit = insert_orbit_unit(
            &env.dbx,
            &format!("1 мсб / {label}"),
            None,
            "battalion",
            &[battalion.id],
        )
        .await;
        let brigade_orbit = insert_orbit_unit(
            &env.dbx,
            &label.to_uppercase(),
            None,
            "brigade",
            &[brigade.id],
        )
        .await;

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&label), None)
                .await
                .unwrap(),
            Some(brigade.id)
        );
        delete_orbit_units(&env.dbx, vec![battalion_orbit, brigade_orbit])
            .await;
    }

    #[tokio::test]
    #[serial]
    async fn same_highest_echelon_is_left_unresolved() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = unique_unit_label();
        let first_orbit =
            insert_orbit_unit(&env.dbx, &label, None, "brigade", &[first.id])
                .await;
        let second_orbit = insert_orbit_unit(
            &env.dbx,
            &format!("резерв / {label}"),
            None,
            "brigade",
            &[second.id],
        )
        .await;

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&label), None)
                .await
                .unwrap(),
            None
        );
        delete_orbit_units(&env.dbx, vec![first_orbit, second_orbit]).await;
    }

    #[tokio::test]
    #[serial]
    async fn an_exact_label_disambiguates_a_blocked_structural_match() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let label_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = unique_unit_label();
        sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(label_unit.id),
            label: Set(label.clone()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let orbit_unit = insert_orbit_unit(
            &env.dbx,
            &label,
            Some("unrelated operational name"),
            "brigade",
            &[],
        )
        .await;

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&label), None)
                .await
                .unwrap(),
            Some(label_unit.id)
        );
        delete_orbit_units(&env.dbx, vec![orbit_unit]).await;
    }

    #[tokio::test]
    #[serial]
    async fn operational_full_name_is_not_a_structural_match() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = unique_unit_label();
        let orbit_unit = insert_orbit_unit(
            &env.dbx,
            "different structural hierarchy",
            Some(&label),
            "brigade",
            &[unit.id],
        )
        .await;

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&label), None)
                .await
                .unwrap(),
            None
        );
        delete_orbit_units(&env.dbx, vec![orbit_unit]).await;
    }

    #[tokio::test]
    #[serial]
    async fn unresolved_sync_clears_stale_links_and_deduplicates_failures() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let stale_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let inbox_item = insert_inbox_item(
            &env.dbx,
            None,
            Some("  невідомий   сирий підрозділ "),
            Some(stale_unit.id),
        )
        .await;

        for _ in 0..2 {
            assert_eq!(
                resolve_and_sync_inbox_item(
                    &env.dbx,
                    inbox_item.id,
                    None,
                    inbox_item.unit.as_deref(),
                )
                .await
                .unwrap(),
                None
            );
        }

        assert!(unit_ids_for_kind(
            &env.dbx,
            inbox_item.id,
            SigintInboxItemUnitKind::Parsed,
        )
        .await
        .is_empty());
        let failures = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item.id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].unit_txt, "невідомий   сирий підрозділ");
        assert!(!failures[0].deleted);
    }

    #[tokio::test]
    #[serial]
    async fn new_failures_inherit_bad_data_classification() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first =
            insert_inbox_item(&env.dbx, None, Some("bad unit text"), None)
                .await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            first.id,
            None,
            first.unit.as_deref(),
        )
        .await
        .unwrap();
        failed_inbox_unit::Entity::update_many()
            .col_expr(failed_inbox_unit::Column::IsBadData, Expr::value(true))
            .filter(failed_inbox_unit::Column::InboxItemId.eq(first.id))
            .exec(&env.dbx)
            .await
            .unwrap();

        let second =
            insert_inbox_item(&env.dbx, None, Some(" BAD   UNIT TEXT "), None)
                .await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            second.id,
            None,
            second.unit.as_deref(),
        )
        .await
        .unwrap();

        let failure = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(second.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(failure.is_bad_data);
    }

    #[tokio::test]
    #[serial]
    async fn network_sync_stores_distinct_union_and_removes_stale_units() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let first_network = crate::functest::tests::mk_sigint_network(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second_network = crate::functest::tests::mk_sigint_network(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        for (network_id, unit_id) in [
            (first_network.id, first_unit.id),
            (first_network.id, second_unit.id),
            (second_network.id, second_unit.id),
        ] {
            crate::functest::tests::mk_sigint_network_unit(
                &env.dbx,
                sigint_network_unit::ActiveModel {
                    network_id: Set(network_id),
                    unit_id: Set(unit_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let inbox_item = insert_inbox_item(&env.dbx, None, None, None).await;
        for network_id in [first_network.id, second_network.id] {
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network_id),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        sync_network_unit_links(&env.dbx, &[inbox_item.id])
            .await
            .unwrap();

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                inbox_item.id,
                SigintInboxItemUnitKind::Network,
            )
            .await,
            vec![first_unit.id, second_unit.id]
        );

        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(inbox_item.id),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintNetworkId
                    .eq(first_network.id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        sync_network_unit_links(&env.dbx, &[inbox_item.id])
            .await
            .unwrap();

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                inbox_item.id,
                SigintInboxItemUnitKind::Network,
            )
            .await,
            vec![second_unit.id]
        );
    }

    #[tokio::test]
    #[serial]
    async fn backfill_syncs_network_derived_unit_links() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let network = crate::functest::tests::mk_sigint_network(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        crate::functest::tests::mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = insert_inbox_item(&env.dbx, None, None, None).await;
        sigint_inbox_item_network::ActiveModel {
            sigint_inbox_item_id: Set(inbox_item.id),
            sigint_network_id: Set(network.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let now = Utc::now().naive_utc();

        assert_eq!(
            backfill_inbox_unit_links(
                &env.dbx,
                now - Duration::minutes(1),
                now + Duration::minutes(1),
                None,
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                inbox_item.id,
                SigintInboxItemUnitKind::Network,
            )
            .await,
            vec![unit.id]
        );
    }

    #[tokio::test]
    #[serial]
    async fn verification_worker_deletes_successes_and_reactivates_failures() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let sigint_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = format!("worker-label-{}", Uuid::new_v4());
        let successful =
            insert_inbox_item(&env.dbx, Some(&label), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            successful.id,
            successful.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        crate::sigint::unit::labels::insert_label(
            &env.dbx,
            sigint_unit.id,
            &label,
        )
        .await
        .unwrap();
        assert_eq!(
            mark_failures_pending_for_text(&env.dbx, &label)
                .await
                .unwrap(),
            1
        );

        let unresolved_label = format!("worker-unresolved-{}", Uuid::new_v4());
        let unresolved =
            insert_inbox_item(&env.dbx, Some(&unresolved_label), None, None)
                .await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            unresolved.id,
            unresolved.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        mark_failures_pending_for_text(&env.dbx, &unresolved_label)
            .await
            .unwrap();

        let stale_label = format!("worker-stale-{}", Uuid::new_v4());
        let current_label = format!("worker-current-{}", Uuid::new_v4());
        let stale =
            insert_inbox_item(&env.dbx, Some(&stale_label), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            stale.id,
            stale.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        mark_failures_pending_for_text(&env.dbx, &stale_label)
            .await
            .unwrap();
        let stale_id = stale.id;
        let mut stale = stale.into_active_model();
        stale.unit_v2 = Set(Some(current_label.clone()));
        stale.update(&env.dbx).await.unwrap();

        run_failed_inbox_unit_worker_once(&env.dbx).await.unwrap();

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                successful.id,
                SigintInboxItemUnitKind::Parsed,
            )
            .await,
            vec![sigint_unit.id]
        );
        assert!(failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(successful.id),)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());

        let failure = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(unresolved.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!failure.deleted);
        assert_eq!(failure.deleted_at, None);

        let failures = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(stale_id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(
            normalize_unit_label(&failures[0].unit_txt),
            normalize_unit_label(&current_label)
        );
        assert!(!failures[0].deleted);
    }

    #[tokio::test]
    #[serial]
    async fn verification_worker_cleans_old_pending_rows_and_skips_bad_data() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let old_item = insert_inbox_item(
            &env.dbx,
            Some("old-pending-worker-label"),
            None,
            None,
        )
        .await;
        let bad_item = insert_inbox_item(
            &env.dbx,
            Some("bad-pending-worker-label"),
            None,
            None,
        )
        .await;
        for (inbox_item_id, is_bad_data, deleted_at) in [
            (
                old_item.id,
                false,
                Utc::now().naive_utc()
                    - Duration::days(FAILED_INBOX_UNIT_RETENTION_DAYS + 1),
            ),
            (bad_item.id, true, Utc::now().naive_utc()),
        ] {
            failed_inbox_unit::ActiveModel {
                deleted: Set(true),
                is_bad_data: Set(is_bad_data),
                inbox_item_id: Set(inbox_item_id),
                unit_txt: Set(format!("pending-{inbox_item_id}")),
                deleted_at: Set(Some(deleted_at)),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        run_failed_inbox_unit_worker_once(&env.dbx).await.unwrap();

        assert!(failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(old_item.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let bad_failure = failed_inbox_unit::Entity::find()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(bad_item.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(bad_failure.deleted);
        assert!(bad_failure.is_bad_data);
    }
}
