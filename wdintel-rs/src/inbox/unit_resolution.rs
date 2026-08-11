use crate::config::{
    FAILED_INBOX_UNIT_BACKFILL_BATCH_PAUSE_MS,
    FAILED_INBOX_UNIT_BACKFILL_BATCH_SIZE, FAILED_INBOX_UNIT_RETENTION_DAYS,
    FAILED_INBOX_UNIT_WORKER_BATCH_SIZE,
    FAILED_INBOX_UNIT_WORKER_ERROR_SLEEP_SECS,
    FAILED_INBOX_UNIT_WORKER_SLEEP_SECS,
};
use crate::entities::{
    failed_inbox_unit, orbit_unit, orbit_unit_echelon, orbit_unit_sigint_unit,
    sigint_inbox_item, sigint_unit, sigint_unit_label, signal_message,
};
use crate::{h, orbit};
use anyhow::Context;
use chrono::{Duration, NaiveDateTime, Utc};
use itertools::Itertools;
use log::warn;
use sea_orm::sea_query::{Expr, LockBehavior, LockType};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseConnection, EntityTrait, IntoActiveModel,
    JoinType, ModelTrait, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
    TransactionTrait,
};
use std::time::Duration as StdDuration;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StructuralResolution {
    Resolved(i64),
    NoMatch,
    Blocked,
}

pub(crate) fn normalize_unit_label(value: &str) -> String {
    value.split_whitespace().join(" ").trim().to_lowercase()
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn unresolved_text<'a>(
    unit_v2: Option<&'a str>,
    unit: Option<&'a str>,
) -> Option<&'a str> {
    nonempty(unit_v2).or_else(|| nonempty(unit))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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

    let mut query = orbit_unit::Entity::find()
        .find_also_related(orbit_unit_echelon::Entity)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::GenerativeUnitNameFull.is_not_null());
    for segment in segments {
        query = query.filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(orbit_unit.generative_unit_name_full), '[[:space:]]+', ' ', 'g')) like $1 escape '\\'",
            vec![format!("%{}%", escape_like(&segment))],
        ));
    }

    Ok(query
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|(unit, echelon)| echelon.map(|echelon| (unit, echelon)))
        .collect())
}

pub(crate) async fn active_sigint_unit_ids_for_orbit<C>(
    db: &C,
    orbit_unit_id: Uuid,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
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
        warn!("No supported ORBIT echelon for unit_v2={unit_v2:?}");
        return Ok(StructuralResolution::Blocked);
    };
    let candidates = candidates
        .into_iter()
        .filter(|(_, echelon)| *echelon == highest_echelon)
        .map(|(unit, _)| unit)
        .collect_vec();
    if candidates.len() != 1 {
        warn!(
            "Multiple ORBIT unit matches at the same echelon for unit_v2={unit_v2:?}: {:?}",
            candidates.iter().map(|unit| unit.unit_id).collect_vec()
        );
        return Ok(StructuralResolution::Blocked);
    }

    let orbit_unit_id = candidates[0].unit_id;
    let sigint_unit_ids = active_sigint_unit_ids_for_orbit(db, orbit_unit_id)
        .await
        .context(h!())?;
    if sigint_unit_ids.len() != 1 {
        warn!(
            "ORBIT unit {orbit_unit_id} matched unit_v2={unit_v2:?}, but has {} active, non-suppressed SIGINT links",
            sigint_unit_ids.len()
        );
        return Ok(StructuralResolution::Blocked);
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
        .filter(sigint_unit::Column::Active.eq(true))
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
            StructuralResolution::Blocked => return Ok(None),
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
    let existing = failed_inbox_unit::Entity::find()
        .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item_id))
        .one(db)
        .await
        .context(h!())?;
    let Some(existing) = existing else {
        failed_inbox_unit::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            deleted: Set(false),
            is_bad_data: Set(false),
            inbox_item_id: Set(inbox_item_id),
            unit_txt: Set(unit_txt.trim().to_string()),
            deleted_at: Set(None),
        }
        .insert(db)
        .await
        .context(h!())?;
        return Ok(());
    };

    let text_changed = normalize_unit_label(&existing.unit_txt)
        != normalize_unit_label(unit_txt);
    let mut existing = existing.into_active_model();
    existing.deleted = Set(false);
    existing.deleted_at = Set(None);
    existing.unit_txt = Set(unit_txt.trim().to_string());
    if text_changed {
        existing.is_bad_data = Set(false);
    }
    existing.update(db).await.context(h!())?;
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
    let sigint_unit_id = resolve_sigint_unit_id(db, unit_v2, unit)
        .await
        .context(h!())?;
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::SigintUnitId,
            Expr::value(sigint_unit_id),
        )
        .filter(sigint_inbox_item::Column::Id.eq(inbox_item_id))
        .exec(db)
        .await
        .context(h!())?;

    if sigint_unit_id.is_some() {
        mark_failure_resolved(db, inbox_item_id)
            .await
            .context(h!())?;
    } else if let Some(unit_txt) = unresolved_text(unit_v2, unit) {
        upsert_failure(db, inbox_item_id, unit_txt)
            .await
            .context(h!())?;
    } else {
        failed_inbox_unit::Entity::delete_many()
            .filter(failed_inbox_unit::Column::InboxItemId.eq(inbox_item_id))
            .exec(db)
            .await
            .context(h!())?;
    }
    Ok(sigint_unit_id)
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
    let current_text = unresolved_text(
        inbox_item.unit_v2.as_deref(),
        inbox_item.unit.as_deref(),
    );
    let sigint_unit_id = resolve_sigint_unit_id(
        db,
        inbox_item.unit_v2.as_deref(),
        inbox_item.unit.as_deref(),
    )
    .await
    .context(h!())?;
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::SigintUnitId,
            Expr::value(sigint_unit_id),
        )
        .filter(sigint_inbox_item::Column::Id.eq(inbox_item.id))
        .exec(db)
        .await
        .context(h!())?;
    if sigint_unit_id.is_some() || current_text.is_none() {
        failure.delete(db).await.context(h!())?;
        return Ok(());
    }

    let current_text = current_text.unwrap();
    let text_changed = normalize_unit_label(current_text)
        != normalize_unit_label(&failure.unit_txt);
    let failure_id = failure.id;
    let mut failure = failure.into_active_model();
    failure.deleted = Set(false);
    failure.deleted_at = Set(None);
    failure.unit_txt = Set(current_text.to_string());
    if text_changed {
        failure.is_bad_data = Set(false);
    }
    failure.update(db).await.context(h!())?;
    warn!(
        "Reactivated unresolved inbox unit failure id={} inbox_item_id={} after verification failed",
        failure_id,
        inbox_item.id
    );
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
        }
        last_id = items.last().unwrap().id;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn unique_unit_label() -> String {
        let number = Utc::now().timestamp_micros().unsigned_abs() % 8_000_000
            + 1_000_000;
        format!("{number} омсбр")
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
        crate::functest::tests::mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                unit_v2: Set(unit_v2.map(str::to_string)),
                unit: Set(unit.map(str::to_string)),
                sigint_unit_id: Set(sigint_unit_id),
                ..Default::default()
            },
        )
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
    fn unresolved_text_prefers_unit_v2() {
        assert_eq!(
            unresolved_text(Some(" 1 мсб "), Some("raw")),
            Some("1 мсб")
        );
        assert_eq!(unresolved_text(Some(" "), Some(" raw ")), Some("raw"));
    }

    #[tokio::test]
    #[serial]
    async fn exact_label_matching_normalizes_case_and_whitespace() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
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
    }

    #[tokio::test]
    #[serial]
    async fn structural_matching_prefers_the_highest_echelon() {
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
            Default::default(),
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
    async fn a_structural_match_without_one_link_does_not_use_a_label() {
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
            None
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

        let inbox_item = sigint_inbox_item::Entity::find_by_id(inbox_item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.sigint_unit_id, None);
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

        run_failed_inbox_unit_worker_once(&env.dbx).await.unwrap();

        let successful = sigint_inbox_item::Entity::find_by_id(successful.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(successful.sigint_unit_id, Some(sigint_unit.id));
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
