use crate::config::Config;
use crate::entities::association;
use anyhow::{Context, Result};
use goi_echo_worker::row::{read_association_rows, AssociationRow};
use sea_orm::sea_query::OnConflict;
use sea_orm::{DatabaseConnection, EntityTrait, NotSet, Set};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileFingerprint {
    modified_ms: u128,
    len: u64,
}

#[derive(Default)]
struct WorkerState {
    last_fingerprint: Option<FileFingerprint>,
    missing_logged: bool,
}

pub async fn associations_worker_nofail(
    db: DatabaseConnection,
    config: Config,
) {
    let mut state = WorkerState::default();
    loop {
        if let Err(err) =
            associations_worker_step(&db, &config, &mut state).await
        {
            log::warn!("goi associations worker step failed: {err:#}");
        }
        tokio::time::sleep(Duration::from_millis(config.poll_sleep_ms())).await;
    }
}

async fn associations_worker_step(
    db: &DatabaseConnection,
    config: &Config,
    state: &mut WorkerState,
) -> Result<()> {
    let path = PathBuf::from(config.associations_xlsx_path());
    let Some(fingerprint) = file_fingerprint(&path, state).await? else {
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
    .context("joining XLSX reader task")??;

    insert_rows(db, rows).await?;
    state.last_fingerprint = Some(fingerprint);
    state.missing_logged = false;
    Ok(())
}

async fn file_fingerprint(
    path: &PathBuf,
    state: &mut WorkerState,
) -> Result<Option<FileFingerprint>> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if !state.missing_logged {
                log::warn!(
                    "GOI associations file not found: {}",
                    path.display()
                );
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

async fn insert_rows(
    db: &DatabaseConnection,
    rows: Vec<AssociationRow>,
) -> Result<()> {
    let models = rows
        .into_iter()
        .filter_map(|row| {
            let dedupe_key = row.dedupe_key()?;
            let row = serde_json::to_value(row).ok()?;
            Some(association::ActiveModel {
                id: NotSet,
                row: Set(row),
                created_at: NotSet,
                deleted: Set(false),
                dedupe_key: Set(dedupe_key),
            })
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Ok(());
    }

    association::Entity::insert_many(models)
        .on_conflict(
            OnConflict::column(association::Column::DedupeKey)
                .do_nothing()
                .to_owned(),
        )
        .exec(db)
        .await
        .context("inserting association rows")?;
    Ok(())
}
