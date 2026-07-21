#![allow(dead_code)]

use crate::devices::custom_fields::{
    apply_custom_fields_patch, custom_fields_to_json,
};
use crate::devices::query::get_device_details;
use crate::devices::types::{
    ArchiveDeviceReq, CreateDeviceReq, DeviceDetailReq, DeviceDetails,
    DeviceUpdateNullableField, DeviceUpdateRequiredField, RestoreDeviceReq,
    UpdateDeviceReq,
};
use crate::devices::validation::{
    normalize_custom_fields, normalize_custom_fields_patch,
    normalize_device_name, normalize_external_url, normalize_source_label,
    normalize_tags, parse_device_id, validate_aor_ids, validate_unit_id,
};
use crate::entities::{device, device_aor};
use crate::h;
use crate::types::{AppError, BTreeMap, ShortContext, Uuid};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, NotSet, QueryFilter, Set, TransactionTrait,
};

struct NormalizedCreateDevice {
    source_label: String,
    name: String,
    aor_ids: Vec<i64>,
    unit_id: Option<i64>,
    tags: Vec<crate::devices::types::DeviceTag>,
    external_url: Option<String>,
    custom_fields: BTreeMap<String, String>,
}

struct NormalizedUpdateDevice {
    source_label: Option<String>,
    name: Option<String>,
    aor_ids: Option<Vec<i64>>,
    unit_id: Option<Option<i64>>,
    tags: Option<Vec<crate::devices::types::DeviceTag>>,
    external_url: Option<Option<String>>,
    custom_fields: Option<BTreeMap<String, Option<String>>>,
}

pub async fn create_device(
    dbx: &DatabaseConnection,
    created_by: &str,
    req: CreateDeviceReq,
) -> Result<DeviceDetails, AppError> {
    validate_created_by(created_by)?;
    let req = normalize_create_device(dbx, req).await?;
    let NormalizedCreateDevice {
        source_label,
        name,
        aor_ids,
        unit_id,
        tags,
        external_url,
        custom_fields,
    } = req;
    let txn = dbx.begin().await.c(h!())?;

    let now = Utc::now().naive_utc();
    let device_id = Uuid::now_v7();
    let tags = serde_json::to_value(tags).c(h!())?;
    device::ActiveModel {
        id: Set(device_id),
        source_label: Set(source_label),
        name: Set(Some(name)),
        created_by: Set(created_by.to_string()),
        unit_id: Set(unit_id),
        tags: Set(tags),
        external_url: Set(external_url),
        custom_fields: Set(custom_fields_to_json(custom_fields)),
        archived: Set(false),
        archived_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await
    .c(h!())?;

    replace_device_aors(&txn, device_id, &aor_ids).await?;
    txn.commit().await.c(h!())?;

    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

pub async fn update_device(
    dbx: &DatabaseConnection,
    req: UpdateDeviceReq,
) -> Result<DeviceDetails, AppError> {
    let device_id = parse_device_id(&req.device_id)?;
    let req = normalize_update_device(dbx, req).await?;

    let txn = dbx.begin().await.c(h!())?;
    let device = find_update_target(&txn, device_id).await?;

    let device_changes = collect_device_changes(&device, &req)?;
    let has_device_changes = !device_changes.is_empty();
    if !has_device_changes {
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

    txn.commit().await.c(h!())?;
    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

pub async fn archive_device(
    dbx: &DatabaseConnection,
    req: ArchiveDeviceReq,
) -> Result<DeviceDetails, AppError> {
    set_device_archived(dbx, &req.device_id, true).await
}

pub async fn restore_device(
    dbx: &DatabaseConnection,
    req: RestoreDeviceReq,
) -> Result<DeviceDetails, AppError> {
    set_device_archived(dbx, &req.device_id, false).await
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
    if device.archived {
        return Err(form_error(
            "device_id",
            "Архівований пристрій не можна редагувати",
        ));
    }
    Ok(device)
}

async fn normalize_create_device(
    dbx: &DatabaseConnection,
    req: CreateDeviceReq,
) -> Result<NormalizedCreateDevice, AppError> {
    Ok(NormalizedCreateDevice {
        source_label: normalize_source_label(&req.source_label)?,
        name: normalize_device_name(&req.name)?,
        aor_ids: validate_aor_ids(dbx, req.aor_ids).await?,
        unit_id: validate_unit_id(dbx, req.unit_id).await?,
        tags: normalize_tags(req.tags)?,
        external_url: normalize_external_url(req.external_url)?,
        custom_fields: normalize_custom_fields(req.custom_fields)?,
    })
}

async fn normalize_update_device(
    dbx: &DatabaseConnection,
    req: UpdateDeviceReq,
) -> Result<NormalizedUpdateDevice, AppError> {
    Ok(NormalizedUpdateDevice {
        source_label: normalize_update_source_label(req.source_label)?,
        name: normalize_update_name(req.name)?,
        aor_ids: normalize_update_aor_ids(dbx, req.aor_ids).await?,
        unit_id: normalize_update_unit_id(dbx, req.unit_id).await?,
        tags: normalize_update_tags(req.tags)?,
        external_url: normalize_update_external_url(req.external_url)?,
        custom_fields: normalize_update_custom_fields(req.custom_fields)?,
    })
}

fn normalize_update_source_label(
    source_label: DeviceUpdateRequiredField<String>,
) -> Result<Option<String>, AppError> {
    match source_label {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(source_label) => {
            Ok(Some(normalize_source_label(&source_label)?))
        }
    }
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

fn normalize_update_tags(
    tags: DeviceUpdateRequiredField<Vec<crate::devices::types::DeviceTag>>,
) -> Result<Option<Vec<crate::devices::types::DeviceTag>>, AppError> {
    match tags {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(tags) => {
            Ok(Some(normalize_tags(tags)?))
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

fn normalize_update_custom_fields(
    custom_fields: DeviceUpdateRequiredField<BTreeMap<String, Option<String>>>,
) -> Result<Option<BTreeMap<String, Option<String>>>, AppError> {
    match custom_fields {
        DeviceUpdateRequiredField::Missing => Ok(None),
        DeviceUpdateRequiredField::Value(custom_fields) => {
            Ok(Some(normalize_custom_fields_patch(custom_fields)?))
        }
    }
}

struct DeviceChanges {
    source_label: Option<String>,
    name: Option<String>,
    aor_ids: Option<Vec<i64>>,
    unit_id: Option<Option<i64>>,
    tags: Option<Vec<crate::devices::types::DeviceTag>>,
    external_url: Option<Option<String>>,
    custom_fields: Option<serde_json::Value>,
}

impl DeviceChanges {
    fn is_empty(&self) -> bool {
        self.source_label.is_none()
            && self.name.is_none()
            && self.aor_ids.is_none()
            && self.unit_id.is_none()
            && self.tags.is_none()
            && self.external_url.is_none()
            && self.custom_fields.is_none()
    }
}

fn collect_device_changes(
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<DeviceChanges, AppError> {
    Ok(DeviceChanges {
        source_label: req
            .source_label
            .as_ref()
            .filter(|source_label| *source_label != &device.source_label)
            .cloned(),
        name: req
            .name
            .as_ref()
            .filter(|name| Some(name.as_str()) != device.name.as_deref())
            .cloned(),
        aor_ids: req.aor_ids.clone(),
        unit_id: changed_nullable(req.unit_id, device.unit_id),
        tags: changed_tags(device, req)?,
        external_url: changed_nullable(
            req.external_url.clone(),
            device.external_url.clone(),
        ),
        custom_fields: changed_custom_fields(device, req)?,
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

fn changed_tags(
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<Option<Vec<crate::devices::types::DeviceTag>>, AppError> {
    let Some(tags) = &req.tags else {
        return Ok(None);
    };
    let current_tags = serde_json::from_value::<
        Vec<crate::devices::types::DeviceTag>,
    >(device.tags.clone())
    .c(h!())?;
    if &current_tags == tags {
        return Ok(None);
    }
    Ok(Some(tags.clone()))
}

fn changed_custom_fields(
    device: &device::Model,
    req: &NormalizedUpdateDevice,
) -> Result<Option<serde_json::Value>, AppError> {
    let Some(patch) = &req.custom_fields else {
        return Ok(None);
    };
    let custom_fields =
        apply_custom_fields_patch(&device.custom_fields, patch.clone())?;
    Ok((custom_fields != device.custom_fields).then_some(custom_fields))
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
    apply_device_change_values(&mut device, &changes)?;
    device.updated_at = Set(now);
    Ok(device.update(db).await.c(h!())?)
}

fn apply_device_change_values(
    device: &mut device::ActiveModel,
    changes: &DeviceChanges,
) -> Result<(), AppError> {
    if let Some(source_label) = &changes.source_label {
        device.source_label = Set(source_label.clone());
    }
    if let Some(name) = &changes.name {
        device.name = Set(Some(name.clone()));
    }
    if let Some(unit_id) = changes.unit_id {
        device.unit_id = Set(unit_id);
    }
    if let Some(tags) = &changes.tags {
        device.tags = Set(serde_json::to_value(tags).c(h!())?);
    }
    if let Some(external_url) = &changes.external_url {
        device.external_url = Set(external_url.clone());
    }
    if let Some(custom_fields) = &changes.custom_fields {
        device.custom_fields = Set(custom_fields.clone());
    }
    Ok(())
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
            id: Set(Uuid::now_v7()),
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

async fn set_device_archived(
    dbx: &DatabaseConnection,
    device_id: &str,
    archived: bool,
) -> Result<DeviceDetails, AppError> {
    let device_id = parse_device_id(device_id)?;
    let txn = dbx.begin().await.c(h!())?;
    let device = device::Entity::find_by_id(device_id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    if device.archived == archived {
        txn.commit().await.c(h!())?;
        return get_device_details(dbx, &device_detail_req(device_id, true))
            .await;
    }

    let now = Utc::now().naive_utc();
    let mut device = device.into_active_model();
    device.archived = Set(archived);
    device.archived_at = Set(archived.then_some(now));
    device.updated_at = Set(now);
    device.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;

    get_device_details(dbx, &device_detail_req(device_id, true)).await
}

fn validate_created_by(created_by: &str) -> Result<(), AppError> {
    if created_by.trim().is_empty() {
        return Err(form_error("created_by", "Користувача не визначено"));
    }
    Ok(())
}

fn device_detail_req(
    device_id: Uuid,
    include_archived: bool,
) -> DeviceDetailReq {
    DeviceDetailReq {
        device_id: device_id.to_string(),
        include_archived: Some(include_archived),
    }
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        field.to_string(),
        message.to_string(),
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use sea_orm::TryIntoModel;
    use serde_json::json;

    fn fixture_device() -> device::Model {
        let now = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        device::Model {
            id: Uuid::now_v7(),
            name: Some("Old name".to_string()),
            created_by: "operator".to_string(),
            unit_id: None,
            tags: json!([]),
            external_url: None,
            archived: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
            source_label: "Source device".to_string(),
            custom_fields: json!({
                "inventory_id": "node-1",
                "transport": "ssh",
            }),
        }
    }

    #[test]
    fn source_label_update_does_not_change_analytical_name() {
        let device = fixture_device();
        let req = NormalizedUpdateDevice {
            source_label: Some("New source".to_string()),
            name: None,
            aor_ids: None,
            unit_id: None,
            tags: None,
            external_url: None,
            custom_fields: None,
        };

        let changes = collect_device_changes(&device, &req).unwrap();
        let mut device = device.into_active_model();
        apply_device_change_values(&mut device, &changes).unwrap();
        let device = device.try_into_model().unwrap();

        assert_eq!(device.source_label, "New source");
        assert_eq!(device.name.as_deref(), Some("Old name"));
    }

    #[test]
    fn custom_field_patch_keeps_unrelated_values() {
        let device = fixture_device();
        let req = NormalizedUpdateDevice {
            source_label: None,
            name: None,
            aor_ids: None,
            unit_id: None,
            tags: None,
            external_url: None,
            custom_fields: Some(BTreeMap::from([
                ("inventory_id".to_string(), None),
                ("transport".to_string(), Some("https".to_string())),
            ])),
        };

        let changes = collect_device_changes(&device, &req).unwrap();
        let mut device = device.into_active_model();
        apply_device_change_values(&mut device, &changes).unwrap();
        let device = device.try_into_model().unwrap();

        assert_eq!(device.custom_fields, json!({"transport": "https"}));
    }
}
