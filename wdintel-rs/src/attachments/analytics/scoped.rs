use super::*;
use crate::config::{
    ANALYTICS_HTTP_READ_TIMEOUT_MS,
    ATTACHMENT_SEARCH_CHANGE_CLEANUP_BATCH_SIZE,
    ATTACHMENT_SEARCH_CHANGE_LIMIT, ATTACHMENT_SEARCH_CHANGE_RETENTION_SECS,
};

pub(crate) enum SearchTimeBasis {
    Interception,
    Timestamp,
    Creation,
}

impl SearchTimeBasis {
    fn column(&self) -> &'static str {
        match self {
            Self::Interception => "inbox.datetime",
            Self::Timestamp => "message.timestamp",
            Self::Creation => "message.created_at",
        }
    }
}

pub(crate) struct SearchCoverageScope<'a> {
    pub since: Option<NaiveDateTime>,
    pub till: Option<NaiveDateTime>,
    pub till_inclusive: bool,
    pub time_basis: SearchTimeBasis,
    pub groups: &'a [String],
}

pub(crate) async fn ensure_search_coverage_scoped(
    source: &DatabaseConnection,
    analytics: &DatabaseConnection,
    search: &Option<String>,
    search_mode: Option<crate::rer_importer::types::AnalysisSearchMode>,
    freshness_max_age_ms: u64,
    scope: SearchCoverageScope<'_>,
) -> anyhow::Result<()> {
    let Some(search_text) = search.as_deref().filter(|s| !s.trim().is_empty())
    else {
        return Ok(());
    };
    if scope.groups.is_empty() {
        return Ok(());
    }
    let mut values = Vec::new();
    let predicate = super::super::search::chunk_terms_predicate_with_mode(
        search_text,
        search_mode,
        &mut values,
    )
    .c(h!())?;
    if predicate == "false" {
        return Ok(());
    }
    if freshness_max_age_ms > ATTACHMENT_SEARCH_CHANGE_RETENTION_SECS * 1_000 {
        return requires_source("retention_window");
    }
    let cutoff = Utc::now().naive_utc()
        - Duration::milliseconds(i64::try_from(freshness_max_age_ms).c(h!())?);
    if !tracking_covers_window(source, cutoff).await.c(h!())? {
        return requires_source("tracking_incomplete");
    }
    let coverage = load_search_coverage(analytics).await.c(h!())?;
    if !coverage.history_complete
        && source_matches_incomplete_coverage(
            source,
            coverage,
            predicate,
            values,
            freshness_max_age_ms,
            false,
        )
        .await
        .c(h!())?
    {
        return requires_source("history_incomplete");
    }
    let changed = changed_messages(source, cutoff).await.c(h!())?;
    if changed.len() as u64 > ATTACHMENT_SEARCH_CHANGE_LIMIT {
        return requires_source("change_limit");
    }
    if !changed.is_empty()
        && (changed_groups_match(source, &changed, &scope)
            .await
            .c(h!())?
            || changed_groups_match(analytics, &changed, &scope)
                .await
                .c(h!())?)
    {
        return requires_source("recent_message_change");
    }
    Ok(())
}

fn requires_source(reason: &str) -> anyhow::Result<()> {
    log::info!(target: "attachment_search_coverage", "reason={reason}");
    Err(AttachmentSearchCoverageError).c(h!())
}

async fn tracking_covers_window(
    source: &DatabaseConnection,
    cutoff: NaiveDateTime,
) -> anyhow::Result<bool> {
    let row = source
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT to_regclass('public.attachment_search_message_change') IS NOT NULL AS ready",
        ))
        .await
        .c(h!())?
        .c(h!())?;
    if !row.try_get::<bool>("", "ready").c(h!())? {
        return Ok(false);
    }
    let row = source
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT COALESCE(tracked_from <= $1, false) AS ready FROM attachment_search_change WHERE singleton",
            [cutoff.into()],
        ))
        .await
        .c(h!())?;
    row.map(|row| row.try_get::<bool>("", "ready").c(h!()))
        .transpose()
        .map(|ready| ready.unwrap_or(false))
        .c(h!())
}

async fn changed_messages(
    source: &DatabaseConnection,
    cutoff: NaiveDateTime,
) -> anyhow::Result<Vec<i64>> {
    source
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT message_id FROM ((SELECT message_id, changed_at FROM attachment_search_message_change WHERE changed_at IS NULL ORDER BY changed_at DESC, message_id DESC LIMIT $2) UNION ALL (SELECT message_id, changed_at FROM attachment_search_message_change WHERE changed_at >= $1 ORDER BY changed_at DESC, message_id DESC LIMIT $2)) changes ORDER BY changed_at DESC NULLS FIRST, message_id DESC LIMIT $2",
            [cutoff.into(), (ATTACHMENT_SEARCH_CHANGE_LIMIT + 1).into()],
        ))
        .await
        .c(h!())?
        .into_iter()
        .map(|row| row.try_get("", "message_id").c(h!()))
        .collect()
}

async fn changed_groups_match(
    db: &DatabaseConnection,
    changed: &[i64],
    scope: &SearchCoverageScope<'_>,
) -> anyhow::Result<bool> {
    let time_column = scope.time_basis.column();
    let till_operator = if scope.till_inclusive { "<=" } else { "<" };
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("SELECT EXISTS(SELECT 1 FROM signal_message message LEFT JOIN sigint_inbox_item inbox ON inbox.id=message.id AND inbox.id=ANY($1) WHERE message.id=ANY($1) AND ($3::timestamp IS NULL OR {time_column} >= $3) AND ($4::timestamp IS NULL OR {time_column} {till_operator} $4) AND EXISTS(SELECT 1 FROM signal_message_group access_group WHERE access_group.signal_message_id=message.id AND access_group.signal_message_id=ANY($1) AND access_group.group_master_key=ANY($2))) AS matches"),
            [changed.to_vec().into(), scope.groups.to_vec().into(),
                scope.since.into(), scope.till.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "matches").c(h!())
}

pub(crate) async fn reconcile_search_changes(
    source: &DatabaseConnection,
) -> anyhow::Result<()> {
    source
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "WITH pending AS MATERIALIZED (SELECT ctid FROM attachment_search_message_change WHERE changed_at IS NULL ORDER BY changed_at, message_id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE attachment_search_message_change changes SET changed_at=clock_timestamp() AT TIME ZONE 'UTC' FROM pending WHERE changes.ctid=pending.ctid AND changes.changed_at IS NULL",
            [ATTACHMENT_SEARCH_CHANGE_CLEANUP_BATCH_SIZE.into()],
        ))
        .await
        .c(h!())?;
    prune_search_changes(source).await.c(h!())
}

async fn prune_search_changes(
    source: &DatabaseConnection,
) -> anyhow::Result<()> {
    let cutoff = Utc::now().naive_utc()
        - Duration::seconds(
            i64::try_from(ATTACHMENT_SEARCH_CHANGE_RETENTION_SECS).c(h!())?,
        )
        - Duration::milliseconds(
            i64::try_from(ANALYTICS_HTTP_READ_TIMEOUT_MS).c(h!())?,
        );
    source
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "WITH expired AS MATERIALIZED (SELECT ctid FROM attachment_search_message_change WHERE changed_at < $1 ORDER BY changed_at, message_id LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM attachment_search_message_change changes USING expired WHERE changes.ctid=expired.ctid AND changes.changed_at < $1",
            [cutoff.into(), ATTACHMENT_SEARCH_CHANGE_CLEANUP_BATCH_SIZE.into()],
        ))
        .await
        .c(h!())?;
    Ok(())
}
