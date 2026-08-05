use crate::config::{
    ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE,
    ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE,
    ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS,
    ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
    ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS,
    ORGANISM_GOI_MESSAGE_UID_SOURCE_DATE_TOLERANCE_MINUTES,
    ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC,
    ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX,
};
use crate::entities::{
    datasource_group, goi_association, sigint_inbox_item, signal_message,
    signal_message_group,
};
use crate::error::AppError;
use crate::types::{info, warn, Env, Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::{h, new_pg_pool_from_mode};
use chrono::{
    DateTime, Duration as ChronoDuration, FixedOffset, NaiveDateTime, Utc,
};
use sea_orm::*;
use sea_query::Expr;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Default, Eq, PartialEq)]
struct BackfillStats {
    scanned: u64,
    filled: u64,
}

#[derive(Debug, FromQueryResult)]
struct MessageCandidate {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    body: Option<String>,
    body_noheader: Option<serde_json::Value>,
    message_uid: Option<String>,
}

#[derive(Debug)]
struct PreparedMessageCandidate {
    id: i64,
    timestamp: NaiveDateTime,
    body: String,
    probe_body: String,
    message_uid: String,
}

#[derive(Debug, Default)]
struct MessageCandidateSelection {
    newest_original: Option<SelectedMessageCandidate>,
    newest_duplicate: Option<SelectedMessageCandidate>,
}

#[derive(Debug)]
struct SelectedMessageCandidate {
    id: i64,
    timestamp: NaiveDateTime,
    message_uid: String,
}

#[derive(Debug)]
struct AssociationMessageWorkItem {
    association: goi_association::Model,
    association_message: String,
    probe: String,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
    inbox_datetime_window: Option<(NaiveDateTime, NaiveDateTime)>,
    group_keys: Arc<Vec<String>>,
}

type OrganismGroupCache = HashMap<i64, Arc<Vec<String>>>;

pub async fn oneoff_backfill_goi_association_message_uids(
    mode: Mode,
    since_ts: Option<&str>,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    info!("starting GOI association message UID backfill");
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let stats = match since_ts {
        Some(since_ts) => {
            let since_ts = parse_since_ts(since_ts).c(h!())?;
            backfill_goi_association_message_uids(&db, Some(&since_ts))
                .await
                .c(h!())?
        }
        None => backfill_latest_goi_association_message_uids(
            &db,
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
        )
        .await
        .c(h!())?,
    };
    info!(
        "GOI association message UID backfill completed: scanned={}, filled={}, elapsed={:?}",
        stats.scanned,
        stats.filled,
        started_at.elapsed()
    );
    if since_ts.is_none() {
        println!(
            "Only the {} newest GOI associations were processed. Pass --since-ts to process the intended range. Example: wdintel-rs --mode live oneoff-backfill-goi-association-message-uids --since-ts 2026-06-15T00:00:00Z",
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT
        );
    }
    Ok(())
}

fn parse_since_ts(value: &str) -> Result<DateTime<FixedOffset>, AppError> {
    DateTime::parse_from_rfc3339(value).map_err(|err| AppError::BL {
        msg: format!(
            "invalid since_ts `{value}`; expected RFC3339, for example `2026-06-15T00:00:00Z`: {err}"
        ),
    })
}

pub async fn goi_association_message_uid_worker_nofail(env: Arc<Env>) {
    loop {
        match goi_association_message_uid_worker_pass(&env).await {
            Ok(Some(stats)) => info!(
                "GOI association message UID worker pass completed: scanned={}, filled={}",
                stats.scanned, stats.filled
            ),
            Ok(None) => {},
            Err(err) => warn!(
                "GOI association message UID worker pass failed: {err:#}"
            ),
        }
        tokio::time::sleep(Duration::from_secs(
            ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC,
        ))
        .await;
    }
}

async fn goi_association_message_uid_worker_pass(
    env: &Env,
) -> Result<Option<BackfillStats>, AppError> {
    if !crate::system_settings::goi_association_message_uid_worker_enabled(
        &env.dbx,
    )
    .await
    .c(h!())?
    {
        return Ok(None);
    }

    Ok(Some(
        backfill_goi_association_message_uids(&env.dbx, None)
            .await
            .c(h!())?,
    ))
}

async fn backfill_goi_association_message_uids(
    db: &DatabaseConnection,
    since_ts: Option<&DateTime<FixedOffset>>,
) -> Result<BackfillStats, AppError> {
    let mut stats = BackfillStats::default();
    let mut group_cache = OrganismGroupCache::new();
    let mut after_id = 0;
    loop {
        let associations = load_association_batch(db, after_id, since_ts)
            .await
            .c(h!())?;
        let Some(last_association) = associations.last() else {
            break;
        };
        after_id = last_association.id;
        fill_association_message_uids(
            db,
            associations,
            &mut group_cache,
            &mut stats,
        )
        .await
        .c(h!())?;
        info!(
            "GOI association message UID backfill progress: last_id={}, scanned={}, filled={}",
            after_id, stats.scanned, stats.filled
        );
    }
    Ok(stats)
}

async fn backfill_latest_goi_association_message_uids(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<BackfillStats, AppError> {
    let associations =
        latest_associations_query(limit).all(db).await.c(h!())?;
    let mut stats = BackfillStats::default();
    let mut group_cache = OrganismGroupCache::new();
    fill_association_message_uids(
        db,
        associations,
        &mut group_cache,
        &mut stats,
    )
    .await
    .c(h!())?;
    Ok(stats)
}

fn latest_associations_query(limit: u64) -> Select<goi_association::Entity> {
    goi_association::Entity::find()
        .order_by_desc(goi_association::Column::Id)
        .limit(limit)
}

async fn fill_association_message_uids(
    db: &DatabaseConnection,
    associations: Vec<goi_association::Model>,
    group_cache: &mut OrganismGroupCache,
    stats: &mut BackfillStats,
) -> Result<(), AppError> {
    stats.scanned += associations.len() as u64;
    let work_items =
        prepare_association_message_work_items(db, associations, group_cache)
            .await
            .c(h!())?;
    for work_items in work_items.into_values() {
        fill_organism_association_message_uids(db, work_items, stats)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn prepare_association_message_work_items(
    db: &DatabaseConnection,
    associations: Vec<goi_association::Model>,
    group_cache: &mut OrganismGroupCache,
) -> Result<HashMap<i64, Vec<AssociationMessageWorkItem>>, AppError> {
    let mut work_items = HashMap::new();
    for association in associations {
        let Some(work_item) =
            prepare_association_message_work_item(db, association, group_cache)
                .await
                .c(h!())?
        else {
            continue;
        };
        work_items
            .entry(work_item.association.organism_id)
            .or_insert_with(Vec::new)
            .push(work_item);
    }
    Ok(work_items)
}

async fn prepare_association_message_work_item(
    db: &DatabaseConnection,
    association: goi_association::Model,
    group_cache: &mut OrganismGroupCache,
) -> Result<Option<AssociationMessageWorkItem>, AppError> {
    if association.message_uid.is_some() {
        return Ok(None);
    }
    let Some(association_message) =
        association_original_message(&association.row)
            .map(normalize_message_body)
            .filter(|message| !message.is_empty())
    else {
        return Ok(None);
    };
    let Some(probe) = message_probe(&association_message) else {
        return Ok(None);
    };
    let group_keys =
        organism_signal_group_keys(db, association.organism_id, group_cache)
            .await
            .c(h!())?;
    if group_keys.is_empty() {
        return Ok(None);
    }
    let (signal_window_start, signal_window_end) =
        signal_message_timestamp_window(
            association.source_date.as_ref(),
            &association.source_created_at,
        );
    let inbox_datetime_window = association
        .source_date
        .as_ref()
        .map(source_date_inbox_datetime_window);
    Ok(Some(AssociationMessageWorkItem {
        association,
        association_message,
        probe,
        signal_window_start,
        signal_window_end,
        inbox_datetime_window,
        group_keys,
    }))
}

async fn fill_organism_association_message_uids(
    db: &DatabaseConnection,
    work_items: Vec<AssociationMessageWorkItem>,
    stats: &mut BackfillStats,
) -> Result<(), AppError> {
    let Some(group_keys) =
        work_items.first().map(|item| item.group_keys.clone())
    else {
        return Ok(());
    };
    let datasource_group_ids =
        load_datasource_group_ids(db, &group_keys).await.c(h!())?;
    for work_item in work_items {
        let Some(message_uid) = find_matching_message_uid(
            db,
            &datasource_group_ids,
            &group_keys,
            &work_item.association_message,
            &work_item.probe,
            work_item.signal_window_start,
            work_item.signal_window_end,
            work_item.inbox_datetime_window,
        )
        .await
        .c(h!())?
        else {
            continue;
        };
        stats.filled += update_association_message_uid(
            db,
            work_item.association.id,
            message_uid,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn update_association_message_uid(
    db: &DatabaseConnection,
    association_id: i64,
    message_uid: String,
) -> Result<u64, AppError> {
    let update = goi_association::Entity::update_many()
        .col_expr(
            goi_association::Column::MessageUid,
            Expr::value(message_uid),
        )
        .filter(goi_association::Column::Id.eq(association_id))
        .filter(goi_association::Column::MessageUid.is_null())
        .exec(db)
        .await
        .c(h!())?;
    Ok(update.rows_affected)
}

async fn organism_signal_group_keys(
    db: &DatabaseConnection,
    organism_id: i64,
    group_cache: &mut OrganismGroupCache,
) -> Result<Arc<Vec<String>>, AppError> {
    if let Some(group_keys) = group_cache.get(&organism_id) {
        return Ok(group_keys.clone());
    }
    let group_keys = Arc::new(
        crate::organism::bl::load_organism_group_ids(db, organism_id)
            .await
            .c(h!())?
            .available_keys,
    );
    group_cache.insert(organism_id, group_keys.clone());
    Ok(group_keys)
}

async fn load_association_batch(
    db: &DatabaseConnection,
    after_id: i64,
    since_ts: Option<&DateTime<FixedOffset>>,
) -> Result<Vec<goi_association::Model>, AppError> {
    let mut query = goi_association::Entity::find()
        .filter(goi_association::Column::Id.gt(after_id))
        .filter(goi_association::Column::MessageUid.is_null())
        .order_by_asc(goi_association::Column::Id)
        .limit(ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE);
    if let Some(since_ts) = since_ts {
        query = query.filter(
            goi_association::Column::SourceCreatedAt.gte(since_ts.to_owned()),
        );
    }
    Ok(query.all(db).await.c(h!())?)
}

async fn find_matching_message_uid(
    db: &DatabaseConnection,
    datasource_group_ids: &[i64],
    group_keys: &[String],
    association_message: &str,
    probe: &str,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
    inbox_datetime_window: Option<(NaiveDateTime, NaiveDateTime)>,
) -> Result<Option<String>, AppError> {
    let mut selection = MessageCandidateSelection::default();
    if !datasource_group_ids.is_empty() {
        let candidate_selection = scan_message_candidate_pages(
            db,
            |cursor| {
                datasource_group_message_candidate_query(
                    datasource_group_ids,
                    probe,
                    signal_window_start,
                    signal_window_end,
                    inbox_datetime_window,
                    cursor,
                )
            },
            association_message,
            probe,
            signal_window_start,
            signal_window_end,
        )
        .await
        .c(h!())?;
        selection.merge(candidate_selection);
    }
    let candidate_selection = scan_message_candidate_pages(
        db,
        |cursor| {
            linked_message_candidate_query(
                group_keys,
                probe,
                signal_window_start,
                signal_window_end,
                inbox_datetime_window,
                cursor,
            )
        },
        association_message,
        probe,
        signal_window_start,
        signal_window_end,
    )
    .await
    .c(h!())?;
    selection.merge(candidate_selection);
    Ok(selection.message_uid())
}

async fn load_datasource_group_ids(
    db: &DatabaseConnection,
    group_keys: &[String],
) -> Result<Vec<i64>, AppError> {
    Ok(datasource_group::Entity::find()
        .select_only()
        .column(datasource_group::Column::Id)
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(group_keys.to_vec()),
        )
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?)
}

async fn scan_message_candidate_pages<F>(
    db: &DatabaseConnection,
    mut query_page: F,
    association_message: &str,
    probe: &str,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
) -> Result<MessageCandidateSelection, AppError>
where
    F: FnMut(Option<(NaiveDateTime, i64)>) -> Select<signal_message::Entity>,
{
    let mut cursor = None;
    let mut selection = MessageCandidateSelection::default();
    loop {
        let rows = query_page(cursor)
            .into_model::<MessageCandidate>()
            .all(db)
            .await
            .c(h!())?;
        let row_count = rows.len() as u64;
        cursor = message_candidate_page_cursor(&rows);
        let candidates = prepare_message_candidates(rows);
        selection.merge(select_matching_message_candidates(
            association_message,
            probe,
            signal_window_start,
            signal_window_end,
            &candidates,
        ));
        if selection.newest_original.is_some()
            || row_count < ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE
            || cursor.is_none()
        {
            return Ok(selection);
        }
    }
}

fn datasource_group_message_candidate_query(
    datasource_group_ids: &[i64],
    probe: &str,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
    inbox_datetime_window: Option<(NaiveDateTime, NaiveDateTime)>,
    cursor: Option<(NaiveDateTime, i64)>,
) -> Select<signal_message::Entity> {
    message_candidate_base_query(
        probe,
        signal_window_start,
        signal_window_end,
        inbox_datetime_window,
        cursor,
    )
    .filter(
        signal_message::Column::DatasourceGroupId
            .eq_any(datasource_group_ids.to_vec()),
    )
}

fn linked_message_candidate_query(
    group_keys: &[String],
    probe: &str,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
    inbox_datetime_window: Option<(NaiveDateTime, NaiveDateTime)>,
    cursor: Option<(NaiveDateTime, i64)>,
) -> Select<signal_message::Entity> {
    message_candidate_base_query(
        probe,
        signal_window_start,
        signal_window_end,
        inbox_datetime_window,
        cursor,
    )
    .distinct()
    .join(
        JoinType::InnerJoin,
        signal_message::Relation::SignalMessageGroup.def(),
    )
    .filter(
        signal_message_group::Column::GroupMasterKey
            .eq_any(group_keys.to_vec()),
    )
}

fn message_candidate_base_query(
    probe: &str,
    signal_window_start: NaiveDateTime,
    signal_window_end: NaiveDateTime,
    inbox_datetime_window: Option<(NaiveDateTime, NaiveDateTime)>,
    cursor: Option<(NaiveDateTime, i64)>,
) -> Select<signal_message::Entity> {
    signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Timestamp)
        .column(signal_message::Column::Body)
        .column_as(sigint_inbox_item::Column::BodyNoheader, "body_noheader")
        .column(signal_message::Column::MessageUid)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(signal_message::Column::Timestamp.gte(signal_window_start))
        .filter(signal_message::Column::Timestamp.lte(signal_window_end))
        .apply_if(inbox_datetime_window, |query, (start, end)| {
            query.filter(inbox_datetime_or_missing_condition(start, end))
        })
        .filter(signal_message::Column::MessageUid.is_not_null())
        .filter(signal_message::Column::MessageUid.ne(""))
        .filter(
            Expr::col(signal_message::Column::Body)
                .like(format!("%{}%", escape_like(probe))),
        )
        .apply_if(cursor, |query, (timestamp, id)| {
            query.filter(
                Condition::any()
                    .add(signal_message::Column::Timestamp.lt(timestamp))
                    .add(
                        signal_message::Column::Timestamp
                            .eq(timestamp)
                            .and(signal_message::Column::Id.lt(id)),
                    ),
            )
        })
        .order_by_desc(signal_message::Column::Timestamp)
        .order_by_desc(signal_message::Column::Id)
        .limit(ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE)
}

fn inbox_datetime_or_missing_condition(
    start: NaiveDateTime,
    end: NaiveDateTime,
) -> Condition {
    Condition::any()
        .add(sigint_inbox_item::Column::Datetime.between(start, end))
        .add(sigint_inbox_item::Column::Datetime.is_null())
}

fn message_candidate_page_cursor(
    rows: &[MessageCandidate],
) -> Option<(NaiveDateTime, i64)> {
    let row = rows.last()?;
    Some((row.timestamp?, row.id))
}

fn prepare_message_candidates(
    rows: Vec<MessageCandidate>,
) -> Vec<PreparedMessageCandidate> {
    let mut candidates_by_id = HashMap::new();
    for row in rows {
        let Some(candidate) = prepare_message_candidate(row) else {
            continue;
        };
        candidates_by_id.entry(candidate.id).or_insert(candidate);
    }
    let mut candidates = candidates_by_id.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .timestamp
            .cmp(&left.timestamp)
            .then_with(|| right.id.cmp(&left.id))
    });
    candidates
}

fn prepare_message_candidate(
    row: MessageCandidate,
) -> Option<PreparedMessageCandidate> {
    let timestamp = row.timestamp?;
    let probe_body = normalize_message_body(row.body.as_deref()?);
    if probe_body.is_empty() {
        return None;
    }
    let body = candidate_message_body(&row)?;
    let message_uid = row
        .message_uid
        .filter(|message_uid| !message_uid.is_empty())?;
    Some(PreparedMessageCandidate {
        id: row.id,
        timestamp,
        body,
        probe_body,
        message_uid,
    })
}

fn candidate_message_body(row: &MessageCandidate) -> Option<String> {
    row.body_noheader
        .as_ref()
        .and_then(|body_noheader| body_noheader.get("body"))
        .and_then(serde_json::Value::as_str)
        .map(normalize_message_body)
        .filter(|body| !body.is_empty())
        .or_else(|| {
            row.body
                .as_deref()
                .map(normalize_message_body)
                .filter(|body| !body.is_empty())
        })
}

impl MessageCandidateSelection {
    fn consider(&mut self, candidate: &PreparedMessageCandidate) {
        let selected = SelectedMessageCandidate {
            id: candidate.id,
            timestamp: candidate.timestamp,
            message_uid: candidate.message_uid.clone(),
        };
        if is_duplicate_trace(candidate.id, &candidate.message_uid) {
            replace_with_newer_candidate(&mut self.newest_duplicate, selected);
        } else {
            replace_with_newer_candidate(&mut self.newest_original, selected);
        }
    }

    fn merge(&mut self, selection: Self) {
        if let Some(candidate) = selection.newest_original {
            replace_with_newer_candidate(&mut self.newest_original, candidate);
        }
        if let Some(candidate) = selection.newest_duplicate {
            replace_with_newer_candidate(&mut self.newest_duplicate, candidate);
        }
    }

    fn message_uid(self) -> Option<String> {
        self.newest_original
            .or(self.newest_duplicate)
            .map(|candidate| candidate.message_uid)
    }
}

fn replace_with_newer_candidate(
    selected: &mut Option<SelectedMessageCandidate>,
    candidate: SelectedMessageCandidate,
) {
    if selected.as_ref().is_none_or(|selected| {
        (candidate.timestamp, candidate.id) > (selected.timestamp, selected.id)
    }) {
        *selected = Some(candidate);
    }
}

pub(crate) fn association_original_message(
    row: &serde_json::Value,
) -> Option<&str> {
    row.get("cells")?
        .get(ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX)?
        .get("value")?
        .as_str()
        .map(str::trim)
        .filter(|message| !message.is_empty())
}

fn normalize_message_body(message: &str) -> String {
    message
        .replace("_x000d_", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn message_probe(message: &str) -> Option<String> {
    let message = message
        .split_whitespace()
        .max_by_key(|part| part.chars().count())?;
    let characters = message.chars().collect::<Vec<_>>();
    if characters.len() <= ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS {
        return Some(message.to_string());
    }
    let start = (characters.len() - ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS) / 2;
    Some(
        characters[start..start + ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS]
            .iter()
            .collect(),
    )
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn signal_message_window(
    window_anchor: &DateTime<FixedOffset>,
) -> (NaiveDateTime, NaiveDateTime) {
    let window_end = window_anchor.with_timezone(&Utc).naive_utc();
    let window_start = window_end
        - ChronoDuration::hours(ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS);
    (window_start, window_end)
}

fn signal_message_timestamp_window(
    source_date: Option<&DateTime<FixedOffset>>,
    source_created_at: &DateTime<FixedOffset>,
) -> (NaiveDateTime, NaiveDateTime) {
    match source_date {
        Some(source_date) => signal_message_window(source_date),
        None => signal_message_window(source_created_at),
    }
}

fn source_date_inbox_datetime_window(
    source_date: &DateTime<FixedOffset>,
) -> (NaiveDateTime, NaiveDateTime) {
    let source_date = source_date.with_timezone(&Utc).naive_utc();
    let tolerance = ChronoDuration::minutes(
        ORGANISM_GOI_MESSAGE_UID_SOURCE_DATE_TOLERANCE_MINUTES,
    );
    (source_date - tolerance, source_date + tolerance)
}

fn select_matching_message_candidates(
    association_message: &str,
    probe: &str,
    window_start: NaiveDateTime,
    window_end: NaiveDateTime,
    candidates: &[PreparedMessageCandidate],
) -> MessageCandidateSelection {
    let mut selection = MessageCandidateSelection::default();
    for candidate in candidates {
        if candidate.timestamp < window_start
            || candidate.timestamp > window_end
        {
            continue;
        }
        if !candidate.probe_body.contains(probe)
            || !normalized_message_bodies_match(
                association_message,
                &candidate.body,
            )
        {
            continue;
        }
        selection.consider(candidate);
    }
    selection
}

#[cfg(test)]
fn select_matching_original_message_uid(
    association_message: &str,
    probe: &str,
    window_start: NaiveDateTime,
    window_end: NaiveDateTime,
    candidates: &[PreparedMessageCandidate],
) -> Option<String> {
    select_matching_message_candidates(
        association_message,
        probe,
        window_start,
        window_end,
        candidates,
    )
    .message_uid()
}

pub(crate) fn message_bodies_equal(left: &str, right: &str) -> bool {
    normalize_message_body(left) == normalize_message_body(right)
}

fn normalized_message_bodies_match(left: &str, right: &str) -> bool {
    !left.is_empty()
        && !right.is_empty()
        && (left.contains(right) || right.contains(left))
}

fn is_duplicate_trace(message_id: i64, message_uid: &str) -> bool {
    message_uid
        .strip_prefix("duplicate-trace-")
        .and_then(|message_id| message_id.parse::<i64>().ok())
        == Some(message_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_since_ts_as_rfc3339() {
        assert_eq!(
            parse_since_ts("2026-06-15T08:00:00Z").unwrap(),
            DateTime::parse_from_rfc3339("2026-06-15T08:00:00Z").unwrap()
        );
        assert!(parse_since_ts("2026-06-15").is_err());
    }

    #[test]
    fn default_oneoff_query_selects_ten_newest_associations() {
        let sql = latest_associations_query(
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(sql.contains("ORDER BY \"goi_association\".\"id\" DESC"));
        assert!(sql.contains("LIMIT 10"));
    }

    #[test]
    fn candidate_queries_scope_to_organism_groups_window_and_probe() {
        let (window_start, window_end) = test_window();
        let linked_sql = linked_message_candidate_query(
            &["allowed-group".to_string()],
            "matching-probe",
            window_start,
            window_end,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        let direct_sql = datasource_group_message_candidate_query(
            &[1],
            "matching-probe",
            window_start,
            window_end,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(linked_sql.contains("signal_message_group"));
        assert!(linked_sql.contains("group_master_key"));
        assert!(linked_sql.starts_with("SELECT DISTINCT"));
        assert!(direct_sql.contains("datasource_group_id"));
        for sql in [linked_sql, direct_sql] {
            assert!(sql.contains("sigint_inbox_item"));
            assert!(sql.contains("body_noheader"));
            assert!(sql.contains("\"signal_message\".\"timestamp\" >="));
            assert!(sql.contains("\"signal_message\".\"timestamp\" <="));
            assert!(sql.contains("LIKE '%matching-probe%'"));
            assert!(sql.contains("LIMIT 1000"));
        }
    }

    #[test]
    fn source_date_candidate_query_uses_inbox_datetime_with_null_fallback() {
        let (window_start, window_end) = test_window();
        let inbox_datetime_window = (
            test_timestamp() - ChronoDuration::minutes(5),
            test_timestamp() + ChronoDuration::minutes(5),
        );
        let sql = datasource_group_message_candidate_query(
            &[1],
            "matching-probe",
            window_start,
            window_end,
            Some(inbox_datetime_window),
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(sql.contains("sigint_inbox_item"));
        assert!(sql.contains("\"sigint_inbox_item\".\"datetime\" BETWEEN"));
        assert!(sql.contains("\"sigint_inbox_item\".\"datetime\" IS NULL"));
    }

    #[test]
    fn candidate_query_uses_keyset_pagination() {
        let (window_start, window_end) = test_window();
        let sql = datasource_group_message_candidate_query(
            &[1],
            "matching-probe",
            window_start,
            window_end,
            None,
            Some((test_timestamp(), 42)),
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(sql.contains("\"signal_message\".\"timestamp\" <"));
        assert!(sql.contains("\"signal_message\".\"id\" < 42"));
    }

    #[test]
    fn association_original_message_decodes_json_escaping() {
        let mut cells = vec![
            serde_json::Value::Null;
            ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX
        ];
        cells.push(serde_json::json!({
            "kind": "string",
            "value": "first line\nquoted \"message\""
        }));
        let encoded = serde_json::to_string(&serde_json::json!({
            "cells": cells
        }))
        .unwrap();
        assert!(encoded.contains("\\n"));
        let row = serde_json::from_str(&encoded).unwrap();

        assert_eq!(
            association_original_message(&row),
            Some("first line\nquoted \"message\"")
        );
    }

    #[test]
    fn message_body_normalization_handles_excel_carriage_returns() {
        assert_eq!(
            normalize_message_body("first_x000d_\r\n second\tthird"),
            "first second third"
        );
        assert!(message_bodies_equal(
            "prefix_x000d_message",
            "prefix message"
        ));
    }

    #[test]
    fn message_probe_uses_middle_twenty_unicode_characters() {
        let message = "початок-1234567890ABCDEFGHIJ-кінець";
        let probe = message_probe(message).unwrap();

        assert_eq!(probe.chars().count(), 20);
        assert!(message.contains(&probe));
        assert_eq!(message_probe("коротке"), Some("коротке".to_string()));
    }

    #[test]
    fn message_probe_does_not_span_normalized_whitespace() {
        let message = normalize_message_body("short_x000d_distinctive-message");

        assert_eq!(
            message_probe(&message),
            Some("distinctive-message".to_string())
        );
    }

    #[test]
    fn message_probe_escapes_like_wildcards() {
        assert_eq!(escape_like(r"a\\b%c_d"), r"a\\\\b\%c\_d");
    }

    #[test]
    fn message_bodies_equal_only_after_normalization() {
        assert!(message_bodies_equal("first_x000d_ second", "first second"));
        assert!(!message_bodies_equal("message", "prefix message suffix"));
    }

    #[test]
    fn signal_message_window_is_previous_twenty_four_hours() {
        let window_anchor = FixedOffset::east_opt(2 * 60 * 60)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 21, 12, 0, 0)
            .unwrap();

        let (start, end) = signal_message_window(&window_anchor);

        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 7, 21, 10, 0, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(start, end - ChronoDuration::hours(24));
    }

    #[test]
    fn source_date_timestamp_window_ends_at_source_date() {
        let source_date =
            DateTime::parse_from_rfc3339("2026-06-15T08:00:00Z").unwrap();
        let source_created_at =
            DateTime::parse_from_rfc3339("2026-06-15T08:30:00Z").unwrap();

        let (start, end) = signal_message_timestamp_window(
            Some(&source_date),
            &source_created_at,
        );

        assert_eq!(
            start,
            Utc.with_ymd_and_hms(2026, 6, 14, 8, 0, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 6, 15, 8, 0, 0)
                .unwrap()
                .naive_utc()
        );
    }

    #[test]
    fn missing_source_date_timestamp_window_uses_created_at_lookback() {
        let source_created_at =
            DateTime::parse_from_rfc3339("2026-07-21T10:00:00Z").unwrap();

        let (start, end) =
            signal_message_timestamp_window(None, &source_created_at);

        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 7, 21, 10, 0, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(start, end - ChronoDuration::hours(24));
    }

    #[test]
    fn source_date_inbox_datetime_window_uses_tolerance() {
        let source_date =
            DateTime::parse_from_rfc3339("2026-06-15T08:00:00Z").unwrap();

        let (start, end) = source_date_inbox_datetime_window(&source_date);

        assert_eq!(
            start,
            Utc.with_ymd_and_hms(2026, 6, 15, 7, 55, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 6, 15, 8, 5, 0)
                .unwrap()
                .naive_utc()
        );
    }

    #[test]
    fn candidate_body_prefers_inbox_body_noheader() {
        let row = MessageCandidate {
            id: 1,
            timestamp: Some(test_timestamp()),
            body: Some("transport header transcript".to_string()),
            body_noheader: Some(serde_json::json!({
                "body": "transcript"
            })),
            message_uid: Some("uid".to_string()),
        };

        let candidate = prepare_message_candidate(row).unwrap();

        assert_eq!(candidate.body, "transcript");
        assert_eq!(candidate.probe_body, "transport header transcript");
    }

    #[test]
    fn candidate_body_falls_back_from_empty_inbox_body() {
        let row = MessageCandidate {
            id: 1,
            timestamp: Some(test_timestamp()),
            body: Some("transport header transcript".to_string()),
            body_noheader: Some(serde_json::json!({ "body": "  " })),
            message_uid: Some("uid".to_string()),
        };

        let candidate = prepare_message_candidate(row).unwrap();

        assert_eq!(candidate.body, "transport header transcript");
    }

    #[test]
    fn matching_uses_signal_body_for_probe_and_noheader_body_for_final_match() {
        let (window_start, window_end) = test_window();
        let candidate = PreparedMessageCandidate {
            id: 1,
            timestamp: test_timestamp(),
            body: normalize_message_body("transcript"),
            probe_body: normalize_message_body(
                "03.08.2026, transport header transcript",
            ),
            message_uid: "uid".to_string(),
        };

        let selected = select_matching_original_message_uid(
            "03.08.2026, transport header transcript",
            "03.08.2026,",
            window_start,
            window_end,
            &[candidate],
        );

        assert_eq!(selected.as_deref(), Some("uid"));
    }

    #[test]
    fn matching_prefers_original_then_falls_back_to_newest_duplicate() {
        let (window_start, window_end) = test_window();
        let duplicate = test_message(3, "duplicate-trace-3", "message");
        let original = test_message(2, "original-uid", "prefix message suffix");
        let older_duplicate =
            test_message(1, "duplicate-trace-1", "prefix message suffix");

        let selected = select_matching_original_message_uid(
            "message",
            "message",
            window_start,
            window_end,
            &[duplicate, original, older_duplicate],
        )
        .unwrap();
        assert_eq!(selected, "original-uid");

        let selected = select_matching_original_message_uid(
            "message",
            "message",
            window_start,
            window_end,
            &[
                test_message(3, "duplicate-trace-3", "message"),
                test_message(1, "duplicate-trace-1", "prefix message suffix"),
            ],
        );
        assert_eq!(selected.as_deref(), Some("duplicate-trace-3"));
    }

    fn test_window() -> (NaiveDateTime, NaiveDateTime) {
        let timestamp = test_timestamp();
        (
            timestamp - ChronoDuration::minutes(1),
            timestamp + ChronoDuration::minutes(1),
        )
    }

    fn test_timestamp() -> NaiveDateTime {
        Utc.with_ymd_and_hms(2026, 7, 21, 10, 0, 0)
            .unwrap()
            .naive_utc()
    }

    fn test_message(
        id: i64,
        message_uid: &str,
        body: &str,
    ) -> PreparedMessageCandidate {
        PreparedMessageCandidate {
            id,
            timestamp: test_timestamp(),
            body: normalize_message_body(body),
            probe_body: normalize_message_body(body),
            message_uid: message_uid.to_string(),
        }
    }
}
