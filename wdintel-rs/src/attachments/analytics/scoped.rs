use super::*;
use crate::config::{
    ANALYSIS_SEARCH_HTTP_TIMEOUT_MS_MAX,
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
    /// Request eligibility depends on attachment presence (`only_with_media`),
    /// so any in-scope change is relevant regardless of search terms.
    pub media_presence_filtered: bool,
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
    if changed.is_empty() {
        return Ok(());
    }
    let terms = ChangedTerms {
        search: search_text,
        search_mode,
    };
    if changed_attachments_match(source, &changed, &scope, &terms)
        .await
        .c(h!())?
        || changed_attachments_match(analytics, &changed, &scope, &terms)
            .await
            .c(h!())?
    {
        return requires_source("recent_message_change");
    }
    log::debug!(target: "attachment_search_coverage", "reason=recent_message_change_unaffected changed={}", changed.len());
    Ok(())
}

struct ChangedTerms<'a> {
    search: &'a str,
    search_mode: Option<crate::rer_importer::types::AnalysisSearchMode>,
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

/// Whether a changed message is in scope and has an attachment matching any
/// search term in this database's state. Evaluated on both source and
/// analytics, so a term only one side matches still forces source.
async fn changed_attachments_match(
    db: &DatabaseConnection,
    changed: &[i64],
    scope: &SearchCoverageScope<'_>,
    terms: &ChangedTerms<'_>,
) -> anyhow::Result<bool> {
    let time_column = scope.time_basis.column();
    let till_operator = if scope.till_inclusive { "<=" } else { "<" };
    let mut values: Vec<Value> = vec![
        changed.to_vec().into(),
        scope.groups.to_vec().into(),
        scope.since.into(),
        scope.till.into(),
    ];
    let relevant = if scope.media_presence_filtered {
        "true".into()
    } else {
        values.push(changed_media(db, changed).await.c(h!())?.into());
        changed_terms_match(terms, &mut values).c(h!())?
    };
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("SELECT EXISTS(SELECT 1 FROM signal_message message LEFT JOIN sigint_inbox_item inbox ON inbox.id=message.id AND inbox.id=ANY($1) WHERE message.id=ANY($1) AND ($3::timestamp IS NULL OR {time_column} >= $3) AND ($4::timestamp IS NULL OR {time_column} {till_operator} $4) AND EXISTS(SELECT 1 FROM signal_message_group access_group WHERE access_group.signal_message_id=message.id AND access_group.signal_message_id=ANY($1) AND access_group.group_master_key=ANY($2)) AND ({relevant})) AS matches"),
            values,
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "matches").c(h!())
}

/// Media of changed messages in this database, used to bound the document and
/// chunk inputs (the gateway does not push the media correlation into them).
async fn changed_media(
    db: &DatabaseConnection,
    changed: &[i64],
) -> anyhow::Result<Vec<uuid::Uuid>> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM signal_message_media WHERE signal_message_id=ANY($1)",
        [changed.to_vec().into()],
    ))
    .await
    .c(h!())?
    .into_iter()
    .map(|row| row.try_get("", "id").c(h!()))
    .collect()
}

/// Correlated to `message`: an attachment chunk, media file name or audio file
/// name of the changed message matches any search term. `$5` holds
/// [`changed_media`].
fn changed_terms_match(
    terms: &ChangedTerms<'_>,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    let attachment =
        super::super::search::attachment_terms_predicate_with_mode(
            terms.search,
            terms.search_mode,
            values,
        )
        .c(h!())?;
    let audio = super::super::search::audio_terms_predicate_with_mode(
        terms.search,
        terms.search_mode,
        values,
    )
    .c(h!())?;
    Ok(format!("EXISTS(SELECT 1 FROM signal_message_media media LEFT JOIN attachment_document doc ON doc.media_id=media.id AND doc.media_id=ANY($5) LEFT JOIN attachment_chunk chunk ON chunk.media_id=doc.media_id AND chunk.revision=doc.revision AND chunk.media_id=ANY($5) WHERE media.signal_message_id=message.id AND media.signal_message_id=ANY($1) AND media.id=ANY($5) AND ({attachment})) OR EXISTS(SELECT 1 FROM signal_message_audio_search audio_search WHERE audio_search.signal_message_id=message.id AND audio_search.signal_message_id=ANY($1) AND ({audio}))"))
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
            i64::try_from(ANALYSIS_SEARCH_HTTP_TIMEOUT_MS_MAX).c(h!())?,
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
