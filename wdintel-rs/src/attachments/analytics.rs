use crate::{h, types::ShortContext};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, Value,
};

#[derive(Debug, thiserror::Error)]
#[error(
    "attachment search requires source history or recent attachment changes"
)]
pub(crate) struct AttachmentSearchCoverageError;

pub(crate) async fn replicate_history(
    mode: crate::types::Mode,
) -> anyhow::Result<()> {
    let script = if matches!(mode, crate::types::Mode::Live) {
        crate::config::ANALYTICS_ATTACHMENT_HISTORY_SCRIPT
    } else {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../deploy/clickhouse/bin/oneoff-replicate-attachment-history.sh"
        )
    };
    let status = tokio::process::Command::new("bash")
        .arg(script)
        .arg("--yes")
        .status()
        .await
        .c(h!())?;
    anyhow::ensure!(
        status.success(),
        "attachment history replication failed: {status}"
    );
    Ok(())
}

#[cfg(test)]
pub(crate) async fn ensure_search_coverage(
    source: &DatabaseConnection,
    analytics: &DatabaseConnection,
    search: &Option<String>,
    freshness_max_age_ms: u64,
) -> anyhow::Result<()> {
    ensure_search_coverage_with_mode(
        source,
        analytics,
        search,
        None,
        freshness_max_age_ms,
    )
    .await
    .c(h!())
}

pub(crate) async fn ensure_search_coverage_with_mode(
    source: &DatabaseConnection,
    analytics: &DatabaseConnection,
    search: &Option<String>,
    search_mode: Option<crate::rer_importer::types::AnalysisSearchMode>,
    freshness_max_age_ms: u64,
) -> anyhow::Result<()> {
    let Some(search) =
        search.as_deref().filter(|search| !search.trim().is_empty())
    else {
        return Ok(());
    };
    let mut values = Vec::new();
    let predicate = super::search::chunk_terms_predicate_with_mode(
        search,
        search_mode,
        &mut values,
    )
    .c(h!())?;
    if predicate == "false" {
        return Ok(());
    }
    let coverage = load_search_coverage(analytics).await.c(h!())?;
    if source_matches_incomplete_coverage(
        source,
        coverage,
        predicate,
        values,
        freshness_max_age_ms,
    )
    .await
    .c(h!())?
    {
        return Err(AttachmentSearchCoverageError).c(h!());
    }
    Ok(())
}

struct AttachmentSearchCoverage {
    started_at: NaiveDateTime,
    history_complete: bool,
}

async fn load_search_coverage(
    analytics: &DatabaseConnection,
) -> anyhow::Result<AttachmentSearchCoverage> {
    let ready = analytics
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT to_regclass('public.echo_analytics_attachment_search') IS NOT NULL AND to_regclass('public.attachment_document') IS NOT NULL AND to_regclass('public.attachment_chunk') IS NOT NULL AS ready",
        ))
        .await
        .c(h!())?
        .c(h!())?;
    if !ready.try_get::<bool>("", "ready").c(h!())? {
        return Err(AttachmentSearchCoverageError).c(h!());
    }
    let coverage = analytics
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT started_at, history_complete FROM public.echo_analytics_attachment_search WHERE singleton",
        ))
        .await
        .c(h!())?;
    let Some(coverage) = coverage else {
        return Err(AttachmentSearchCoverageError).c(h!());
    };
    Ok(AttachmentSearchCoverage {
        started_at: coverage.try_get("", "started_at").c(h!())?,
        history_complete: coverage.try_get("", "history_complete").c(h!())?,
    })
}

async fn source_matches_incomplete_coverage(
    source: &DatabaseConnection,
    coverage: AttachmentSearchCoverage,
    predicate: String,
    mut values: Vec<Value>,
    freshness_max_age_ms: u64,
) -> anyhow::Result<bool> {
    let started_at_parameter = values.len() + 1;
    values.push(coverage.started_at.into());
    let history_parameter = values.len() + 1;
    values.push(coverage.history_complete.into());
    let recent_parameter = values.len() + 1;
    let freshness_max_age_ms = i64::try_from(freshness_max_age_ms).c(h!())?;
    values.push(
        (Utc::now().naive_utc() - Duration::milliseconds(freshness_max_age_ms))
            .into(),
    );
    let row = source
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("SELECT (NOT ${history_parameter} AND EXISTS(SELECT 1 FROM attachment_chunk chunk JOIN attachment_document doc ON doc.media_id=chunk.media_id AND doc.revision=chunk.revision WHERE doc.created_at < ${started_at_parameter} AND ({predicate}))) OR COALESCE((SELECT doc.updated_at FROM attachment_document doc ORDER BY doc.updated_at DESC LIMIT 1) >= ${recent_parameter}, false) OR COALESCE((SELECT changed_at FROM attachment_search_change WHERE singleton) >= ${recent_parameter}, true) AS requires_source"),
            values,
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get::<bool>("", "requires_source").c(h!())
}
