mod bl;
pub(crate) mod content;
mod cursor;
mod error;
mod ltree;
mod metadata;
mod path;
pub(in crate::devices) mod query;
pub(crate) mod sync;
#[cfg(test)]
mod tests;
mod validation;

pub(in crate::devices::files) use error::{
    map_database_error, map_transaction_body_error,
};
pub(in crate::devices) use error::{FilesystemError, FilesystemFieldError};
pub(in crate::devices) use metadata::normalize_file_metadata;
pub(in crate::devices) use path::parse as parse_source_path;
pub(in crate::devices) use types::{
    Breadcrumb, BrowseFilesCommand, BrowseFilesResult, DirectoryEntry,
    DirectoryScope, DomainFileEntryKind, DomainSourceFileStateKind,
    EntryQueryScope, EntrySortKey, FileEntry, FileJournalEntry,
    FileJournalSortKey, FileSearchFilters, JournalFilesCommand,
    JournalFilesResult, KeysetPage, KeysetPageRequest,
    NormalizedSourceFileState, PreparedFileMutation, RawFileSearchFilters,
    RootEntry, SearchEntry, SearchFilesCommand, SearchFilesResult,
    SubtreeFileCount, SubtreeFileCountsCommand, TreeEntry,
};
pub mod types;

use std::time::Instant;

use self::bl::{
    map_browse, map_journal, map_roots, map_search, map_subtree_counts,
};
use self::types::FileEntryKind as ApiFileEntryKind;
use self::types::{
    ApplyFileSyncBatchRsp, BrowseDeviceFilesReq, BrowseDeviceFilesRsp,
    CompleteFileSyncSessionReq, CountDeviceFileSubtreesReq,
    CountDeviceFileSubtreesRsp, FileSyncSessionItemsRsp, FileSyncSessionRsp,
    JournalDeviceFilesReq, JournalDeviceFilesRsp, ListDeviceFileRootsReq,
    ListDeviceFileRootsRsp, RawApplyFileSyncBatchReq, RawSyncDeviceFilesReq,
    SearchDeviceFilesReq, SearchDeviceFilesRsp, StartFileSyncSessionReq,
    SyncDeviceFilesRsp,
};
use crate::devices::access;
use crate::devices::types::{parse_datetime, parse_uuid};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::web::{Data, Json, Path, Query};
use actix_web::{post, HttpResponse};

#[post("/api/device/files/roots")]
pub(crate) async fn roots(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<ListDeviceFileRootsReq>,
) -> Result<Json<ListDeviceFileRootsRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let roots = bl::list_roots(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        parse_uuid(&body.device_id),
    )
    .await
    .c(h!())?;
    Ok(Json(map_roots(roots)))
}
#[post("/api/device/files/subtree-counts")]
pub(crate) async fn subtree_counts(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<CountDeviceFileSubtreesReq>,
) -> Result<Json<CountDeviceFileSubtreesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let counts = bl::count_subtrees(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        SubtreeFileCountsCommand {
            device_id: parse_uuid(&body.device_id),
            parent_entry_id: body.parent_entry_id.as_deref().map(parse_uuid),
            directory_entry_ids: body
                .directory_entry_ids
                .iter()
                .map(|entry_id| parse_uuid(entry_id))
                .collect(),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(map_subtree_counts(counts)))
}

#[post("/api/device/files/browse")]
pub(crate) async fn browse(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<BrowseDeviceFilesReq>,
) -> Result<Json<BrowseDeviceFilesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::browse(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        BrowseFilesCommand {
            device_id: parse_uuid(&body.device_id),
            parent_entry_id: parse_uuid(&body.parent_entry_id),
            include_breadcrumbs: body.include_breadcrumbs.unwrap_or(true),
            limit: body.limit,
            cursor: body.cursor,
            tag_ids: body.tag_ids.unwrap_or_default(),
            tag_match: body.tag_match,
            untagged: body.untagged.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(map_browse(result).c(h!())?))
}

#[post("/api/device/files/search")]
pub(crate) async fn search(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<SearchDeviceFilesReq>,
) -> Result<Json<SearchDeviceFilesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::search(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        SearchFilesCommand {
            device_id: parse_uuid(&body.device_id),
            scope_entry_id: parse_uuid(&body.scope_entry_id),
            filters: RawFileSearchFilters {
                kinds: body
                    .kinds
                    .unwrap_or_default()
                    .into_iter()
                    .map(map_entry_kind)
                    .collect(),
                name_query: body.name_query,
                mime_types: body.mime_types.unwrap_or_default(),
                extensions: body.extensions.unwrap_or_default(),
                file_metadata_modified_from: body
                    .file_metadata_modified_from
                    .as_deref()
                    .map(parse_datetime),
                file_metadata_modified_to: body
                    .file_metadata_modified_to
                    .as_deref()
                    .map(parse_datetime),
            },
            limit: body.limit,
            cursor: body.cursor,
            tag_ids: body.tag_ids.unwrap_or_default(),
            tag_match: body.tag_match,
            untagged: body.untagged.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(map_search(result)))
}

#[post("/api/device/files/journal")]
pub(crate) async fn journal(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<JournalDeviceFilesReq>,
) -> Result<Json<JournalDeviceFilesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::journal(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        JournalFilesCommand {
            device_id: parse_uuid(&body.device_id),
            limit: body.limit,
            cursor: body.cursor,
            tag_ids: body.tag_ids.unwrap_or_default(),
            tag_match: body.tag_match,
            untagged: body.untagged.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(map_journal(result)))
}

#[post("/api/device/files/sync")]
pub(crate) async fn sync_files(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<RawSyncDeviceFilesReq>,
) -> Result<Json<SyncDeviceFilesRsp>, AppError> {
    let started_at = Instant::now();
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = sync::automatic_with_metrics(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        parse_uuid(&body.device_id),
        body.files,
        env.metrics.as_ref(),
    )
    .await
    .c(h!())?;
    if let Some(metrics) = &env.metrics {
        metrics.record_device_files_sync(
            result.sync.counts.created,
            result.sync.counts.updated,
            started_at.elapsed(),
        );
    }
    Ok(Json(result))
}

#[post("/api/device/files/sync-session")]
pub(crate) async fn start_sync_session(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<StartFileSyncSessionReq>,
) -> Result<HttpResponse, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = sync::start_explicit(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        parse_uuid(&body.device_id),
    )
    .await
    .c(h!())?;
    if result.created {
        Ok(HttpResponse::Created().json(result.response))
    } else {
        Ok(HttpResponse::Ok().json(result.response))
    }
}

#[post("/api/device/files/sync-session/{sync_id}")]
pub(crate) async fn sync_session_status(
    env: Data<Env>,
    user: Identity,
    sync_id: Path<uuid::Uuid>,
) -> Result<Json<FileSyncSessionRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(
        sync::status(
            &env.dbx,
            env.file_registry_db()?,
            &login,
            sync_id.into_inner(),
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/device/files/sync-session/{sync_id}/batches/{batch_index}")]
pub(crate) async fn apply_sync_batch(
    env: Data<Env>,
    user: Identity,
    path: Path<(uuid::Uuid, i32)>,
    Json(body): Json<RawApplyFileSyncBatchReq>,
) -> Result<Json<ApplyFileSyncBatchRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let (sync_id, batch_index) = path.into_inner();
    if batch_index < 0 {
        return Err(AppError::Form(std::collections::BTreeMap::from([(
            "batch_index".to_string(),
            "must be non-negative".to_string(),
        )])));
    }
    Ok(Json(
        sync::apply_batch_with_metrics(
            &env.dbx,
            env.file_registry_db()?,
            &login,
            sync_id,
            batch_index,
            body.files,
            env.metrics.as_ref(),
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/device/files/sync-session/{sync_id}/complete")]
pub(crate) async fn complete_sync_session(
    env: Data<Env>,
    user: Identity,
    sync_id: Path<uuid::Uuid>,
    Json(body): Json<CompleteFileSyncSessionReq>,
) -> Result<Json<FileSyncSessionRsp>, AppError> {
    let expected_batch_count = i32::try_from(body.expected_batch_count)
        .map_err(|_| {
            AppError::Form(std::collections::BTreeMap::from([(
                "expected_batch_count".to_string(),
                "must be at most 2147483647".to_string(),
            )]))
        })?;
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let response = sync::complete(
        &env.dbx,
        env.file_registry_db()?,
        &login,
        sync_id.into_inner(),
        expected_batch_count,
    )
    .await
    .c(h!())?;
    Ok(Json(response))
}

#[derive(serde::Deserialize)]
pub(crate) struct SyncItemsQuery {
    outcome: Option<String>,
    limit: Option<u64>,
    cursor: Option<String>,
}

#[post("/api/device/files/sync-session/{sync_id}/items")]
pub(crate) async fn sync_session_items(
    env: Data<Env>,
    user: Identity,
    sync_id: Path<uuid::Uuid>,
    Query(query): Query<SyncItemsQuery>,
) -> Result<Json<FileSyncSessionItemsRsp>, AppError> {
    let outcome = match query.outcome.as_deref() {
        None => None,
        Some("created") => Some(crate::file_registry::entities::sea_orm_active_enums::FileSyncItemOutcome::Created),
        Some("updated") => Some(crate::file_registry::entities::sea_orm_active_enums::FileSyncItemOutcome::Updated),
        Some("rejected") => Some(crate::file_registry::entities::sea_orm_active_enums::FileSyncItemOutcome::Rejected),
        Some(_) => {
            return Err(AppError::Form(std::collections::BTreeMap::from([(
                "outcome".to_string(),
                "must be one of created, updated, rejected".to_string(),
            )])));
        }
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(
        sync::items(
            &env.dbx,
            env.file_registry_db()?,
            &login,
            sync_id.into_inner(),
            outcome,
            query.limit,
            query.cursor.as_deref(),
        )
        .await
        .c(h!())?,
    ))
}

fn map_entry_kind(kind: ApiFileEntryKind) -> DomainFileEntryKind {
    match kind {
        ApiFileEntryKind::Directory => DomainFileEntryKind::Directory,
        ApiFileEntryKind::File => DomainFileEntryKind::File,
    }
}
