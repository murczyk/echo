#![allow(dead_code)]

use crate::devices::query::render_device_file_entry;
use crate::devices::types::{
    CreateDeviceFileItem, CreateDeviceFilesReq, CreateDeviceFilesRsp,
    DeleteDeviceFileReq, DeviceFileEntry, RestoreDeviceFileReq,
};
use crate::devices::validation::{
    normalize_required_file_create_items, parse_device_id, parse_file_id,
};
use crate::entities::{device, device_file};
use crate::h;
use crate::types::{AppError, BTreeMap, ShortContext, Uuid};
use chrono::{DateTime, NaiveDateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, QueryFilter, Set, TransactionTrait,
};

pub async fn create_device_files(
    dbx: &DatabaseConnection,
    req: CreateDeviceFilesReq,
) -> Result<CreateDeviceFilesRsp, AppError> {
    let device_id = parse_device_id(&req.device_id)?;
    let files = normalize_required_file_create_items(req.files)?;
    let txn = dbx.begin().await.c(h!())?;

    find_active_device(&txn, device_id).await?;
    let now = Utc::now().naive_utc();
    let files = insert_device_file_rows(&txn, device_id, files, now).await?;
    touch_device_updated_at(&txn, device_id, now).await?;

    txn.commit().await.c(h!())?;
    Ok(CreateDeviceFilesRsp {
        list: files.into_iter().map(render_device_file_entry).collect(),
    })
}

pub async fn delete_device_file(
    dbx: &DatabaseConnection,
    req: DeleteDeviceFileReq,
) -> Result<DeviceFileEntry, AppError> {
    set_device_file_deleted(dbx, req.device_id, req.file_id, true).await
}

pub async fn restore_device_file(
    dbx: &DatabaseConnection,
    req: RestoreDeviceFileReq,
) -> Result<DeviceFileEntry, AppError> {
    set_device_file_deleted(dbx, req.device_id, req.file_id, false).await
}

pub(super) async fn insert_device_file_rows<C>(
    db: &C,
    device_id: Uuid,
    files: Vec<CreateDeviceFileItem>,
    now: NaiveDateTime,
) -> Result<Vec<device_file::Model>, AppError>
where
    C: ConnectionTrait,
{
    let mut inserted_files = Vec::with_capacity(files.len());
    for (idx, file) in files.into_iter().enumerate() {
        let file = device_file::ActiveModel {
            id: Set(Uuid::now_v7()),
            device_id: Set(device_id),
            original_name: Set(file.original_name),
            original_absolute_path: Set(file.original_absolute_path),
            original_created_at: Set(timestamp_ms_to_datetime(
                format!("files.{idx}.original_created_at_ms"),
                file.original_created_at_ms,
            )?),
            original_modified_at: Set(timestamp_ms_to_datetime(
                format!("files.{idx}.original_modified_at_ms"),
                file.original_modified_at_ms,
            )?),
            created_at: Set(now),
            updated_at: Set(now),
            deleted: Set(false),
            deleted_at: Set(None),
        }
        .insert(db)
        .await
        .c(h!())?;
        inserted_files.push(file);
    }
    Ok(inserted_files)
}

pub(super) async fn find_active_device<C>(
    db: &C,
    device_id: Uuid,
) -> Result<device::Model, AppError>
where
    C: ConnectionTrait,
{
    device::Entity::find_by_id(device_id)
        .filter(device::Column::Archived.eq(false))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub(super) async fn touch_device_updated_at<C>(
    db: &C,
    device_id: Uuid,
    now: NaiveDateTime,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let res = device::Entity::update_many()
        .col_expr(device::Column::UpdatedAt, Expr::value(now))
        .filter(device::Column::Id.eq(device_id))
        .filter(device::Column::Archived.eq(false))
        .exec(db)
        .await
        .c(h!())?;
    if res.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn set_device_file_deleted(
    dbx: &DatabaseConnection,
    device_id: String,
    file_id: String,
    deleted: bool,
) -> Result<DeviceFileEntry, AppError> {
    let device_id = parse_device_id(&device_id)?;
    let file_id = parse_file_id(&file_id)?;
    let txn = dbx.begin().await.c(h!())?;

    find_active_device(&txn, device_id).await?;
    let file = find_device_file(&txn, device_id, file_id).await?;
    if file.deleted == deleted {
        txn.commit().await.c(h!())?;
        return Ok(render_device_file_entry(file));
    }

    let now = Utc::now().naive_utc();
    let file = update_file_lifecycle(&txn, file, deleted, now).await?;
    touch_device_updated_at(&txn, device_id, now).await?;

    txn.commit().await.c(h!())?;
    Ok(render_device_file_entry(file))
}

async fn find_device_file<C>(
    db: &C,
    device_id: Uuid,
    file_id: Uuid,
) -> Result<device_file::Model, AppError>
where
    C: ConnectionTrait,
{
    device_file::Entity::find_by_id(file_id)
        .filter(device_file::Column::DeviceId.eq(device_id))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn update_file_lifecycle<C>(
    db: &C,
    file: device_file::Model,
    deleted: bool,
    now: NaiveDateTime,
) -> Result<device_file::Model, AppError>
where
    C: ConnectionTrait,
{
    let mut file = file.into_active_model();
    file.deleted = Set(deleted);
    file.deleted_at = Set(deleted.then_some(now));
    file.updated_at = Set(now);
    Ok(file.update(db).await.c(h!())?)
}

fn timestamp_ms_to_datetime(
    field: String,
    timestamp_ms: Option<i64>,
) -> Result<Option<NaiveDateTime>, AppError> {
    let Some(timestamp_ms) = timestamp_ms else {
        return Ok(None);
    };
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| Some(timestamp.naive_utc()))
        .ok_or_else(|| form_error(&field, "Некоректний час файлу"))
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        field.to_string(),
        message.to_string(),
    )]))
}
