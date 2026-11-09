use super::types::{DeviceFileRoot, DeviceFileTreeEntry, FileEntryKind};
use crate::{
    devices::{
        access,
        devices::query::{
            authorize_file_registry_access, FileRegistryDeviceAccess,
        },
    },
    entities::login,
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(deny_unknown_fields)]
pub struct SetDeviceFileFavoriteReq {
    pub device_id: Uuid,
    pub entry_id: Uuid,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(deny_unknown_fields)]
pub struct MarkDeviceFileViewedReq {
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileMarkers {
    pub is_favorite: bool,
    pub is_viewed: bool,
}

#[post("/api/device/files/favorite")]
pub(crate) async fn favorite(
    env: Data<Env>,
    user: Identity,
    body: Json<SetDeviceFileFavoriteReq>,
) -> Result<Json<DeviceFileMarkers>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(set_favorite(&env, &login, &body).await.c(h!())?))
}

pub(super) async fn set_favorite(
    env: &Env,
    login: &login::Model,
    body: &SetDeviceFileFavoriteReq,
) -> anyhow::Result<DeviceFileMarkers> {
    authorize_file_registry_access(
        &env.dbx,
        login,
        body.device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let db = env.file_registry_db().c(h!())?.connection();
    db.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select 1 from file_entry where device_id=$1 and id=$2",
        [body.device_id.into(), body.entry_id.into()],
    ))
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)
    .c(h!())?;
    if body.favorite {
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into file_favorite (entry_id, created_by) values ($1,$2) on conflict (entry_id) do nothing",
            [body.entry_id.into(), login.id.into()])).await.c(h!())?;
    } else {
        db.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "delete from file_favorite where entry_id=$1",
            [body.entry_id.into()],
        ))
        .await
        .c(h!())?;
    }
    read_markers(db, body.device_id, body.entry_id, None, login.id)
        .await
        .c(h!())
}

#[post("/api/device/files/viewed")]
pub(crate) async fn viewed(
    env: Data<Env>,
    user: Identity,
    body: Json<MarkDeviceFileViewedReq>,
) -> Result<Json<DeviceFileMarkers>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(mark_viewed(&env, &login, &body).await.c(h!())?))
}

pub(super) async fn mark_viewed(
    env: &Env,
    login: &login::Model,
    body: &MarkDeviceFileViewedReq,
) -> anyhow::Result<DeviceFileMarkers> {
    set_viewed(env, login, body, true).await.c(h!())
}

#[post("/api/device/files/unviewed")]
pub(crate) async fn unviewed(
    env: Data<Env>,
    user: Identity,
    body: Json<MarkDeviceFileViewedReq>,
) -> Result<Json<DeviceFileMarkers>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(set_viewed(&env, &login, &body, false).await.c(h!())?))
}

pub(super) async fn set_viewed(
    env: &Env,
    login: &login::Model,
    body: &MarkDeviceFileViewedReq,
    is_viewed: bool,
) -> anyhow::Result<DeviceFileMarkers> {
    authorize_file_registry_access(
        &env.dbx,
        login,
        body.device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let db = env.file_registry_db().c(h!())?.connection();
    super::locate::load(
        env,
        &super::locate::LocateDeviceFileReq {
            device_id: body.device_id.to_string(),
            file_id: body.file_id.to_string(),
            revision: Some(body.revision),
        },
    )
    .await
    .c(h!())?;
    let sql = if is_viewed {
        "insert into file_view (file_id, revision, login_id) values ($1,$2,$3) on conflict (file_id,revision,login_id) do nothing"
    } else {
        "delete from file_view where file_id=$1 and revision=$2 and login_id=$3"
    };
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [body.file_id.into(), body.revision.into(), login.id.into()],
    ))
    .await
    .c(h!())?;
    read_markers(
        db,
        body.device_id,
        body.file_id,
        Some(body.revision),
        login.id,
    )
    .await
    .c(h!())
}

async fn read_markers(
    db: &impl ConnectionTrait,
    device: Uuid,
    entry: Uuid,
    revision: Option<i64>,
    login: Uuid,
) -> anyhow::Result<DeviceFileMarkers> {
    let row = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select exists(select 1 from file_favorite f where f.entry_id=e.id) as favorite,
                exists(select 1 from file_view v where v.file_id=e.id and v.revision=coalesce($3,e.revision) and v.login_id=$4) as viewed
         from file_entry e where e.device_id=$1 and e.id=$2",
        [device.into(), entry.into(), revision.into(), login.into()])).await.c(h!())?.ok_or(AppError::NotFound).c(h!())?;
    Ok(DeviceFileMarkers {
        is_favorite: row.try_get("", "favorite").c(h!())?,
        is_viewed: row.try_get("", "viewed").c(h!())?,
    })
}

pub(super) async fn hydrate_roots(
    env: &Env,
    roots: &mut [DeviceFileRoot],
) -> anyhow::Result<()> {
    if roots.is_empty() {
        return Ok(());
    }
    let ids = roots
        .iter()
        .map(|root| Uuid::parse_str(&root.entry_id).c(h!()))
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let rows = env
        .file_registry_db()
        .c(h!())?
        .connection()
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select entry_id from file_favorite where entry_id=any($1::uuid[])",
            [ids.into()],
        ))
        .await
        .c(h!())?;
    for row in rows {
        let id: Uuid = row.try_get("", "entry_id").c(h!())?;
        for root in roots
            .iter_mut()
            .filter(|root| root.entry_id == id.to_string())
        {
            root.is_favorite = true;
        }
    }
    Ok(())
}

pub(super) async fn hydrate(
    env: &Env,
    login: Uuid,
    entries: &mut [DeviceFileTreeEntry],
) -> anyhow::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let refs = entries.iter().map(|entry| serde_json::json!({"id":entry.entry_id,"revision":entry.revision})).collect::<Vec<_>>();
    let rows = env.file_registry_db().c(h!())?.connection().query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select selected.id, selected.revision,
                exists(select 1 from file_favorite f where f.entry_id=selected.id) as favorite,
                exists(select 1 from file_view v where v.file_id=selected.id and v.revision=selected.revision and v.login_id=$2) as viewed,
                c.source_size_bytes as size_bytes, c.created_at as content_uploaded_at
         from jsonb_to_recordset($1::jsonb) selected(id uuid, revision bigint)
         left join file_content c on c.file_id=selected.id and c.revision=selected.revision",
        [serde_json::json!(refs).into(), login.into()])).await.c(h!())?;
    for row in rows {
        let id: Uuid = row.try_get("", "id").c(h!())?;
        let revision: Option<i64> = row.try_get("", "revision").c(h!())?;
        let entry = entries
            .iter_mut()
            .find(|entry| {
                entry.entry_id == id.to_string() && entry.revision == revision
            })
            .c(h!())?;
        entry.is_favorite = row.try_get("", "favorite").c(h!())?;
        entry.is_viewed = row.try_get("", "viewed").c(h!())?;
        if entry.kind == FileEntryKind::File {
            entry.size_bytes = row.try_get("", "size_bytes").c(h!())?;
        }
        let uploaded_at: Option<chrono::DateTime<chrono::FixedOffset>> =
            row.try_get("", "content_uploaded_at").c(h!())?;
        if entry.kind == FileEntryKind::File {
            entry.content_uploaded_at =
                uploaded_at.map(|date| date.to_rfc3339());
        }
    }
    super::query::sizes::hydrate(
        env.file_registry_db().c(h!())?.connection(),
        entries,
    )
    .await
    .c(h!())
}

#[derive(Clone, Copy)]
pub(super) struct Filters {
    pub has_content: Option<bool>,
    pub favorites_only: bool,
    pub unviewed_only: bool,
    pub archive_failed: bool,
    pub archive_encrypted: bool,
}

impl Filters {
    pub fn active(self) -> bool {
        self.has_content.is_some()
            || self.favorites_only
            || self.unviewed_only
            || self.archive_failed
            || self.archive_encrypted
    }

    pub fn matches(self, entry: &DeviceFileTreeEntry) -> bool {
        use super::archive::types::{DeviceArchiveReason, DeviceArchiveState};
        self.has_content
            .is_none_or(|value| entry.has_content == value)
            && (!self.favorites_only || entry.is_favorite)
            && (!self.unviewed_only
                || (entry.kind == FileEntryKind::File && !entry.is_viewed))
            && (!self.archive_failed
                || entry.archive.as_ref().is_some_and(|archive| {
                    archive.state == DeviceArchiveState::ArchiveFailed
                }))
            && (!self.archive_encrypted
                || entry.archive.as_ref().is_some_and(|archive| {
                    archive.reason
                        == Some(
                            DeviceArchiveReason::ArchiveReasonPasswordProtected,
                        )
                }))
    }
}

pub(super) async fn filter_entries(
    env: &Env,
    login: Uuid,
    entries: &mut Vec<DeviceFileTreeEntry>,
    filters: Filters,
    browse: bool,
) -> anyhow::Result<()> {
    hydrate(env, login, entries).await.c(h!())?;
    if !filters.active() {
        return Ok(());
    }
    entries.retain(|entry| {
        (browse && entry.kind == FileEntryKind::Directory)
            || filters.matches(entry)
    });
    Ok(())
}
