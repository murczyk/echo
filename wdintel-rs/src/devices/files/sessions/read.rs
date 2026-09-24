mod tree;

use super::{cursor, query::SessionQuery};
use crate::devices::analytics::{normalize_tag_filter, types::*};
use crate::devices::files::{bl, query, types::*};
use crate::devices::types::parse_uuid;
use crate::file_registry::{entities::file_entry, FileRegistryDb};
use crate::{config, entities::login, error::AppError, h, types::ShortContext};
use sea_orm::{
    AccessMode, DatabaseConnection, FromQueryResult, IsolationLevel,
    QueryResult, TransactionTrait,
};
use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(in crate::devices) use tree::{browse, search};

pub(super) fn scope_key(
    kind: &str,
    request: &impl Serialize,
) -> anyhow::Result<String> {
    let mut value = serde_json::to_value(request).c(h!())?;
    if let Some(fields) = value.as_object_mut() {
        fields.remove("cursor");
        fields.remove("limit");
    }
    Ok(format!("{kind}:{}", sha256::digest(value.to_string())))
}

fn page_limit(limit: Option<u64>) -> Result<u64, AppError> {
    let limit = limit.unwrap_or(config::DEVICE_FILE_PAGE_DEFAULT_LIMIT);
    if !(1..=config::DEVICE_FILE_PAGE_MAX_LIMIT).contains(&limit) {
        return Err(cursor::invalid("limit"));
    }
    Ok(limit)
}

async fn authorize_request(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    device_id: &str,
    sync_id: Option<&str>,
) -> Result<(Uuid, Uuid), AppError> {
    let device_id = parse_uuid(device_id);
    let sync_id =
        parse_uuid(sync_id.ok_or_else(|| cursor::invalid("sync_id")).c(h!())?);
    super::authorize(main, files, login, device_id, sync_id)
        .await
        .c(h!())?;
    Ok((device_id, sync_id))
}

fn tags_from_rows(
    rows: &[QueryResult],
) -> anyhow::Result<BTreeMap<Uuid, Vec<AnalyticsTag>>> {
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get("", "id").c(h!())?,
                serde_json::from_value(row.try_get("", "tags").c(h!())?)
                    .c(h!())?,
            ))
        })
        .collect()
}

pub(in crate::devices) async fn roots(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: ListDeviceFileRootsReq,
) -> Result<ListDeviceFileRootsRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let rows = SessionQuery::new(device_id, vec![sync_id]).all(files.connection(),
        "select * from session_entries where kind = 'directory' and parent_id is null order by convert_to(name, 'UTF8'), id").await.c(h!())?;
    let roots = rows
        .iter()
        .map(|row| {
            let entry =
                file_entry::Model::from_query_result(row, "").c(h!())?;
            query::model::map_root_model(entry)
                .map_err(bl::map_read_error)
                .c(h!())
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    Ok(bl::map_roots(roots))
}

pub(in crate::devices) async fn counts(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: CountDeviceFileSubtreesReq,
) -> Result<CountDeviceFileSubtreesRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let ids = body
        .directory_entry_ids
        .iter()
        .map(|id| parse_uuid(id))
        .collect::<Vec<_>>();
    crate::devices::files::validation::validate_subtree_count_directories(&ids)
        .map_err(bl::map_read_error)
        .c(h!())?;
    let mut query = SessionQuery::new(device_id, vec![sync_id]);
    let ids_param = query.bind(ids.clone());
    let parent = match body.parent_entry_id {
        Some(id) => {
            format!("entry.parent_id = {}", query.bind(parse_uuid(&id)))
        }
        None => "entry.parent_id is null".to_owned(),
    };
    let rows = query.all(files.connection(), &format!(
        "select entry.id, (select count(*) from selected_revisions revision where revision.hierarchy_path <@ entry.hierarchy_path) as file_count
         from file_entry entry where entry.device_id = $1 and entry.kind = 'directory' and entry.id = any({ids_param}::uuid[]) and {parent}"
    )).await.c(h!())?;
    if rows.len() != ids.len() {
        return Err(AppError::NotFound);
    }
    let counts_by_id = rows
        .into_iter()
        .map(|row| {
            let id = row.try_get::<Uuid>("", "id").c(h!())?;
            Ok((
                id,
                row.try_get::<i64>("", "file_count")
                    .c(h!())?
                    .try_into()
                    .c(h!())?,
            ))
        })
        .collect::<anyhow::Result<BTreeMap<_, u64>>>()
        .c(h!())?;
    let counts = ids
        .into_iter()
        .map(|id| DeviceFileSubtreeCount {
            entry_id: id.to_string(),
            file_count: counts_by_id[&id],
        })
        .collect();
    Ok(CountDeviceFileSubtreesRsp { counts })
}

pub(in crate::devices) async fn journal(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: JournalDeviceFilesReq,
) -> Result<JournalDeviceFilesRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let scope = scope_key("journal", &body).c(h!())?;
    let limit = page_limit(body.limit).c(h!())?;
    let filter = normalize_tag_filter(
        files.connection(),
        body.tag_ids.unwrap_or_default(),
        body.tag_match,
        body.untagged.unwrap_or(false),
    )
    .await
    .c(h!())?;
    let transaction = files
        .connection()
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let mut count = SessionQuery::new(device_id, vec![sync_id]);
    let predicate = count.tag_filter("files", filter.as_ref());
    let count_source = if filter.is_none() {
        "selected_revisions"
    } else {
        "session_files"
    };
    let totals = count.all(&transaction, &format!("select count(*) as total from {count_source} files where {predicate}")).await.c(h!())?;
    let total_count = totals[0]
        .try_get::<i64>("", "total")
        .c(h!())?
        .try_into()
        .c(h!())?;
    let mut query = SessionQuery::new(device_id, vec![sync_id]);
    let mut predicate = query.tag_filter("files", filter.as_ref());
    let after: Option<(chrono::NaiveDateTime, Uuid)> = body
        .cursor
        .as_deref()
        .map(|value| cursor::decode(value, &scope))
        .transpose()
        .c(h!())?;
    if filter.is_none() {
        query.journal_page(after, limit);
    }
    if let Some((time, id)) = after {
        let time = query.bind(time);
        let id = query.bind(id);
        predicate.push_str(&format!(
            " and (files.updated_at, files.id) < ({time}, {id})"
        ));
    }
    let cap = query.bind((limit + 1) as i64);
    let mut rows = query.all(&transaction, &format!("select files.* from session_files files where {predicate} order by files.updated_at desc, files.id desc limit {cap}")).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let tags_by_file = tags_from_rows(&rows).c(h!())?;
    let entries = rows
        .iter()
        .map(|row| {
            let entry =
                file_entry::Model::from_query_result(row, "").c(h!())?;
            query::model::map_file_journal_model(entry)
                .map_err(bl::map_read_error)
                .c(h!())
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let next_cursor = if more {
        entries
            .last()
            .map(|entry| {
                cursor::encode(&scope, (entry.synchronized_at, entry.file_id))
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    Ok(bl::map_journal(JournalFilesResult {
        entries,
        total_count,
        next_cursor,
        tags_by_file,
    }))
}

pub(in crate::devices) async fn summary(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: DeviceAnalyticsSummaryReq,
) -> Result<DeviceAnalyticsSummaryRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    super::listing::load_summaries(files, device_id, vec![sync_id])
        .await
        .c(h!())?
        .pop()
        .map(|summary| summary.analysis)
        .ok_or(AppError::NotFound)
}

pub(in crate::devices) async fn analytics_files(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: DeviceAnalyticsFilesReq,
) -> Result<DeviceAnalyticsFilesRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let scope = scope_key("analytics_files", &body).c(h!())?;
    let limit = page_limit(body.limit.or(Some(10))).c(h!())?;
    let filter = normalize_tag_filter(
        files.connection(),
        vec![body.tag_id],
        None,
        false,
    )
    .await
    .c(h!())?;
    let mut query = SessionQuery::new(device_id, vec![sync_id]);
    let mut predicate = query.tag_filter("files", filter.as_ref());
    if let Some(value) = body.cursor {
        let (time, id): (chrono::NaiveDateTime, Uuid) =
            cursor::decode(&value, &scope).c(h!())?;
        let time = query.bind(time);
        let id = query.bind(id);
        predicate.push_str(&format!(
            " and (files.created_at, files.id) < ({time}, {id})"
        ));
    }
    let cap = query.bind((limit + 1) as i64);
    let mut rows = query.all(files.connection(), &format!("select files.* from session_files files where {predicate} order by files.created_at desc, files.id desc limit {cap}")).await.c(h!())?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if more {
        rows.last()
            .map(|row| {
                cursor::encode(
                    &scope,
                    (
                        row.try_get::<chrono::NaiveDateTime>("", "created_at")
                            .c(h!())?,
                        row.try_get::<Uuid>("", "id").c(h!())?,
                    ),
                )
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    let files = rows
        .into_iter()
        .map(|row| {
            Ok(DeviceAnalyticsFile {
                file_id: row.try_get::<Uuid>("", "id").c(h!())?.to_string(),
                name: row.try_get("", "name").c(h!())?,
                absolute_path: row.try_get("", "absolute_path").c(h!())?,
                file_entry_created_at: crate::devices::types::format_datetime(
                    row.try_get("", "created_at").c(h!())?,
                ),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    Ok(DeviceAnalyticsFilesRsp { files, next_cursor })
}
