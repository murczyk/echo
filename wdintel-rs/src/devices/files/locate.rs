use super::{
    bl::mapping::map_tree_entry, ltree, query::model::map_tree_model,
    types::DeviceFileTreeEntry,
};
use crate::{
    devices::documents::api::authorize,
    error::AppError,
    file_registry::entities::{
        file_content, file_entry, file_revision,
        sea_orm_active_enums::FileEntryKind,
    },
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocateDeviceFileReq {
    pub device_id: String,
    pub file_id: String,
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct LocateDeviceFileRsp {
    pub file: DeviceFileTreeEntry,
    pub ancestors: Vec<DeviceFileTreeEntry>,
    pub root_entry_id: String,
    pub current_revision: i64,
}

#[post("/api/device/files/locate")]
pub(crate) async fn locate(
    env: Data<Env>,
    user: Identity,
    req: Json<LocateDeviceFileReq>,
) -> Result<Json<LocateDeviceFileRsp>, AppError> {
    authorize(&env, &user, &req.device_id).await.c(h!())?;
    Ok(Json(load(&env, &req).await.c(h!())?))
}

pub(in crate::devices) async fn load(
    env: &Env,
    req: &LocateDeviceFileReq,
) -> anyhow::Result<LocateDeviceFileRsp> {
    let db = env.file_registry_db().c(h!())?.connection();
    let device = Uuid::parse_str(&req.device_id).c(h!())?;
    let file =
        file_entry::Entity::find_by_id(Uuid::parse_str(&req.file_id).c(h!())?)
            .filter(file_entry::Column::DeviceId.eq(device))
            .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
    let current_revision = file.revision.c(h!())?;
    let mut path = ltree::hierarchy_entry_ids(&file.hierarchy_path).c(h!())?;
    path.pop();
    let root_entry_id = path.first().c(h!())?.to_string();
    let mut entries = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device))
        .filter(file_entry::Column::Id.is_in(path.iter().copied()))
        .all(db)
        .await
        .c(h!())?;
    let mut ancestors = Vec::new();
    let mut names = Vec::new();
    for id in path {
        let index = entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(AppError::NotFound)
            .c(h!())?;
        let entry = entries.swap_remove(index);
        if entry.parent_id.is_none() {
            continue;
        }
        names.push(entry.name.clone());
        ancestors.push(map_tree_entry(
            map_tree_model(entry).c(h!())?,
            names.clone(),
            vec![],
        ));
    }
    let file = pinned_revision(db, file, req.revision).await.c(h!())?;
    names.push(file.name.clone());
    Ok(LocateDeviceFileRsp {
        file: map_tree_entry(map_tree_model(file).c(h!())?, names, vec![]),
        ancestors,
        root_entry_id,
        current_revision,
    })
}

async fn pinned_revision(
    db: &impl ConnectionTrait,
    mut file: file_entry::Model,
    revision: Option<i64>,
) -> anyhow::Result<file_entry::Model> {
    let Some(revision) =
        revision.filter(|revision| Some(*revision) != file.revision)
    else {
        return Ok(file);
    };
    let revision = file_revision::Entity::find_by_id((file.id, revision))
        .filter(file_revision::Column::DeviceId.eq(file.device_id))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let content =
        file_content::Entity::find_by_id((file.id, revision.revision))
            .one(db)
            .await
            .c(h!())?;
    file.revision = Some(revision.revision);
    file.sync_id = Some(revision.sync_id);
    file.name = revision.name;
    file.absolute_path = Some(revision.absolute_path);
    file.extension = revision.extension;
    file.mime_type = revision.mime_type;
    file.file_metadata_created_at = revision
        .file_metadata_created_at
        .map(|time| time.naive_utc());
    file.file_metadata_modified_at = revision
        .file_metadata_modified_at
        .map(|time| time.naive_utc());
    file.content_path = content.map(|content| content.object_key);
    file.source_file_state = revision.source_file_state;
    file.source_file_state_settled_at = revision.source_file_state_settled_at;
    file.source_file_state_settled_by = revision.source_file_state_settled_by;
    Ok(file)
}
