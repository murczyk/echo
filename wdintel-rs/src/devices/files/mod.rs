mod bl;
mod cursor;
mod error;
mod ltree;
mod metadata;
mod path;
pub(in crate::devices) mod query;
mod sync_pipeline;
#[cfg(test)]
mod tests;
mod validation;

pub(in crate::devices::files) use error::{
    classify_transaction_error, map_database_error, map_transaction_body_error,
    FilesystemError, FilesystemFieldError, TransactionErrorClass,
};
pub(in crate::devices) use metadata::normalize_file_metadata;
pub(in crate::devices) use types::{
    Breadcrumb, BrowseFilesCommand, BrowseFilesResult, DirectoryEntry,
    DirectoryScope, DomainFileEntryKind, DomainPathSyntax, EntryQueryScope,
    EntrySortKey, FileEntry, FileJournalEntry, FileJournalSortKey,
    FileMutationResult, FileSearchFilters, JournalFilesCommand,
    JournalFilesResult, KeysetPage, KeysetPageRequest, PreparedFileMutation,
    RawFileSearchFilters, RootEntry, SearchEntry, SearchFilesCommand,
    SearchFilesResult, SubtreeFileCount, SubtreeFileCountsCommand,
    SyncFileItemCommand, SyncFileItemOutcome, SyncFileItemResult,
    SyncFileOperation, SyncFileRejectionKind, SyncFilesCommand,
    SyncFilesResult, TreeEntry,
};
pub mod types;

use std::time::Instant;

use self::bl::{
    map_browse, map_journal, map_roots, map_search, map_subtree_counts,
    map_sync,
};
use self::types::{
    BrowseDeviceFilesReq, BrowseDeviceFilesRsp, CountDeviceFileSubtreesReq,
    CountDeviceFileSubtreesRsp, JournalDeviceFilesReq, JournalDeviceFilesRsp,
    ListDeviceFileRootsReq, ListDeviceFileRootsRsp, SearchDeviceFilesReq,
    SearchDeviceFilesRsp, SyncDeviceFilesReq, SyncDeviceFilesRsp,
};
use self::types::{
    FileEntryKind as ApiFileEntryKind, PathSyntax as ApiPathSyntax,
};
use crate::devices::access;
use crate::devices::types::{parse_datetime, parse_uuid, RequiredPatch};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};

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
        &env.file_registry_db,
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
        &env.file_registry_db,
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
        &env.file_registry_db,
        &login,
        BrowseFilesCommand {
            device_id: parse_uuid(&body.device_id),
            parent_entry_id: parse_uuid(&body.parent_entry_id),
            include_breadcrumbs: body.include_breadcrumbs.unwrap_or(true),
            limit: body.limit,
            cursor: body.cursor,
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
        &env.file_registry_db,
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
        &env.file_registry_db,
        &login,
        JournalFilesCommand {
            device_id: parse_uuid(&body.device_id),
            limit: body.limit,
            cursor: body.cursor,
        },
    )
    .await
    .c(h!())?;
    Ok(Json(map_journal(result)))
}

#[post("/api/device/files/sync")]
pub(crate) async fn sync(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<SyncDeviceFilesReq>,
) -> Result<Json<SyncDeviceFilesRsp>, AppError> {
    let started_at = Instant::now();
    let result = sync_files(&env, &user, body).await.c(h!())?;
    let (created, updated) = synchronized_file_counts(&result);
    if let Some(metrics) = &env.metrics {
        metrics.record_device_files_sync(
            created,
            updated,
            started_at.elapsed(),
        );
    }
    Ok(Json(map_sync(result)))
}

async fn sync_files(
    env: &Env,
    user: &Identity,
    body: SyncDeviceFilesReq,
) -> Result<SyncFilesResult, AppError> {
    let login = access::resolve_current_login(&env.dbx, user)
        .await
        .c(h!())?;
    bl::sync(
        &env.dbx,
        &env.file_registry_db,
        &login,
        SyncFilesCommand {
            device_id: parse_uuid(&body.device_id),
            path_syntax: map_path_syntax(body.path_syntax),
            files: body
                .files
                .into_iter()
                .map(|file| SyncFileItemCommand {
                    file_id: match file.file_id {
                        RequiredPatch::Missing => None,
                        RequiredPatch::Value(file_id) => {
                            Some(parse_uuid(&file_id))
                        }
                    },
                    absolute_path: file.absolute_path,
                    mime_type: file.mime_type,
                    extension: file.extension,
                    file_metadata_created_at: file.file_metadata_created_at,
                    file_metadata_modified_at: file.file_metadata_modified_at,
                })
                .collect(),
        },
    )
    .await
}

fn synchronized_file_counts(result: &SyncFilesResult) -> (u64, u64) {
    result
        .results
        .iter()
        .fold((0, 0), |(created, updated), result| match &result.outcome {
            SyncFileItemOutcome::Accepted { operation, .. } => {
                match operation {
                    SyncFileOperation::Created => (created + 1, updated),
                    SyncFileOperation::Updated => (created, updated + 1),
                }
            }
            SyncFileItemOutcome::Rejected { .. } => (created, updated),
        })
}

fn map_entry_kind(kind: ApiFileEntryKind) -> DomainFileEntryKind {
    match kind {
        ApiFileEntryKind::Directory => DomainFileEntryKind::Directory,
        ApiFileEntryKind::File => DomainFileEntryKind::File,
    }
}

fn map_path_syntax(path_syntax: ApiPathSyntax) -> DomainPathSyntax {
    match path_syntax {
        ApiPathSyntax::Posix => DomainPathSyntax::Posix,
        ApiPathSyntax::Windows => DomainPathSyntax::Windows,
    }
}
