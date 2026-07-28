use super::mapping::{
    map_browse, map_journal, map_roots, map_search, map_sync,
};
use super::request::DeviceApiJson;
use super::types::{
    parse_datetime, parse_uuid, BrowseDeviceFilesReq, BrowseDeviceFilesRsp,
    FileEntryKind, JournalDeviceFilesReq, JournalDeviceFilesRsp,
    ListDeviceFileRootsReq, ListDeviceFileRootsRsp, PathSyntax, RequiredPatch,
    SearchDeviceFilesReq, SearchDeviceFilesRsp, SyncDeviceFilesReq,
    SyncDeviceFilesRsp,
};
use crate::devices::filesystem::{
    BrowseFilesCommand, FileEntryKind as DomainFileEntryKind,
    FileMetadataService, JournalFilesCommand, PathSyntax as DomainPathSyntax,
    RawFileSearchFilters, SearchFilesCommand, SyncFileItemCommand,
    SyncFilesCommand,
};
use crate::devices::main_db::MainDb;
use crate::error::AppError;
use actix_web::post;
use actix_web::web::Json;

#[post("/api/device/files/roots")]
pub(in crate::devices) async fn roots(
    api: DeviceApiJson<ListDeviceFileRootsReq>,
) -> Result<Json<ListDeviceFileRootsRsp>, AppError> {
    let DeviceApiJson { actor, env, body } = api;
    let roots = FileMetadataService::list_roots(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        parse_uuid(&body.device_id),
    )
    .await?;
    Ok(Json(map_roots(roots)))
}

#[post("/api/device/files/browse")]
pub(in crate::devices) async fn browse(
    api: DeviceApiJson<BrowseDeviceFilesReq>,
) -> Result<Json<BrowseDeviceFilesRsp>, AppError> {
    let DeviceApiJson { actor, env, body } = api;
    let result = FileMetadataService::browse(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        BrowseFilesCommand {
            device_id: parse_uuid(&body.device_id),
            parent_entry_id: parse_uuid(&body.parent_entry_id),
            include_breadcrumbs: body.include_breadcrumbs.unwrap_or(true),
            limit: body.limit,
            cursor: body.cursor,
        },
    )
    .await?;
    Ok(Json(map_browse(result)?))
}

#[post("/api/device/files/search")]
pub(in crate::devices) async fn search(
    api: DeviceApiJson<SearchDeviceFilesReq>,
) -> Result<Json<SearchDeviceFilesRsp>, AppError> {
    let DeviceApiJson { actor, env, body } = api;
    let result = FileMetadataService::search(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
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
    .await?;
    Ok(Json(map_search(result)))
}

#[post("/api/device/files/journal")]
pub(in crate::devices) async fn journal(
    api: DeviceApiJson<JournalDeviceFilesReq>,
) -> Result<Json<JournalDeviceFilesRsp>, AppError> {
    let DeviceApiJson { actor, env, body } = api;
    let result = FileMetadataService::journal(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        JournalFilesCommand {
            device_id: parse_uuid(&body.device_id),
            limit: body.limit,
            cursor: body.cursor,
        },
    )
    .await?;
    Ok(Json(map_journal(result)))
}

#[post("/api/device/files/sync")]
pub(in crate::devices) async fn sync(
    api: DeviceApiJson<SyncDeviceFilesReq>,
) -> Result<Json<SyncDeviceFilesRsp>, AppError> {
    let DeviceApiJson { actor, env, body } = api;
    let result = FileMetadataService::sync(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
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
    .await?;
    Ok(Json(map_sync(result)))
}

fn map_entry_kind(kind: FileEntryKind) -> DomainFileEntryKind {
    match kind {
        FileEntryKind::Directory => DomainFileEntryKind::Directory,
        FileEntryKind::File => DomainFileEntryKind::File,
    }
}

fn map_path_syntax(path_syntax: PathSyntax) -> DomainPathSyntax {
    match path_syntax {
        PathSyntax::Posix => DomainPathSyntax::Posix,
        PathSyntax::Windows => DomainPathSyntax::Windows,
    }
}
