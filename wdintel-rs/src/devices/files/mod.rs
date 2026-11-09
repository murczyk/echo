pub(crate) mod archive;
mod bl;
pub(crate) mod content;
mod cursor;
mod error;
pub mod listing_filters;
mod ltree;
pub(crate) mod markers;
mod metadata;
mod path;
pub(crate) mod preview;
pub(in crate::devices) mod query;
pub(crate) mod sessions;
mod sorting;
pub(crate) mod stats;
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
pub(crate) mod locate;
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
    RebuildDeviceStatsReq, RebuildDeviceStatsRsp, SearchDeviceFilesReq,
    SearchDeviceFilesRsp, StartFileSyncSessionReq, SyncDeviceFilesRsp,
};
use crate::devices::access;
use crate::devices::devices::query::{
    authorize_file_registry_access, FileRegistryDeviceAccess,
};
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
    let listing_filters = body.filters.clone();
    let device_id = parse_uuid(&body.device_id);
    let sync_id = body.sync_id.as_deref().map(parse_uuid);
    let mut response = if body.sync_id.is_some() {
        sessions::read::roots(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            &login,
            body,
        )
        .await
        .c(h!())?
    } else {
        map_roots(
            bl::list_roots(
                &env.dbx,
                env.file_registry_db().c(h!())?,
                &login,
                parse_uuid(&body.device_id),
            )
            .await
            .c(h!())?,
        )
    };
    markers::hydrate_roots(&env, &mut response.roots)
        .await
        .c(h!())?;
    if let Some(filters) = &listing_filters {
        let ids = response
            .roots
            .iter()
            .map(|root| parse_uuid(&root.entry_id))
            .collect();
        let matched = listing_filters::matching_ids(
            &env,
            login.id,
            listing_filters::ListingFilterScope {
                device: device_id,
                sync: sync_id,
                archive: None,
            },
            ids,
            filters,
            true,
        )
        .await
        .c(h!())?;
        response
            .roots
            .retain(|root| matched.contains(&root.entry_id));
    }
    Ok(Json(response))
}

#[post("/api/device/files/filter-options")]
pub(crate) async fn filter_options(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<ListDeviceFileRootsReq>,
) -> Result<Json<listing_filters::DeviceFileFilterOptions>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = parse_uuid(&body.device_id);
    authorize_file_registry_access(
        &env.dbx,
        &login,
        device,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let sync = body.sync_id.as_deref().map(parse_uuid);
    if let Some(sync) = sync {
        sessions::authorize(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            &login,
            device,
            sync,
        )
        .await
        .c(h!())?;
    }
    Ok(Json(
        listing_filters::options(&env, device, sync).await.c(h!())?,
    ))
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
    if body.sync_id.is_some() {
        return Ok(Json(
            sessions::read::counts(
                &env.dbx,
                env.file_registry_db().c(h!())?,
                &login,
                body,
            )
            .await
            .c(h!())?,
        ));
    }
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

#[post("/api/device/stats/rebuild")]
pub(crate) async fn rebuild_stats(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<RebuildDeviceStatsReq>,
) -> Result<Json<RebuildDeviceStatsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device_id = authorize_file_registry_access(
        &env.dbx,
        &login,
        parse_uuid(&body.device_id),
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let rebuilt =
        stats::rebuild(env.file_registry_db().c(h!())?.connection(), device_id)
            .await
            .c(h!())?;
    Ok(Json(RebuildDeviceStatsRsp {
        directory_count: rebuilt.directory_count,
        file_count: rebuilt.file_count,
        content_count: rebuilt.content_count,
        content_bytes: rebuilt.content_bytes,
        batch_count: rebuilt.batch_count,
    }))
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
    Ok(Json(browse_marked(&env, &login, body).await.c(h!())?))
}

async fn browse_marked(
    env: &Env,
    login: &crate::entities::login::Model,
    mut body: BrowseDeviceFilesReq,
) -> Result<BrowseDeviceFilesRsp, AppError> {
    let filters = markers::Filters {
        has_content: if body.filters.is_none() {
            body.has_content
        } else {
            None
        },
        favorites_only: body.filters.is_none()
            && body.favorites_only.unwrap_or(false),
        unviewed_only: body.filters.is_none()
            && body.unviewed_only.unwrap_or(false),
        archive_failed: body.filters.is_none()
            && body.archive_failed.unwrap_or(false),
        archive_encrypted: body.filters.is_none()
            && body.archive_encrypted.unwrap_or(false),
    };
    let limit = body
        .limit
        .unwrap_or(crate::devices::config::DEVICE_FILE_PAGE_DEFAULT_LIMIT);
    let mut response = browse_page(env, login, body.clone()).await.c(h!())?;
    markers::filter_entries(
        env,
        login.id,
        &mut response.entries,
        filters,
        true,
    )
    .await
    .c(h!())?;
    filter_browse_listing(env, login.id, &body, &mut response)
        .await
        .c(h!())?;
    let mut pages = 1;
    while (filters.active() || body.filters.is_some())
        && pages < crate::devices::config::DEVICE_FILE_MARKER_SCAN_MAX_PAGES
        && response.entries.len() < limit as usize
        && response.next_cursor.is_some()
    {
        pages += 1;
        body.cursor = response.next_cursor.take();
        body.limit = Some(limit - response.entries.len() as u64);
        let mut page = browse_page(env, login, body.clone()).await.c(h!())?;
        markers::filter_entries(
            env,
            login.id,
            &mut page.entries,
            filters,
            true,
        )
        .await
        .c(h!())?;
        filter_browse_listing(env, login.id, &body, &mut page)
            .await
            .c(h!())?;
        response.entries.extend(page.entries);
        response.next_cursor = page.next_cursor;
    }
    Ok(response)
}

async fn browse_page(
    env: &Env,
    login: &crate::entities::login::Model,
    mut body: BrowseDeviceFilesReq,
) -> Result<BrowseDeviceFilesRsp, AppError> {
    if body.filters.is_some() {
        body.has_content = None;
        body.tag_ids = None;
        body.tag_match = None;
        body.untagged = None;
    }
    let device_id = parse_uuid(&body.device_id);
    if let Some(response) = archive::tree::browse(
        &env.dbx,
        env.file_registry_db().c(h!())?,
        login,
        &body,
    )
    .await
    .c(h!())?
    {
        return Ok(response);
    }
    if body.sync_id.is_some() {
        let mut response = sessions::read::browse(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            login,
            body,
        )
        .await
        .c(h!())?;
        archive::hydrate::tree(
            env.file_registry_db().c(h!())?.connection(),
            device_id,
            &mut response.entries,
        )
        .await
        .c(h!())?;
        return Ok(response);
    }
    let sort = sorting::FileListingSort::new(body.sort_by, body.sort_direction);
    let cursor_scope =
        sessions::read::browse_scope_key("sorted-browse", &body).c(h!())?;
    let cursor = sort
        .decode_cursor(body.cursor.clone(), &cursor_scope)
        .c(h!())?;
    let command = BrowseFilesCommand {
        device_id: parse_uuid(&body.device_id),
        parent_entry_id: parse_uuid(&body.parent_entry_id),
        include_breadcrumbs: body.include_breadcrumbs.unwrap_or(true),
        limit: body.limit,
        cursor,
        tag_ids: body.tag_ids.unwrap_or_default(),
        tag_match: body.tag_match,
        untagged: body.untagged.unwrap_or(false),
        has_content: body.has_content,
    };
    let files = env.file_registry_db().c(h!())?;
    let result = if sort == Default::default() {
        bl::browse(&env.dbx, files, login, command).await
    } else {
        bl::browse_sorted(&env.dbx, files, login, command, sort).await
    }
    .c(h!())?;

    let mut response = map_browse(result).c(h!())?;
    sort.encode_cursor(&mut response.next_cursor, &cursor_scope)
        .c(h!())?;
    archive::hydrate::tree(
        env.file_registry_db().c(h!())?.connection(),
        device_id,
        &mut response.entries,
    )
    .await
    .c(h!())?;
    Ok(response)
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
    Ok(Json(search_marked(&env, &login, body).await.c(h!())?))
}

pub(super) async fn search_marked(
    env: &Env,
    login: &crate::entities::login::Model,
    mut body: SearchDeviceFilesReq,
) -> Result<SearchDeviceFilesRsp, AppError> {
    if body.filters.is_some() {
        body.tag_ids = None;
        body.tag_match = None;
        body.untagged = None;
    }
    let snapshot = archive::tree::search_snapshot(
        &env.dbx,
        env.file_registry_db().c(h!())?,
        login,
        &body,
    )
    .await
    .c(h!())?;
    let archive_source = snapshot.as_ref().map(|snapshot| {
        archive::types::DeviceFileContentRef {
            device_id: snapshot.device,
            file_id: snapshot.job.source_file_id,
            revision: snapshot.job.source_revision,
        }
    });
    let filters = markers::Filters {
        has_content: if body.filters.is_none() {
            body.has_content
        } else {
            None
        },
        favorites_only: body.filters.is_none()
            && body.favorites_only.unwrap_or(false),
        unviewed_only: body.filters.is_none()
            && body.unviewed_only.unwrap_or(false),
        archive_failed: body.filters.is_none()
            && body.archive_failed.unwrap_or(false),
        archive_encrypted: body.filters.is_none()
            && body.archive_encrypted.unwrap_or(false),
    };
    let limit = body
        .limit
        .unwrap_or(crate::devices::config::DEVICE_FILE_PAGE_DEFAULT_LIMIT);
    let mut response = search_page(env, login, body.clone(), snapshot.as_ref())
        .await
        .c(h!())?;
    markers::filter_entries(
        env,
        login.id,
        &mut response.entries,
        filters,
        false,
    )
    .await
    .c(h!())?;
    filter_search_listing(
        env,
        login.id,
        &body,
        archive_source.as_ref(),
        &mut response.entries,
    )
    .await
    .c(h!())?;
    let mut pages = 1;
    while (filters.active() || body.filters.is_some())
        && pages < crate::devices::config::DEVICE_FILE_MARKER_SCAN_MAX_PAGES
        && response.entries.len() < limit as usize
        && response.next_cursor.is_some()
    {
        pages += 1;
        body.cursor = response.next_cursor.take();
        body.limit = Some(limit - response.entries.len() as u64);
        let mut page = search_page(env, login, body.clone(), snapshot.as_ref())
            .await
            .c(h!())?;
        markers::filter_entries(
            env,
            login.id,
            &mut page.entries,
            filters,
            false,
        )
        .await
        .c(h!())?;
        filter_search_listing(
            env,
            login.id,
            &body,
            archive_source.as_ref(),
            &mut page.entries,
        )
        .await
        .c(h!())?;
        response.entries.extend(page.entries);
        response.next_cursor = page.next_cursor;
    }
    Ok(response)
}

async fn search_page(
    env: &Env,
    login: &crate::entities::login::Model,
    body: SearchDeviceFilesReq,
    snapshot: Option<&archive::tree::Snapshot>,
) -> Result<SearchDeviceFilesRsp, AppError> {
    if let Some(snapshot) = snapshot {
        return Ok(archive::search::search(
            env.file_registry_db().c(h!())?,
            snapshot,
            body,
        )
        .await
        .c(h!())?);
    }
    let device_id = parse_uuid(&body.device_id);
    if body.sync_id.is_some() {
        let mut response = sessions::read::search(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            login,
            body,
        )
        .await
        .c(h!())?;
        archive::hydrate::tree(
            env.file_registry_db().c(h!())?.connection(),
            device_id,
            &mut response.entries,
        )
        .await
        .c(h!())?;
        return Ok(response);
    }
    let sort = sorting::FileListingSort::new(body.sort_by, body.sort_direction);
    let cursor_scope =
        sessions::read::scope_key("sorted-search", &body).c(h!())?;
    let search_mode = body.global_search.unwrap_or(false)
        || body.rank_by_relevance.unwrap_or(false);
    let cursor = if search_mode {
        body.cursor
            .as_deref()
            .map(|value| {
                sessions::cursor::decode(value, &cursor_scope)
                    .map(cursor::encode)
            })
            .transpose()
            .c(h!())?
    } else {
        sort.decode_cursor(body.cursor.clone(), &cursor_scope)
            .c(h!())?
    };
    let command = SearchFilesCommand {
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
        cursor,
        tag_ids: body.tag_ids.unwrap_or_default(),
        tag_match: body.tag_match,
        untagged: body.untagged.unwrap_or(false),
    };
    let files = env.file_registry_db().c(h!())?;
    let result = if search_mode {
        bl::search_with_options(
            &env.dbx,
            files,
            login,
            command,
            sort,
            body.global_search.unwrap_or(false),
            body.rank_by_relevance.unwrap_or(false),
        )
        .await
    } else if sort == Default::default() {
        bl::search(&env.dbx, files, login, command).await
    } else {
        bl::search_sorted(&env.dbx, files, login, command, sort).await
    }
    .c(h!())?;

    let mut response = map_search(result);
    if search_mode {
        if let Some(value) = response.next_cursor.take() {
            let boundary =
                cursor::decode(&value).map_err(bl::map_read_error).c(h!())?;
            response.next_cursor = Some(
                sessions::cursor::encode(&cursor_scope, boundary).c(h!())?,
            );
        }
    } else {
        sort.encode_cursor(&mut response.next_cursor, &cursor_scope)
            .c(h!())?;
    }
    archive::hydrate::tree(
        env.file_registry_db().c(h!())?.connection(),
        device_id,
        &mut response.entries,
    )
    .await
    .c(h!())?;
    Ok(response)
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
    let device_id = parse_uuid(&body.device_id);
    if body.sync_id.is_some() {
        let mut response = sessions::read::journal(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            &login,
            body,
        )
        .await
        .c(h!())?;
        archive::hydrate::journal(
            env.file_registry_db().c(h!())?.connection(),
            device_id,
            &mut response.entries,
        )
        .await
        .c(h!())?;
        return Ok(Json(response));
    }
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
    let mut response = map_journal(result);
    archive::hydrate::journal(
        env.file_registry_db().c(h!())?.connection(),
        device_id,
        &mut response.entries,
    )
    .await
    .c(h!())?;
    Ok(Json(response))
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

async fn filter_browse_listing(
    env: &Env,
    login: uuid::Uuid,
    body: &BrowseDeviceFilesReq,
    response: &mut BrowseDeviceFilesRsp,
) -> anyhow::Result<()> {
    let scope = listing_filters::ListingFilterScope {
        device: parse_uuid(&body.device_id),
        sync: body.sync_id.as_deref().map(parse_uuid),
        archive: response.archive_source.as_ref(),
    };
    filter_listing(
        env,
        login,
        scope,
        &mut response.entries,
        body.filters.as_ref(),
        true,
    )
    .await
    .c(h!())
}

async fn filter_search_listing(
    env: &Env,
    login: uuid::Uuid,
    body: &SearchDeviceFilesReq,
    archive: Option<&archive::types::DeviceFileContentRef>,
    entries: &mut Vec<types::DeviceFileTreeEntry>,
) -> anyhow::Result<()> {
    let scope = listing_filters::ListingFilterScope {
        device: parse_uuid(&body.device_id),
        sync: body.sync_id.as_deref().map(parse_uuid),
        archive,
    };
    filter_listing(env, login, scope, entries, body.filters.as_ref(), true)
        .await
        .c(h!())
}

async fn filter_listing(
    env: &Env,
    login: uuid::Uuid,
    scope: listing_filters::ListingFilterScope<'_>,
    entries: &mut Vec<types::DeviceFileTreeEntry>,
    filters: Option<&listing_filters::DeviceFileFilters>,
    ancestors: bool,
) -> anyhow::Result<()> {
    let Some(filters) = filters else {
        return Ok(());
    };
    let ids = entries
        .iter()
        .map(|entry| parse_uuid(&entry.entry_id))
        .collect();
    let matched = listing_filters::matching_ids(
        env, login, scope, ids, filters, ancestors,
    )
    .await
    .c(h!())?;
    entries.retain(|entry| matched.contains(&entry.entry_id));
    Ok(())
}
