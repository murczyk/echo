use crate::config::Config;
use crate::entities::{association, knowledge};
use anyhow::{Context, Result};
use goi_echo_worker::knowledge::{
    read_knowledge_rows, KnowledgeRow, KNOWLEDGE_WORKER_DEDUPE_KEY_PREFIX,
};
use goi_echo_worker::row::{read_association_rows, AssociationRow};
use goi_echo_worker::xlsx::empty_xlsx_buffer;
use sea_orm::sea_query::{
    Alias, BinOper, Condition, Expr, ExprTrait, OnConflict, SimpleExpr,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, NotSet, PaginatorTrait, QueryFilter, Set,
    TransactionTrait, TryInsertResult,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileFingerprint {
    path: PathBuf,
    modified_ms: u128,
    len: u64,
}

#[derive(Default)]
struct FileState {
    last_fingerprint: Option<FileFingerprint>,
    last_refresh_bucket: Option<i64>,
    missing_logged: bool,
}

pub async fn ensure_xlsx_files_exist(config: &Config) -> Result<()> {
    for (kind, path) in [
        (
            "associations",
            PathBuf::from(config.associations_xlsx_path()),
        ),
        ("knowledge", config.preferred_knowledge_xlsx_path()),
        ("frequencies", config.preferred_frequencies_xlsx_path()),
    ] {
        ensure_xlsx_file_exists(&path, kind).await?;
    }
    Ok(())
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
    let path = config.preferred_knowledge_xlsx_path();
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
                log::warn!(
                    "GOI {kind} file not found, creating empty XLSX: {}",
                    path.display()
                );
                state.missing_logged = true;
            }
            state.last_fingerprint = None;
            ensure_xlsx_file_exists(path, kind).await?;
            state.missing_logged = false;
            tokio::fs::metadata(path)
                .await
                .with_context(|| path.display().to_string())?
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
        path: path.clone(),
        modified_ms,
        len: metadata.len(),
    }))
}

async fn ensure_xlsx_file_exists(path: &Path, kind: &str) -> Result<bool> {
    match tokio::fs::metadata(path).await {
        Ok(_) => Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            create_empty_xlsx_file(path).await?;
            log::info!("Created empty GOI {kind} XLSX: {}", path.display());
            Ok(true)
        }
        Err(err) => Err(err).with_context(|| path.display().to_string()),
    }
}

async fn create_empty_xlsx_file(path: &Path) -> Result<()> {
    let parent = path.parent().context("XLSX path has no parent directory")?;
    tokio::fs::create_dir_all(parent).await?;

    let tmp_path = temp_xlsx_path(path);
    let file_data = tokio::task::spawn_blocking(empty_xlsx_buffer)
        .await
        .context("joining empty XLSX writer task")??;
    tokio::fs::write(&tmp_path, file_data).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        tokio::fs::set_permissions(
            &tmp_path,
            std::fs::Permissions::from_mode(0o644),
        )
        .await?;
    }
    tokio::fs::rename(&tmp_path, path).await?;
    Ok(())
}

fn temp_xlsx_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("goi.xlsx");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{file_name}.tmp-{suffix}"))
}

async fn insert_association_rows(
    db: &DatabaseConnection,
    rows: Vec<AssociationRow>,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let dedupe_targets = association_dedupe_targets(&rows)
        .context("building association dedupe targets")?;
    let tx = db
        .begin()
        .await
        .context("beginning association insert tx")?;
    rekey_existing_association_rows(&tx, &dedupe_targets)
        .await
        .context("rekeying existing associations")?;

    let mut models_batch = Vec::new();
    for association_row in rows {
        models_batch.push(
            association_row_to_active_model(association_row)
                .context("building association model")?,
        );
        if models_batch.len()
            >= crate::config::GOI_ASSOCIATIONS_INSERT_BATCH_SIZE
        {
            insert_association_model_batch(
                &tx,
                std::mem::take(&mut models_batch),
            )
            .await
            .context("inserting association batch")?;
        }
    }
    if !models_batch.is_empty() {
        insert_association_model_batch(&tx, models_batch)
            .await
            .context("inserting final association batch")?;
    }
    tx.commit()
        .await
        .context("committing association insert tx")?;
    Ok(())
}

fn association_dedupe_targets(
    rows: &[AssociationRow],
) -> Result<BTreeMap<String, String>> {
    rows.iter()
        .map(|association_row| {
            let cells = serde_json::to_string(&association_row.cells)
                .context("serializing association cells")?;
            Ok((cells, association_row.dedupe_key()))
        })
        .collect()
}

async fn rekey_existing_association_rows<C>(
    db: &C,
    dedupe_targets: &BTreeMap<String, String>,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let legacy_key_count = association::Entity::find()
        .filter(
            association::Column::DedupeKeyVersion
                .lt(crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION),
        )
        .count(db)
        .await
        .context("counting legacy association dedupe keys")?;
    if legacy_key_count == 0 {
        return Ok(());
    }

    let existing_rows = association::Entity::find()
        .all(db)
        .await
        .context("loading existing association dedupe keys")?;
    let key_updates = plan_association_rekey(existing_rows, dedupe_targets)
        .context("planning association dedupe rekey")?;
    let update_count = key_updates.len();
    for (association, dedupe_key) in key_updates {
        let association_id = association.id;
        let mut association = association.into_active_model();
        association.dedupe_key = Set(dedupe_key);
        association.dedupe_key_version =
            Set(crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION);
        association.update(db).await.with_context(|| {
            format!("rekeying association row {association_id}")
        })?;
    }
    if update_count > 0 {
        log::info!(
            "GOI associations worker normalized {update_count} existing dedupe keys"
        );
    }
    Ok(())
}

fn plan_association_rekey(
    mut existing_rows: Vec<association::Model>,
    dedupe_targets: &BTreeMap<String, String>,
) -> Result<Vec<(association::Model, String)>> {
    let mut occupied_keys = existing_rows
        .iter()
        .map(|association| association.dedupe_key.clone())
        .collect::<BTreeSet<_>>();
    existing_rows.sort_by_key(|association| association.id);

    let mut key_updates = Vec::new();
    for association in existing_rows {
        if association.dedupe_key_version
            >= crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION
        {
            continue;
        }
        let association_row =
            serde_json::from_value::<AssociationRow>(association.row.clone())
                .with_context(|| {
                format!(
                    "deserializing stored association row {}",
                    association.id
                )
            })?;
        let cells =
            serde_json::to_string(&association_row.excel_unescaped_cells())
                .with_context(|| {
                    format!(
                        "serializing stored association row {}",
                        association.id
                    )
                })?;
        let Some(dedupe_key) = dedupe_targets.get(&cells) else {
            continue;
        };
        if association.dedupe_key != *dedupe_key
            && occupied_keys.contains(dedupe_key)
        {
            continue;
        }
        occupied_keys.remove(&association.dedupe_key);
        occupied_keys.insert(dedupe_key.clone());
        key_updates.push((association, dedupe_key.clone()));
    }
    Ok(key_updates)
}

fn association_row_to_active_model(
    association_row: AssociationRow,
) -> Result<association::ActiveModel> {
    let dedupe_key = association_row.dedupe_key();
    let association_row = serde_json::to_value(association_row)
        .context("serializing association row")?;
    Ok(association::ActiveModel {
        id: NotSet,
        row: Set(association_row),
        created_at: NotSet,
        deleted: Set(false),
        dedupe_key: Set(dedupe_key),
        dedupe_key_version: Set(
            crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION,
        ),
    })
}

async fn insert_association_model_batch<C>(
    db: &C,
    models_batch: Vec<association::ActiveModel>,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let result = association::Entity::insert_many(models_batch)
        .on_conflict_do_nothing_on([association::Column::DedupeKey])
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

    rekey_existing_worker_knowledge_rows(&tx, &deduped_rows).await?;
    delete_missing_knowledge_rows(&tx, &dedupe_keys).await?;
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
                ])
                .action_cond_where(knowledge_upsert_has_changes())
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

async fn rekey_existing_worker_knowledge_rows<C>(
    db: &C,
    desired_rows: &BTreeMap<String, KnowledgeRow>,
) -> Result<()>
where
    C: ConnectionTrait,
{
    let desired_keys = desired_rows
        .keys()
        .filter(|key| key.starts_with(KNOWLEDGE_WORKER_DEDUPE_KEY_PREFIX))
        .cloned()
        .collect::<Vec<_>>();
    if desired_keys.is_empty() {
        return Ok(());
    }
    let existing_key_count = knowledge::Entity::find()
        .filter(knowledge::Column::DedupeKey.is_in(desired_keys.clone()))
        .count(db)
        .await
        .context("counting stable worker knowledge keys")?;
    if existing_key_count == desired_keys.len() as u64 {
        return Ok(());
    }

    let existing_rows = knowledge::Entity::find()
        .all(db)
        .await
        .context("loading existing knowledge keys")?;
    let key_updates = plan_worker_knowledge_rekey(existing_rows, desired_rows)?;

    for (knowledge, dedupe_key) in key_updates {
        let knowledge_id = knowledge.id;
        let mut knowledge = knowledge.into_active_model();
        knowledge.dedupe_key = Set(dedupe_key);
        knowledge.update(db).await.with_context(|| {
            format!("rekeying worker knowledge row {knowledge_id}")
        })?;
    }
    Ok(())
}

fn plan_worker_knowledge_rekey(
    mut existing_rows: Vec<knowledge::Model>,
    desired_rows: &BTreeMap<String, KnowledgeRow>,
) -> Result<Vec<(knowledge::Model, String)>> {
    let mut occupied_keys = existing_rows
        .iter()
        .map(|knowledge| knowledge.dedupe_key.clone())
        .collect::<std::collections::BTreeSet<_>>();
    existing_rows.sort_by_key(|row| std::cmp::Reverse(row.id));
    let mut key_updates = Vec::new();
    for knowledge in existing_rows {
        let knowledge_row =
            serde_json::from_value::<KnowledgeRow>(knowledge.row.clone())
                .with_context(|| {
                    format!(
                        "deserializing stored knowledge row {}",
                        knowledge.id
                    )
                })?;
        let Some(next_key) = knowledge_row.dedupe_key() else {
            continue;
        };
        if knowledge.dedupe_key != next_key
            && desired_rows.contains_key(&next_key)
            && occupied_keys.insert(next_key.clone())
        {
            key_updates.push((knowledge, next_key));
        }
    }
    Ok(key_updates)
}

fn knowledge_upsert_has_changes() -> Condition {
    Condition::any().add(knowledge_row_contents_are_distinct())
}

fn knowledge_row_contents_are_distinct() -> SimpleExpr {
    knowledge_row_without_layout(Expr::col((
        knowledge::Entity,
        knowledge::Column::Row,
    )))
    .binary(
        BinOper::Custom("IS DISTINCT FROM"),
        knowledge_row_without_layout(Expr::col((
            Alias::new("excluded"),
            knowledge::Column::Row,
        ))),
    )
}

fn knowledge_row_without_layout(row: SimpleExpr) -> SimpleExpr {
    row.binary(BinOper::Custom("-"), Expr::value("sheet_name"))
        .binary(BinOper::Custom("-"), Expr::value("row_num"))
}

async fn delete_missing_knowledge_rows<C>(
    db: &C,
    dedupe_keys: &[String],
) -> Result<()>
where
    C: ConnectionTrait,
{
    let mut query = knowledge::Entity::delete_many();
    if !dedupe_keys.is_empty() {
        query = query.filter(
            knowledge::Column::DedupeKey.is_not_in(dedupe_keys.iter().cloned()),
        );
    }
    query
        .exec(db)
        .await
        .context("deleting missing knowledge rows")?;
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
    if knowledge_row.is_worker_managed_callsign() {
        return true;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use goi_echo_worker::knowledge::{
        read_knowledge_rows, KnowledgeCell, KNOWLEDGE_KIND_CALL_SIGN,
        KNOWLEDGE_WORKER_AUTHOR, KNOWLEDGE_WORKER_ID_PREFIX,
    };
    use goi_echo_worker::row::{read_association_rows, AssociationCell};
    use serde_json::Value;

    #[test]
    fn worker_callsign_rekey_keeps_latest_existing_row_id() {
        let previous = worker_callsign_row(42, "previous");
        let desired =
            dedupe_knowledge_rows(vec![worker_callsign_row(42, "next")]);
        let existing_rows = vec![
            stored_knowledge(7, "legacy-key-a", &previous),
            stored_knowledge(9, "legacy-key-b", &previous),
        ];

        let key_updates = plan_worker_knowledge_rekey(existing_rows, &desired)
            .expect("plan rekey");

        assert_eq!(key_updates.len(), 1);
        assert_eq!(key_updates[0].0.id, 9);
        assert_eq!(
            key_updates[0].1,
            format!("{KNOWLEDGE_WORKER_DEDUPE_KEY_PREFIX}42")
        );
    }

    #[test]
    fn association_rekey_preserves_existing_id_after_excel_unescape() {
        let legacy = association_row("first_x000d_\nsecond");
        let desired = association_row("first\nsecond");
        let legacy_key = legacy.dedupe_key();
        let desired_key = desired.dedupe_key();
        let dedupe_targets =
            association_dedupe_targets(std::slice::from_ref(&desired))
                .expect("dedupe targets");

        let key_updates = plan_association_rekey(
            vec![stored_association(7, &legacy_key, &legacy)],
            &dedupe_targets,
        )
        .expect("plan rekey");

        assert_ne!(legacy_key, desired_key);
        assert_eq!(key_updates.len(), 1);
        assert_eq!(key_updates[0].0.id, 7);
        assert_eq!(key_updates[0].1, desired_key);

        let active = association_row_to_active_model(desired)
            .expect("association active model");
        assert_eq!(
            active.dedupe_key_version,
            Set(crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION)
        );

        let literal = association_row("literal _x000D_ token");
        let dedupe_targets =
            association_dedupe_targets(std::slice::from_ref(&literal))
                .expect("literal dedupe targets");
        let mut stored = stored_association(8, &literal.dedupe_key(), &literal);
        stored.dedupe_key_version =
            crate::config::GOI_ASSOCIATION_DEDUPE_KEY_VERSION;

        assert!(plan_association_rekey(vec![stored], &dedupe_targets)
            .expect("plan current rekey")
            .is_empty());
    }

    #[test]
    fn worker_managed_callsigns_ignore_knowledge_age_cutoff() {
        let now =
            chrono::DateTime::parse_from_rfc3339("2026-03-01T00:00:00+00:00")
                .expect("now")
                .to_utc();
        let mut knowledge_row = KnowledgeRow {
            sheet_name: "Knowledge".to_string(),
            row_num: 1,
            cells: Vec::new(),
            name: Some("BARS".to_string()),
            key: None,
            knowledge_type: Some(KNOWLEDGE_KIND_CALL_SIGN.to_string()),
            author: Some(KNOWLEDGE_WORKER_AUTHOR.to_string()),
            note: None,
            source_date_raw: Some("01.01.2026 00:00:00".to_string()),
            formation: None,
        };

        assert!(knowledge_row_is_recent(&now, &knowledge_row));

        knowledge_row.author = Some("USER".to_string());
        assert!(!knowledge_row_is_recent(&now, &knowledge_row));
    }

    #[tokio::test]
    async fn ensure_xlsx_file_exists_creates_valid_empty_workbook() {
        let dir = temp_dir("goi-empty-xlsx");
        let path = dir.join("nested").join("knowledge.xlsx");

        assert!(ensure_xlsx_file_exists(&path, "knowledge")
            .await
            .expect("create xlsx"));
        assert!(!ensure_xlsx_file_exists(&path, "knowledge")
            .await
            .expect("existing xlsx"));
        assert!(read_association_rows(&path)
            .expect("association rows")
            .is_empty());
        assert!(read_knowledge_rows(&path)
            .expect("knowledge rows")
            .is_empty());

        std::fs::remove_dir_all(dir).ok();
    }

    fn worker_callsign_row(id: i64, note: &str) -> KnowledgeRow {
        let mut cells = vec![
            KnowledgeCell {
                kind: "empty".to_string(),
                value: Value::Null,
            };
            9
        ];
        cells[8] = KnowledgeCell {
            kind: "string".to_string(),
            value: Value::String(format!("{KNOWLEDGE_WORKER_ID_PREFIX}{id}")),
        };
        KnowledgeRow {
            sheet_name: "Knowledge".to_string(),
            row_num: 1,
            cells,
            name: Some("BARS".to_string()),
            key: None,
            knowledge_type: Some(KNOWLEDGE_KIND_CALL_SIGN.to_string()),
            author: Some(KNOWLEDGE_WORKER_AUTHOR.to_string()),
            note: Some(note.to_string()),
            source_date_raw: None,
            formation: None,
        }
    }

    fn association_row(note: &str) -> AssociationRow {
        AssociationRow {
            sheet_name: "Associations".to_string(),
            row_num: 1,
            cells: vec![AssociationCell {
                kind: "string".to_string(),
                value: Value::String(note.to_string()),
            }],
            association_type: None,
            frequency: Some("145.1000".to_string()),
            coordinates: Some("37UDR0682401768".to_string()),
            note: Some(note.to_string()),
            category: None,
            call_signs: Vec::new(),
            formation: None,
            association_count: None,
            sidc: None,
            author: None,
            source_date_raw: None,
            palettes: None,
        }
    }

    fn stored_association(
        id: i64,
        dedupe_key: &str,
        association_row: &AssociationRow,
    ) -> association::Model {
        association::Model {
            id,
            row: serde_json::to_value(association_row)
                .expect("serialize association row"),
            created_at: chrono::Utc::now().fixed_offset(),
            deleted: false,
            dedupe_key: dedupe_key.to_string(),
            dedupe_key_version: 1,
        }
    }

    fn stored_knowledge(
        id: i64,
        dedupe_key: &str,
        knowledge_row: &KnowledgeRow,
    ) -> knowledge::Model {
        let now = chrono::Utc::now().fixed_offset();
        knowledge::Model {
            id,
            row: serde_json::to_value(knowledge_row).expect("serialize row"),
            created_at: now,
            updated_at: now,
            dedupe_key: dedupe_key.to_string(),
        }
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("{prefix}-{}-{suffix}", std::process::id()))
    }
}
