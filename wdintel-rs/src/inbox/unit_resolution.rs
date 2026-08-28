use crate::config::{
    FAILED_INBOX_UNIT_AUTO_ARCHIVE_PATTERNS,
    FAILED_INBOX_UNIT_AUTO_ARCHIVE_WORDS,
    FAILED_INBOX_UNIT_BACKFILL_BATCH_PAUSE_MS,
    FAILED_INBOX_UNIT_BACKFILL_BATCH_SIZE, FAILED_INBOX_UNIT_RETENTION_DAYS,
    FAILED_INBOX_UNIT_WORKER_BATCH_SIZE,
    FAILED_INBOX_UNIT_WORKER_ERROR_SLEEP_SECS,
    FAILED_INBOX_UNIT_WORKER_SLEEP_SECS, INBOX_ITEM_UNIT_REPROCESS_BATCH_SIZE,
    INBOX_ITEM_UNIT_SYNC_INSERT_BATCH_SIZE,
    INBOX_ITEM_UNIT_SYNC_QUERY_BATCH_SIZE,
    INBOX_UNIT_EQUIVALENT_NAME_VARIANT_LIMIT,
};
use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
use crate::entities::{
    failed_unit_label, orbit_unit, orbit_unit_echelon, orbit_unit_sigint_unit,
    sigint_inbox_item, sigint_inbox_item_failed_unit_label,
    sigint_inbox_item_network, sigint_inbox_item_unit, sigint_network,
    sigint_network_unit, sigint_unit, sigint_unit_label, signal_message,
};
use crate::{h, orbit};
use anyhow::Context;
use chrono::{Duration, NaiveDateTime, Utc};
use indicatif::ProgressBar;
use itertools::Itertools;
use lazy_static::lazy_static;
use log::{debug, info, warn};
use regex::RegexBuilder;
use sea_orm::sea_query::{Expr, LockBehavior, LockType, OnConflict};
use sea_orm::{
    ActiveValue::NotSet, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, EntityTrait, ExprTrait, JoinType, ModelTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait,
    RelationTrait, TransactionTrait,
};
use std::collections::{BTreeSet, HashMap};
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
    source_text: String,
    source: UnitTextSource,
    is_fallback: bool,
}

#[derive(Debug, Clone)]
struct UnitTextResolution {
    text: String,
    source_text: String,
    sigint_unit_id: Option<i64>,
    is_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UnitTextResolutionCacheKey {
    unit_v2: Option<String>,
    unit: Option<String>,
}

type FailureMetadata = (bool, String);
type FailureMetadataCache = HashMap<String, FailureMetadata>;

#[derive(Default)]
struct InboxUnitBackfillCache {
    unit_text_resolutions:
        HashMap<UnitTextResolutionCacheKey, Vec<UnitTextResolution>>,
    failure_metadata: FailureMetadataCache,
}

fn contains_word(value: &str, word: &str) -> bool {
    value.match_indices(word).any(|(start, matched)| {
        let end = start + matched.len();
        let has_alphanumeric_before = value[..start]
            .chars()
            .next_back()
            .is_some_and(|character| character.is_alphanumeric());
        let has_alphanumeric_after = value[end..]
            .chars()
            .next()
            .is_some_and(|character| character.is_alphanumeric());
        !has_alphanumeric_before && !has_alphanumeric_after
    })
}

pub(crate) fn should_auto_archive_failed_unit(value: &str) -> bool {
    if crate::unit::parse_library_unit_typed_segments(value).is_some() {
        return false;
    }
    lazy_static! {
        static ref AUTO_ARCHIVE_PATTERNS: Vec<regex::Regex> =
            FAILED_INBOX_UNIT_AUTO_ARCHIVE_PATTERNS
                .iter()
                .map(|pattern| {
                    RegexBuilder::new(pattern)
                        .case_insensitive(true)
                        .build()
                        .expect("invalid failed-unit auto-archive regex")
                })
                .collect();
    }
    let value = value.to_lowercase();
    FAILED_INBOX_UNIT_AUTO_ARCHIVE_WORDS
        .iter()
        .any(|word| contains_word(&value, word))
        || AUTO_ARCHIVE_PATTERNS
            .iter()
            .any(|pattern| pattern.is_match(&value))
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
    let (source, source_texts): (UnitTextSource, Vec<&str>) =
        if let Some(unit_v2) = nonempty(unit_v2) {
            (UnitTextSource::UnitV2, unit_v2.split(',').collect_vec())
        } else if let Some(unit) = nonempty(unit) {
            (UnitTextSource::Unit, vec![unit])
        } else {
            return Vec::new();
        };

    source_texts
        .into_iter()
        .flat_map(|source_text| {
            let texts = match source {
                UnitTextSource::UnitV2 => resolution_texts(source_text),
                UnitTextSource::Unit => {
                    vec![(source_text.trim().to_string(), false)]
                }
            };
            let source_text = normalize_unit_label(source_text);
            texts.into_iter().map(move |(text, is_fallback)| {
                UnitTextCandidate {
                    text,
                    source_text: source_text.clone(),
                    source,
                    is_fallback,
                }
            })
        })
        .filter(|candidate| !candidate.text.is_empty())
        .unique_by(|candidate| {
            (
                candidate.source_text.clone(),
                normalize_unit_label(&candidate.text),
            )
        })
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

async fn resolve_by_exact_sigint_unit_name<C>(
    db: &C,
    value: &str,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let normalized = normalize_unit_label(value);
    if normalized.is_empty() {
        return Ok(None);
    }
    let sigint_unit_ids = sigint_unit::Entity::find()
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(sigint_unit.name), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalized],
        ))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit::Column::Id)
        .distinct()
        .limit(2)
        .into_tuple::<i64>()
        .all(db)
        .await
        .context(h!())?;
    if sigint_unit_ids.len() > 1 {
        warn!("Multiple SIGINT unit names match value={value:?}");
        return Ok(None);
    }
    Ok(sigint_unit_ids.into_iter().next())
}

async fn resolve_by_equivalent_sigint_unit_name<C>(
    db: &C,
    value: &str,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let normalized = crate::unit::normalize_unit_formation_name(value);
    if normalized.is_empty() {
        return Ok(None);
    }
    let name_variants =
        equivalent_sigint_unit_name_variants(value, &normalized);
    if name_variants.len() > INBOX_UNIT_EQUIVALENT_NAME_VARIANT_LIMIT {
        warn!(
            "Too many equivalent SIGINT unit name variants for value={value:?}"
        );
        return Ok(None);
    }
    let sigint_unit_ids = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(
            Expr::cust(
                "lower(btrim(regexp_replace(sigint_unit.name, '[[:punct:][:space:]]+', ' ', 'g')))",
            )
            .is_in(name_variants),
        )
        .select_only()
        .column(sigint_unit::Column::Id)
        .distinct()
        .limit(2)
        .into_tuple::<i64>()
        .all(db)
        .await
        .context(h!())?;
    if sigint_unit_ids.len() > 1 {
        warn!("Multiple equivalent SIGINT unit names match value={value:?}");
        return Ok(None);
    }
    Ok(sigint_unit_ids.into_iter().next())
}

fn equivalent_sigint_unit_name_variants(
    value: &str,
    normalized: &str,
) -> Vec<String> {
    std::iter::once(normalize_unit_label(value))
        .chain(
            normalized
                .split_whitespace()
                .map(|word| {
                    crate::config::UNIT_FORMATION_EQUIVALENT_NOTIONS
                        .iter()
                        .find_map(|(canonical, aliases)| {
                            (*canonical == word).then_some(aliases.to_vec())
                        })
                        .unwrap_or_else(|| vec![word])
                })
                .multi_cartesian_product()
                .map(|words| words.join(" ")),
        )
        .unique()
        .take(INBOX_UNIT_EQUIVALENT_NAME_VARIANT_LIMIT + 1)
        .collect_vec()
}

async fn resolve_unit_v2_name_fallback<C>(
    db: &C,
    value: &str,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    if let Some(sigint_unit_id) =
        resolve_by_label(db, value).await.context(h!())?
    {
        return Ok(Some(sigint_unit_id));
    }
    resolve_by_equivalent_sigint_unit_name(db, value)
        .await
        .context(h!())
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
        if let Some(sigint_unit_id) =
            resolve_by_exact_sigint_unit_name(db, unit_v2)
                .await
                .context(h!())?
        {
            return Ok(Some(sigint_unit_id));
        }
        match resolve_structurally(db, unit_v2).await.context(h!())? {
            StructuralResolution::Resolved(sigint_unit_id) => {
                return Ok(Some(sigint_unit_id));
            }
            StructuralResolution::Blocked(reason) => {
                let sigint_unit_id = resolve_unit_v2_name_fallback(db, unit_v2)
                    .await
                    .context(h!())?;
                if let Some(sigint_unit_id) = sigint_unit_id {
                    debug!(
                        "{reason}; resolved unit_v2={unit_v2:?} by SIGINT unit name/label fallback to sigint_unit_id={sigint_unit_id}"
                    );
                } else {
                    warn!(
                        "{reason}; no SIGINT unit name/label fallback matched"
                    );
                }
                return Ok(sigint_unit_id);
            }
            StructuralResolution::NoMatch => {
                return resolve_unit_v2_name_fallback(db, unit_v2)
                    .await
                    .context(h!());
            }
        }
    }
    match nonempty(unit) {
        Some(unit) => {
            if let Some(sigint_unit_id) =
                resolve_by_exact_sigint_unit_name(db, unit)
                    .await
                    .context(h!())?
            {
                return Ok(Some(sigint_unit_id));
            }
            resolve_by_label(db, unit).await.context(h!())
        }
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
            match resolve_by_exact_sigint_unit_name(db, &candidate.text)
                .await
                .context(h!())?
            {
                Some(sigint_unit_id) => Some(sigint_unit_id),
                None => match candidate.source {
                    UnitTextSource::UnitV2 => {
                        resolve_unit_v2_name_fallback(db, &candidate.text)
                            .await
                            .context(h!())?
                    }
                    UnitTextSource::Unit => {
                        resolve_by_label(db, &candidate.text)
                            .await
                            .context(h!())?
                    }
                },
            }
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
            source_text: candidate.source_text,
            sigint_unit_id,
            is_fallback: candidate.is_fallback,
        });
    }
    let resolved_fallbacks = resolved
        .iter()
        .filter(|resolution| {
            resolution.is_fallback && resolution.sigint_unit_id.is_some()
        })
        .map(|resolution| resolution.source_text.clone())
        .collect::<BTreeSet<_>>();
    resolved.retain(|resolution| {
        resolution.is_fallback
            || !resolved_fallbacks.contains(&resolution.source_text)
    });
    Ok(resolved)
}

async fn resolve_unit_text_candidates_cached<C>(
    db: &C,
    unit_v2: Option<&str>,
    unit: Option<&str>,
    cache: &mut InboxUnitBackfillCache,
) -> anyhow::Result<Vec<UnitTextResolution>>
where
    C: ConnectionTrait,
{
    let unit_v2 = nonempty(unit_v2).map(str::to_owned);
    let unit = unit_v2
        .is_none()
        .then(|| nonempty(unit).map(str::to_owned))
        .flatten();
    let key = UnitTextResolutionCacheKey { unit_v2, unit };
    if let Some(resolutions) = cache.unit_text_resolutions.get(&key) {
        return Ok(resolutions.clone());
    }
    let resolutions = resolve_unit_text_candidates(
        db,
        key.unit_v2.as_deref(),
        key.unit.as_deref(),
    )
    .await
    .context(h!())?;
    cache.unit_text_resolutions.insert(key, resolutions.clone());
    Ok(resolutions)
}

async fn mark_failure_resolved<C>(
    db: &C,
    inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_failed_unit_label::Entity::update_many()
        .col_expr(
            sigint_inbox_item_failed_unit_label::Column::Deleted,
            Expr::value(true),
        )
        .col_expr(
            sigint_inbox_item_failed_unit_label::Column::DeletedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(
            sigint_inbox_item_failed_unit_label::Column::InboxItemId
                .eq(inbox_item_id),
        )
        .filter(sigint_inbox_item_failed_unit_label::Column::Deleted.eq(false))
        .exec(db)
        .await
        .context(h!())?;
    Ok(())
}

pub(crate) async fn upsert_failure<C>(
    db: &C,
    inbox_item_id: i64,
    unit_txt: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    upsert_failure_inner(db, inbox_item_id, unit_txt, None)
        .await
        .context(h!())
}

async fn upsert_failure_cached<C>(
    db: &C,
    inbox_item_id: i64,
    unit_txt: &str,
    cache: &mut FailureMetadataCache,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    upsert_failure_inner(db, inbox_item_id, unit_txt, Some(cache))
        .await
        .context(h!())
}

async fn upsert_failure_inner<C>(
    db: &C,
    inbox_item_id: i64,
    unit_txt: &str,
    cache: Option<&mut FailureMetadataCache>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let normalized_unit_txt = normalize_unit_label(unit_txt);
    let group_metadata = if let Some(group_metadata) = cache
        .as_deref()
        .and_then(|cache| cache.get(&normalized_unit_txt))
    {
        Some(group_metadata.clone())
    } else {
        failed_unit_label::Entity::find()
            .filter(Expr::cust_with_values(
                "lower(regexp_replace(btrim(failed_unit_label.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
                vec![normalized_unit_txt.clone()],
            ))
            .one(db)
            .await
            .context(h!())?
            .map(|label| (label.is_bad_data, label.note))
    };
    let (is_bad_data, note) =
        group_metadata.as_ref().cloned().unwrap_or_default();
    let is_bad_data = is_bad_data || should_auto_archive_failed_unit(unit_txt);
    if let Some(cache) = cache {
        cache.insert(normalized_unit_txt.clone(), (is_bad_data, note.clone()));
    }
    failed_unit_label::Entity::insert(failed_unit_label::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            unit_txt: Set(unit_txt.trim().to_string()),
            is_bad_data: Set(is_bad_data),
            note: Set(note),
        })
        .on_conflict(
            OnConflict::new()
                .expr(Expr::cust(
                    "lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))",
                ))
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(db)
        .await
        .context(h!())?;
    let label = failed_unit_label::Entity::find()
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(failed_unit_label.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalized_unit_txt],
        ))
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    if is_bad_data && !label.is_bad_data {
        failed_unit_label::Entity::update_many()
            .col_expr(failed_unit_label::Column::IsBadData, Expr::value(true))
            .filter(failed_unit_label::Column::Id.eq(label.id))
            .exec(db)
            .await
            .context(h!())?;
    }
    sigint_inbox_item_failed_unit_label::Entity::insert(
        sigint_inbox_item_failed_unit_label::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            inbox_item_id: Set(inbox_item_id),
            failed_unit_label_id: Set(label.id),
            deleted: Set(false),
            deleted_at: Set(None),
        },
    )
    .on_conflict(
        OnConflict::columns([
            sigint_inbox_item_failed_unit_label::Column::InboxItemId,
            sigint_inbox_item_failed_unit_label::Column::FailedUnitLabelId,
        ])
        .update_columns([
            sigint_inbox_item_failed_unit_label::Column::Deleted,
            sigint_inbox_item_failed_unit_label::Column::DeletedAt,
        ])
        .to_owned(),
    )
    .exec_without_returning(db)
    .await
    .context(h!())?;
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

async fn calculated_network_unit_links<C>(
    db: &C,
    inbox_item_ids: &[i64],
    network_ids_by_item: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<Vec<(i64, i64)>>
where
    C: ConnectionTrait,
{
    let network_ids = inbox_item_ids
        .iter()
        .filter_map(|item_id| network_ids_by_item.get(item_id))
        .flatten()
        .copied()
        .collect::<BTreeSet<_>>();
    if network_ids.is_empty() {
        return Ok(Vec::new());
    }
    let unit_ids_by_network = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.is_in(network_ids))
        .select_only()
        .column(sigint_network_unit::Column::NetworkId)
        .column(sigint_network_unit::Column::UnitId)
        .distinct()
        .into_tuple::<(i64, i64)>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .into_group_map();
    Ok(inbox_item_ids
        .iter()
        .flat_map(|item_id| {
            network_ids_by_item
                .get(item_id)
                .into_iter()
                .flatten()
                .filter_map(|network_id| unit_ids_by_network.get(network_id))
                .flatten()
                .map(|unit_id| (*item_id, *unit_id))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

async fn delete_network_unit_links<C>(
    db: &C,
    inbox_item_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
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
    Ok(())
}

async fn insert_network_unit_links<C>(
    db: &C,
    unit_links: Vec<(i64, i64)>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let unit_links = unit_links
        .into_iter()
        .map(|(item_id, unit_id)| sigint_inbox_item_unit::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            item_id: Set(item_id),
            unit_id: Set(unit_id),
            kind: Set(SigintInboxItemUnitKind::Network),
        })
        .collect_vec();
    for unit_links in unit_links.chunks(INBOX_ITEM_UNIT_SYNC_INSERT_BATCH_SIZE)
    {
        sigint_inbox_item_unit::Entity::insert_many(unit_links.to_vec())
            .on_conflict(
                OnConflict::columns([
                    sigint_inbox_item_unit::Column::ItemId,
                    sigint_inbox_item_unit::Column::UnitId,
                    sigint_inbox_item_unit::Column::Kind,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec_without_returning(db)
            .await
            .context(h!())?;
    }
    Ok(())
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
        delete_network_unit_links(db, inbox_item_ids)
            .await
            .context(h!())?;
        let unit_links =
            network_unit_links(db, inbox_item_ids).await.context(h!())?;
        insert_network_unit_links(db, unit_links)
            .await
            .context(h!())?;
    }
    Ok(())
}

pub(crate) async fn sync_calculated_network_unit_links<C>(
    db: &C,
    inbox_item_ids: &[i64],
    network_ids_by_item: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for inbox_item_ids in
        inbox_item_ids.chunks(INBOX_ITEM_UNIT_SYNC_QUERY_BATCH_SIZE)
    {
        delete_network_unit_links(db, inbox_item_ids)
            .await
            .context(h!())?;
        let unit_links = calculated_network_unit_links(
            db,
            inbox_item_ids,
            network_ids_by_item,
        )
        .await
        .context(h!())?;
        insert_network_unit_links(db, unit_links)
            .await
            .context(h!())?;
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
    sync_resolved_inbox_item(db, inbox_item_id, resolved_unit_texts, None)
        .await
        .context(h!())
}

async fn resolve_and_sync_inbox_item_cached<C>(
    db: &C,
    inbox_item_id: i64,
    unit_v2: Option<&str>,
    unit: Option<&str>,
    cache: &mut InboxUnitBackfillCache,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let resolved_unit_texts =
        resolve_unit_text_candidates_cached(db, unit_v2, unit, cache)
            .await
            .context(h!())?;
    sync_resolved_inbox_item(
        db,
        inbox_item_id,
        resolved_unit_texts,
        Some(&mut cache.failure_metadata),
    )
    .await
    .context(h!())
}

async fn sync_resolved_inbox_item<C>(
    db: &C,
    inbox_item_id: i64,
    resolved_unit_texts: Vec<UnitTextResolution>,
    mut failure_metadata_cache: Option<&mut FailureMetadataCache>,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait,
{
    let sigint_unit_ids = resolved_unit_texts
        .iter()
        .filter_map(|resolution| resolution.sigint_unit_id)
        .collect_vec();
    replace_parsed_unit_links(db, inbox_item_id, &sigint_unit_ids)
        .await
        .context(h!())?;

    if resolved_unit_texts.is_empty() {
        sigint_inbox_item_failed_unit_label::Entity::delete_many()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(inbox_item_id),
            )
            .exec(db)
            .await
            .context(h!())?;
    } else {
        mark_failure_resolved(db, inbox_item_id)
            .await
            .context(h!())?;
        for resolution in resolved_unit_texts {
            if resolution.sigint_unit_id.is_none() && !resolution.is_fallback {
                if let Some(cache) = failure_metadata_cache.as_deref_mut() {
                    upsert_failure_cached(
                        db,
                        inbox_item_id,
                        &resolution.text,
                        cache,
                    )
                    .await
                    .context(h!())?;
                } else {
                    upsert_failure(db, inbox_item_id, &resolution.text)
                        .await
                        .context(h!())?;
                }
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
    let label_ids = failed_unit_label::Entity::find()
        .select_only()
        .column(failed_unit_label::Column::Id)
        .filter(failed_unit_label::Column::IsBadData.eq(false))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(failed_unit_label.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
            vec![normalize_unit_label(unit_txt)],
        ));
    let result = sigint_inbox_item_failed_unit_label::Entity::update_many()
        .col_expr(
            sigint_inbox_item_failed_unit_label::Column::Deleted,
            Expr::value(true),
        )
        .col_expr(
            sigint_inbox_item_failed_unit_label::Column::DeletedAt,
            Expr::value(Utc::now().naive_utc()),
        )
        .filter(sigint_inbox_item_failed_unit_label::Column::Deleted.eq(false))
        .filter(
            sigint_inbox_item_failed_unit_label::Column::FailedUnitLabelId
                .in_subquery(label_ids.into_query()),
        )
        .exec(db)
        .await
        .context(h!())?;
    Ok(result.rows_affected)
}

pub(crate) async fn reprocess_inbox_items_for_unit<C>(
    db: &C,
    sigint_unit_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
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
            .filter(sigint_inbox_item_unit::Column::UnitId.eq(sigint_unit_id))
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
    failure: sigint_inbox_item_failed_unit_label::Model,
    label: failed_unit_label::Model,
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
    match sigint_inbox_item_failed_unit_label::Entity::find_by_id(failure_id)
        .one(db)
        .await
        .context(h!())?
    {
        Some(failure) if failure.deleted => {
            failure.delete(db).await.context(h!())?;
        }
        Some(_) => {
            warn!(
                "Reactivated unresolved inbox unit failure id={} inbox_item_id={} label={:?} after verification failed",
                failure_id, inbox_item.id, label.unit_txt
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
    sigint_inbox_item_failed_unit_label::Entity::delete_many()
        .filter(sigint_inbox_item_failed_unit_label::Column::Deleted.eq(true))
        .filter(
            sigint_inbox_item_failed_unit_label::Column::DeletedAt
                .lte(cleanup_before),
        )
        .exec(&transaction)
        .await
        .context(h!())?;

    let retryable_label_ids = failed_unit_label::Entity::find()
        .select_only()
        .column(failed_unit_label::Column::Id)
        .filter(failed_unit_label::Column::IsBadData.eq(false));
    let failures = sigint_inbox_item_failed_unit_label::Entity::find()
        .filter(sigint_inbox_item_failed_unit_label::Column::Deleted.eq(true))
        .filter(
            sigint_inbox_item_failed_unit_label::Column::FailedUnitLabelId
                .in_subquery(retryable_label_ids.into_query()),
        )
        .order_by_asc(sigint_inbox_item_failed_unit_label::Column::DeletedAt)
        .order_by_asc(sigint_inbox_item_failed_unit_label::Column::Id)
        .limit(FAILED_INBOX_UNIT_WORKER_BATCH_SIZE)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .all(&transaction)
        .await
        .context(h!())?;
    let label_ids = failures
        .iter()
        .map(|failure| failure.failed_unit_label_id)
        .collect_vec();
    let labels = failed_unit_label::Entity::find()
        .filter(failed_unit_label::Column::Id.is_in(label_ids))
        .all(&transaction)
        .await
        .context(h!())?
        .into_iter()
        .map(|label| (label.id, label))
        .collect::<HashMap<_, _>>();
    for failure in failures {
        let label = labels
            .get(&failure.failed_unit_label_id)
            .cloned()
            .context(h!())?;
        let inbox_item_id = failure.inbox_item_id;
        verify_pending_failure(&transaction, failure, label)
            .await
            .context(h!())?;
        crate::stats::enqueue_group_stats_recalculation_for_message(
            &transaction,
            inbox_item_id,
            format!("resolved pending unit for inbox message {inbox_item_id}"),
        )
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
    after_inbox_item_id: i64,
    progress: Option<&ProgressBar>,
) -> anyhow::Result<u64> {
    validate_inbox_unit_link_backfill_bounds(
        start_ts,
        till_ts,
        after_inbox_item_id,
    )
    .context(h!())?;
    let mut last_id = after_inbox_item_id;
    let mut processed = 0_u64;
    loop {
        let items = sigint_inbox_item::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .filter(sigint_inbox_item::Column::Id.gt(last_id))
            .filter(signal_message::Column::Id.gt(last_id))
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
        let last_item_id = items.last().unwrap().id;
        let mut cache = InboxUnitBackfillCache::default();
        let transaction = db.begin().await.context(h!())?;
        for item in &items {
            resolve_and_sync_inbox_item_cached(
                &transaction,
                item.id,
                item.unit_v2.as_deref(),
                item.unit.as_deref(),
                &mut cache,
            )
            .await
            .context(h!())?;
        }
        sync_network_unit_links(&transaction, &item_ids)
            .await
            .context(h!())?;
        transaction.commit().await.context(h!())?;
        let batch_size = u64::try_from(items.len()).context(h!())?;
        processed += batch_size;
        if let Some(progress) = progress {
            progress.inc(batch_size);
        }
        last_id = last_item_id;
        info!(
            "backfilled inbox unit links batch: processed={processed}, last_inbox_item_id={last_id}, cached_unit_texts={}, cached_failure_texts={}",
            cache.unit_text_resolutions.len(),
            cache.failure_metadata.len(),
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
    after_inbox_item_id: i64,
) -> anyhow::Result<u64> {
    validate_inbox_unit_link_backfill_bounds(
        start_ts,
        till_ts,
        after_inbox_item_id,
    )
    .context(h!())?;
    sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_inbox_item::Column::Id.gt(after_inbox_item_id))
        .filter(signal_message::Column::Id.gt(after_inbox_item_id))
        .filter(signal_message::Column::CreatedAt.gte(start_ts))
        .filter(signal_message::Column::CreatedAt.lt(till_ts))
        .count(db)
        .await
        .context(h!())
}

fn validate_inbox_unit_link_backfill_bounds(
    start_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    after_inbox_item_id: i64,
) -> anyhow::Result<()> {
    if start_ts >= till_ts {
        anyhow::bail!("start_ts must be earlier than till_ts");
    }
    if after_inbox_item_id < 0 {
        anyhow::bail!("after_inbox_item_id must not be negative");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ActiveModelTrait, IntoActiveModel};
    use serial_test::serial;

    async fn failure_rows(
        db: &DatabaseConnection,
        inbox_item_id: i64,
    ) -> Vec<(
        sigint_inbox_item_failed_unit_label::Model,
        failed_unit_label::Model,
    )> {
        sigint_inbox_item_failed_unit_label::Entity::find()
            .find_also_related(failed_unit_label::Entity)
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(inbox_item_id),
            )
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .map(|(link, label)| (link, label.unwrap()))
            .collect()
    }

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
    fn detects_failed_unit_auto_archive_words() {
        for label in [
            "НВ",
            "підрозділ н/В резерв",
            "123 Н.В.",
            "УКХ радіомережа управління 148.5 МГц",
            "DMR р/м оповіщення",
            "пости ППС біля н.п. Харків",
            "УНПП район Вовчанська",
            "район Вовчанська",
        ] {
            assert!(should_auto_archive_failed_unit(label), "{label}");
        }
        for label in [
            "НВО",
            "анв",
            "н/ва",
            "н.в.о",
            "управління батальйону",
            "пости охорони",
            "1 мсб 68 ак управління",
            "60 омсбр 5 а УКХ",
        ] {
            assert!(!should_auto_archive_failed_unit(label), "{label}");
        }
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

    #[test]
    fn equivalent_name_variants_report_the_configured_limit_overflow() {
        let value = ["В"; 8].join(" ");
        let normalized = crate::unit::normalize_unit_formation_name(&value);

        assert_eq!(
            equivalent_sigint_unit_name_variants(&value, &normalized).len(),
            INBOX_UNIT_EQUIVALENT_NAME_VARIANT_LIMIT + 1
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
    async fn exact_sigint_unit_name_matches_unit_v2_and_unit() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let name = unique_unit_label();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set(name.clone()),
                name: Set(name.clone()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let search = format!("  {}\n", name.to_uppercase());

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&search), None)
                .await
                .unwrap(),
            Some(unit.id)
        );
        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, None, Some(&search))
                .await
                .unwrap(),
            Some(unit.id)
        );
    }

    #[tokio::test]
    #[serial]
    async fn equivalent_sigint_unit_name_matches_unit_v2_as_last_fallback() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unique = unique_unit_label();
        let name = format!("“{unique}” 1 (об БпС), 2 ЗВА");
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set(name),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unit_v2 = format!("{unique} 1 обБпС 2 ОА");

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, Some(&unit_v2), None)
                .await
                .unwrap(),
            Some(unit.id)
        );
    }

    #[tokio::test]
    #[serial]
    async fn duplicate_exact_sigint_unit_names_are_not_linked() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let name = unique_unit_label();
        for _ in 0..2 {
            crate::functest::tests::mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    regiment: Set(name.clone()),
                    name: Set(name.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        assert_eq!(
            resolve_sigint_unit_id(&env.dbx, None, Some(&name))
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
        let failures = failure_rows(&env.dbx, item.id).await;
        assert_eq!(failures.len(), 1);
        assert_eq!(
            normalize_unit_label(&failures[0].1.unit_txt),
            normalize_unit_label(&missing_label)
        );
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_failure_upserts_share_the_existing_row() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let label = format!("concurrent-missing-{}", Uuid::new_v4());
        let item = insert_inbox_item(&env.dbx, Some(&label), None, None).await;

        let results = futures::future::join_all(
            (0..8).map(|_| upsert_failure(&env.dbx, item.id, &label)),
        )
        .await;
        for result in results {
            result.unwrap();
        }

        let failures = sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(item.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 1);
        assert!(!failures[0].deleted);
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
        assert!(sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(item.id)
            )
            .filter(
                sigint_inbox_item_failed_unit_label::Column::Deleted.eq(false)
            )
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn resolved_exact_fallback_suppresses_parsed_failure() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let unit_v2 = format!("власний тег {}", unique_unit_label());
        sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(unit.id),
            label: Set(unit_v2.clone()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
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

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                item.id,
                SigintInboxItemUnitKind::Parsed,
            )
            .await,
            vec![unit.id]
        );
        assert!(sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(item.id)
            )
            .filter(
                sigint_inbox_item_failed_unit_label::Column::Deleted.eq(false)
            )
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn exact_name_fallback_suppresses_parsed_failure() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit_v2 = format!("власний тег {}", unique_unit_label());
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set(unit_v2.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
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

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                item.id,
                SigintInboxItemUnitKind::Parsed,
            )
            .await,
            vec![unit.id]
        );
        assert!(sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(item.id)
            )
            .filter(
                sigint_inbox_item_failed_unit_label::Column::Deleted.eq(false)
            )
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
        let label_txt = format!("archived-failure-{}", Uuid::new_v4());
        let first =
            insert_inbox_item(&env.dbx, Some(&label_txt), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            first.id,
            first.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        let label = failure_rows(&env.dbx, first.id).await.remove(0).1;
        let mut label = label.into_active_model();
        label.is_bad_data = Set(true);
        label.note = Set("keep this note".to_string());
        label.update(&env.dbx).await.unwrap();

        resolve_and_sync_inbox_item(
            &env.dbx,
            first.id,
            first.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();
        let second =
            insert_inbox_item(&env.dbx, Some(&label_txt), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            second.id,
            second.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        let first_failure = failure_rows(&env.dbx, first.id).await.remove(0);
        let second_failure = failure_rows(&env.dbx, second.id).await.remove(0);
        assert_eq!(first_failure.1.id, second_failure.1.id);
        assert!(first_failure.1.is_bad_data);
        assert_eq!(first_failure.1.note, "keep this note");
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
        let failures = failure_rows(&env.dbx, inbox_item.id).await;
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].1.unit_txt, "невідомий   сирий підрозділ");
        assert!(!failures[0].0.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn auto_archive_uses_stored_failure_text_for_both_sources() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let raw_marker =
            insert_inbox_item(&env.dbx, None, Some("НВ"), None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            raw_marker.id,
            None,
            raw_marker.unit.as_deref(),
        )
        .await
        .unwrap();

        let raw_failure = failure_rows(&env.dbx, raw_marker.id).await.remove(0);
        assert_eq!(raw_failure.1.unit_txt, "НВ");
        assert!(raw_failure.1.is_bad_data);

        let parsed_label = unique_unit_label();
        let unit_v2 = format!("н/в {parsed_label}");
        let parsed_unit =
            insert_inbox_item(&env.dbx, Some(&unit_v2), None, None).await;
        resolve_and_sync_inbox_item(
            &env.dbx,
            parsed_unit.id,
            parsed_unit.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        let parsed_failure =
            failure_rows(&env.dbx, parsed_unit.id).await.remove(0);
        assert_eq!(parsed_failure.1.unit_txt, parsed_label);
        assert!(!parsed_failure.1.is_bad_data);
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
        let label_id = failure_rows(&env.dbx, first.id).await.remove(0).1.id;
        failed_unit_label::Entity::update_many()
            .col_expr(failed_unit_label::Column::IsBadData, Expr::value(true))
            .filter(failed_unit_label::Column::Id.eq(label_id))
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

        let failure = failure_rows(&env.dbx, second.id).await.remove(0);
        assert!(failure.1.is_bad_data);
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
    async fn calculated_network_sync_uses_calculation_result() {
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

        sync_calculated_network_unit_links(
            &env.dbx,
            &[inbox_item.id],
            &HashMap::from([(inbox_item.id, vec![network.id])]),
        )
        .await
        .unwrap();

        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                inbox_item.id,
                SigintInboxItemUnitKind::Network,
            )
            .await,
            vec![unit.id]
        );

        sync_calculated_network_unit_links(
            &env.dbx,
            &[inbox_item.id],
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(unit_ids_for_kind(
            &env.dbx,
            inbox_item.id,
            SigintInboxItemUnitKind::Network,
        )
        .await
        .is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn calculated_network_sync_ignores_concurrent_unit_links() {
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
        let network_ids_by_item =
            HashMap::from([(inbox_item.id, vec![network.id])]);
        let inbox_item_ids = [inbox_item.id];

        let (first, second) = tokio::join!(
            sync_calculated_network_unit_links(
                &env.dbx,
                &inbox_item_ids,
                &network_ids_by_item,
            ),
            sync_calculated_network_unit_links(
                &env.dbx,
                &inbox_item_ids,
                &network_ids_by_item,
            ),
        );
        first.unwrap();
        second.unwrap();

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
    async fn backfill_resumes_after_item_id_and_syncs_network_unit_links() {
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
        let skipped_item = insert_inbox_item(&env.dbx, None, None, None).await;
        let resumed_item = insert_inbox_item(&env.dbx, None, None, None).await;
        for inbox_item_id in [skipped_item.id, resumed_item.id] {
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item_id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        let now = Utc::now().naive_utc();

        assert_eq!(
            backfill_inbox_unit_links(
                &env.dbx,
                now - Duration::minutes(1),
                now + Duration::minutes(1),
                skipped_item.id,
                None,
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                skipped_item.id,
                SigintInboxItemUnitKind::Network,
            )
            .await,
            Vec::<i64>::new()
        );
        assert_eq!(
            unit_ids_for_kind(
                &env.dbx,
                resumed_item.id,
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
        let successful_items = vec![
            insert_inbox_item(&env.dbx, Some(&label), None, None).await,
            insert_inbox_item(&env.dbx, Some(&label), None, None).await,
        ];
        for successful in &successful_items {
            resolve_and_sync_inbox_item(
                &env.dbx,
                successful.id,
                successful.unit_v2.as_deref(),
                None,
            )
            .await
            .unwrap();
        }
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
            2
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

        for successful in successful_items {
            assert_eq!(
                unit_ids_for_kind(
                    &env.dbx,
                    successful.id,
                    SigintInboxItemUnitKind::Parsed,
                )
                .await,
                vec![sigint_unit.id]
            );
            assert!(sigint_inbox_item_failed_unit_label::Entity::find()
                .filter(
                    sigint_inbox_item_failed_unit_label::Column::InboxItemId
                        .eq(successful.id),
                )
                .one(&env.dbx)
                .await
                .unwrap()
                .is_none());
        }

        let failure = sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(unresolved.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!failure.deleted);
        assert_eq!(failure.deleted_at, None);

        let failures = failure_rows(&env.dbx, stale_id).await;
        assert_eq!(failures.len(), 1);
        assert_eq!(
            normalize_unit_label(&failures[0].1.unit_txt),
            normalize_unit_label(&current_label)
        );
        assert!(!failures[0].0.deleted);
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
            upsert_failure(
                &env.dbx,
                inbox_item_id,
                &format!("pending-{inbox_item_id}"),
            )
            .await
            .unwrap();
            let (link, label) =
                failure_rows(&env.dbx, inbox_item_id).await.remove(0);
            if is_bad_data {
                let mut label = label.into_active_model();
                label.is_bad_data = Set(true);
                label.update(&env.dbx).await.unwrap();
            }
            let mut link = link.into_active_model();
            link.deleted = Set(true);
            link.deleted_at = Set(Some(deleted_at));
            link.update(&env.dbx).await.unwrap();
        }

        run_failed_inbox_unit_worker_once(&env.dbx).await.unwrap();

        assert!(sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::InboxItemId
                    .eq(old_item.id)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let (bad_link, bad_label) =
            failure_rows(&env.dbx, bad_item.id).await.remove(0);
        assert!(bad_link.deleted);
        assert!(bad_label.is_bad_data);
    }
}
