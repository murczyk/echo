use super::{
    DeviceAorReference, DeviceCurrentState, DeviceService, DeviceUnitReference,
};
use crate::devices::access::DeviceActor;
use crate::devices::custom_fields::custom_fields_from_json;
use crate::devices::main_db::MainDb;
use crate::devices::visibility::{DeviceReadScope, DeviceVisibility};
use crate::entities::{
    area_of_responsibility, device, device_aor, sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::types::{BTreeMap, BTreeSet, ShortContext, Uuid};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder,
};

impl DeviceService {
    pub(in crate::devices) async fn read(
        main_db: &MainDb<'_, DatabaseConnection>,
        actor: &DeviceActor,
        device_id: Uuid,
        scope: DeviceReadScope,
    ) -> Result<DeviceCurrentState, AppError> {
        let device =
            DeviceVisibility::find_for_read(main_db, actor, device_id, scope)
                .await?;
        let mut devices = hydrate_devices(main_db, vec![device]).await?;
        Ok(devices
            .pop()
            .ok_or_else(|| anyhow::anyhow!("device hydrator lost its input"))
            .c(h!())?)
    }
}

pub(super) async fn hydrate_devices<C>(
    main_db: &MainDb<'_, C>,
    devices: Vec<device::Model>,
) -> Result<Vec<DeviceCurrentState>, AppError>
where
    C: ConnectionTrait,
{
    if devices.is_empty() {
        return Ok(Vec::new());
    }

    let device_ids = devices.iter().map(|device| device.id).collect();
    let unit_ids = devices.iter().filter_map(|device| device.unit_id).collect();
    let mut aors_by_device = load_device_aors(main_db, device_ids).await?;
    let unit_names = load_unit_names(main_db, unit_ids).await?;

    devices
        .into_iter()
        .map(|device| hydrate_device(device, &mut aors_by_device, &unit_names))
        .collect()
}

async fn load_device_aors<C>(
    main_db: &MainDb<'_, C>,
    device_ids: BTreeSet<Uuid>,
) -> Result<BTreeMap<Uuid, Vec<DeviceAorReference>>, AppError>
where
    C: ConnectionTrait,
{
    let rows = device_aor::Entity::find()
        .find_also_related(area_of_responsibility::Entity)
        .filter(device_aor::Column::DeviceId.is_in(device_ids))
        .order_by_asc(device_aor::Column::DeviceId)
        .order_by_asc(device_aor::Column::AorId)
        .all(main_db.connection())
        .await
        .c(h!())?;

    let mut aors_by_device = BTreeMap::new();
    for (device_aor, aor) in rows {
        let aor = aor
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "missing AOR reference for device {:?}, AOR {}",
                    device_aor.device_id,
                    device_aor.aor_id,
                )
            })
            .c(h!())?;
        aors_by_device
            .entry(device_aor.device_id)
            .or_insert_with(Vec::new)
            .push(DeviceAorReference {
                id: device_aor.aor_id,
                name: aor.name,
            });
    }
    for aors in aors_by_device.values_mut() {
        aors.sort_by_key(|aor| aor.id);
    }
    Ok(aors_by_device)
}

async fn load_unit_names<C>(
    main_db: &MainDb<'_, C>,
    unit_ids: BTreeSet<i64>,
) -> Result<BTreeMap<i64, String>, AppError>
where
    C: ConnectionTrait,
{
    if unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(unit_ids))
        .all(main_db.connection())
        .await
        .c(h!())?;
    Ok(units.into_iter().map(|unit| (unit.id, unit.name)).collect())
}

fn hydrate_device(
    device: device::Model,
    aors_by_device: &mut BTreeMap<Uuid, Vec<DeviceAorReference>>,
    unit_names: &BTreeMap<i64, String>,
) -> Result<DeviceCurrentState, AppError> {
    let device_id = device.id;
    let custom_fields = custom_fields_from_json(&device.custom_fields)?;
    let unit = match device.unit_id {
        Some(unit_id) => Some(DeviceUnitReference {
            id: unit_id,
            name: unit_names
                .get(&unit_id)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "missing unit reference for device {device_id:?}, unit {unit_id}"
                    )
                })
                .c(h!())?
                .clone(),
        }),
        None => None,
    };

    Ok(DeviceCurrentState {
        id: device_id,
        source_label: device.source_label,
        name: device.name,
        aors: aors_by_device.remove(&device_id).unwrap_or_default(),
        unit,
        external_url: device.external_url,
        custom_fields,
        created_by: device.created_by,
        archived: device.archived,
        archived_at: device.archived_at,
        created_at: device.created_at,
        updated_at: device.updated_at,
    })
}
