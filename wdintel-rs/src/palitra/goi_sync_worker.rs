use crate::config::{
    ORGANISM_GOI_INTEGRATION_TYPE_FULL, ORGANISM_GOI_PATH_DEFAULT,
    ORGANISM_GOI_SSH_PORT_DEFAULT, PALITRA_ALLOWED_UPLOAD_EXTENSIONS,
    PALITRA_BLOCKED_UNSTABLE_UPLOAD_EXTENSIONS,
    PALITRA_CONVERSION_STATUS_ERROR, PALITRA_CONVERSION_STATUS_PROCESSING,
    PALITRA_CONVERSION_STATUS_READY, PALITRA_GOI_RECONCILE_INTERVAL_SEC,
    PALITRA_GOI_REMOTE_STATUS_MISSING, PALITRA_GOI_REMOTE_STATUS_PRESENT,
    PALITRA_GOI_SYNC_DIRECTION_ECHO, PALITRA_GOI_SYNC_DIRECTION_GOI,
    PALITRA_GOI_SYNC_JOB_KIND_DELETE, PALITRA_GOI_SYNC_JOB_KIND_MOVE,
    PALITRA_GOI_SYNC_JOB_KIND_UPLOAD, PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC,
    PALITRA_GOI_SYNC_WORKER_SLEEP_SEC,
};
use crate::entities::*;
use crate::error::AppError;
use crate::organism::goi;
use crate::organism::goi::shared::goi_integration_worker_paused;
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::palitra::types::{
    CreatePalitraReq, PalitraAccess, PalitraChangelogEntry,
};
use crate::types::*;
use crate::utils::string::normalize_trimmed_or_default;
use chrono::Utc;
use itertools::Itertools;
use sea_orm::prelude::Expr;
use sea_orm::Statement;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, Instant};

const GOI_PALITRA_DUPLICATE_REMOTE_PATH_CONFLICT_TEXT: &str =
    "Duplicate GOI remote path tracking conflict";
const GOI_PALITRA_DUPLICATE_ECHO_REMOTE_PATH_CONFLICT_TEXT: &str =
    "Duplicate Echo-origin palitras map to the same GOI remote path";
const GOI_PALITRA_MISSING_ECHO_CHECKSUM_TEXT: &str =
    "Missing stored Echo checksum metadata";
const GOI_PALITRA_MISSING_ECHO_PALETTE_TEXT: &str =
    "Missing Echo palitra for checksum sync";
const GOI_PALITRA_MISSING_ECHO_FILE_TEXT: &str =
    "Missing Echo palitra source file for checksum sync";
const GOI_PALITRA_ECHO_AND_GOI_CHANGED_TEXT: &str =
    "Echo and GOI checksums changed since last sync";

#[derive(Clone)]
struct GoiSyncTarget {
    integration: goi_integration::Model,
    req: CheckOrganismGoiConnectionReq,
}

struct DownloadedGoiPalitraFile {
    data: Vec<u8>,
    file_size: i64,
    file_sha256: String,
}

#[derive(Clone)]
struct GoiSourceFileSnapshot {
    file_name: String,
    source_format: String,
    content_type: Option<String>,
    file_data: Vec<u8>,
    file_size: i64,
    file_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileChecksumRef<'a> {
    file_size: i64,
    file_sha256: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OwnedFileChecksum {
    file_size: i64,
    file_sha256: String,
}

impl OwnedFileChecksum {
    fn as_ref(&self) -> FileChecksumRef<'_> {
        FileChecksumRef {
            file_size: self.file_size,
            file_sha256: &self.file_sha256,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CurrentEchoChecksum<'a> {
    Known(FileChecksumRef<'a>),
    MissingPalette,
    MissingFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GoiPalitraSyncDecisionInput<'a> {
    stored_echo_checksum: Option<FileChecksumRef<'a>>,
    current_echo_checksum: CurrentEchoChecksum<'a>,
    stored_goi_checksum: Option<FileChecksumRef<'a>>,
    current_goi_checksum: FileChecksumRef<'a>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GoiPalitraSyncDecision {
    RefreshEcho,
    PushEcho,
    Noop,
    Conflict(GoiPalitraSyncConflict),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GoiPalitraSyncConflict {
    MissingEchoChecksumMetadata,
    MissingEchoPalette,
    MissingEchoFile,
    EchoAndGoiChanged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GoiRemotePathTrackingState {
    Normal,
    DuplicateRemotePathConflict,
    GoiOriginDuplicateCleanupNeeded,
}

struct EchoOriginGoiSyncDecision {
    row: goi_palitra_sync::Model,
    decision: GoiPalitraSyncDecision,
    current_echo_file_data: Option<Vec<u8>>,
}

pub async fn palitra_goi_sync_worker_nofail(env: Arc<Env>) {
    let mut last_reconcile_at = None;
    loop {
        let no_jobs = match palitra_goi_sync_worker_step(
            env.as_ref(),
            &mut last_reconcile_at,
        )
        .await
        {
            Ok(no_jobs) => no_jobs,
            Err(err) => {
                warn!("palitra_goi_sync_worker failed: {err:#}");
                true
            }
        };
        if no_jobs {
            tokio::time::sleep(Duration::from_secs(
                PALITRA_GOI_SYNC_WORKER_SLEEP_SEC,
            ))
            .await;
        }
    }
}

async fn palitra_goi_sync_worker_step(
    env: &Env,
    last_reconcile_at: &mut Option<Instant>,
) -> Result<bool, AppError> {
    if should_reconcile_goi_palitras(*last_reconcile_at) {
        *last_reconcile_at = Some(Instant::now());
        reconcile_goi_palitras(env).await.c(h!())?;
    }

    let txn = env.dbx.begin().await.c(h!())?;
    let Some(job) = take_next_job(&txn).await.c(h!())? else {
        txn.commit().await.c(h!())?;
        return Ok(true);
    };
    txn.commit().await.c(h!())?;

    let result = match job.kind.as_str() {
        PALITRA_GOI_SYNC_JOB_KIND_UPLOAD => sync_upload_job(env, &job).await,
        PALITRA_GOI_SYNC_JOB_KIND_MOVE => sync_move_job(&env.dbx, &job).await,
        PALITRA_GOI_SYNC_JOB_KIND_DELETE => {
            sync_delete_job(&env.dbx, &job).await
        }
        kind => Err(anyhow::anyhow!(
            "unknown palitra GOI sync job kind '{kind}'"
        )
        .context(h!())),
    };

    match result {
        Ok(()) => {
            palitra_goi_sync_job::Entity::delete_many()
                .filter(palitra_goi_sync_job::Column::Id.eq(job.id))
                .filter(
                    palitra_goi_sync_job::Column::LastAttemptAt
                        .eq(job.last_attempt_at),
                )
                .filter(
                    palitra_goi_sync_job::Column::AttemptCount
                        .eq(job.attempt_count),
                )
                .exec(&env.dbx)
                .await
                .c(h!())?;
        }
        Err(err) => {
            palitra_goi_sync_job::Entity::update_many()
                .filter(palitra_goi_sync_job::Column::Id.eq(job.id))
                .filter(
                    palitra_goi_sync_job::Column::LastAttemptAt
                        .eq(job.last_attempt_at),
                )
                .filter(
                    palitra_goi_sync_job::Column::AttemptCount
                        .eq(job.attempt_count),
                )
                .col_expr(
                    palitra_goi_sync_job::Column::LastError,
                    Expr::value(Some(format!("{err:#}"))),
                )
                .exec(&env.dbx)
                .await
                .c(h!())?;
        }
    }

    Ok(false)
}

fn should_reconcile_goi_palitras(last_reconcile_at: Option<Instant>) -> bool {
    match last_reconcile_at {
        Some(last_reconcile_at) => {
            last_reconcile_at.elapsed()
                >= Duration::from_secs(PALITRA_GOI_RECONCILE_INTERVAL_SEC)
        }
        None => true,
    }
}

async fn take_next_job(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Option<palitra_goi_sync_job::Model>> {
    let stmt = Statement::from_string(
        DatabaseBackend::Postgres,
        format!(
            r#"
        with next_job as (
            select id
            from palitra_goi_sync_job
            where last_attempt_at is null
               or last_attempt_at <= now() - interval '{} seconds'
            order by id
            for update skip locked
            limit 1
        )
        update palitra_goi_sync_job
        set
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            last_error = null
        where id in (select id from next_job)
        returning *
        "#,
            PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC
        ),
    );
    palitra_goi_sync_job::Model::find_by_statement(stmt)
        .one(txn)
        .await
        .c(h!())
}

async fn reconcile_goi_palitras(env: &Env) -> anyhow::Result<()> {
    let targets = collect_all_goi_sync_targets(&env.dbx).await.c(h!())?;
    for target in targets {
        if let Err(err) = reconcile_goi_target(env, &target).await {
            warn!(
                "GOI palitra reconciliation failed for integration {} ({}): {err:#}",
                target.integration.id,
                target.integration.server_label
            );
        }
    }
    Ok(())
}

async fn reconcile_goi_target(
    env: &Env,
    target: &GoiSyncTarget,
) -> anyhow::Result<()> {
    if target.integration.disable_goi_to_echo_palitra_sync {
        return reconcile_goi_target_files(env, target, None).await.c(h!());
    }

    let Some(lock) = goi::goi_try_acquire_sync_lock(target.req.clone())
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let result = reconcile_goi_target_files(env, target, Some(&lock)).await;
    release_goi_sync_lock(lock).await;
    result
}

async fn reconcile_goi_target_files(
    env: &Env,
    target: &GoiSyncTarget,
    lock: Option<&goi::GoiSyncLock>,
) -> anyhow::Result<()> {
    let entries = goi::goi_list_relative_files(target.req.clone())
        .await
        .c(h!())?;
    refresh_goi_sync_lock(lock).await.c(h!())?;
    let remote_paths = entries
        .into_iter()
        .filter_map(|entry| normalize_goi_palitra_relative_path(&entry))
        .collect::<BTreeSet<_>>();
    reconcile_tracked_goi_paths(&env.dbx, &target.integration, &remote_paths)
        .await
        .c(h!())?;
    refresh_goi_sync_lock(lock).await.c(h!())?;
    for remote_path in &remote_paths {
        if let Err(err) =
            reconcile_goi_remote_path(env, target, remote_path).await
        {
            warn!(
                "GOI palitra reconciliation failed for integration {} ({}), remote path '{}': {err:#}",
                target.integration.id,
                target.integration.server_label,
                remote_path
            );
        }
        refresh_goi_sync_lock(lock).await.c(h!())?;
    }
    reconcile_echo_palitras_missing_in_goi(env, target, &remote_paths, lock)
        .await
        .c(h!())?;
    refresh_goi_sync_lock(lock).await.c(h!())?;
    Ok(())
}

async fn reconcile_goi_remote_path(
    env: &Env,
    target: &GoiSyncTarget,
    remote_path: &str,
) -> anyhow::Result<()> {
    let tracked_rows = find_goi_palitra_sync_rows(
        &env.dbx,
        target.integration.id,
        remote_path,
    )
    .await
    .c(h!())?;
    if tracked_rows.is_empty() {
        return reconcile_untracked_goi_palitra(env, target, remote_path)
            .await
            .c(h!());
    }
    refresh_tracked_goi_palitra_if_changed(
        env,
        target,
        remote_path,
        &tracked_rows,
    )
    .await
    .c(h!())
}

async fn reconcile_echo_palitras_missing_in_goi(
    env: &Env,
    target: &GoiSyncTarget,
    remote_paths: &BTreeSet<String>,
    lock: Option<&goi::GoiSyncLock>,
) -> anyhow::Result<()> {
    let palitras = find_echo_palitras_for_goi_target(
        &env.dbx,
        target.integration.owner_organism_id,
    )
    .await
    .c(h!())?;
    let tracked_palitra_ids = find_present_tracked_palitra_ids(
        &env.dbx,
        target.integration.id,
        remote_paths,
    )
    .await
    .c(h!())?;
    let mut remote_paths = remote_paths.clone();

    for palitra in palitras {
        if tracked_palitra_ids.contains(&palitra.id) {
            continue;
        }
        match reconcile_echo_palitra_missing_in_goi(
            env,
            target,
            &palitra,
            &remote_paths,
        )
        .await
        {
            Ok(Some(relative_path)) => {
                remote_paths.insert(relative_path);
            }
            Ok(None) => {}
            Err(err) => {
                warn!(
                    "GOI palitra backfill failed for integration {} ({}), palitra {}: {err:#}",
                    target.integration.id,
                    target.integration.server_label,
                    palitra.id
                );
            }
        }
        refresh_goi_sync_lock(lock).await.c(h!())?;
    }
    Ok(())
}

async fn reconcile_echo_palitra_missing_in_goi(
    env: &Env,
    target: &GoiSyncTarget,
    palitra: &palitra::Model,
    remote_paths: &BTreeSet<String>,
) -> anyhow::Result<Option<String>> {
    let geometry =
        super::read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;
    let target_folder =
        super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
    let remote_file_names = super::palitra_goi_remote_file_names(
        palitra.id,
        Some(&palitra.name),
        geometry.source_file_name.as_deref(),
    );
    let Some(remote_file_name) = find_echo_palitra_backfill_remote_file_name(
        remote_paths,
        target_folder.as_deref(),
        &remote_file_names,
    ) else {
        return Ok(None);
    };

    let relative_path =
        compose_relative_path(target_folder.as_deref(), remote_file_name);
    let remote_file_path = compose_remote_path(
        &target.req,
        target_folder.as_deref(),
        remote_file_name,
    );
    let file_data = load_palitra_file_data(env, palitra).await.c(h!())?;
    upload_palitra_to_goi_target(
        &env.dbx,
        target,
        palitra.id,
        &relative_path,
        &remote_file_path,
        &file_data,
    )
    .await
    .c(h!())?;
    Ok(Some(relative_path))
}

fn find_echo_palitra_backfill_remote_file_name<'a>(
    remote_paths: &BTreeSet<String>,
    target_folder: Option<&str>,
    remote_file_names: &'a [String],
) -> Option<&'a str> {
    remote_file_names.iter().find_map(|file_name| {
        (!remote_paths
            .contains(&compose_relative_path(target_folder, file_name)))
        .then_some(file_name.as_str())
    })
}

async fn find_echo_palitras_for_goi_target(
    dbx: &DatabaseConnection,
    owner_organism_id: i64,
) -> anyhow::Result<Vec<palitra::Model>> {
    let palitra_ids = palitra_access_organism::Entity::find()
        .filter(
            palitra_access_organism::Column::OrganismId.eq(owner_organism_id),
        )
        .select_only()
        .column(palitra_access_organism::Column::PalitraId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    if palitra_ids.is_empty() {
        return Ok(Vec::new());
    }
    palitra::Entity::find()
        .filter(palitra::Column::Id.is_in(palitra_ids))
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra::Column::ImportedFromGoi.eq(false))
        .filter(
            palitra::Column::ConversionStatus
                .eq(PALITRA_CONVERSION_STATUS_READY),
        )
        .order_by_asc(palitra::Column::Id)
        .all(dbx)
        .await
        .c(h!())
}

async fn find_present_tracked_palitra_ids(
    dbx: &DatabaseConnection,
    goi_integration_id: i64,
    remote_paths: &BTreeSet<String>,
) -> anyhow::Result<BTreeSet<i64>> {
    if remote_paths.is_empty() {
        return Ok(BTreeSet::new());
    }
    goi_palitra_sync::Entity::find()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .is_in(remote_paths.iter().cloned()),
        )
        .filter(goi_palitra_sync::Column::PalitraId.is_not_null())
        .select_only()
        .column(goi_palitra_sync::Column::PalitraId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())
        .map(|palitra_ids| palitra_ids.into_iter().collect())
}

async fn refresh_goi_sync_lock(
    lock: Option<&goi::GoiSyncLock>,
) -> anyhow::Result<()> {
    if let Some(lock) = lock {
        lock.refresh().await.c(h!())?;
    }
    Ok(())
}

async fn reconcile_untracked_goi_palitra(
    env: &Env,
    target: &GoiSyncTarget,
    remote_path: &str,
) -> anyhow::Result<()> {
    let palitras = find_echo_palitra_matches_for_remote_path(
        &env.dbx,
        &target.integration,
        remote_path,
    )
    .await
    .c(h!())?;
    if palitras.is_empty() {
        if !target.integration.disable_goi_to_echo_palitra_sync {
            import_goi_palitra(env, target, remote_path).await.c(h!())?;
        }
        return Ok(());
    }

    let goi_file = download_goi_palitra_file(target, remote_path)
        .await
        .c(h!())?;
    for palitra in palitras {
        if !goi_file_matches_echo_palitra(env, &palitra, &goi_file)
            .await
            .c(h!())?
        {
            continue;
        }
        upsert_echo_origin_goi_palitra(
            env,
            target,
            &palitra,
            remote_path,
            &goi_file,
        )
        .await
        .c(h!())?;
        return Ok(());
    }

    if target.integration.disable_goi_to_echo_palitra_sync {
        return Ok(());
    }
    import_replacement_goi_palitra_file(
        env,
        &target.integration,
        remote_path,
        goi_file.data,
        goi_file.file_size,
        goi_file.file_sha256,
    )
    .await
    .c(h!())
}

async fn upsert_echo_origin_goi_palitra(
    env: &Env,
    target: &GoiSyncTarget,
    palitra: &palitra::Model,
    remote_path: &str,
    goi_file: &DownloadedGoiPalitraFile,
) -> anyhow::Result<()> {
    upsert_goi_palitra_sync(
        &env.dbx,
        target.integration.id,
        Some(palitra.id),
        remote_path,
        PALITRA_GOI_SYNC_DIRECTION_ECHO,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(goi_file.file_size),
        Some(goi_file.file_sha256.clone()),
        None,
        None,
    )
    .await
    .c(h!())?;
    refresh_palitra_missing_in_goi(&env.dbx, palitra.id)
        .await
        .c(h!())?;
    Ok(())
}

async fn goi_file_matches_echo_palitra(
    env: &Env,
    palitra: &palitra::Model,
    goi_file: &DownloadedGoiPalitraFile,
) -> anyhow::Result<bool> {
    let Some(echo_file_data) =
        maybe_load_palitra_file_data(env, palitra).await.c(h!())?
    else {
        return Ok(false);
    };
    Ok(goi_file_matches_echo_file_data(goi_file, &echo_file_data))
}

fn goi_file_matches_echo_file_data(
    goi_file: &DownloadedGoiPalitraFile,
    echo_file_data: &[u8],
) -> bool {
    goi_file.file_size == echo_file_data.len() as i64
        && goi_file.file_sha256 == sha256::digest(echo_file_data)
}

async fn download_goi_palitra_file(
    target: &GoiSyncTarget,
    remote_path: &str,
) -> anyhow::Result<DownloadedGoiPalitraFile> {
    let remote_file_path =
        super::compose_goi_palette_remote_path(&target.req.path, remote_path);
    let data = goi::goi_download_file(target.req.clone(), remote_file_path)
        .await
        .c(h!())?;
    Ok(DownloadedGoiPalitraFile {
        file_size: data.len() as i64,
        file_sha256: sha256::digest(&data),
        data,
    })
}

async fn find_goi_palitra_sync_rows(
    dbx: &DatabaseConnection,
    goi_integration_id: i64,
    remote_path: &str,
) -> anyhow::Result<Vec<goi_palitra_sync::Model>> {
    goi_palitra_sync_without_source_data_query()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .eq(remote_path.to_string()),
        )
        .order_by_asc(goi_palitra_sync::Column::Id)
        .all(dbx)
        .await
        .c(h!())
}

fn goi_palitra_sync_without_source_data_query(
) -> Select<goi_palitra_sync::Entity> {
    goi_palitra_sync::Entity::find()
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::GoiIntegrationId)
        .column(goi_palitra_sync::Column::PalitraId)
        .column(goi_palitra_sync::Column::RemoteRelativePath)
        .column(goi_palitra_sync::Column::Direction)
        .column(goi_palitra_sync::Column::RemoteStatus)
        .column(goi_palitra_sync::Column::FileSize)
        .column(goi_palitra_sync::Column::FileSha256)
        .column(goi_palitra_sync::Column::LastSeenAt)
        .column(goi_palitra_sync::Column::LastSyncAt)
        .column(goi_palitra_sync::Column::CreatedAt)
        .column(goi_palitra_sync::Column::UpdatedAt)
        .column(goi_palitra_sync::Column::EchoFileSize)
        .column(goi_palitra_sync::Column::EchoFileSha256)
        .column(goi_palitra_sync::Column::EchoUpdatedAt)
        .column(goi_palitra_sync::Column::GoiFileSize)
        .column(goi_palitra_sync::Column::GoiFileSha256)
        .column(goi_palitra_sync::Column::GoiUpdatedAt)
        .column(goi_palitra_sync::Column::Changelog)
        .column(goi_palitra_sync::Column::GoiSourceFileName)
        .column(goi_palitra_sync::Column::GoiSourceFormat)
        .column(goi_palitra_sync::Column::GoiSourceContentType)
        .column_as(Expr::cust("NULL::bytea"), "goi_source_file_data")
        .column(goi_palitra_sync::Column::GoiSourceFileSize)
        .column(goi_palitra_sync::Column::GoiSourceFileSha256)
        .column(goi_palitra_sync::Column::GoiSourceFailedFileSha256)
        .column(goi_palitra_sync::Column::GoiSourceLastRetryAt)
}

async fn reconcile_tracked_goi_paths(
    dbx: &DatabaseConnection,
    integration: &goi_integration::Model,
    remote_paths: &BTreeSet<String>,
) -> anyhow::Result<()> {
    #[derive(Debug, FromQueryResult)]
    struct TrackedGoiPathRow {
        id: i64,
        palitra_id: Option<i64>,
        remote_relative_path: String,
    }

    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::GoiIntegrationId.eq(integration.id))
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::PalitraId)
        .column(goi_palitra_sync::Column::RemoteRelativePath)
        .into_model::<TrackedGoiPathRow>()
        .all(dbx)
        .await
        .c(h!())?;
    let now = Utc::now().fixed_offset();
    for row in rows {
        let is_present = remote_paths.contains(&row.remote_relative_path);
        let palitra_id = row.palitra_id;
        let mut update = goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::RemoteStatus,
                Expr::value(if is_present {
                    PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string()
                } else {
                    PALITRA_GOI_REMOTE_STATUS_MISSING.to_string()
                }),
            )
            .col_expr(goi_palitra_sync::Column::UpdatedAt, Expr::value(now));
        if is_present {
            update = update.col_expr(
                goi_palitra_sync::Column::LastSeenAt,
                Expr::value(Some(now)),
            );
        }
        update.exec(dbx).await.c(h!())?;
        if let Some(palitra_id) = palitra_id {
            refresh_palitra_missing_in_goi(dbx, palitra_id)
                .await
                .c(h!())?;
        }
    }
    Ok(())
}

async fn refresh_tracked_goi_palitra_if_changed(
    env: &Env,
    target: &GoiSyncTarget,
    remote_path: &str,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    if target.integration.disable_goi_to_echo_palitra_sync {
        return Ok(());
    }
    if classify_goi_remote_path_tracking(tracked_rows)
        == GoiRemotePathTrackingState::DuplicateRemotePathConflict
    {
        mark_duplicate_remote_path_conflict(&env.dbx, tracked_rows)
            .await
            .c(h!())?;
        return Ok(());
    }
    mark_duplicate_remote_path_resolved(&env.dbx, tracked_rows)
        .await
        .c(h!())?;

    let remote_file_path =
        super::compose_goi_palette_remote_path(&target.req.path, remote_path);
    let file_data =
        goi::goi_download_file(target.req.clone(), remote_file_path)
            .await
            .c(h!())?;
    let file_size = file_data.len() as i64;
    let file_sha256 = sha256::digest(&file_data);
    if tracked_goi_palitra_ids(tracked_rows).is_empty() {
        let sync_decisions = read_echo_origin_goi_sync_decisions(
            env,
            tracked_rows,
            file_size,
            &file_sha256,
        )
        .await
        .c(h!())?;
        if echo_origin_goi_file_needs_refresh(&sync_decisions) {
            return refresh_imported_goi_palitra_file(
                env,
                &target.integration,
                remote_path,
                file_data,
                file_size,
                file_sha256,
                tracked_rows,
            )
            .await
            .c(h!());
        }
        update_echo_origin_goi_palitra_remote_metadata(
            &env.dbx,
            &sync_decisions,
            file_size,
            &file_sha256,
        )
        .await
        .c(h!())?;
        return Ok(());
    }
    if !tracked_goi_file_needs_refresh(tracked_rows, file_size, &file_sha256) {
        update_tracked_goi_palitra_metadata(
            &env.dbx,
            tracked_rows,
            file_size,
            &file_sha256,
        )
        .await
        .c(h!())?;
        return Ok(());
    }

    refresh_imported_goi_palitra_file(
        env,
        &target.integration,
        remote_path,
        file_data,
        file_size,
        file_sha256,
        tracked_rows,
    )
    .await
    .c(h!())
}

fn classify_goi_remote_path_tracking(
    tracked_rows: &[goi_palitra_sync::Model],
) -> GoiRemotePathTrackingState {
    if has_duplicate_remote_path_conflict(tracked_rows) {
        return GoiRemotePathTrackingState::DuplicateRemotePathConflict;
    }
    if tracked_goi_palitra_ids(tracked_rows).len() > 1 {
        return GoiRemotePathTrackingState::GoiOriginDuplicateCleanupNeeded;
    }
    GoiRemotePathTrackingState::Normal
}

fn has_duplicate_remote_path_conflict(
    tracked_rows: &[goi_palitra_sync::Model],
) -> bool {
    let has_echo_origin_row = tracked_rows
        .iter()
        .any(|row| row.direction == PALITRA_GOI_SYNC_DIRECTION_ECHO);
    has_echo_origin_row && tracked_palitra_ids(tracked_rows).len() > 1
}

async fn mark_duplicate_remote_path_conflict(
    dbx: &DatabaseConnection,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    for row in tracked_rows {
        let changelog =
            super::goi_changelog::append_to_value_if_latest_differs(
                &row.changelog,
                super::goi_changelog::error_entry(
                    GOI_PALITRA_DUPLICATE_REMOTE_PATH_CONFLICT_TEXT,
                    "Кілька палітр привʼязані до одного шляху в ГОІ. Синхронізацію цього шляху заблоковано до виправлення дубля.",
                ),
            )
            .c(h!())?;
        goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::Changelog,
                Expr::value(changelog),
            )
            .col_expr(
                goi_palitra_sync::Column::UpdatedAt,
                Expr::value(Utc::now().fixed_offset()),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn mark_duplicate_remote_path_resolved(
    dbx: &DatabaseConnection,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    for row in tracked_rows {
        let entries = super::goi_changelog::entries_from_value(&row.changelog);
        let Some(latest) = super::goi_changelog::latest_entry(&entries) else {
            continue;
        };
        if latest.is_ok || !is_duplicate_remote_path_conflict_text(&latest.text)
        {
            continue;
        }
        let changelog = super::goi_changelog::append_to_value(
            &row.changelog,
            super::goi_changelog::ok_entry(
                "Duplicate Echo-origin GOI remote path conflict resolved",
                "Конфлікт дубльованого шляху ГОІ виправлено. Синхронізацію відновлено.",
            ),
        )
        .c(h!())?;
        goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::Changelog,
                Expr::value(changelog),
            )
            .col_expr(
                goi_palitra_sync::Column::UpdatedAt,
                Expr::value(Utc::now().fixed_offset()),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

fn is_duplicate_remote_path_conflict_text(text: &str) -> bool {
    text == GOI_PALITRA_DUPLICATE_REMOTE_PATH_CONFLICT_TEXT
        || text == GOI_PALITRA_DUPLICATE_ECHO_REMOTE_PATH_CONFLICT_TEXT
}

fn tracked_goi_file_needs_refresh(
    tracked_rows: &[goi_palitra_sync::Model],
    file_size: i64,
    file_sha256: &str,
) -> bool {
    if classify_goi_remote_path_tracking(tracked_rows)
        == GoiRemotePathTrackingState::GoiOriginDuplicateCleanupNeeded
    {
        return true;
    }
    tracked_rows
        .iter()
        .filter(|row| row.direction == PALITRA_GOI_SYNC_DIRECTION_GOI)
        .any(|row| {
            tracked_row_goi_file_size(row) != Some(file_size)
                || tracked_row_goi_file_sha256(row) != Some(file_sha256)
        })
}

async fn read_echo_origin_goi_sync_decisions(
    env: &Env,
    tracked_rows: &[goi_palitra_sync::Model],
    file_size: i64,
    file_sha256: &str,
) -> anyhow::Result<Vec<EchoOriginGoiSyncDecision>> {
    let current_goi_checksum = OwnedFileChecksum {
        file_size,
        file_sha256: file_sha256.to_string(),
    };
    let mut decisions = Vec::new();
    for row in tracked_rows
        .iter()
        .filter(|row| row.direction == PALITRA_GOI_SYNC_DIRECTION_ECHO)
    {
        let current_echo_checksum =
            read_current_echo_checksum(env, row).await.c(h!())?;
        let decision =
            decide_goi_palitra_checksum_sync(GoiPalitraSyncDecisionInput {
                stored_echo_checksum: tracked_row_echo_checksum(row),
                current_echo_checksum: current_echo_checksum.as_ref(),
                stored_goi_checksum: tracked_row_goi_checksum(row),
                current_goi_checksum: current_goi_checksum.as_ref(),
            });
        let current_echo_file_data =
            if decision == GoiPalitraSyncDecision::PushEcho {
                current_echo_checksum
                    .file_data()
                    .map(|file_data| file_data.to_vec())
            } else {
                None
            };
        decisions.push(EchoOriginGoiSyncDecision {
            row: row.clone(),
            decision,
            current_echo_file_data,
        });
    }
    Ok(decisions)
}

fn echo_origin_goi_file_needs_refresh(
    decisions: &[EchoOriginGoiSyncDecision],
) -> bool {
    decisions.iter().any(|decision| {
        decision.decision == GoiPalitraSyncDecision::RefreshEcho
    })
}

async fn read_current_echo_checksum(
    env: &Env,
    row: &goi_palitra_sync::Model,
) -> anyhow::Result<CurrentEchoChecksumOwned> {
    let Some(palitra_id) = row.palitra_id else {
        return Ok(CurrentEchoChecksumOwned::MissingPalette);
    };
    let Some(palitra) = palitra::Entity::find_by_id(palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(CurrentEchoChecksumOwned::MissingPalette);
    };
    let Some(file_data) =
        maybe_load_palitra_file_data(env, &palitra).await.c(h!())?
    else {
        return Ok(CurrentEchoChecksumOwned::MissingFile);
    };
    Ok(CurrentEchoChecksumOwned::Known(OwnedEchoFile {
        checksum: OwnedFileChecksum {
            file_size: file_data.len() as i64,
            file_sha256: sha256::digest(&file_data),
        },
        file_data,
    }))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OwnedEchoFile {
    checksum: OwnedFileChecksum,
    file_data: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CurrentEchoChecksumOwned {
    Known(OwnedEchoFile),
    MissingPalette,
    MissingFile,
}

impl CurrentEchoChecksumOwned {
    fn as_ref(&self) -> CurrentEchoChecksum<'_> {
        match self {
            Self::Known(echo_file) => {
                CurrentEchoChecksum::Known(echo_file.checksum.as_ref())
            }
            Self::MissingPalette => CurrentEchoChecksum::MissingPalette,
            Self::MissingFile => CurrentEchoChecksum::MissingFile,
        }
    }

    fn file_data(&self) -> Option<&[u8]> {
        match self {
            Self::Known(echo_file) => Some(&echo_file.file_data),
            Self::MissingPalette | Self::MissingFile => None,
        }
    }
}

fn decide_goi_palitra_checksum_sync(
    input: GoiPalitraSyncDecisionInput<'_>,
) -> GoiPalitraSyncDecision {
    let Some(stored_echo_checksum) = input.stored_echo_checksum else {
        return GoiPalitraSyncDecision::Conflict(
            GoiPalitraSyncConflict::MissingEchoChecksumMetadata,
        );
    };
    let current_echo_checksum = match input.current_echo_checksum {
        CurrentEchoChecksum::Known(checksum) => checksum,
        CurrentEchoChecksum::MissingPalette => {
            return GoiPalitraSyncDecision::Conflict(
                GoiPalitraSyncConflict::MissingEchoPalette,
            );
        }
        CurrentEchoChecksum::MissingFile => {
            return GoiPalitraSyncDecision::Conflict(
                GoiPalitraSyncConflict::MissingEchoFile,
            );
        }
    };
    let echo_changed = current_echo_checksum != stored_echo_checksum;
    let goi_changed =
        input.stored_goi_checksum != Some(input.current_goi_checksum);
    match (echo_changed, goi_changed) {
        (false, false) => GoiPalitraSyncDecision::Noop,
        (false, true) => GoiPalitraSyncDecision::RefreshEcho,
        (true, false) => GoiPalitraSyncDecision::PushEcho,
        (true, true) => GoiPalitraSyncDecision::Conflict(
            GoiPalitraSyncConflict::EchoAndGoiChanged,
        ),
    }
}

fn tracked_row_checksum<'a>(
    file_size: Option<i64>,
    file_sha256: Option<&'a str>,
) -> Option<FileChecksumRef<'a>> {
    Some(FileChecksumRef {
        file_size: file_size?,
        file_sha256: file_sha256?,
    })
}

fn tracked_row_goi_checksum(
    row: &goi_palitra_sync::Model,
) -> Option<FileChecksumRef<'_>> {
    tracked_row_checksum(
        tracked_row_goi_file_size(row),
        tracked_row_goi_file_sha256(row),
    )
}

fn tracked_row_echo_checksum(
    row: &goi_palitra_sync::Model,
) -> Option<FileChecksumRef<'_>> {
    tracked_row_checksum(
        tracked_row_echo_file_size(row),
        tracked_row_echo_file_sha256(row),
    )
}

fn tracked_row_goi_file_size(row: &goi_palitra_sync::Model) -> Option<i64> {
    row.goi_file_size.or(row.file_size)
}

fn tracked_row_goi_file_sha256(row: &goi_palitra_sync::Model) -> Option<&str> {
    row.goi_file_sha256
        .as_deref()
        .or(row.file_sha256.as_deref())
}

fn tracked_row_echo_file_size(row: &goi_palitra_sync::Model) -> Option<i64> {
    row.echo_file_size.or(row.file_size)
}

fn tracked_row_echo_file_sha256(row: &goi_palitra_sync::Model) -> Option<&str> {
    row.echo_file_sha256
        .as_deref()
        .or(row.file_sha256.as_deref())
}

fn checksum_sync_conflict_entry(
    conflict: GoiPalitraSyncConflict,
) -> PalitraChangelogEntry {
    let (text, description) = checksum_sync_conflict_text(conflict);
    super::goi_changelog::error_entry(text, description)
}

fn checksum_sync_conflict_text(
    conflict: GoiPalitraSyncConflict,
) -> (&'static str, &'static str) {
    match conflict {
        GoiPalitraSyncConflict::MissingEchoChecksumMetadata => (
            GOI_PALITRA_MISSING_ECHO_CHECKSUM_TEXT,
            "Не вистачає контрольної суми Echo для безпечної синхронізації з ГОІ.",
        ),
        GoiPalitraSyncConflict::MissingEchoPalette => (
            GOI_PALITRA_MISSING_ECHO_PALETTE_TEXT,
            "Палітру Echo не знайдено. Синхронізацію з ГОІ зупинено для цього рядка.",
        ),
        GoiPalitraSyncConflict::MissingEchoFile => (
            GOI_PALITRA_MISSING_ECHO_FILE_TEXT,
            "Файл палітри Echo не знайдено. Синхронізацію з ГОІ зупинено для цього рядка.",
        ),
        GoiPalitraSyncConflict::EchoAndGoiChanged => (
            GOI_PALITRA_ECHO_AND_GOI_CHANGED_TEXT,
            "Палітру змінено і в Echo, і в ГОІ після останньої синхронізації. Потрібне ручне виправлення.",
        ),
    }
}

fn is_checksum_sync_conflict_text(text: &str) -> bool {
    [
        GOI_PALITRA_MISSING_ECHO_CHECKSUM_TEXT,
        GOI_PALITRA_MISSING_ECHO_PALETTE_TEXT,
        GOI_PALITRA_MISSING_ECHO_FILE_TEXT,
        GOI_PALITRA_ECHO_AND_GOI_CHANGED_TEXT,
    ]
    .contains(&text)
}

fn append_checksum_sync_resolution_if_needed(
    changelog: &serde_json::Value,
) -> anyhow::Result<Option<serde_json::Value>> {
    let entries = super::goi_changelog::entries_from_value(changelog);
    let Some(latest) = super::goi_changelog::latest_entry(&entries) else {
        return Ok(None);
    };
    if latest.is_ok || !is_checksum_sync_conflict_text(&latest.text) {
        return Ok(None);
    }
    super::goi_changelog::append_to_value(
        changelog,
        super::goi_changelog::ok_entry(
            "GOI checksum sync conflict resolved",
            "Конфлікт контрольних сум між Echo та ГОІ виправлено.",
        ),
    )
    .map(Some)
    .c(h!())
}

fn append_goi_sync_success_resolution_if_needed(
    changelog: &serde_json::Value,
) -> anyhow::Result<Option<serde_json::Value>> {
    let entries = super::goi_changelog::entries_from_value(changelog);
    let Some(latest) = super::goi_changelog::latest_entry(&entries) else {
        return Ok(None);
    };
    if latest.is_ok {
        return Ok(None);
    }
    super::goi_changelog::append_to_value(
        changelog,
        super::goi_changelog::ok_entry(
            "GOI palitra sync recovered",
            "Синхронізація палітри з ГОІ знову успішна.",
        ),
    )
    .map(Some)
    .c(h!())
}

async fn update_echo_origin_goi_palitra_remote_metadata<'a, C>(
    dbx: &'a C,
    sync_decisions: &[EchoOriginGoiSyncDecision],
    file_size: i64,
    file_sha256: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let now = Utc::now().fixed_offset();
    for sync_decision in sync_decisions {
        let row = &sync_decision.row;
        let goi_changed = tracked_row_goi_checksum(row)
            != tracked_row_checksum(Some(file_size), Some(file_sha256));
        let changelog = match sync_decision.decision {
            GoiPalitraSyncDecision::Conflict(conflict) => Some(
                super::goi_changelog::append_to_value_if_latest_differs(
                    &row.changelog,
                    checksum_sync_conflict_entry(conflict),
                )
                .c(h!())?,
            ),
            _ => append_checksum_sync_resolution_if_needed(&row.changelog)
                .c(h!())?,
        };
        if matches!(sync_decision.decision, GoiPalitraSyncDecision::PushEcho) {
            super::schedule_palitra_goi_upload(
                dbx,
                row.palitra_id.c(h!())?,
                sync_decision.current_echo_file_data.clone().c(h!())?,
            )
            .await
            .c(h!())?;
        }
        let mut update = goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::RemoteStatus,
                Expr::value(PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string()),
            )
            .col_expr(
                goi_palitra_sync::Column::LastSeenAt,
                Expr::value(Some(now)),
            )
            .col_expr(goi_palitra_sync::Column::UpdatedAt, Expr::value(now));
        if matches!(sync_decision.decision, GoiPalitraSyncDecision::Noop) {
            update = update
                .col_expr(
                    goi_palitra_sync::Column::GoiFileSize,
                    Expr::value(Some(file_size)),
                )
                .col_expr(
                    goi_palitra_sync::Column::GoiFileSha256,
                    Expr::value(Some(file_sha256.to_string())),
                );
            if goi_changed {
                update = update.col_expr(
                    goi_palitra_sync::Column::GoiUpdatedAt,
                    Expr::value(Some(now)),
                );
            }
        }
        if let Some(changelog) = changelog {
            update = update.col_expr(
                goi_palitra_sync::Column::Changelog,
                Expr::value(changelog),
            );
        }
        update.exec(dbx).await.c(h!())?;
    }
    Ok(())
}

async fn update_tracked_goi_palitra_metadata<'a, C>(
    dbx: &'a C,
    tracked_rows: &[goi_palitra_sync::Model],
    file_size: i64,
    file_sha256: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let now = Utc::now().fixed_offset();
    for row in tracked_rows
        .iter()
        .filter(|row| row.direction == PALITRA_GOI_SYNC_DIRECTION_GOI)
    {
        let changelog =
            append_goi_sync_success_resolution_if_needed(&row.changelog)
                .c(h!())?;
        let goi_changed = tracked_row_goi_file_size(row) != Some(file_size)
            || tracked_row_goi_file_sha256(row) != Some(file_sha256);
        let echo_checksum_known = tracked_row_echo_file_size(row).is_some()
            || tracked_row_echo_file_sha256(row).is_some();
        let mut update = goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::RemoteStatus,
                Expr::value(PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string()),
            )
            .col_expr(
                goi_palitra_sync::Column::FileSize,
                Expr::value(Some(file_size)),
            )
            .col_expr(
                goi_palitra_sync::Column::FileSha256,
                Expr::value(Some(file_sha256.to_string())),
            )
            .col_expr(
                goi_palitra_sync::Column::GoiFileSize,
                Expr::value(Some(file_size)),
            )
            .col_expr(
                goi_palitra_sync::Column::GoiFileSha256,
                Expr::value(Some(file_sha256.to_string())),
            )
            .col_expr(
                goi_palitra_sync::Column::LastSeenAt,
                Expr::value(Some(now)),
            )
            .col_expr(
                goi_palitra_sync::Column::LastSyncAt,
                Expr::value(Some(now)),
            )
            .col_expr(goi_palitra_sync::Column::UpdatedAt, Expr::value(now));
        if !echo_checksum_known {
            update = update
                .col_expr(
                    goi_palitra_sync::Column::EchoFileSize,
                    Expr::value(Some(file_size)),
                )
                .col_expr(
                    goi_palitra_sync::Column::EchoFileSha256,
                    Expr::value(Some(file_sha256.to_string())),
                )
                .col_expr(
                    goi_palitra_sync::Column::EchoUpdatedAt,
                    Expr::value(Some(now)),
                );
        }
        if goi_changed {
            update = update.col_expr(
                goi_palitra_sync::Column::GoiUpdatedAt,
                Expr::value(Some(now)),
            );
        }
        if let Some(changelog) = changelog {
            update = update.col_expr(
                goi_palitra_sync::Column::Changelog,
                Expr::value(changelog),
            );
        }
        update.exec(dbx).await.c(h!())?;
    }
    Ok(())
}

async fn refresh_imported_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    file_data: Vec<u8>,
    file_size: i64,
    file_sha256: String,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    let filename = remote_path_file_name(remote_path).c(h!())?;
    let extension =
        super::validate_palitra_upload_filename(&filename).c(h!())?;
    let is_archived = remote_path_is_in_archive_folder(remote_path);
    if !super::is_direct_palitra_upload_extension(&extension) {
        return refresh_convertible_goi_palitra_file(
            env,
            integration,
            remote_path,
            filename,
            extension,
            file_data,
            is_archived,
            file_size,
            file_sha256,
            tracked_rows,
        )
        .await;
    }
    refresh_direct_goi_palitra_file(
        env,
        integration,
        remote_path,
        filename,
        extension,
        file_data,
        is_archived,
        file_size,
        file_sha256,
        tracked_rows,
    )
    .await
}

async fn refresh_convertible_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    filename: String,
    extension: String,
    file_data: Vec<u8>,
    is_archived: bool,
    file_size: i64,
    file_sha256: String,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    let goi_source = GoiSourceFileSnapshot {
        file_name: filename.clone(),
        source_format: extension.clone(),
        content_type: None,
        file_data: file_data.clone(),
        file_size,
        file_sha256: file_sha256.clone(),
    };
    let palitra_ids = tracked_palitra_ids(tracked_rows);
    let Some(palitra) =
        find_first_existing_tracked_palitra(&env.dbx, tracked_rows)
            .await
            .c(h!())?
    else {
        let txn = env.dbx.begin().await.c(h!())?;
        delete_tracked_goi_palitra_sync_rows(
            &txn,
            integration.id,
            remote_path,
            &palitra_ids,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        return import_replacement_goi_palitra_file(
            env,
            integration,
            remote_path,
            file_data,
            file_size,
            file_sha256,
        )
        .await;
    };
    let retained_palitra_id = palitra.id;

    let txn = env.dbx.begin().await.c(h!())?;
    update_imported_palitra_fields(
        &txn,
        retained_palitra_id,
        PALITRA_CONVERSION_STATUS_PROCESSING,
        &extension,
        is_archived,
        imported_from_goi_update_for_refresh(tracked_rows),
    )
    .await
    .c(h!())?;
    let schedule_result = super::schedule_palitra_goi_source_conversion(
        &txn,
        retained_palitra_id,
        filename,
        extension,
        None,
        file_data,
    )
    .await;
    if let Err(err) = schedule_result {
        let error = format!("{err:#}");
        record_goi_source_conversion_scheduling_failure(
            &txn,
            integration.id,
            retained_palitra_id,
            remote_path,
            goi_source.source_format.clone(),
            file_size,
            file_sha256.clone(),
            error.clone(),
            format!(
                "Failed to schedule GOI source refresh conversion: {error}"
            ),
            "Не вдалося поставити оновлення з ГОІ в чергу на конвертацію.",
            goi_source,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        anyhow::bail!(
            "failed to schedule GOI source refresh conversion: {error}"
        );
    }
    upsert_goi_palitra_sync(
        &txn,
        integration.id,
        Some(retained_palitra_id),
        remote_path,
        PALITRA_GOI_SYNC_DIRECTION_GOI,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(file_size),
        Some(file_sha256),
        Some(super::goi_changelog::ok_entry(
            "GOI source refresh queued for conversion",
            "Нову версію з ГОІ поставлено в чергу на конвертацію.",
        )),
        Some(goi_source),
    )
    .await
    .c(h!())?;
    refresh_palitra_missing_in_goi(&txn, retained_palitra_id)
        .await
        .c(h!())?;
    let stale_palitra_ids = palitra_ids
        .into_iter()
        .filter(|palitra_id| *palitra_id != retained_palitra_id)
        .collect_vec();
    for stale_palitra_id in stale_palitra_ids {
        delete_stale_imported_goi_palitra(
            &txn,
            integration.id,
            remote_path,
            stale_palitra_id,
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn record_goi_source_conversion_scheduling_failure<'a, C>(
    dbx: &'a C,
    integration_id: i64,
    palitra_id: i64,
    remote_path: &str,
    source_format: String,
    file_size: i64,
    file_sha256: String,
    conversion_error: String,
    changelog_text: String,
    changelog_description: &str,
    goi_source: GoiSourceFileSnapshot,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    super::update_palitra_conversion_status(
        dbx,
        palitra_id,
        PALITRA_CONVERSION_STATUS_ERROR,
        Some(source_format),
        None,
        Some(conversion_error),
    )
    .await
    .c(h!())?;
    upsert_goi_palitra_sync(
        dbx,
        integration_id,
        Some(palitra_id),
        remote_path,
        PALITRA_GOI_SYNC_DIRECTION_GOI,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(file_size),
        Some(file_sha256),
        Some(super::goi_changelog::error_entry(
            changelog_text,
            changelog_description,
        )),
        Some(goi_source),
    )
    .await
    .c(h!())?;
    refresh_palitra_missing_in_goi(dbx, palitra_id)
        .await
        .c(h!())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn refresh_direct_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    filename: String,
    extension: String,
    file_data: Vec<u8>,
    is_archived: bool,
    file_size: i64,
    file_sha256: String,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<()> {
    let palitra_ids = tracked_palitra_ids(tracked_rows);
    let Some(palitra) =
        find_first_existing_tracked_palitra(&env.dbx, tracked_rows)
            .await
            .c(h!())?
    else {
        let txn = env.dbx.begin().await.c(h!())?;
        delete_tracked_goi_palitra_sync_rows(
            &txn,
            integration.id,
            remote_path,
            &palitra_ids,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        return import_replacement_goi_palitra_file(
            env,
            integration,
            remote_path,
            file_data,
            file_size,
            file_sha256,
        )
        .await;
    };
    let retained_palitra_id = palitra.id;
    let upload =
        load_direct_goi_palitra_upload(env, filename.clone(), file_data)
            .await
            .c(h!())?;
    let uploaded_at = Utc::now();
    let txn = env.dbx.begin().await.c(h!())?;
    update_imported_palitra_fields(
        &txn,
        retained_palitra_id,
        PALITRA_CONVERSION_STATUS_READY,
        &extension,
        is_archived,
        imported_from_goi_update_for_refresh(tracked_rows),
    )
    .await
    .c(h!())?;
    rewrite_direct_goi_palitra_geometries(
        env,
        &txn,
        retained_palitra_id,
        &filename,
        uploaded_at,
        upload,
    )
    .await
    .c(h!())?;
    upsert_goi_palitra_sync(
        &txn,
        integration.id,
        Some(retained_palitra_id),
        remote_path,
        PALITRA_GOI_SYNC_DIRECTION_GOI,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(file_size),
        Some(file_sha256),
        Some(super::goi_changelog::ok_entry(
            "Synced from GOI",
            "Палітру оновлено з ГОІ.",
        )),
        None,
    )
    .await
    .c(h!())?;
    refresh_palitra_missing_in_goi(&txn, retained_palitra_id)
        .await
        .c(h!())?;
    let stale_palitra_ids = palitra_ids
        .into_iter()
        .filter(|palitra_id| *palitra_id != retained_palitra_id)
        .collect_vec();
    for stale_palitra_id in stale_palitra_ids {
        delete_stale_imported_goi_palitra(
            &txn,
            integration.id,
            remote_path,
            stale_palitra_id,
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn find_first_existing_tracked_palitra<'a, C>(
    dbx: &'a C,
    tracked_rows: &[goi_palitra_sync::Model],
) -> anyhow::Result<Option<palitra::Model>>
where
    C: ConnectionTrait + 'a,
{
    for palitra_id in tracked_palitra_ids(tracked_rows) {
        if let Some(palitra) = palitra::Entity::find_by_id(palitra_id)
            .filter(palitra::Column::Deleted.eq(false))
            .one(dbx)
            .await
            .c(h!())?
        {
            return Ok(Some(palitra));
        }
    }
    Ok(None)
}

fn tracked_palitra_ids(tracked_rows: &[goi_palitra_sync::Model]) -> Vec<i64> {
    tracked_rows
        .iter()
        .filter_map(|row| row.palitra_id)
        .unique()
        .collect_vec()
}

fn tracked_goi_palitra_ids(
    tracked_rows: &[goi_palitra_sync::Model],
) -> Vec<i64> {
    tracked_rows
        .iter()
        .filter(|row| row.direction == PALITRA_GOI_SYNC_DIRECTION_GOI)
        .filter_map(|row| row.palitra_id)
        .unique()
        .collect_vec()
}

fn imported_from_goi_update_for_refresh(
    tracked_rows: &[goi_palitra_sync::Model],
) -> Option<bool> {
    (!tracked_rows.is_empty()).then_some(true)
}

fn goi_source_snapshot_for_remote_path(
    remote_path: &str,
    file_data: &[u8],
    file_size: i64,
    file_sha256: &str,
) -> anyhow::Result<Option<GoiSourceFileSnapshot>> {
    let filename = remote_path_file_name(remote_path).c(h!())?;
    let extension =
        super::validate_palitra_upload_filename(&filename).c(h!())?;
    if super::is_direct_palitra_upload_extension(&extension) {
        return Ok(None);
    }
    Ok(Some(GoiSourceFileSnapshot {
        file_name: filename,
        source_format: extension,
        content_type: None,
        file_data: file_data.to_vec(),
        file_size,
        file_sha256: file_sha256.to_string(),
    }))
}

async fn import_replacement_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    file_data: Vec<u8>,
    file_size: i64,
    file_sha256: String,
) -> anyhow::Result<()> {
    let goi_source = goi_source_snapshot_for_remote_path(
        remote_path,
        &file_data,
        file_size,
        &file_sha256,
    )
    .c(h!())?;
    let changelog_entry = super::goi_changelog::ok_entry(
        "Imported GOI palitra",
        "Палітру імпортовано з ГОІ.",
    );
    let palitra_ids = import_goi_palitra_file(
        env,
        integration,
        remote_path,
        file_data,
        file_size,
        file_sha256.clone(),
        goi_source.clone(),
        changelog_entry.clone(),
    )
    .await
    .c(h!())?;
    if goi_source.is_some() {
        return Ok(());
    }
    for palitra_id in palitra_ids {
        upsert_goi_palitra_sync(
            &env.dbx,
            integration.id,
            Some(palitra_id),
            remote_path,
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            PALITRA_GOI_REMOTE_STATUS_PRESENT,
            Some(file_size),
            Some(file_sha256.clone()),
            Some(changelog_entry.clone()),
            None,
        )
        .await
        .c(h!())?;
        refresh_palitra_missing_in_goi(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

fn goi_geometry_colors(
    points_by_color: &BTreeMap<
        String,
        Vec<crate::palitra::types::PalitraPoint>,
    >,
    line_strings_by_color: &BTreeMap<
        String,
        Vec<crate::palitra::kmz::PalitraLineString>,
    >,
) -> Vec<String> {
    let primary_color_hex =
        super::pick_primary_color_hex(points_by_color, line_strings_by_color);
    let mut geometry_colors = vec![primary_color_hex.clone()];
    geometry_colors.extend(
        points_by_color
            .keys()
            .filter(|color_hex| *color_hex != &primary_color_hex)
            .cloned(),
    );
    geometry_colors.extend(
        line_strings_by_color
            .keys()
            .filter(|color_hex| *color_hex != &primary_color_hex)
            .cloned(),
    );
    let mut seen_colors = BTreeSet::new();
    geometry_colors.retain(|color_hex| seen_colors.insert(color_hex.clone()));
    if geometry_colors.is_empty() {
        geometry_colors
            .push(crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX.to_string());
    }
    geometry_colors
}

async fn load_direct_goi_palitra_upload(
    env: &Env,
    filename: String,
    file_data: Vec<u8>,
) -> anyhow::Result<crate::palitra::kmz::PalitraKmzData> {
    super::kmz::load_coordinates_from_file(filename, file_data, env)
        .await
        .c(h!())
}

async fn rewrite_direct_goi_palitra_geometries(
    env: &Env,
    txn: &DatabaseTransaction,
    palitra_id: i64,
    filename: &str,
    uploaded_at: chrono::DateTime<Utc>,
    upload: crate::palitra::kmz::PalitraKmzData,
) -> anyhow::Result<()> {
    let mut points_by_color =
        super::group_palitra_points_by_color(upload.points);
    let mut line_strings_by_color =
        super::group_palitra_lines_by_color(upload.line_strings);
    let geometry_colors =
        goi_geometry_colors(&points_by_color, &line_strings_by_color);
    let existing_palitra_geometries = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut retained_geometry_ids = BTreeSet::new();
    for color_hex in geometry_colors {
        let palitra_geometry = super::upsert_palitra_geometry_by_color(
            txn,
            palitra_id,
            &color_hex,
            filename,
            uploaded_at.naive_utc(),
        )
        .await
        .c(h!())?;
        retained_geometry_ids.insert(palitra_geometry.id);
        let color_points =
            points_by_color.remove(&color_hex).unwrap_or_default();
        let color_line_strings =
            line_strings_by_color.remove(&color_hex).unwrap_or_default();
        super::bl::rewrite_palitra_points(
            palitra_geometry.id,
            color_points,
            txn,
            &env.rq,
        )
        .await
        .c(h!())?;
        super::bl::rewrite_palitra_line_strings(
            palitra_geometry.id,
            color_line_strings,
            txn,
        )
        .await
        .c(h!())?;
    }
    for stale_geometry_id in existing_palitra_geometries
        .into_iter()
        .map(|geometry| geometry.id)
        .filter(|id| !retained_geometry_ids.contains(id))
    {
        super::bl::soft_delete_palitra_geometry(stale_geometry_id, txn)
            .await
            .c(h!())?;
    }
    super::bl::update_palitra_s3_id(txn, palitra_id, upload.s3_id)
        .await
        .c(h!())?;
    Ok(())
}

async fn delete_stale_imported_goi_palitra(
    txn: &DatabaseTransaction,
    goi_integration_id: i64,
    remote_path: &str,
    palitra_id: i64,
) -> anyhow::Result<()> {
    if let Some(palitra) = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
    {
        if palitra.imported_from_goi && !palitra.deleted {
            let geometries = palitra_geometry::Entity::find()
                .filter(palitra_geometry::Column::PalitraId.eq(palitra_id))
                .filter(palitra_geometry::Column::Deleted.eq(false))
                .all(txn)
                .await
                .c(h!())?;
            for geometry in geometries {
                super::bl::soft_delete_palitra_geometry(geometry.id, txn)
                    .await
                    .c(h!())?;
            }
            palitra::Entity::update_many()
                .filter(palitra::Column::Id.eq(palitra_id))
                .col_expr(palitra::Column::Deleted, Expr::value(true))
                .col_expr(
                    palitra::Column::DeletedAt,
                    Expr::value(Some(Utc::now().naive_utc())),
                )
                .exec(txn)
                .await
                .c(h!())?;
        }
    }
    delete_tracked_goi_palitra_sync_rows(
        txn,
        goi_integration_id,
        remote_path,
        &[palitra_id],
    )
    .await
}

async fn delete_tracked_goi_palitra_sync_rows<'a, C>(
    dbx: &'a C,
    goi_integration_id: i64,
    remote_path: &str,
    palitra_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    if palitra_ids.is_empty() {
        return Ok(());
    }
    goi_palitra_sync::Entity::delete_many()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .eq(remote_path.to_string()),
        )
        .filter(goi_palitra_sync::Column::PalitraId.is_in(palitra_ids.to_vec()))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn import_goi_palitra(
    env: &Env,
    target: &GoiSyncTarget,
    remote_path: &str,
) -> anyhow::Result<()> {
    let remote_file_path =
        super::compose_goi_palette_remote_path(&target.req.path, remote_path);
    let file_data =
        goi::goi_download_file(target.req.clone(), remote_file_path)
            .await
            .c(h!())?;
    let file_size = file_data.len() as i64;
    let file_sha256 = sha256::digest(&file_data);
    let goi_source = goi_source_snapshot_for_remote_path(
        remote_path,
        &file_data,
        file_size,
        &file_sha256,
    )
    .c(h!())?;
    let changelog_entry = super::goi_changelog::ok_entry(
        "Created from GOI",
        "Палітру створено з файлу ГОІ.",
    );
    let palitra_ids = import_goi_palitra_file(
        env,
        &target.integration,
        remote_path,
        file_data,
        file_size,
        file_sha256.clone(),
        goi_source.clone(),
        changelog_entry.clone(),
    )
    .await
    .c(h!())?;
    if goi_source.is_some() {
        return Ok(());
    }
    let file_size = Some(file_size);
    let file_sha256 = Some(file_sha256);
    for palitra_id in palitra_ids {
        upsert_goi_palitra_sync(
            &env.dbx,
            target.integration.id,
            Some(palitra_id),
            remote_path,
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            PALITRA_GOI_REMOTE_STATUS_PRESENT,
            file_size,
            file_sha256.clone(),
            Some(changelog_entry.clone()),
            None,
        )
        .await
        .c(h!())?;
        refresh_palitra_missing_in_goi(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn import_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    file_data: Vec<u8>,
    file_size: i64,
    file_sha256: String,
    goi_source: Option<GoiSourceFileSnapshot>,
    changelog_entry: PalitraChangelogEntry,
) -> anyhow::Result<Vec<i64>> {
    let filename = remote_path_file_name(remote_path).c(h!())?;
    let extension =
        super::validate_palitra_upload_filename(&filename).c(h!())?;
    let is_archived = remote_path_is_in_archive_folder(remote_path);
    if !super::is_direct_palitra_upload_extension(&extension) {
        return import_convertible_goi_palitra_file(
            env,
            integration,
            remote_path,
            filename,
            extension,
            file_data,
            is_archived,
            file_size,
            file_sha256,
            goi_source.c(h!())?,
            changelog_entry,
        )
        .await;
    }
    import_direct_goi_palitra_file(
        env,
        integration,
        remote_path,
        filename,
        extension,
        file_data,
        is_archived,
    )
    .await
}

async fn import_convertible_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    filename: String,
    extension: String,
    file_data: Vec<u8>,
    is_archived: bool,
    file_size: i64,
    file_sha256: String,
    goi_source: GoiSourceFileSnapshot,
    changelog_entry: PalitraChangelogEntry,
) -> anyhow::Result<Vec<i64>> {
    let organism_ids =
        goi_import_access(&env.dbx, integration).await.c(h!())?;
    let author = integration.maintainer_login.clone().c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra = super::bl::create_palitra(
        author,
        CreatePalitraReq {
            name: goi_palitra_name(remote_path),
            color_hex: crate::config::PALITRA_POINT_FALLBACK_COLOR_HEX
                .to_string(),
            access: PalitraAccess::ByOrganisms { organism_ids },
            source_file_name: Some(filename.clone()),
            last_uploaded_at_ts: Some(Utc::now().timestamp_millis()),
        },
        &txn,
    )
    .await
    .c(h!())?;
    update_imported_palitra_folder(&txn, palitra.id, remote_path)
        .await
        .c(h!())?;
    update_imported_palitra_fields(
        &txn,
        palitra.id,
        PALITRA_CONVERSION_STATUS_PROCESSING,
        &extension,
        is_archived,
        Some(true),
    )
    .await
    .c(h!())?;
    upsert_goi_palitra_sync(
        &txn,
        integration.id,
        Some(palitra.id),
        remote_path,
        PALITRA_GOI_SYNC_DIRECTION_GOI,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(file_size),
        Some(file_sha256.clone()),
        Some(changelog_entry),
        Some(goi_source.clone()),
    )
    .await
    .c(h!())?;
    refresh_palitra_missing_in_goi(&txn, palitra.id)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    let schedule_result = super::schedule_palitra_conversion_with_goi_upload(
        &env.dbx,
        palitra.id,
        filename,
        extension.clone(),
        None,
        file_data,
        false,
    )
    .await;
    if let Err(err) = schedule_result {
        let error = format!("{err:#}");
        record_goi_source_conversion_scheduling_failure(
            &env.dbx,
            integration.id,
            palitra.id,
            remote_path,
            extension,
            file_size,
            file_sha256,
            error.clone(),
            format!("Failed to schedule GOI source conversion: {error}"),
            "Не вдалося поставити конвертацію файлу ГОІ в чергу.",
            goi_source,
        )
        .await
        .c(h!())?;
        anyhow::bail!("failed to schedule GOI source conversion: {error}");
    }
    Ok(vec![palitra.id])
}

async fn import_direct_goi_palitra_file(
    env: &Env,
    integration: &goi_integration::Model,
    remote_path: &str,
    filename: String,
    extension: String,
    file_data: Vec<u8>,
    is_archived: bool,
) -> anyhow::Result<Vec<i64>> {
    let upload =
        load_direct_goi_palitra_upload(env, filename.clone(), file_data)
            .await
            .c(h!())?;
    let s3_id = upload.s3_id;
    let points_by_color = super::group_palitra_points_by_color(upload.points);
    let line_strings_by_color =
        super::group_palitra_lines_by_color(upload.line_strings);
    let geometry_colors =
        goi_geometry_colors(&points_by_color, &line_strings_by_color);
    let primary_color_hex = geometry_colors.first().cloned().c(h!())?;
    let upload = crate::palitra::kmz::PalitraKmzData {
        points: points_by_color.into_values().flatten().collect::<Vec<_>>(),
        line_strings: line_strings_by_color
            .into_values()
            .flatten()
            .collect::<Vec<_>>(),
        s3_id,
    };

    let organism_ids =
        goi_import_access(&env.dbx, integration).await.c(h!())?;
    let author = integration.maintainer_login.clone().c(h!())?;
    let uploaded_at = Utc::now();
    let txn = env.dbx.begin().await.c(h!())?;
    let palitra = super::bl::create_palitra(
        author,
        CreatePalitraReq {
            name: goi_palitra_name(remote_path),
            color_hex: primary_color_hex,
            access: PalitraAccess::ByOrganisms { organism_ids },
            source_file_name: Some(filename.clone()),
            last_uploaded_at_ts: Some(uploaded_at.timestamp_millis()),
        },
        &txn,
    )
    .await
    .c(h!())?;
    update_imported_palitra_folder(&txn, palitra.id, remote_path)
        .await
        .c(h!())?;
    update_imported_palitra_fields(
        &txn,
        palitra.id,
        PALITRA_CONVERSION_STATUS_READY,
        &extension,
        is_archived,
        Some(true),
    )
    .await
    .c(h!())?;
    rewrite_direct_goi_palitra_geometries(
        env,
        &txn,
        palitra.id,
        &filename,
        uploaded_at,
        upload,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(vec![palitra.id])
}

async fn update_imported_palitra_folder<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    remote_path: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let Some(folder) = goi_remote_path_folder(remote_path).c(h!())? else {
        return Ok(());
    };
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(palitra::Column::Folder, Expr::value(Some(folder)))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

fn goi_remote_path_folder(remote_path: &str) -> anyhow::Result<Option<String>> {
    let remote_path = remote_path
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_matches('/');
    let Some((folder, _)) = remote_path.rsplit_once('/') else {
        return Ok(None);
    };
    let folder = normalize_goi_remote_folder(folder).c(h!())?;
    Ok(Some(folder))
}

fn normalize_goi_remote_folder(folder: &str) -> anyhow::Result<String> {
    let folder = folder.trim();
    if folder.is_empty() {
        anyhow::bail!("GOI palitra folder may not be empty");
    }
    let parts = folder.split('/').map(str::trim).collect_vec();
    if parts.iter().any(|part| part.is_empty()) {
        anyhow::bail!(
            "GOI palitra folder may not contain empty path segments: {folder}"
        );
    }
    if parts.iter().any(|part| part == &"." || part == &"..") {
        anyhow::bail!(
            "GOI palitra folder may not contain '.' or '..' path segments: {folder}"
        );
    }
    Ok(parts.join("/"))
}

async fn update_imported_palitra_fields<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    status: &str,
    source_format: &str,
    is_archived: bool,
    imported_from_goi: Option<bool>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let mut update = palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(palitra::Column::MissingInGoi, Expr::value(false))
        .col_expr(palitra::Column::IsArchived, Expr::value(is_archived))
        .col_expr(
            palitra::Column::ConversionStatus,
            Expr::value(status.to_string()),
        )
        .col_expr(
            palitra::Column::SourceFormat,
            Expr::value(Some(source_format.to_string())),
        )
        .col_expr(
            palitra::Column::ConversionReceipt,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            palitra::Column::ConversionError,
            Expr::value(Option::<String>::None),
        );
    if let Some(imported_from_goi) = imported_from_goi {
        update = update.col_expr(
            palitra::Column::ImportedFromGoi,
            Expr::value(imported_from_goi),
        );
    }
    if status == PALITRA_CONVERSION_STATUS_PROCESSING {
        update = update.col_expr(
            palitra::Column::ConversionLastAttemptAt,
            Expr::value(Some(Utc::now().fixed_offset())),
        );
    }
    update.exec(dbx).await.c(h!())?;
    Ok(())
}

async fn goi_import_access(
    dbx: &DatabaseConnection,
    integration: &goi_integration::Model,
) -> anyhow::Result<Vec<i64>> {
    let mut organism_ids = vec![integration.owner_organism_id];
    organism_ids.extend(
        goi_integration_access_organism::Entity::find()
            .filter(
                goi_integration_access_organism::Column::GoiIntegrationId
                    .eq(integration.id),
            )
            .select_only()
            .column(goi_integration_access_organism::Column::OrganismId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?,
    );
    organism_ids.sort();
    organism_ids.dedup();
    Ok(organism_ids)
}

async fn read_palitra_goi_organism_ids<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait + 'a,
{
    let mut organism_ids =
        super::bl::collect_palitra_access_organisms(dbx, palitra_id)
            .await
            .c(h!())?;
    organism_ids.sort();
    organism_ids.dedup();
    Ok(organism_ids)
}

async fn find_echo_palitra_matches_for_remote_path(
    dbx: &DatabaseConnection,
    integration: &goi_integration::Model,
    remote_path: &str,
) -> anyhow::Result<Vec<palitra::Model>> {
    let palitra_ids = palitra_access_organism::Entity::find()
        .filter(
            palitra_access_organism::Column::OrganismId
                .eq(integration.owner_organism_id),
        )
        .select_only()
        .column(palitra_access_organism::Column::PalitraId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    if palitra_ids.is_empty() {
        return Ok(Vec::new());
    }
    let palitras = palitra::Entity::find()
        .filter(palitra::Column::Id.is_in(palitra_ids))
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let mut matches = Vec::new();
    for palitra in palitras {
        let geometry = match super::read_latest_palitra_geometry_with_warning(
            dbx, palitra.id,
        )
        .await
        {
            Ok(geometry) => geometry,
            Err(_) => continue,
        };
        let target_folder =
            super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
        for file_name in super::palitra_goi_remote_file_names(
            palitra.id,
            Some(&palitra.name),
            geometry.source_file_name.as_deref(),
        ) {
            if remote_path_matches_palitra_file(
                remote_path,
                target_folder.as_deref(),
                &file_name,
            ) {
                matches.push(palitra);
                break;
            }
        }
    }
    Ok(matches)
}

fn remote_path_matches_palitra_file(
    remote_path: &str,
    target_folder: Option<&str>,
    file_name: &str,
) -> bool {
    let expected = compose_relative_path(target_folder, file_name);
    let remote_path = remote_path
        .trim()
        .trim_start_matches("./")
        .trim_matches('/');
    remote_path == expected
}

fn remote_path_is_in_archive_folder(remote_path: &str) -> bool {
    remote_path
        .trim()
        .trim_start_matches("./")
        .trim_matches('/')
        .split('/')
        .next()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("archive"))
}

async fn collect_all_goi_sync_targets(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<GoiSyncTarget>> {
    let worker_active = goi_integration::Column::PauseWorker.eq(false);
    let integrations = goi_integration::Entity::find()
        .filter(worker_active)
        .filter(
            goi_integration::Column::IntegrationType
                .eq(ORGANISM_GOI_INTEGRATION_TYPE_FULL),
        )
        .all(dbx)
        .await
        .c(h!())?;
    collect_valid_goi_sync_targets(integrations)
}

async fn collect_goi_sync_targets_for_organisms(
    dbx: &DatabaseConnection,
    organism_ids: &[i64],
) -> anyhow::Result<Vec<GoiSyncTarget>> {
    if organism_ids.is_empty() {
        return Ok(vec![]);
    }
    let worker_active = goi_integration::Column::PauseWorker.eq(false);
    let integrations = goi_integration::Entity::find()
        .filter(worker_active)
        .filter(
            goi_integration::Column::OwnerOrganismId
                .is_in(organism_ids.to_vec()),
        )
        .filter(
            goi_integration::Column::IntegrationType
                .eq(ORGANISM_GOI_INTEGRATION_TYPE_FULL),
        )
        .all(dbx)
        .await
        .c(h!())?;
    collect_valid_goi_sync_targets(integrations)
}

fn collect_valid_goi_sync_targets(
    integrations: Vec<goi_integration::Model>,
) -> anyhow::Result<Vec<GoiSyncTarget>> {
    let mut targets = Vec::with_capacity(integrations.len());
    for integration in integrations {
        let Some(target) =
            goi_sync_target_from_integration(integration).c(h!())?
        else {
            continue;
        };
        targets.push(target);
    }
    Ok(targets)
}

fn goi_sync_target_from_integration(
    integration: goi_integration::Model,
) -> anyhow::Result<Option<GoiSyncTarget>> {
    if goi_integration_worker_paused(&integration) {
        return Ok(None);
    }
    let ssh_host = integration
        .ssh_host
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let ssh_user = integration
        .ssh_user
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(ssh_host) = ssh_host else {
        return Ok(None);
    };
    let Some(ssh_user) = ssh_user else {
        return Ok(None);
    };
    let path = normalize_trimmed_or_default(
        integration.path.clone(),
        ORGANISM_GOI_PATH_DEFAULT,
    );
    let ssh_port = if integration.ssh_port > 0 {
        integration.ssh_port
    } else {
        ORGANISM_GOI_SSH_PORT_DEFAULT
    };
    let req = CheckOrganismGoiConnectionReq {
        ssh_host,
        ssh_user,
        ssh_port,
        path,
    };
    super::goi_validate_connection_req(&req).c(h!())?;
    Ok(Some(GoiSyncTarget { integration, req }))
}

async fn upsert_goi_palitra_sync<'a, C>(
    dbx: &'a C,
    goi_integration_id: i64,
    palitra_id: Option<i64>,
    remote_relative_path: &str,
    direction: &str,
    remote_status: &str,
    file_size: Option<i64>,
    file_sha256: Option<String>,
    changelog_entry: Option<PalitraChangelogEntry>,
    goi_source: Option<GoiSourceFileSnapshot>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let now = Utc::now().fixed_offset();
    let has_file_metadata = file_size.is_some() || file_sha256.is_some();
    let mut row = goi_palitra_sync::Entity::find()
        .filter(
            goi_palitra_sync::Column::GoiIntegrationId.eq(goi_integration_id),
        )
        .filter(
            goi_palitra_sync::Column::RemoteRelativePath
                .eq(remote_relative_path.to_string()),
        );
    row = if let Some(palitra_id) = palitra_id {
        row.filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
    } else {
        row.filter(goi_palitra_sync::Column::PalitraId.is_null())
    };
    if let Some(row) = row.one(dbx).await.c(h!())? {
        let echo_changed = has_file_metadata
            && (tracked_row_echo_file_size(&row) != file_size
                || tracked_row_echo_file_sha256(&row)
                    != file_sha256.as_deref());
        let goi_changed = has_file_metadata
            && (tracked_row_goi_file_size(&row) != file_size
                || tracked_row_goi_file_sha256(&row) != file_sha256.as_deref());
        let changelog = match changelog_entry {
            Some(entry) => Some(
                super::goi_changelog::append_to_value(&row.changelog, entry)
                    .c(h!())?,
            ),
            None => None,
        };
        let mut row = row.into_active_model();
        row.direction = Set(direction.to_string());
        row.remote_status = Set(remote_status.to_string());
        if has_file_metadata {
            row.file_size = Set(file_size);
            row.file_sha256 = Set(file_sha256.clone());
            row.echo_file_size = Set(file_size);
            row.echo_file_sha256 = Set(file_sha256.clone());
            if echo_changed {
                row.echo_updated_at = Set(Some(now));
            }
            row.goi_file_size = Set(file_size);
            row.goi_file_sha256 = Set(file_sha256.clone());
            if goi_changed {
                row.goi_updated_at = Set(Some(now));
            }
        }
        row.last_seen_at = Set(Some(now));
        row.last_sync_at = Set(Some(now));
        if let Some(changelog) = changelog {
            row.changelog = Set(changelog);
        }
        if let Some(goi_source) = goi_source {
            row.goi_source_file_name = Set(Some(goi_source.file_name));
            row.goi_source_format = Set(Some(goi_source.source_format));
            row.goi_source_content_type = Set(goi_source.content_type);
            row.goi_source_file_data = Set(Some(goi_source.file_data));
            row.goi_source_file_size = Set(Some(goi_source.file_size));
            row.goi_source_file_sha256 = Set(Some(goi_source.file_sha256));
        }
        row.updated_at = Set(now);
        row.update(dbx).await.c(h!())?;
        return Ok(());
    }
    let changelog =
        changelog_entry.map(|entry| vec![entry]).unwrap_or_default();
    let changelog = serde_json::to_value(changelog).c(h!())?;
    let (
        goi_source_file_name,
        goi_source_format,
        goi_source_content_type,
        goi_source_file_data,
        goi_source_file_size,
        goi_source_file_sha256,
    ) = match goi_source {
        Some(goi_source) => (
            Some(goi_source.file_name),
            Some(goi_source.source_format),
            goi_source.content_type,
            Some(goi_source.file_data),
            Some(goi_source.file_size),
            Some(goi_source.file_sha256),
        ),
        None => (None, None, None, None, None, None),
    };
    goi_palitra_sync::Entity::insert(goi_palitra_sync::ActiveModel {
        goi_integration_id: Set(goi_integration_id),
        palitra_id: Set(palitra_id),
        remote_relative_path: Set(remote_relative_path.to_string()),
        direction: Set(direction.to_string()),
        remote_status: Set(remote_status.to_string()),
        file_size: Set(file_size),
        file_sha256: Set(file_sha256.clone()),
        echo_file_size: Set(file_size),
        echo_file_sha256: Set(file_sha256.clone()),
        echo_updated_at: Set(has_file_metadata.then_some(now)),
        goi_file_size: Set(file_size),
        goi_file_sha256: Set(file_sha256),
        goi_updated_at: Set(has_file_metadata.then_some(now)),
        last_seen_at: Set(Some(now)),
        last_sync_at: Set(Some(now)),
        changelog: Set(changelog),
        goi_source_file_name: Set(goi_source_file_name),
        goi_source_format: Set(goi_source_format),
        goi_source_content_type: Set(goi_source_content_type),
        goi_source_file_data: Set(goi_source_file_data),
        goi_source_file_size: Set(goi_source_file_size),
        goi_source_file_sha256: Set(goi_source_file_sha256),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(dbx)
    .await
    .c(h!())?;
    Ok(())
}

async fn refresh_palitra_missing_in_goi<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let remote_statuses = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .select_only()
        .column(goi_palitra_sync::Column::RemoteStatus)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;
    let missing = !remote_statuses.is_empty()
        && remote_statuses.iter().all(|remote_status| {
            remote_status != PALITRA_GOI_REMOTE_STATUS_PRESENT
        });
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(palitra::Column::MissingInGoi, Expr::value(missing))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

fn normalize_goi_palitra_relative_path(entry: &str) -> Option<String> {
    let entry = entry
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_matches('/')
        .to_string();
    if entry.is_empty() {
        return None;
    }
    let extension = Path::new(&entry)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.trim().to_ascii_lowercase())
        .filter(|extension| !extension.is_empty())?;
    if PALITRA_BLOCKED_UNSTABLE_UPLOAD_EXTENSIONS.contains(&extension.as_str())
    {
        warn!(
            "Skipping GOI palitra file '{entry}': PGD conversion is not stable enough yet"
        );
        return None;
    }
    if !PALITRA_ALLOWED_UPLOAD_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(entry)
}

fn remote_path_file_name(remote_path: &str) -> anyhow::Result<String> {
    Path::new(remote_path)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .map(str::to_string)
        .c(h!())
}

fn goi_palitra_name(remote_path: &str) -> String {
    Path::new(remote_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("palitra")
        .to_string()
}

async fn sync_upload_job(
    env: &Env,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let geometry =
        super::read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;
    let organism_ids = read_palitra_goi_organism_ids(&env.dbx, palitra.id)
        .await
        .c(h!())?;
    let remote_file_name = super::palitra_goi_remote_file_name(
        palitra.id,
        Some(&palitra.name),
        geometry.source_file_name.as_deref(),
    );
    let target_folder =
        super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
    let file_data = load_upload_file_data(env, job, &palitra).await.c(h!())?;
    upload_palitra_to_connected_organisms_strict(
        &env.dbx,
        palitra.id,
        &organism_ids,
        &remote_file_name,
        target_folder.as_deref(),
        &file_data,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn load_upload_file_data(
    env: &Env,
    job: &palitra_goi_sync_job::Model,
    palitra: &palitra::Model,
) -> anyhow::Result<Vec<u8>> {
    if let Some(file_data) = &job.file_data {
        return Ok(file_data.clone());
    }

    load_palitra_file_data(env, palitra).await.c(h!())
}

async fn load_palitra_file_data(
    env: &Env,
    palitra: &palitra::Model,
) -> anyhow::Result<Vec<u8>> {
    maybe_load_palitra_file_data(env, palitra)
        .await
        .c(h!())?
        .c(h!())
}

async fn maybe_load_palitra_file_data(
    env: &Env,
    palitra: &palitra::Model,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(s3_id) = palitra.s3_id.as_deref() else {
        return Ok(None);
    };
    let strongbox_key = env
        .config
        .s3_config
        .as_ref()
        .map(|s3_config| s3_config.strongbox_key.as_str())
        .c(h!())?;
    crate::storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        strongbox_key,
        s3_id,
    )
    .await
    .map_err(|err| anyhow::anyhow!(err))
    .map(Some)
    .c(h!())
}

async fn sync_move_job(
    dbx: &DatabaseConnection,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };

    let sync_item = super::bl::PalitraFolderSyncItem {
        palitra_id: palitra.id,
        source_folder: if job.source_folder.is_empty() {
            None
        } else {
            Some(job.source_folder.clone())
        },
    };
    super::sync_move_palitra_files_to_connected_organisms(
        dbx,
        std::slice::from_ref(&sync_item),
    )
    .await
    .c(h!())
}

async fn sync_delete_job(
    dbx: &DatabaseConnection,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let organism_ids = read_palitra_goi_organism_ids(dbx, palitra.id)
        .await
        .c(h!())?;
    let target_folders = if job.source_folder.is_empty() {
        let target_folder =
            super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
        if target_folder.is_some() {
            vec![target_folder, None]
        } else {
            vec![None]
        }
    } else {
        vec![super::bl::normalize_palitra_folder_from_db(Some(
            job.source_folder.clone(),
        ))]
    };
    let source_file_names = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|geometry| geometry.source_file_name)
        .collect::<Vec<_>>();
    let tracked_relative_paths_by_integration =
        read_tracked_goi_palitra_relative_paths_by_integration(dbx, palitra.id)
            .await
            .c(h!())?;
    delete_palitra_from_connected_organisms_strict(
        dbx,
        palitra.id,
        &palitra.name,
        &organism_ids,
        &target_folders,
        &source_file_names,
        &tracked_relative_paths_by_integration,
    )
    .await
    .c(h!())
}

async fn read_tracked_goi_palitra_relative_paths_by_integration<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<BTreeMap<i64, Vec<String>>>
where
    C: ConnectionTrait + 'a,
{
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .select_only()
        .column(goi_palitra_sync::Column::GoiIntegrationId)
        .column(goi_palitra_sync::Column::RemoteRelativePath)
        .into_tuple::<(i64, String)>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut paths_by_integration = BTreeMap::<i64, BTreeSet<String>>::new();
    for (goi_integration_id, remote_relative_path) in rows {
        let Some(path) = normalize_remote_relative_path(&remote_relative_path)
        else {
            continue;
        };
        paths_by_integration
            .entry(goi_integration_id)
            .or_default()
            .insert(path);
    }
    Ok(paths_by_integration
        .into_iter()
        .map(|(integration_id, paths)| {
            (integration_id, paths.into_iter().collect_vec())
        })
        .collect())
}

async fn upload_palitra_to_connected_organisms_strict(
    dbx: &DatabaseConnection,
    palitra_id: i64,
    organism_ids: &[i64],
    remote_file_name: &str,
    target_folder: Option<&str>,
    file_data: &[u8],
) -> anyhow::Result<()> {
    if organism_ids.is_empty() {
        return Ok(());
    }
    let goi_targets = collect_goi_sync_targets_for_organisms(dbx, organism_ids)
        .await
        .c(h!())?;
    let mut errors = Vec::new();
    for target in goi_targets {
        let relative_path =
            compose_relative_path(target_folder, remote_file_name);
        let remote_file_path =
            compose_remote_path(&target.req, target_folder, remote_file_name);
        if target.integration.disable_goi_to_echo_palitra_sync {
            if let Err(err) = upload_palitra_to_goi_target(
                dbx,
                &target,
                palitra_id,
                &relative_path,
                &remote_file_path,
                file_data,
            )
            .await
            {
                errors.push(format!(
                    "{}:{} {}: {err:#}",
                    target.req.ssh_host, target.req.ssh_port, remote_file_path
                ));
            }
            continue;
        }
        let Some(lock) =
            (match goi::goi_try_acquire_sync_lock(target.req.clone()).await {
                Ok(lock) => lock,
                Err(err) => {
                    errors.push(format!(
                        "{}:{} acquire sync lock: {err:#}",
                        target.req.ssh_host, target.req.ssh_port
                    ));
                    continue;
                }
            })
        else {
            errors.push(format!(
                "{}:{} sync lock is held by another worker",
                target.req.ssh_host, target.req.ssh_port
            ));
            continue;
        };
        let sync_result = async {
            upload_palitra_to_goi_target(
                dbx,
                &target,
                palitra_id,
                &relative_path,
                &remote_file_path,
                file_data,
            )
            .await
            .c(h!())?;
            lock.refresh().await.c(h!())?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        release_goi_sync_lock(lock).await;
        if let Err(err) = sync_result {
            errors.push(format!(
                "{}:{} {}: {err:#}",
                target.req.ssh_host, target.req.ssh_port, remote_file_path
            ));
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    anyhow::bail!("palitra GOI upload failed: {}", errors.join("; "));
}

async fn upload_palitra_to_goi_target(
    dbx: &DatabaseConnection,
    target: &GoiSyncTarget,
    palitra_id: i64,
    relative_path: &str,
    remote_file_path: &str,
    file_data: &[u8],
) -> anyhow::Result<()> {
    goi::goi_upload_file(
        target.req.clone(),
        remote_file_path.to_string(),
        file_data.to_vec(),
    )
    .await
    .c(h!())?;
    upsert_goi_palitra_sync(
        dbx,
        target.integration.id,
        Some(palitra_id),
        relative_path,
        PALITRA_GOI_SYNC_DIRECTION_ECHO,
        PALITRA_GOI_REMOTE_STATUS_PRESENT,
        Some(file_data.len() as i64),
        Some(sha256::digest(file_data)),
        Some(super::goi_changelog::ok_entry(
            "Synced to GOI",
            "Палітру синхронізовано в ГОІ.",
        )),
        None,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn delete_palitra_from_connected_organisms_strict(
    dbx: &DatabaseConnection,
    palitra_id: i64,
    palitra_name: &str,
    organism_ids: &[i64],
    target_folders: &[Option<String>],
    source_file_names: &[Option<String>],
    tracked_relative_paths_by_integration: &BTreeMap<i64, Vec<String>>,
) -> anyhow::Result<()> {
    if organism_ids.is_empty() {
        return Ok(());
    }
    let goi_targets = super::collect_connected_goi_targets(dbx, organism_ids)
        .await
        .c(h!())?;

    let mut errors = Vec::new();
    for target in goi_targets {
        let tracked_relative_paths = tracked_relative_paths_by_integration
            .get(&target.integration_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let relative_paths = delete_relative_path_candidates(
            palitra_id,
            palitra_name,
            target_folders,
            source_file_names,
            tracked_relative_paths,
        );
        if relative_paths.is_empty() {
            continue;
        }
        if target.disable_goi_to_echo_palitra_sync {
            if let Err(err) = delete_palitra_from_goi_target(
                target.req.clone(),
                &relative_paths,
            )
            .await
            {
                errors.push(format!(
                    "{}:{} {err:#}",
                    target.req.ssh_host, target.req.ssh_port
                ));
            }
            continue;
        }
        let Some(lock) =
            (match goi::goi_try_acquire_sync_lock(target.req.clone()).await {
                Ok(lock) => lock,
                Err(err) => {
                    errors.push(format!(
                        "{}:{} acquire sync lock: {err:#}",
                        target.req.ssh_host, target.req.ssh_port
                    ));
                    continue;
                }
            })
        else {
            errors.push(format!(
                "{}:{} sync lock is held by another worker",
                target.req.ssh_host, target.req.ssh_port
            ));
            continue;
        };
        let sync_result = async {
            let entries =
                match goi::goi_list_relative_files(target.req.clone()).await {
                    Ok(entries) => entries,
                    Err(err) => anyhow::bail!("list relative files: {err:#}"),
                };
            lock.refresh().await.c(h!())?;
            for entry in entries {
                if !matches_remote_relative_path(&entry, &relative_paths) {
                    continue;
                }
                let remote_file_path = super::compose_goi_palette_remote_path(
                    &target.req.path,
                    &entry,
                );
                if let Err(err) = goi::goi_delete_file(
                    target.req.clone(),
                    remote_file_path.clone(),
                )
                .await
                {
                    anyhow::bail!("{remote_file_path}: {err:#}");
                }
                lock.refresh().await.c(h!())?;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        release_goi_sync_lock(lock).await;
        if let Err(err) = sync_result {
            errors.push(format!(
                "{}:{} {err:#}",
                target.req.ssh_host, target.req.ssh_port
            ));
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    anyhow::bail!("palitra GOI delete failed: {}", errors.join("; "));
}

fn delete_relative_path_candidates(
    palitra_id: i64,
    palitra_name: &str,
    target_folders: &[Option<String>],
    source_file_names: &[Option<String>],
    tracked_relative_paths: &[String],
) -> BTreeSet<String> {
    let mut relative_paths = BTreeSet::new();
    relative_paths.extend(
        tracked_relative_paths
            .iter()
            .filter_map(|path| normalize_remote_relative_path(path)),
    );
    for source_file_name in source_file_names {
        for file_name in super::palitra_goi_remote_file_names(
            palitra_id,
            Some(palitra_name),
            source_file_name.as_deref(),
        ) {
            for target_folder in target_folders {
                relative_paths.insert(compose_relative_path(
                    target_folder.as_deref(),
                    &file_name,
                ));
            }
        }
    }
    relative_paths
}

async fn delete_palitra_from_goi_target(
    target: CheckOrganismGoiConnectionReq,
    relative_paths: &BTreeSet<String>,
) -> anyhow::Result<()> {
    let entries = match goi::goi_list_relative_files(target.clone()).await {
        Ok(entries) => entries,
        Err(err) => anyhow::bail!("list relative files: {err:#}"),
    };
    for entry in entries {
        if !matches_remote_relative_path(&entry, relative_paths) {
            continue;
        }
        let remote_file_path =
            super::compose_goi_palette_remote_path(&target.path, &entry);
        if let Err(err) =
            goi::goi_delete_file(target.clone(), remote_file_path.clone()).await
        {
            anyhow::bail!("{remote_file_path}: {err:#}");
        }
    }
    Ok(())
}

async fn release_goi_sync_lock(lock: goi::GoiSyncLock) {
    let target = lock.target();
    if let Err(err) = lock.release().await {
        warn!("Failed to release GOI sync lock for {target}: {err:#}");
    }
}

fn compose_relative_path(
    target_folder: Option<&str>,
    file_name: &str,
) -> String {
    let file_name = file_name.trim().trim_start_matches('/');
    match target_folder
        .map(str::trim)
        .map(|folder| folder.trim_matches('/'))
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{file_name}"),
        None => file_name.to_string(),
    }
}

fn compose_remote_path(
    target: &CheckOrganismGoiConnectionReq,
    target_folder: Option<&str>,
    remote_file_name: &str,
) -> String {
    let relative_path = match target_folder
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{remote_file_name}"),
        None => remote_file_name.to_string(),
    };
    super::compose_goi_palette_remote_path(&target.path, &relative_path)
}

fn matches_remote_relative_path(
    entry: &str,
    relative_paths: &BTreeSet<String>,
) -> bool {
    normalize_remote_relative_path(entry)
        .is_some_and(|entry| relative_paths.contains(&entry))
}

fn normalize_remote_relative_path(path: &str) -> Option<String> {
    let path = path.trim().trim_start_matches("./").trim_matches('/');
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PALITRA_CONVERSION_JOB_STATUS_PENDING;
    use crate::functest::tests::{
        cleanup, find_test_login, find_test_organism, find_test_palitra,
    };
    use serial_test::serial;

    fn goi_palitra_sync_row(
        direction: &str,
        palitra_id: Option<i64>,
        file_size: Option<i64>,
        file_sha256: Option<&str>,
    ) -> goi_palitra_sync::Model {
        let now = Utc::now().fixed_offset();
        goi_palitra_sync::Model {
            id: 1,
            goi_integration_id: 2,
            palitra_id,
            remote_relative_path: "foo.kmz".to_string(),
            direction: direction.to_string(),
            remote_status: PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string(),
            file_size,
            file_sha256: file_sha256.map(str::to_string),
            echo_file_size: file_size,
            echo_file_sha256: file_sha256.map(str::to_string),
            echo_updated_at: Some(now),
            goi_file_size: file_size,
            goi_file_sha256: file_sha256.map(str::to_string),
            goi_updated_at: Some(now),
            last_seen_at: Some(now),
            last_sync_at: Some(now),
            created_at: now,
            updated_at: now,
            changelog: serde_json::json!([]),
            goi_source_file_name: None,
            goi_source_format: None,
            goi_source_content_type: None,
            goi_source_file_data: None,
            goi_source_file_size: None,
            goi_source_file_sha256: None,
            goi_source_failed_file_sha256: None,
            goi_source_last_retry_at: None,
        }
    }

    async fn mk_goi_integration_for_test(
        dbx: &DatabaseConnection,
        server_key: &str,
    ) -> goi_integration::Model {
        let organism = find_test_organism(dbx).await.unwrap();
        let login = find_test_login(dbx).await.unwrap();
        goi_integration::ActiveModel {
            id: NotSet,
            owner_organism_id: Set(organism.id),
            created_at: Set(Utc::now().fixed_offset()),
            integration_type: Set(
                ORGANISM_GOI_INTEGRATION_TYPE_FULL.to_string()
            ),
            server_key: Set(server_key.to_string()),
            server_label: Set(server_key.to_string()),
            ssh_host: Set(Some("goi.test".to_string())),
            ssh_user: Set(Some("goi".to_string())),
            ssh_port: Set(22),
            path: Set("/goi/palettes".to_string()),
            api_host: Set(None),
            api_port: Set(8088),
            api_login: Set(None),
            api_password: Set(None),
            disable_goi_to_echo_palitra_sync: Set(false),
            maintainer_login: Set(Some(login.login)),
            pause_worker: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    #[test]
    fn goi_reconciliation_is_due_on_start_and_after_interval() {
        assert!(should_reconcile_goi_palitras(None));
        assert!(!should_reconcile_goi_palitras(Some(Instant::now())));
        assert!(should_reconcile_goi_palitras(Some(
            Instant::now()
                - Duration::from_secs(PALITRA_GOI_RECONCILE_INTERVAL_SEC)
        )));
    }

    #[test]
    fn echo_backfill_uses_first_available_remote_name() {
        let remote_file_names = super::super::palitra_goi_remote_file_names(
            42,
            Some("Current name"),
            Some("source.kml"),
        );

        assert_eq!(
            find_echo_palitra_backfill_remote_file_name(
                &BTreeSet::new(),
                Some("folder"),
                &remote_file_names,
            ),
            Some("Current name.kmz")
        );
        let current_path =
            BTreeSet::from(["folder/Current name.kmz".to_string()]);
        assert_eq!(
            find_echo_palitra_backfill_remote_file_name(
                &current_path,
                Some("folder"),
                &remote_file_names,
            ),
            Some("source.kml")
        );
        let current_and_source_paths = BTreeSet::from([
            "folder/Current name.kmz".to_string(),
            "folder/source.kml".to_string(),
        ]);
        assert_eq!(
            find_echo_palitra_backfill_remote_file_name(
                &current_and_source_paths,
                Some("folder"),
                &remote_file_names,
            ),
            Some("palitra_000042.kmz")
        );
        let all_paths = BTreeSet::from([
            "folder/Current name.kmz".to_string(),
            "folder/source.kml".to_string(),
            "folder/palitra_000042.kmz".to_string(),
        ]);
        assert_eq!(
            find_echo_palitra_backfill_remote_file_name(
                &all_paths,
                Some("folder"),
                &remote_file_names,
            ),
            None
        );
    }

    #[test]
    fn remote_path_match_requires_full_relative_path_for_foldered_files() {
        assert!(remote_path_matches_palitra_file(
            "folder-a/foo.kmz",
            Some("folder-a"),
            "foo.kmz"
        ));
        assert!(!remote_path_matches_palitra_file(
            "folder-b/foo.kmz",
            Some("folder-a"),
            "foo.kmz"
        ));
        assert!(!remote_path_matches_palitra_file(
            "folder-a/foo.kmz",
            None,
            "foo.kmz"
        ));
        assert!(remote_path_matches_palitra_file("foo.kmz", None, "foo.kmz"));
    }

    #[test]
    fn remote_path_archive_detection_uses_first_folder_segment() {
        assert!(remote_path_is_in_archive_folder("archive/foo.kmz"));
        assert!(remote_path_is_in_archive_folder("./Archive/sub/foo.kmz"));
        assert!(!remote_path_is_in_archive_folder("folder/archive/foo.kmz"));
        assert!(!remote_path_is_in_archive_folder("archive.kmz"));
    }

    #[test]
    fn goi_remote_path_folder_preserves_safe_relative_folder() {
        assert_eq!(goi_remote_path_folder("foo.kmz").unwrap(), None);
        assert_eq!(
            goi_remote_path_folder("sector/foo.kmz").unwrap().as_deref(),
            Some("sector")
        );
        assert_eq!(
            goi_remote_path_folder("./sector / sub/foo.kmz")
                .unwrap()
                .as_deref(),
            Some("sector/sub")
        );
        assert!(goi_remote_path_folder("sector/../foo.kmz").is_err());
        assert!(goi_remote_path_folder("sector//foo.kmz").is_err());
    }

    #[test]
    fn delete_candidates_include_tracked_original_goi_relative_path() {
        let target_folders = vec![Some("sector".to_string()), None];
        let source_file_names = vec![Some("foo.kmz".to_string())];
        let tracked_relative_paths = vec!["sector/foo.gpx".to_string()];
        let candidates = delete_relative_path_candidates(
            42,
            "foo",
            &target_folders,
            &source_file_names,
            &tracked_relative_paths,
        );

        assert!(candidates.contains("sector/foo.gpx"));
        assert!(candidates.contains("sector/foo.kmz"));
        assert!(candidates.contains("foo.kmz"));
    }

    #[test]
    fn delete_candidates_use_only_current_integration_tracked_paths() {
        let target_folders = vec![None];
        let source_file_names = vec![Some("foo.kmz".to_string())];
        let mut tracked_paths_by_integration = BTreeMap::new();
        tracked_paths_by_integration.insert(1, vec!["one/foo.gpx".to_string()]);
        tracked_paths_by_integration.insert(2, vec!["two/foo.gpx".to_string()]);

        let candidates = delete_relative_path_candidates(
            42,
            "foo",
            &target_folders,
            &source_file_names,
            tracked_paths_by_integration
                .get(&1)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );

        assert!(candidates.contains("one/foo.gpx"));
        assert!(!candidates.contains("two/foo.gpx"));
    }

    #[test]
    fn goi_source_snapshot_tracks_convertible_source_only() {
        let snapshot = goi_source_snapshot_for_remote_path(
            "sector/source.gpx",
            &[1, 2, 3],
            3,
            "source-sha",
        )
        .unwrap()
        .unwrap();

        assert_eq!(snapshot.file_name, "source.gpx");
        assert_eq!(snapshot.source_format, "gpx");
        assert_eq!(snapshot.file_data, vec![1, 2, 3]);
        assert_eq!(snapshot.file_size, 3);
        assert_eq!(snapshot.file_sha256, "source-sha");
        assert!(goi_source_snapshot_for_remote_path(
            "sector/direct.kmz",
            &[1, 2, 3],
            3,
            "kmz-sha",
        )
        .unwrap()
        .is_none());
    }

    #[serial]
    #[tokio::test]
    async fn convertible_goi_import_and_refresh_track_source_without_goi_upload(
    ) {
        let env = cleanup().await.unwrap();
        let integration = mk_goi_integration_for_test(
            &env.dbx,
            "goi-convertible-import-refresh-test",
        )
        .await;

        import_replacement_goi_palitra_file(
            env.as_ref(),
            &integration,
            "sector/source.gpx",
            vec![1, 2, 3],
            3,
            "imported-sha".to_string(),
        )
        .await
        .unwrap();

        let row = goi_palitra_sync::Entity::find()
            .filter(
                goi_palitra_sync::Column::GoiIntegrationId.eq(integration.id),
            )
            .filter(
                goi_palitra_sync::Column::RemoteRelativePath
                    .eq("sector/source.gpx"),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let palitra_id = row.palitra_id.unwrap();
        let palitra = palitra::Entity::find_by_id(palitra_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let job = palitra_conversion_job::Entity::find()
            .filter(palitra_conversion_job::Column::PalitraId.eq(palitra_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert!(palitra.imported_from_goi);
        assert_eq!(
            palitra.conversion_status,
            PALITRA_CONVERSION_STATUS_PROCESSING
        );
        assert_eq!(row.direction, PALITRA_GOI_SYNC_DIRECTION_GOI);
        assert_eq!(row.goi_source_file_name.as_deref(), Some("source.gpx"));
        assert_eq!(row.goi_source_format.as_deref(), Some("gpx"));
        assert_eq!(row.goi_source_file_data, Some(vec![1, 2, 3]));
        assert_eq!(row.goi_source_file_sha256.as_deref(), Some("imported-sha"));
        assert_eq!(job.status, PALITRA_CONVERSION_JOB_STATUS_PENDING);
        assert!(!job.should_schedule_goi_upload);

        refresh_convertible_goi_palitra_file(
            env.as_ref(),
            &integration,
            "sector/source.gpx",
            "source.gpx".to_string(),
            "gpx".to_string(),
            vec![4, 5, 6, 7],
            false,
            4,
            "refreshed-sha".to_string(),
            std::slice::from_ref(&row),
        )
        .await
        .unwrap();

        let refreshed_row = goi_palitra_sync::Entity::find_by_id(row.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let refreshed_job = palitra_conversion_job::Entity::find()
            .filter(palitra_conversion_job::Column::PalitraId.eq(palitra_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(refreshed_row.goi_source_file_data, Some(vec![4, 5, 6, 7]));
        assert_eq!(
            refreshed_row.goi_source_file_sha256.as_deref(),
            Some("refreshed-sha")
        );
        assert_eq!(refreshed_job.file_data, Some(vec![4, 5, 6, 7]));
        assert!(!refreshed_job.should_schedule_goi_upload);
    }

    #[serial]
    #[tokio::test]
    async fn goi_source_scheduling_failure_marks_palitra_error_and_keeps_source(
    ) {
        let env = cleanup().await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let integration = mk_goi_integration_for_test(
            &env.dbx,
            "goi-source-scheduling-failure-test",
        )
        .await;
        let goi_source = GoiSourceFileSnapshot {
            file_name: "source.gpx".to_string(),
            source_format: "gpx".to_string(),
            content_type: None,
            file_data: vec![9, 8, 7],
            file_size: 3,
            file_sha256: "failed-sha".to_string(),
        };

        record_goi_source_conversion_scheduling_failure(
            &env.dbx,
            integration.id,
            palitra.id,
            "sector/source.gpx",
            "gpx".to_string(),
            3,
            "failed-sha".to_string(),
            "simulated schedule error".to_string(),
            "Failed to schedule GOI source conversion: simulated schedule error"
                .to_string(),
            "Не вдалося поставити конвертацію файлу ГОІ в чергу.",
            goi_source,
        )
        .await
        .unwrap();

        let palitra = palitra::Entity::find_by_id(palitra.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let row = goi_palitra_sync::Entity::find()
            .filter(
                goi_palitra_sync::Column::GoiIntegrationId.eq(integration.id),
            )
            .filter(
                goi_palitra_sync::Column::RemoteRelativePath
                    .eq("sector/source.gpx"),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let entries =
            super::super::goi_changelog::entries_from_value(&row.changelog);
        let latest =
            super::super::goi_changelog::latest_entry(&entries).unwrap();

        assert_eq!(palitra.conversion_status, PALITRA_CONVERSION_STATUS_ERROR);
        assert_eq!(palitra.source_format.as_deref(), Some("gpx"));
        assert_eq!(
            palitra.conversion_error.as_deref(),
            Some("simulated schedule error")
        );
        assert!(!latest.is_ok);
        assert_eq!(
            latest.text,
            "Failed to schedule GOI source conversion: simulated schedule error"
        );
        assert_eq!(row.goi_source_file_data, Some(vec![9, 8, 7]));
        assert_eq!(row.goi_source_file_sha256.as_deref(), Some("failed-sha"));
    }

    fn checksum(file_size: i64, file_sha256: &str) -> FileChecksumRef<'_> {
        FileChecksumRef {
            file_size,
            file_sha256,
        }
    }

    #[test]
    fn checksum_sync_decision_uses_side_specific_checksums() {
        let cases = vec![
            (
                "no changes",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::Known(
                        checksum(3, "echo-a"),
                    ),
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(3, "goi-a"),
                },
                GoiPalitraSyncDecision::Noop,
            ),
            (
                "goi changed",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::Known(
                        checksum(3, "echo-a"),
                    ),
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(4, "goi-b"),
                },
                GoiPalitraSyncDecision::RefreshEcho,
            ),
            (
                "echo changed",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::Known(
                        checksum(4, "echo-b"),
                    ),
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(3, "goi-a"),
                },
                GoiPalitraSyncDecision::PushEcho,
            ),
            (
                "both changed",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::Known(
                        checksum(4, "echo-b"),
                    ),
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(4, "goi-b"),
                },
                GoiPalitraSyncDecision::Conflict(
                    GoiPalitraSyncConflict::EchoAndGoiChanged,
                ),
            ),
            (
                "missing stored echo checksum",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: None,
                    current_echo_checksum: CurrentEchoChecksum::Known(
                        checksum(3, "echo-a"),
                    ),
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(3, "goi-a"),
                },
                GoiPalitraSyncDecision::Conflict(
                    GoiPalitraSyncConflict::MissingEchoChecksumMetadata,
                ),
            ),
            (
                "missing echo palette",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::MissingPalette,
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(3, "goi-a"),
                },
                GoiPalitraSyncDecision::Conflict(
                    GoiPalitraSyncConflict::MissingEchoPalette,
                ),
            ),
            (
                "missing echo file",
                GoiPalitraSyncDecisionInput {
                    stored_echo_checksum: Some(checksum(3, "echo-a")),
                    current_echo_checksum: CurrentEchoChecksum::MissingFile,
                    stored_goi_checksum: Some(checksum(3, "goi-a")),
                    current_goi_checksum: checksum(3, "goi-a"),
                },
                GoiPalitraSyncDecision::Conflict(
                    GoiPalitraSyncConflict::MissingEchoFile,
                ),
            ),
        ];

        for (name, input, expected) in cases {
            assert_eq!(
                decide_goi_palitra_checksum_sync(input),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn checksum_sync_resolution_appends_ok_after_conflict() {
        let changelog = super::super::goi_changelog::append_to_value(
            &serde_json::json!([]),
            checksum_sync_conflict_entry(
                GoiPalitraSyncConflict::EchoAndGoiChanged,
            ),
        )
        .unwrap();

        let changelog = append_checksum_sync_resolution_if_needed(&changelog)
            .unwrap()
            .expect("resolution entry");
        let entries =
            super::super::goi_changelog::entries_from_value(&changelog);
        let latest = super::super::goi_changelog::latest_entry(&entries)
            .expect("latest");

        assert!(latest.is_ok);
        assert_eq!(latest.text, "GOI checksum sync conflict resolved");
    }

    #[test]
    fn goi_sync_success_resolution_appends_ok_after_warning() {
        let changelog = super::super::goi_changelog::append_to_value(
            &serde_json::json!([]),
            super::super::goi_changelog::error_entry(
                "Migrated GOI sync warning",
                "Попередня синхронізація ГОІ завершилась помилкою.",
            ),
        )
        .unwrap();

        let changelog =
            append_goi_sync_success_resolution_if_needed(&changelog)
                .unwrap()
                .expect("resolution entry");
        let entries =
            super::super::goi_changelog::entries_from_value(&changelog);
        let latest = super::super::goi_changelog::latest_entry(&entries)
            .expect("latest");

        assert!(latest.is_ok);
        assert_eq!(latest.text, "GOI palitra sync recovered");
    }

    #[test]
    fn tracked_goi_file_refresh_uses_goi_checksum_metadata() {
        let row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(10),
            Some(3),
            Some("abc"),
        );
        assert!(!tracked_goi_file_needs_refresh(
            std::slice::from_ref(&row),
            3,
            "abc"
        ));
        assert!(tracked_goi_file_needs_refresh(
            std::slice::from_ref(&row),
            4,
            "abc"
        ));
        assert!(tracked_goi_file_needs_refresh(
            std::slice::from_ref(&row),
            3,
            "def"
        ));

        let echo_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(11),
            Some(3),
            Some("abc"),
        );
        assert!(!tracked_goi_file_needs_refresh(&[echo_row], 4, "def"));
    }

    #[test]
    fn tracked_palitra_ids_include_echo_origin_rows_without_marking_them_goi_origin(
    ) {
        let echo_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(11),
            Some(3),
            Some("abc"),
        );
        let goi_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(10),
            Some(3),
            Some("abc"),
        );

        assert_eq!(
            tracked_palitra_ids(std::slice::from_ref(&echo_row)),
            vec![11]
        );
        assert!(tracked_goi_palitra_ids(&[echo_row]).is_empty());
        assert_eq!(tracked_goi_palitra_ids(&[goi_row]), vec![10]);
    }

    #[test]
    fn echo_origin_refresh_marks_palitra_as_imported_from_goi() {
        let echo_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(11),
            Some(3),
            Some("abc"),
        );
        let goi_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(10),
            Some(3),
            Some("abc"),
        );

        assert_eq!(
            imported_from_goi_update_for_refresh(&[echo_row]),
            Some(true)
        );
        assert_eq!(
            imported_from_goi_update_for_refresh(&[goi_row]),
            Some(true)
        );
    }

    #[serial]
    #[tokio::test]
    async fn echo_origin_push_echo_schedules_upload_job() {
        let env = cleanup().await.unwrap();
        let palitra = find_test_palitra(&env.dbx).await.unwrap();
        let integration = mk_goi_integration_for_test(
            &env.dbx,
            "echo-origin-push-echo-schedules-upload-test",
        )
        .await;
        let now = Utc::now().fixed_offset();
        let row = goi_palitra_sync::ActiveModel {
            goi_integration_id: Set(integration.id),
            palitra_id: Set(Some(palitra.id)),
            remote_relative_path: Set("foo.kmz".to_string()),
            direction: Set(PALITRA_GOI_SYNC_DIRECTION_ECHO.to_string()),
            remote_status: Set(PALITRA_GOI_REMOTE_STATUS_PRESENT.to_string()),
            file_size: Set(Some(3)),
            file_sha256: Set(Some("goi-a".to_string())),
            echo_file_size: Set(Some(3)),
            echo_file_sha256: Set(Some("echo-a".to_string())),
            echo_updated_at: Set(Some(now)),
            goi_file_size: Set(Some(3)),
            goi_file_sha256: Set(Some("goi-a".to_string())),
            goi_updated_at: Set(Some(now)),
            last_seen_at: Set(Some(now)),
            last_sync_at: Set(Some(now)),
            changelog: Set(serde_json::json!([])),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let file_data = vec![1, 2, 3, 4];

        update_echo_origin_goi_palitra_remote_metadata(
            &env.dbx,
            &[EchoOriginGoiSyncDecision {
                row,
                decision: GoiPalitraSyncDecision::PushEcho,
                current_echo_file_data: Some(file_data.clone()),
            }],
            3,
            "goi-a",
        )
        .await
        .unwrap();

        let job = palitra_goi_sync_job::Entity::find()
            .filter(palitra_goi_sync_job::Column::PalitraId.eq(palitra.id))
            .filter(
                palitra_goi_sync_job::Column::Kind
                    .eq(PALITRA_GOI_SYNC_JOB_KIND_UPLOAD),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(job.file_data, Some(file_data));
    }

    #[test]
    fn remote_path_tracking_classifies_duplicate_echo_origin_as_blocking_conflict(
    ) {
        let mut row_a = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(10),
            Some(3),
            Some("abc"),
        );
        row_a.id = 1;
        let mut row_b = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(11),
            Some(3),
            Some("abc"),
        );
        row_b.id = 2;

        assert_eq!(
            classify_goi_remote_path_tracking(&[row_a, row_b]),
            GoiRemotePathTrackingState::DuplicateRemotePathConflict
        );
    }

    #[test]
    fn remote_path_tracking_classifies_mixed_origin_duplicate_as_blocking_conflict(
    ) {
        let mut echo_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(10),
            Some(3),
            Some("abc"),
        );
        echo_row.id = 1;
        let mut goi_row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(11),
            Some(3),
            Some("abc"),
        );
        goi_row.id = 2;

        assert_eq!(
            classify_goi_remote_path_tracking(&[echo_row, goi_row]),
            GoiRemotePathTrackingState::DuplicateRemotePathConflict
        );
    }

    #[test]
    fn remote_path_tracking_classifies_duplicate_goi_origin_as_cleanup_needed()
    {
        let mut row_a = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(10),
            Some(3),
            Some("abc"),
        );
        row_a.id = 1;
        let mut row_b = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_GOI,
            Some(11),
            Some(3),
            Some("abc"),
        );
        row_b.id = 2;
        let rows = vec![row_a, row_b];

        assert_eq!(
            classify_goi_remote_path_tracking(&rows),
            GoiRemotePathTrackingState::GoiOriginDuplicateCleanupNeeded
        );
        assert!(tracked_goi_file_needs_refresh(&rows, 3, "abc"));
    }

    #[test]
    fn remote_path_tracking_uses_normal_state_for_single_echo_origin_mapping() {
        let row = goi_palitra_sync_row(
            PALITRA_GOI_SYNC_DIRECTION_ECHO,
            Some(10),
            Some(3),
            Some("abc"),
        );

        assert_eq!(
            classify_goi_remote_path_tracking(&[row]),
            GoiRemotePathTrackingState::Normal
        );
    }

    #[test]
    fn goi_echo_file_match_requires_same_checksum() {
        let goi_file = DownloadedGoiPalitraFile {
            data: b"abc".to_vec(),
            file_size: 3,
            file_sha256: sha256::digest(b"abc"),
        };
        assert!(goi_file_matches_echo_file_data(&goi_file, b"abc"));
        assert!(!goi_file_matches_echo_file_data(&goi_file, b"abd"));
        assert!(!goi_file_matches_echo_file_data(&goi_file, b"abcd"));
    }
}
