use crate::config::Config;
use crate::entities::{association, knowledge};
use anyhow::{Context, Result};
use goi_echo_worker::knowledge::{read_knowledge_rows, KnowledgeRow};
use goi_echo_worker::row::{read_association_rows, AssociationRow};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait, NotSet,
    QueryFilter, Set, TransactionTrait, TryInsertResult,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileFingerprint {
    modified_ms: u128,
    len: u64,
}

#[derive(Default)]
struct FileState {
    last_fingerprint: Option<FileFingerprint>,
    last_refresh_bucket: Option<i64>,
    missing_logged: bool,
}

pub async fn associations_worker_nofail(
    db: DatabaseConnection,
    config: Config,
) {
    let mut state = FileState::default();
    loop {
        if let Err(err) =
            associations_worker_step(&db, &config, &mut state).await
        {
            log::warn!("goi associations worker step failed: {err:#}");
        }
        tokio::time::sleep(Duration::from_millis(config.poll_sleep_ms())).await;
    }
}

pub async fn knowledge_worker_nofail(db: DatabaseConnection, config: Config) {
    let mut state = FileState::default();
    loop {
        if let Err(err) = knowledge_worker_step(&db, &config, &mut state).await
        {
            log::warn!("goi knowledge worker step failed: {err:#}");
        }
        tokio::time::sleep(Duration::from_millis(config.poll_sleep_ms())).await;
    }
}

async fn associations_worker_step(
    db: &DatabaseConnection,
    config: &Config,
    state: &mut FileState,
) -> Result<()> {
    let path = PathBuf::from(config.associations_xlsx_path());
    let Some(fingerprint) =
        file_fingerprint(&path, state, "associations").await?
    else {
        return Ok(());
    };
    if state.last_fingerprint.as_ref() == Some(&fingerprint) {
        return Ok(());
    }

    let path_for_read = path.clone();
    let rows = tokio::task::spawn_blocking(move || {
        read_association_rows(&path_for_read)
    })
    .await
    .context("joining associations XLSX reader task")??;
    log::info!(
        "GOI associations worker read {} rows from {}",
        rows.len(),
        path.display()
    );

    insert_association_rows(db, rows).await?;
    state.last_fingerprint = Some(fingerprint);
    state.missing_logged = false;
    Ok(())
}

async fn knowledge_worker_step(
    db: &DatabaseConnection,
    config: &Config,
    state: &mut FileState,
) -> Result<()> {
    let path = PathBuf::from(config.knowledge_xlsx_path());
    let Some(fingerprint) = file_fingerprint(&path, state, "knowledge").await?
    else {
        return Ok(());
    };
    let refresh_bucket = knowledge_refresh_bucket();
    if state.last_fingerprint.as_ref() == Some(&fingerprint)
        && state.last_refresh_bucket == Some(refresh_bucket)
    {
        return Ok(());
    }

    let path_for_read = path.clone();
    let rows = tokio::task::spawn_blocking(move || {
        read_knowledge_rows(&path_for_read)
    })
    .await
    .context("joining knowledge XLSX reader task")??;
    log::info!(
        "GOI knowledge worker read {} rows from {}",
        rows.len(),
        path.display()
    );

    sync_knowledge_rows(db, rows).await?;
    prune_old_deleted_knowledge_rows(db).await?;
    state.last_fingerprint = Some(fingerprint);
    state.last_refresh_bucket = Some(refresh_bucket);
    state.missing_logged = false;
    Ok(())
}

async fn file_fingerprint(
    path: &PathBuf,
    state: &mut FileState,
    kind: &str,
) -> Result<Option<FileFingerprint>> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if !state.missing_logged {
                log::warn!("GOI {kind} file not found: {}", path.display());
                state.missing_logged = true;
            }
            state.last_fingerprint = None;
            return Ok(None);
        }
        Err(err) => {
            return Err(err).with_context(|| path.display().to_string())
        }
    };
    let modified_ms = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(Some(FileFingerprint {
        modified_ms,
        len: metadata.len(),
    }))
}

async fn insert_association_rows(
    db: &DatabaseConnection,
    rows: Vec<AssociationRow>,
) -> Result<()> {
    let models = rows
        .into_iter()
        .map(|association_row| {
            let dedupe_key = association_row.dedupe_key();
            let association_row = serde_json::to_value(association_row)
                .context("serializing association row")?;
            Ok(association::ActiveModel {
                id: NotSet,
                row: Set(association_row),
                created_at: NotSet,
                deleted: Set(false),
                dedupe_key: Set(dedupe_key),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if models.is_empty() {
        return Ok(());
    }

    let result = association::Entity::insert_many(models)
        .on_conflict(
            OnConflict::column(association::Column::DedupeKey)
                .do_nothing()
                .to_owned(),
        )
        .do_nothing()
        .exec(db)
        .await
        .context("inserting association rows")?;
    log_insert_result(result);
    Ok(())
}

async fn sync_knowledge_rows(
    db: &DatabaseConnection,
    rows: Vec<KnowledgeRow>,
) -> Result<()> {
    let now = chrono::Utc::now();
    let deduped_rows = dedupe_knowledge_rows(
        rows.into_iter()
            .filter(|knowledge_row| {
                knowledge_row_is_recent(&now, knowledge_row)
            })
            .collect(),
    );
    let dedupe_keys = deduped_rows.keys().cloned().collect::<Vec<_>>();
    let tx = db.begin().await.context("beginning knowledge sync tx")?;

    mark_missing_knowledge_rows_deleted(&tx, &dedupe_keys, now.fixed_offset())
        .await?;
    if deduped_rows.is_empty() {
        tx.commit().await.context("committing knowledge sync tx")?;
        log::info!("GOI knowledge worker detected no active rows in workbook");
        return Ok(());
    }

    let models = deduped_rows
        .into_iter()
        .map(|(dedupe_key, knowledge_row)| {
            serde_json::to_value(knowledge_row).map(|knowledge_row| {
                knowledge::ActiveModel {
                    id: NotSet,
                    row: Set(knowledge_row),
                    created_at: NotSet,
                    updated_at: Set(now.fixed_offset()),
                    deleted: Set(false),
                    dedupe_key: Set(dedupe_key),
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    knowledge::Entity::insert_many(models)
        .on_conflict(
            OnConflict::column(knowledge::Column::DedupeKey)
                .update_columns([
                    knowledge::Column::Row,
                    knowledge::Column::UpdatedAt,
                    knowledge::Column::Deleted,
                ])
                .to_owned(),
        )
        .exec(&tx)
        .await
        .context("upserting knowledge rows")?;
    tx.commit().await.context("committing knowledge sync tx")?;
    log::info!(
        "GOI knowledge worker synced {} active rows",
        dedupe_keys.len()
    );
    Ok(())
}

async fn mark_missing_knowledge_rows_deleted(
    db: &DatabaseTransaction,
    dedupe_keys: &[String],
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Result<()> {
    let mut query = knowledge::Entity::update_many()
        .col_expr(knowledge::Column::Deleted, Expr::value(true))
        .col_expr(knowledge::Column::UpdatedAt, Expr::value(now))
        .filter(knowledge::Column::Deleted.eq(false));
    if !dedupe_keys.is_empty() {
        query = query.filter(
            knowledge::Column::DedupeKey.is_not_in(dedupe_keys.iter().cloned()),
        );
    }
    query
        .exec(db)
        .await
        .context("marking missing knowledge rows deleted")?;
    Ok(())
}

async fn prune_old_deleted_knowledge_rows(
    db: &DatabaseConnection,
) -> Result<()> {
    let cutoff = chrono::Utc::now()
        - chrono::Duration::days(
            crate::config::GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS,
        );
    knowledge::Entity::delete_many()
        .filter(knowledge::Column::Deleted.eq(true))
        .filter(knowledge::Column::UpdatedAt.lt(cutoff.fixed_offset()))
        .exec(db)
        .await
        .context("deleting stale knowledge rows")?;
    Ok(())
}

fn dedupe_knowledge_rows(
    rows: Vec<KnowledgeRow>,
) -> BTreeMap<String, KnowledgeRow> {
    let mut deduped_rows = BTreeMap::new();
    for knowledge_row in rows {
        let Some(dedupe_key) = knowledge_row.dedupe_key() else {
            continue;
        };
        deduped_rows.insert(dedupe_key, knowledge_row);
    }
    deduped_rows
}

fn knowledge_row_is_recent(
    now: &chrono::DateTime<chrono::Utc>,
    knowledge_row: &KnowledgeRow,
) -> bool {
    match knowledge_row.source_date() {
        Some(source_date) => {
            source_date
                >= *now
                    - chrono::Duration::days(
                        crate::config::GOI_KNOWLEDGE_SYNC_MAX_AGE_DAYS,
                    )
        }
        None => true,
    }
}

fn knowledge_refresh_bucket() -> i64 {
    chrono::Utc::now().timestamp() / 3600
}

fn log_insert_result(
    result: TryInsertResult<sea_orm::InsertResult<association::ActiveModel>>,
) {
    match result {
        TryInsertResult::Empty => {}
        TryInsertResult::Conflicted => {
            log::info!(
                "GOI associations worker detected no new rows to insert"
            );
        }
        TryInsertResult::Inserted(insert_result) => {
            log::info!(
                "GOI associations worker stored new rows; last_insert_id={}",
                insert_result.last_insert_id
            );
        }
    }
}
