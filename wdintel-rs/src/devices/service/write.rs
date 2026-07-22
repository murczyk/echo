use super::read::hydrate_devices;
use super::{
    CreateDeviceCommand, DeviceCurrentState, DevicePatchField, DeviceService,
    UpdateDeviceCommand,
};
use crate::devices::access::DeviceActor;
use crate::devices::custom_fields::{
    apply_custom_fields_patch, custom_fields_from_json, custom_fields_to_json,
};
use crate::devices::main_db::MainDb;
use crate::devices::validation::{
    normalize_custom_fields, normalize_custom_fields_patch,
    normalize_device_name, normalize_present_external_url,
    normalize_source_label, normalize_unique_aor_ids,
    validate_custom_fields_count,
};
use crate::devices::visibility::DeviceVisibility;
use crate::entities::{
    area_of_responsibility, device, device_aor, sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::types::{BTreeMap, NaiveDateTime, ShortContext, Utc, Uuid};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select, Set,
    TransactionTrait,
};

impl DeviceService {
    pub(in crate::devices) async fn create(
        main_db: &MainDb<'_, DatabaseConnection>,
        actor: &DeviceActor,
        command: CreateDeviceCommand,
    ) -> Result<DeviceCurrentState, AppError> {
        actor.require_source_write()?;

        let CreateDeviceCommand {
            source_label,
            external_url,
            custom_fields,
        } = command;
        let source_label = normalize_source_label(&source_label)?;
        let external_url = external_url
            .map(normalize_present_external_url)
            .transpose()?;
        let custom_fields =
            normalize_custom_fields(custom_fields.unwrap_or_default())?;
        let device_id = Uuid::now_v7();
        let now = Utc::now().naive_utc();

        let transaction = main_db.connection().begin().await.c(h!())?;
        let state = {
            let transaction_db = MainDb::new(&transaction);
            let device = device::ActiveModel {
                id: Set(device_id),
                source_label: Set(source_label),
                name: Set(None),
                created_by: Set(actor.login().to_string()),
                unit_id: Set(None),
                tags: Set(serde_json::json!([])),
                external_url: Set(external_url),
                custom_fields: Set(custom_fields_to_json(custom_fields)),
                archived: Set(false),
                archived_at: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(transaction_db.connection())
            .await
            .c(h!())?;
            let mut states =
                hydrate_devices(&transaction_db, vec![device]).await?;
            states
                .pop()
                .ok_or_else(|| {
                    anyhow::anyhow!("device hydrator lost inserted device")
                })
                .c(h!())?
        };
        transaction.commit().await.c(h!())?;
        Ok(state)
    }
}

impl DeviceService {
    pub(in crate::devices) async fn update(
        main_db: &MainDb<'_, DatabaseConnection>,
        actor: &DeviceActor,
        command: UpdateDeviceCommand,
    ) -> Result<DeviceCurrentState, AppError> {
        let field_groups = command.field_groups();
        actor.require_field_groups(field_groups)?;
        if command.is_structurally_empty() {
            return Err(empty_patch_error());
        }
        let command = normalize_update_command(command)?;

        let transaction = main_db.connection().begin().await.c(h!())?;
        let state = {
            let transaction_db = MainDb::new(&transaction);
            let device = DeviceVisibility::find_active_for_update(
                &transaction_db,
                actor,
                command.device_id,
            )
            .await?;
            lock_references(&transaction_db, &command).await?;
            let current_aor_ids =
                load_current_aor_ids(&transaction_db, device.id).await?;
            let changes =
                collect_device_changes(&device, current_aor_ids, command)?;

            let next_device = if changes.is_empty() {
                device
            } else {
                let now = Utc::now().naive_utc();
                if let Some(aor_ids) = &changes.aor_ids {
                    replace_device_aors(
                        &transaction_db,
                        device.id,
                        aor_ids,
                        now,
                    )
                    .await?;
                }
                apply_device_changes(&transaction_db, device.id, changes, now)
                    .await?
            };
            let mut states =
                hydrate_devices(&transaction_db, vec![next_device]).await?;
            states
                .pop()
                .ok_or_else(|| {
                    anyhow::anyhow!("device hydrator lost updated device")
                })
                .c(h!())?
        };
        transaction.commit().await.c(h!())?;
        Ok(state)
    }
}

struct NormalizedUpdateDevice {
    device_id: Uuid,
    source_label: DevicePatchField<String>,
    external_url: DevicePatchField<Option<String>>,
    custom_fields: DevicePatchField<BTreeMap<String, Option<String>>>,
    name: DevicePatchField<Option<String>>,
    aor_ids: DevicePatchField<Vec<i64>>,
    unit_id: DevicePatchField<Option<i64>>,
}

struct DeviceChanges {
    source_label: Option<String>,
    external_url: Option<Option<String>>,
    custom_fields: Option<serde_json::Value>,
    name: Option<Option<String>>,
    aor_ids: Option<Vec<i64>>,
    unit_id: Option<Option<i64>>,
}

impl DeviceChanges {
    fn is_empty(&self) -> bool {
        self.source_label.is_none()
            && self.external_url.is_none()
            && self.custom_fields.is_none()
            && self.name.is_none()
            && self.aor_ids.is_none()
            && self.unit_id.is_none()
    }
}

fn normalize_update_command(
    command: UpdateDeviceCommand,
) -> Result<NormalizedUpdateDevice, AppError> {
    Ok(NormalizedUpdateDevice {
        device_id: command.device_id,
        source_label: normalize_patch_field(
            command.source_label,
            |source_label| normalize_source_label(&source_label),
        )?,
        external_url: normalize_patch_field(
            command.external_url,
            |external_url| {
                external_url.map(normalize_present_external_url).transpose()
            },
        )?,
        custom_fields: normalize_patch_field(
            command.custom_fields,
            normalize_custom_fields_patch,
        )?,
        name: normalize_patch_field(command.name, |name| {
            name.map(|name| normalize_device_name(&name)).transpose()
        })?,
        aor_ids: normalize_patch_field(
            command.aor_ids,
            normalize_unique_aor_ids,
        )?,
        unit_id: command.unit_id,
    })
}

fn normalize_patch_field<T, U>(
    field: DevicePatchField<T>,
    normalize: impl FnOnce(T) -> Result<U, AppError>,
) -> Result<DevicePatchField<U>, AppError> {
    match field {
        DevicePatchField::Missing => Ok(DevicePatchField::Missing),
        DevicePatchField::Value(value) => {
            Ok(DevicePatchField::Value(normalize(value)?))
        }
    }
}

async fn lock_references(
    main_db: &MainDb<'_, DatabaseTransaction>,
    command: &NormalizedUpdateDevice,
) -> Result<(), AppError> {
    if let DevicePatchField::Value(aor_ids) = &command.aor_ids {
        if !aor_ids.is_empty() {
            let aors = active_aor_reference_query(aor_ids)
                .all(main_db.connection())
                .await
                .c(h!())?;
            if aors.len() != aor_ids.len() {
                return Err(form_error("aor_ids", "Смугу не знайдено"));
            }
        }
    }

    if let DevicePatchField::Value(Some(unit_id)) = &command.unit_id {
        let unit = active_unit_reference_query(*unit_id)
            .one(main_db.connection())
            .await
            .c(h!())?;
        if unit.is_none() {
            return Err(form_error("unit_id", "Підрозділ не знайдено"));
        }
    }

    Ok(())
}

pub(super) fn active_aor_reference_query(
    aor_ids: &[i64],
) -> Select<area_of_responsibility::Entity> {
    area_of_responsibility::Entity::find()
        .filter(
            area_of_responsibility::Column::Id.is_in(aor_ids.iter().copied()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(area_of_responsibility::Column::Id)
        .lock_shared()
}

pub(super) fn active_unit_reference_query(
    unit_id: i64,
) -> Select<sigint_unit::Entity> {
    sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.eq(unit_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_shared()
}

async fn load_current_aor_ids(
    main_db: &MainDb<'_, DatabaseTransaction>,
    device_id: Uuid,
) -> Result<Vec<i64>, AppError> {
    Ok(device_aor::Entity::find()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .order_by_asc(device_aor::Column::AorId)
        .all(main_db.connection())
        .await
        .c(h!())?
        .into_iter()
        .map(|device_aor| device_aor.aor_id)
        .collect())
}

fn collect_device_changes(
    device: &device::Model,
    current_aor_ids: Vec<i64>,
    command: NormalizedUpdateDevice,
) -> Result<DeviceChanges, AppError> {
    let source_label = match command.source_label {
        DevicePatchField::Value(source_label)
            if source_label != device.source_label =>
        {
            Some(source_label)
        }
        _ => None,
    };
    let external_url = match command.external_url {
        DevicePatchField::Value(external_url)
            if external_url != device.external_url =>
        {
            Some(external_url)
        }
        _ => None,
    };
    let custom_fields = match command.custom_fields {
        DevicePatchField::Value(custom_fields) => {
            let custom_fields = apply_custom_fields_patch(
                &device.custom_fields,
                custom_fields,
            )?;
            let final_custom_fields = custom_fields_from_json(&custom_fields)?;
            validate_custom_fields_count(&final_custom_fields)?;
            (custom_fields != device.custom_fields).then_some(custom_fields)
        }
        DevicePatchField::Missing => None,
    };
    let name = match command.name {
        DevicePatchField::Value(name) if name != device.name => Some(name),
        _ => None,
    };
    let aor_ids = match command.aor_ids {
        DevicePatchField::Value(aor_ids) if aor_ids != current_aor_ids => {
            Some(aor_ids)
        }
        _ => None,
    };
    let unit_id = match command.unit_id {
        DevicePatchField::Value(unit_id) if unit_id != device.unit_id => {
            Some(unit_id)
        }
        _ => None,
    };

    Ok(DeviceChanges {
        source_label,
        external_url,
        custom_fields,
        name,
        aor_ids,
        unit_id,
    })
}

async fn replace_device_aors(
    main_db: &MainDb<'_, DatabaseTransaction>,
    device_id: Uuid,
    aor_ids: &[i64],
    now: NaiveDateTime,
) -> Result<(), AppError> {
    device_aor::Entity::delete_many()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .exec(main_db.connection())
        .await
        .c(h!())?;
    if aor_ids.is_empty() {
        return Ok(());
    }

    let aors = aor_ids.iter().map(|aor_id| device_aor::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(device_id),
        aor_id: Set(*aor_id),
        created_at: Set(now),
    });
    device_aor::Entity::insert_many(aors)
        .exec(main_db.connection())
        .await
        .c(h!())?;
    Ok(())
}

async fn apply_device_changes(
    main_db: &MainDb<'_, DatabaseTransaction>,
    device_id: Uuid,
    changes: DeviceChanges,
    now: NaiveDateTime,
) -> Result<device::Model, AppError> {
    let DeviceChanges {
        source_label,
        external_url,
        custom_fields,
        name,
        aor_ids: _,
        unit_id,
    } = changes;
    let mut device = device::ActiveModel {
        id: Set(device_id),
        ..Default::default()
    };
    if let Some(source_label) = source_label {
        device.source_label = Set(source_label);
    }
    if let Some(external_url) = external_url {
        device.external_url = Set(external_url);
    }
    if let Some(custom_fields) = custom_fields {
        device.custom_fields = Set(custom_fields);
    }
    if let Some(name) = name {
        device.name = Set(name);
    }
    if let Some(unit_id) = unit_id {
        device.unit_id = Set(unit_id);
    }
    device.updated_at = Set(now);
    Ok(device.update(main_db.connection()).await.c(h!())?)
}

fn empty_patch_error() -> AppError {
    form_error("patch", "Потрібно передати хоча б одне поле для зміни")
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from([(field.to_string(), message.to_string())]))
}
