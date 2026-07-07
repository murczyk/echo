#![allow(dead_code)]

use crate::devices::files::{insert_device_file_rows, touch_device_updated_at};
use crate::devices::query::get_device_details;
use crate::devices::types::{
    CreateDeviceFileItem, CreateDeviceReq, DeleteDeviceReq, DeviceDetailReq,
    DeviceDetails, DeviceUpdateNullableField, DeviceUpdateRequiredField,
    RestoreDeviceReq, UpdateDeviceReq,
};
use crate::devices::validation::{
    normalize_custom_fields, normalize_device_name, normalize_external_url,
    normalize_optional_file_create_items, normalized_device_name_key,
    parse_device_id, validate_aor_ids, validate_unit_id,
};
use crate::entities::{device, device_aor};
use crate::h;
use crate::types::{AppError, BTreeMap, ShortContext, ShortContextErr, Uuid};
use chrono::{NaiveDateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, NotSet, QueryFilter, Set, TransactionTrait,
};

struct NormalizedCreateDevice {
    name: String,
    aor_ids: Vec<i64>,
    unit_id: Option<i64>,
    custom_fields: Vec<crate::devices::types::DeviceCustomField>,
    external_url: Option<String>,
    files: Vec<CreateDeviceFileItem>,
}

struct NormalizedUpdateDevice {
    device_id: Uuid,
    name: Option<String>,
    aor_ids: Option<Vec<i64>>,
    unit_id: Option<Option<i64>>,
    custom_fields: Option<Vec<crate::devices::types::DeviceCustomField>>,
    external_url: Option<Option<String>>,
    files: Vec<CreateDeviceFileItem>,
}

pub async fn create_device(
    dbx: &DatabaseConnection,
    created_by: &str,
    req: CreateDeviceReq,
) -> Result<DeviceDetails, AppError> {
    validate_created_by(created_by)?;
    let req = normalize_create_device(dbx, req).await?;
    ensure_device_name_available(
        dbx,
        &normalized_device_name_key(&req.name)?,
        None,
    )
    .await?;

    let txn = dbx.begin().await.c(h!())?;
    ensure_device_name_available(
        &txn,
        &normalized_device_name_key(&req.name)?,
        None,
    )
    .await?;

    let now = Utc::now().naive_utc();
    let device_id = Uuid::now_v7();
    let custom_fields = serde_json::to_value(req.custom_fields).c(h!())?;
    device::ActiveModel {
        id: Set(device_id),
        name: Set(req.name),
        created_by: Set(created_by.to_string()),
        unit_id: Set(req.unit_id),
        custom_fields: Set(custom_fields),
        external_url: Set(req.external_url),
        deleted: Set(false),
        deleted_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await
    .map_err(map_device_write_error)?;

    replace_device_aors(&txn, device_id, &req.aor_ids).await?;
    insert_device_file_rows(&txn, device_id, req.files, now).await?;
    txn.commit().await.c(h!())?;

    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

pub async fn update_device(
    dbx: &DatabaseConnection,
    req: UpdateDeviceReq,
) -> Result<DeviceDetails, AppError> {
    let device_id = parse_device_id(&req.device_id)?;
    let device = find_update_target(dbx, device_id).await?;
    let req = normalize_update_device(dbx, device_id, req).await?;
    precheck_update_device_name(dbx, &device, &req).await?;

    let txn = dbx.begin().await.c(h!())?;
    let device = find_update_target(&txn, device_id).await?;
    precheck_update_device_name(&txn, &device, &req).await?;

    let device_changes = collect_device_changes(&device, &req)?;
    let has_device_changes = !device_changes.is_empty();
    if !has_device_changes && req.files.is_empty() {
        txn.commit().await.c(h!())?;
        return get_device_details(dbx, &device_detail_req(device_id, true))
            .await;
    }

    let now = Utc::now().naive_utc();
    let aor_ids = device_changes.aor_ids.clone();
    if has_device_changes {
        apply_device_changes(&txn, device, device_changes, now).await?;
    }
    if let Some(aor_ids) = aor_ids {
        replace_device_aors(&txn, device_id, &aor_ids).await?;
    }
    if !req.files.is_empty() {
        insert_device_file_rows(&txn, device_id, req.files, now).await?;
        if !has_device_changes {
            touch_device_updated_at(&txn, device_id, now).await?;
        }
    }

    txn.commit().await.c(h!())?;
    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

pub async fn delete_device(
    dbx: &DatabaseConnection,
    req: DeleteDeviceReq,
) -> Result<DeviceDetails, AppError> {
    set_device_deleted(dbx, &req.device_id, true).await
}

pub async fn restore_device(
    dbx: &DatabaseConnection,
    req: RestoreDeviceReq,
) -> Result<DeviceDetails, AppError> {
    set_device_deleted(dbx, &req.device_id, false).await
}

async fn find_update_target<C>(
    db: &C,
    device_id: Uuid,
) -> Result<device::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let device = device::Entity::find_by_id(device_id)
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if device.deleted {
        return Err(form_error(
            "device_id",
            "Видалений пристрій не можна редагувати",
        ));
    }
    Ok(device)
}

async fn normalize_create_device(
    dbx: &DatabaseConnection,
    req: CreateDeviceReq,
) -> Result<NormalizedCreateDevice, AppError> {
    Ok(NormalizedCreateDevice {
        name: normalize_device_name(&req.name)?,
        aor_ids: validate_aor_ids(dbx, req.aor_ids).await?,
        unit_id: validate_unit_id(dbx, req.unit_id).await?,
        custom_fields: normalize_custom_fields(req.custom_fields)?,
        external_url: normalize_external_url(req.external_url)?,
        files: normalize_optional_file_create_items(req.files)?,
    })
}

async fn normalize_update_device(
    dbx: &DatabaseConnection,
    device_id: Uuid,
    req: UpdateDeviceReq,
) -> Result<NormalizedUpdateDevice, AppError> {
    Ok(NormalizedUpdateDevice {
        device_id,
        name: normalize_update_name(req.name)?,
        aor_ids: normalize_update_aor_ids(dbx, req.aor_ids).await?,
        unit_id: normalize_update_unit_id(dbx, req.unit_id).await?,
        custom_fields: normalize_update_custom_fields(req.custom_fields)?,
        external_url: normalize_update_external_url(req.external_url)?,
        files: normalize_optional_file_create_items(req.files)?,
    })
}

fn normalize_update_name(
    name: DeviceUpdateRequiredField<String>,
) -> Result<Option<String>, AppError> {
    match name {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(name) => {
            Ok(Some(normalize_device_name(&name)?))
        }
    }
}

async fn normalize_update_aor_ids(
    dbx: &DatabaseConnection,
    aor_ids: DeviceUpdateRequiredField<Vec<i64>>,
) -> Result<Option<Vec<i64>>, AppError> {
    match aor_ids {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(aor_ids) => {
            Ok(Some(validate_aor_ids(dbx, aor_ids).await?))
        }
    }
}

async fn normalize_update_unit_id(
    dbx: &DatabaseConnection,
    unit_id: DeviceUpdateNullableField<i64>,
) -> Result<Option<Option<i64>>, AppError> {
    match unit_id {
        DeviceUpdateNullableField::Missing => Ok(None),
        DeviceUpdateNullableField::Null => Ok(Some(None)),
        DeviceUpdateNullableField::Value(unit_id) => {
            Ok(Some(validate_unit_id(dbx, Some(unit_id)).await?))
        }
    }
}

fn normalize_update_custom_fields(
    custom_fields: DeviceUpdateRequiredField<
        Vec<crate::devices::types::DeviceCustomField>,
    >,
) -> Result<Option<Vec<crate::devices::types::DeviceCustomField>>, AppError> {
    match custom_fields {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(custom_fields) => {
            Ok(Some(normalize_custom_fields(custom_fields)?))
        }
    }
}

fn normalize_update_external_url(
    external_url: DeviceUpdateNullableField<String>,
) -> Result<Option<Option<String>>, AppError> {
    match external_url {
        DeviceUpdateNullableField::Missing => Ok(None),
        DeviceUpdateNullableField::Null => Ok(Some(None)),
        DeviceUpdateNullableField::Value(external_url) => {
            Ok(Some(normalize_external_url(Some(external_url))?))
        }
    }
}

async fn precheck_update_device_name<C>(
    db: &C,
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let Some(name) = &req.name else {
        return Ok(());
    };
    if normalized_device_name_key(&device.name)?
        == normalized_device_name_key(name)?
    {
        return Ok(());
    }
    ensure_device_name_available(
        db,
        &normalized_device_name_key(name)?,
        Some(req.device_id),
    )
    .await
}

#[derive(Clone)]
struct DeviceChanges {
    name: Option<String>,
    aor_ids: Option<Vec<i64>>,
    unit_id: Option<Option<i64>>,
    custom_fields: Option<Vec<crate::devices::types::DeviceCustomField>>,
    external_url: Option<Option<String>>,
}

impl DeviceChanges {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.aor_ids.is_none()
            && self.unit_id.is_none()
            && self.custom_fields.is_none()
            && self.external_url.is_none()
    }
}

fn collect_device_changes(
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<DeviceChanges, AppError> {
    Ok(DeviceChanges {
        name: req
            .name
            .as_ref()
            .filter(|name| *name != &device.name)
            .cloned(),
        aor_ids: req.aor_ids.clone(),
        unit_id: changed_nullable(req.unit_id, device.unit_id),
        custom_fields: changed_custom_fields(device, req)?,
        external_url: changed_nullable(
            req.external_url.clone(),
            device.external_url.clone(),
        ),
    })
}

fn changed_nullable<T>(
    next: Option<Option<T>>,
    current: Option<T>,
) -> Option<Option<T>>
where
    T: PartialEq,
{
    match next {
        Some(next) if next != current => Some(next),
        _ => None,
    }
}

fn changed_custom_fields(
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<Option<Vec<crate::devices::types::DeviceCustomField>>, AppError> {
    let Some(custom_fields) = &req.custom_fields else {
        return Ok(None);
    };
    let current_custom_fields = serde_json::from_value::<
        Vec<crate::devices::types::DeviceCustomField>,
    >(device.custom_fields.clone())
    .c(h!())?;
    if &current_custom_fields == custom_fields {
        return Ok(None);
    }
    Ok(Some(custom_fields.clone()))
}

async fn apply_device_changes<C>(
    db: &C,
    device: device::Model,
    changes: DeviceChanges,
    now: NaiveDateTime,
) -> Result<device::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let mut device = device.into_active_model();
    if let Some(name) = changes.name {
        device.name = Set(name);
    }
    if let Some(unit_id) = changes.unit_id {
        device.unit_id = Set(unit_id);
    }
    if let Some(custom_fields) = changes.custom_fields {
        device.custom_fields =
            Set(serde_json::to_value(custom_fields).c(h!())?);
    }
    if let Some(external_url) = changes.external_url {
        device.external_url = Set(external_url);
    }
    device.updated_at = Set(now);
    device.update(db).await.map_err(map_device_write_error)
}

async fn replace_device_aors<C>(
    db: &C,
    device_id: Uuid,
    aor_ids: &[i64],
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    device_aor::Entity::delete_many()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .exec(db)
        .await
        .c(h!())?;

    for smuha_id in aor_ids {
        device_aor::ActiveModel {
            id: NotSet,
            device_id: Set(device_id),
            aor_id: Set(*smuha_id),
            created_at: NotSet,
        }
        .insert(db)
        .await
        .c(h!())?;
    }

    Ok(())
}

async fn set_device_deleted(
    dbx: &DatabaseConnection,
    device_id: &str,
    deleted: bool,
) -> Result<DeviceDetails, AppError> {
    let device_id = parse_device_id(device_id)?;
    let txn = dbx.begin().await.c(h!())?;
    let device = device::Entity::find_by_id(device_id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    if device.deleted == deleted {
        txn.commit().await.c(h!())?;
        return get_device_details(dbx, &device_detail_req(device_id, true))
            .await;
    }

    let now = Utc::now().naive_utc();
    let mut device = device.into_active_model();
    device.deleted = Set(deleted);
    device.deleted_at = Set(deleted.then_some(now));
    device.updated_at = Set(now);
    device.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;

    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

async fn ensure_device_name_available<C>(
    db: &C,
    normalized_name_key: &str,
    except_device_id: Option<Uuid>,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let mut query = device::Entity::find().filter(Expr::cust_with_values(
        r#"lower(btrim("device"."name")) = $1"#,
        vec![normalized_name_key.to_string()],
    ));
    if let Some(except_device_id) = except_device_id {
        query = query.filter(device::Column::Id.ne(except_device_id));
    }
    if query.one(db).await.c(h!())?.is_some() {
        return Err(duplicate_name_error());
    }
    Ok(())
}

fn validate_created_by(created_by: &str) -> Result<(), AppError> {
    if created_by.trim().is_empty() {
        return Err(form_error("created_by", "Користувача не визначено"));
    }
    Ok(())
}

fn device_detail_req(
    device_id: Uuid,
    include_deleted: bool,
) -> DeviceDetailReq {
    DeviceDetailReq {
        device_id: device_id.to_string(),
        include_deleted: Some(include_deleted),
    }
}

fn duplicate_name_error() -> AppError {
    form_error("name", "Пристрій з такою назвою вже існує")
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        field.to_string(),
        message.to_string(),
    )]))
}

fn map_device_write_error(err: sea_orm::DbErr) -> AppError {
    if is_duplicate_device_name_error(&err) {
        return duplicate_name_error();
    }
    AppError::from(err).c(h!())
}

fn is_duplicate_device_name_error(err: &sea_orm::DbErr) -> bool {
    let msg = err.to_string();
    msg.contains("device_lower_trimmed_name_unique_idx")
        || (msg.contains("duplicate key") && msg.contains("device"))
}
