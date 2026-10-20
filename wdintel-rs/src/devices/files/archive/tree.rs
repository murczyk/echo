use super::super::sessions::cursor;
use crate::{
    devices::{
        devices::query::{
            authorize_file_registry_access, FileRegistryDeviceAccess,
        },
        files::{bl, query, types::*},
    },
    entities::login,
    error::AppError,
    file_registry::{
        entities::{file_archive, file_entry},
        FileRegistryDb,
    },
    h,
    types::ShortContext,
};
use anyhow::Result;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait,
    FromQueryResult, QueryFilter, Statement,
};
use uuid::Uuid;

pub(in crate::devices::files) async fn browse(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: &BrowseDeviceFilesReq,
) -> Result<Option<BrowseDeviceFilesRsp>, AppError> {
    let Some(snapshot) = resolve_context(main, files, login, body).await?
    else {
        return Ok(None);
    };
    let Snapshot { device, entry, job } = snapshot;
    let parent = entry.id;
    let db = files.connection();
    let limit = body
        .limit
        .unwrap_or(crate::devices::config::DEVICE_FILE_PAGE_DEFAULT_LIMIT);
    if limit == 0 || limit > crate::devices::config::DEVICE_FILE_PAGE_MAX_LIMIT
    {
        return Err(AppError::BadRequestJson {
            body: serde_json::json!({"code":"invalid_request"}),
        });
    }
    let mut scope = serde_json::to_value(body).c(h!())?;
    scope.as_object_mut().c(h!())?.remove("cursor");
    scope.as_object_mut().c(h!())?.remove("limit");
    let scope =
        format!("archive:{}:{}", job.id, sha256::digest(scope.to_string()));
    let boundary: Option<Uuid> = body
        .cursor
        .as_ref()
        .map(|value| cursor::decode(value, &scope))
        .transpose()?;
    let filter = crate::devices::analytics::normalize_tag_filter(
        db,
        body.tag_ids.clone().unwrap_or_default(),
        body.tag_match,
        body.untagged.unwrap_or(false),
    )
    .await
    .c(h!())?;
    let rows=db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select e.id,e.device_id,e.parent_id,e.kind::text,r.name,r.absolute_path,e.hierarchy_path::text,r.mime_type,r.extension,
                r.file_metadata_created_at::timestamp,r.file_metadata_modified_at::timestamp,e.created_at,r.created_at::timestamp as updated_at,c.object_key as content_path,r.revision,r.sync_id,
                r.source_file_state::text,r.source_file_state_settled_at,r.source_file_state_settled_by,r.analysis_input_revision,null::uuid as current_analysis_run_id,r.is_archive,e.archive_file_id,e.archive_relative_path
         from file_revision r join file_entry e on e.id=r.id left join file_content c on c.file_id=r.id and c.revision=r.revision
         where r.origin_archive_id=$1 and e.parent_id=$2 order by e.kind,convert_to(r.name,'UTF8'),e.id",
        [job.id.into(),parent.into()])).await.c(h!())?;
    let models = rows
        .iter()
        .map(|row| file_entry::Model::from_query_result(row, "").c(h!()))
        .collect::<Result<Vec<_>>>()
        .c(h!())?;
    if let Some(boundary) = boundary {
        if !models.iter().any(|entry| entry.id == boundary) {
            return Err(AppError::BadRequestJson {
                body: serde_json::json!({"code":"invalid_request"}),
            });
        }
    }
    let ids = models.iter().map(|entry| entry.id).collect::<Vec<_>>();
    let matched =
        matching_children(db, job.id, &ids, body, filter.as_ref()).await?;
    let mut after = boundary.is_none();
    let mut entries = Vec::new();
    for entry in models {
        if !after {
            after = Some(entry.id) == boundary;
            continue;
        }
        if (filter.is_some() || body.has_content.is_some())
            && !matched.contains(&entry.id)
        {
            continue;
        }
        entries.push(
            query::model::map_tree_model(entry).map_err(bl::map_read_error)?,
        );
        if entries.len() > limit as usize {
            break;
        }
    }
    let next = if entries.len() > limit as usize {
        entries.pop();
        entries
            .last()
            .map(|entry| match entry {
                TreeEntry::Directory(d) => d.entry_id,
                TreeEntry::File(f) => f.file_id,
            })
            .map(|id| cursor::encode(&scope, id))
            .transpose()
            .c(h!())?
    } else {
        None
    };
    let breadcrumbs = breadcrumbs(
        db,
        device,
        &entry,
        body.include_breadcrumbs.unwrap_or(true),
    )
    .await?;
    let paths = vec![Vec::new(); entries.len()];
    let mut response = bl::map_browse(BrowseFilesResult {
        breadcrumbs,
        entries,
        entry_path_components: paths,
        next_cursor: next,
        tags_by_file: crate::devices::analytics::hydrate_active_tags(db, &ids)
            .await
            .c(h!())?,
    })?;
    super::hydrate::tree(db, device, &mut response.entries)
        .await
        .c(h!())?;
    Ok(Some(response))
}

async fn selected_revision(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    device: Uuid,
    target: Uuid,
    body: &BrowseDeviceFilesReq,
) -> Result<i64, AppError> {
    let db = files.connection();
    let root = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "with recursive ancestors as (select id,archive_file_id,revision from file_entry where device_id=$1 and id=$2 union all select e.id,e.archive_file_id,e.revision from file_entry e join ancestors a on e.id=a.archive_file_id where e.device_id=$1) select id,revision from ancestors where archive_file_id is null",
        [device.into(),target.into()])).await.c(h!())?.ok_or(AppError::NotFound)?;
    let root_id: Uuid = root.try_get("", "id").c(h!())?;
    let revision = if let Some(sync) = &body.sync_id {
        let sync = Uuid::parse_str(sync).c(h!())?;
        super::super::sessions::authorize(main, files, login, device, sync)
            .await
            .c(h!())?;
        let row=db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select revision from file_revision where device_id=$1 and id=$2 and sync_id=$3 order by revision desc limit 1",[device.into(),root_id.into(),sync.into()])).await.c(h!())?.ok_or(AppError::NotFound)?;
        let revision: i64 = row.try_get("", "revision").c(h!())?;
        if body
            .archive_revision
            .is_some_and(|explicit| explicit != revision)
        {
            return Err(AppError::BadRequestJson {
                body: serde_json::json!({"code":"invalid_request"}),
            });
        }
        revision
    } else if let Some(revision) = body.archive_revision {
        revision
    } else {
        root.try_get("", "revision").c(h!())?
    };
    Ok(revision)
}

struct Snapshot {
    device: Uuid,
    entry: file_entry::Model,
    job: file_archive::Model,
}

async fn resolve_context(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: &BrowseDeviceFilesReq,
) -> Result<Option<Snapshot>, AppError> {
    let device = Uuid::parse_str(&body.device_id).c(h!())?;
    authorize_file_registry_access(
        main,
        login,
        device,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let parent = Uuid::parse_str(&body.parent_entry_id).c(h!())?;
    let db = files.connection();
    let entry = file_entry::Entity::find_by_id(parent)
        .filter(file_entry::Column::DeviceId.eq(device))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let target = if entry.kind == DomainFileEntryKind::Directory {
        entry.archive_file_id
    } else {
        Some(entry.id)
    };
    let Some(target) = target else {
        if body.archive_revision.is_some() {
            return Err(AppError::BadRequestJson {
                body: serde_json::json!({"code":"invalid_request"}),
            });
        }
        return Ok(None);
    };
    let revision =
        selected_revision(main, files, login, device, target, body).await?;
    let reference = super::types::DeviceFileContentRef {
        device_id: device,
        file_id: target,
        revision,
    };
    if let Err(error) = super::query::source(db, &reference).await {
        if let Some(super::query::Rejection(code)) = error.downcast_ref() {
            if *code == "unsupported_format"
                && entry.archive_file_id.is_none()
                && body.archive_revision.is_none()
            {
                return Ok(None);
            }
            return Err(if *code == "not_found" {
                AppError::NotFound
            } else {
                AppError::BadRequestJson {
                    body: serde_json::json!({"code":code}),
                }
            });
        }
        return Err(error.into());
    }
    let job=super::query::archive(db,&reference).await.c(h!())?.filter(|a|a.state=="ready").ok_or_else(||AppError::ConflictJson{body:serde_json::json!({"code":"archive_not_ready","message":"Архів ще не підготовлено"})})?;
    if parent != target {
        let present=db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select 1 from file_revision where id=$1 and origin_archive_id=$2",[parent.into(),job.id.into()])).await.c(h!())?;
        if present.is_none() {
            return Err(AppError::NotFound);
        }
    }
    Ok(Some(Snapshot { device, entry, job }))
}

async fn matching_children(
    db: &DatabaseConnection,
    archive: Uuid,
    ids: &[Uuid],
    body: &BrowseDeviceFilesReq,
    filter: Option<&crate::devices::analytics::types::TagFilter>,
) -> Result<std::collections::BTreeSet<Uuid>, AppError> {
    let mut matched = std::collections::BTreeSet::new();
    if filter.is_some() || body.has_content.is_some() {
        let candidates=db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select candidate.id,child.id as file_id from file_entry candidate join file_entry child on child.device_id=candidate.device_id and child.hierarchy_path <@ candidate.hierarchy_path and child.kind='file' join file_revision r on r.id=child.id and r.origin_archive_id=$1 left join file_content c on c.file_id=r.id and c.revision=r.revision where candidate.id=any($2::uuid[]) and ($3::boolean is null or (c.file_id is not null)=$3)",
            [archive.into(),ids.to_vec().into(),body.has_content.into()])).await.c(h!())?;
        let descendants = candidates
            .iter()
            .map(|row| row.try_get::<Uuid>("", "file_id").c(h!()))
            .collect::<Result<Vec<_>>>()
            .c(h!())?;
        let memberships =
            crate::devices::analytics::load_active_tag_memberships(
                db,
                &descendants,
            )
            .await
            .c(h!())?;
        for candidate in candidates {
            let file: Uuid = candidate.try_get("", "file_id").c(h!())?;
            if filter.is_none_or(|filter| {
                crate::devices::analytics::matches_tag_filter(
                    memberships.get(&file),
                    filter,
                )
            }) {
                matched.insert(candidate.try_get::<Uuid>("", "id").c(h!())?);
            }
        }
    }
    Ok(matched)
}

async fn breadcrumbs(
    db: &DatabaseConnection,
    device: Uuid,
    entry: &file_entry::Model,
    include: bool,
) -> Result<Vec<Breadcrumb>, AppError> {
    let breadcrumbs = if include {
        let rows=db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select a.id,a.name from file_entry a where a.device_id=$1 and a.hierarchy_path @> $2::ltree order by nlevel(a.hierarchy_path)",[device.into(),entry.hierarchy_path.clone().into()])).await.c(h!())?;
        rows.iter()
            .map(|row| {
                Ok(Breadcrumb {
                    entry_id: row.try_get("", "id").c(h!())?,
                    name: row.try_get("", "name").c(h!())?,
                })
            })
            .collect::<Result<Vec<_>>>()
            .c(h!())?
    } else {
        Vec::new()
    };
    Ok(breadcrumbs)
}
