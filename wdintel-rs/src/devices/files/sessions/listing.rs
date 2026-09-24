use super::{cursor, query::SessionQuery, types::*};
use crate::devices::devices::query::{
    authorize_file_registry_access, FileRegistryDeviceAccess,
};
use crate::devices::files::{sync, types::SyncSummary};
use crate::devices::types::parse_uuid;
use crate::file_registry::{
    entities::{file_analysis_run, file_sync_session},
    FileRegistryDb,
};
use crate::{config, entities::login, error::AppError, h, types::ShortContext};
use chrono::{DateTime, FixedOffset};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, ExprTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(in crate::devices::files) async fn list(
    main_db: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: ListDeviceSyncSessionsReq,
) -> Result<ListDeviceSyncSessionsRsp, AppError> {
    let device_id = parse_uuid(&body.device_id);
    authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let limit = body
        .limit
        .unwrap_or(config::DEVICE_FILE_SESSION_DEFAULT_LIMIT);
    if !(1..=config::DEVICE_FILE_SESSION_MAX_LIMIT).contains(&limit) {
        return Err(cursor::invalid("limit"));
    }
    let scope = super::read::scope_key("sessions", &body).c(h!())?;
    let mut query = file_sync_session::Entity::find()
        .filter(file_sync_session::Column::DeviceId.eq(device_id));
    let from = body
        .created_from
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .c(h!())?;
    let to = body
        .created_to
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .c(h!())?;
    if from.zip(to).is_some_and(|(from, to)| from >= to) {
        return Err(cursor::invalid("created_to"));
    }
    if let Some(from) = from {
        query = query.filter(file_sync_session::Column::CreatedAt.gte(from));
    }
    if let Some(to) = to {
        query = query.filter(file_sync_session::Column::CreatedAt.lt(to));
    }
    if let Some(value) = body.cursor {
        let (created_at, id): (DateTime<FixedOffset>, Uuid) =
            cursor::decode(&value, &scope).c(h!())?;
        query = query.filter(
            Expr::tuple([
                Expr::col(file_sync_session::Column::CreatedAt),
                Expr::col(file_sync_session::Column::Id),
            ])
            .lt(Expr::tuple([Expr::val(created_at), Expr::val(id)])),
        );
    }
    let mut rows = query
        .order_by_desc(file_sync_session::Column::CreatedAt)
        .order_by_desc(file_sync_session::Column::Id)
        .limit(limit + 1)
        .all(files.connection())
        .await
        .c(h!())?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| cursor::encode(&scope, (row.created_at, row.id)))
            .transpose()
            .c(h!())?
    } else {
        None
    };
    Ok(ListDeviceSyncSessionsRsp {
        sessions: map_sessions(files, rows).await.c(h!())?,
        next_cursor,
    })
}

pub(super) async fn map_sessions(
    files: &FileRegistryDb,
    sessions: Vec<file_sync_session::Model>,
) -> anyhow::Result<Vec<SyncSummary>> {
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    let runs = file_analysis_run::Entity::find()
        .filter(
            file_analysis_run::Column::SyncId
                .is_in(sessions.iter().map(|session| session.id)),
        )
        .all(files.connection())
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|run| run.sync_id.map(|sync_id| (sync_id, run.id)))
        .collect::<BTreeMap<_, _>>();
    Ok(sessions
        .into_iter()
        .map(|session| {
            let run_id = runs.get(&session.id).copied();
            sync::map_session(session, run_id)
        })
        .collect())
}

pub(in crate::devices::files) async fn summaries(
    main_db: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: DeviceSyncSessionSummariesReq,
) -> Result<DeviceSyncSessionSummariesRsp, AppError> {
    let device_id = parse_uuid(&body.device_id);
    authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    if body.sync_ids.len() > config::DEVICE_FILE_SESSION_SUMMARIES_LIMIT {
        return Err(cursor::invalid("sync_ids"));
    }
    let ids = body
        .sync_ids
        .iter()
        .map(|id| parse_uuid(id))
        .collect::<std::collections::BTreeSet<_>>();
    let sessions = file_sync_session::Entity::find()
        .filter(file_sync_session::Column::DeviceId.eq(device_id))
        .filter(file_sync_session::Column::Id.is_in(ids.iter().copied()))
        .all(files.connection())
        .await
        .c(h!())?;
    if sessions.len() != ids.len() {
        return Err(AppError::NotFound);
    }
    Ok(DeviceSyncSessionSummariesRsp {
        summaries: load_summaries(files, device_id, ids.into_iter().collect())
            .await
            .c(h!())?,
    })
}

pub(super) async fn load_summaries(
    files: &FileRegistryDb,
    device_id: Uuid,
    ids: Vec<Uuid>,
) -> anyhow::Result<Vec<DeviceSyncSessionSummary>> {
    let rows = SessionQuery::new(device_id, ids).all(files.connection(), r#"
        , summary_files as materialized (select sync_id, current_analysis_run_id, tag_ids, created_at from session_files), totals as (
            select sync_id, count(*) as total, count(current_analysis_run_id) as analyzed
            from summary_files group by sync_id
        ), tag_counts as (
            select files.sync_id, tag.id, tag.name, count(*) as file_count, max(files.created_at) as latest
            from summary_files files cross join lateral unnest(files.tag_ids) result(tag_id)
            join analytics_tag tag on tag.id = result.tag_id
            group by files.sync_id, tag.id, tag.name
        )
        select session.id as sync_id, coalesce(totals.total, 0) as total,
            coalesce(totals.analyzed, 0) as analyzed,
            coalesce(jsonb_agg(jsonb_build_object('tag', jsonb_build_object('id', tag.id, 'name', tag.name),
                'file_count', tag.file_count, 'latest_file_entry_created_at',
                to_char(tag.latest, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by tag.id)
                filter (where tag.id is not null), '[]'::jsonb) as items
        from file_sync_session session left join totals on totals.sync_id = session.id
        left join tag_counts tag on tag.sync_id = session.id
        where session.device_id = $1 and session.id = any($2::uuid[])
        group by session.id, totals.total, totals.analyzed order by session.created_at desc, session.id desc
    "#).await.c(h!())?;
    rows.into_iter().map(|row| Ok(DeviceSyncSessionSummary {
        sync_id: row.try_get::<Uuid>("", "sync_id").c(h!())?.to_string(),
        analysis: crate::devices::analytics::types::DeviceAnalyticsSummaryRsp {
            total_file_count: row.try_get::<i64>("", "total").c(h!())?.try_into().c(h!())?,
            analyzed_file_count: row.try_get::<i64>("", "analyzed").c(h!())?.try_into().c(h!())?,
            items: serde_json::from_value(row.try_get("", "items").c(h!())?).c(h!())?,
        },
    })).collect()
}
