use super::{settings, types::*};
use crate::devices::access;
use crate::devices::devices::query::{visible_devices_query, DeviceReadScope};
use crate::entities::{
    device, device_audio_forwarding_group as binding,
    device_audio_forwarding_settings as forwarding, login, signal_group,
};
use crate::{error::AppError, h, types::ShortContext};
use sea_orm::*;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct Entry {
    device_id: Uuid,
    device_name: Option<String>,
    device_archived: bool,
    group_master_key: String,
    group_name: Option<String>,
    enabled: bool,
    version: Uuid,
}

impl From<Entry> for DeviceAudioForwardingEntry {
    fn from(entry: Entry) -> Self {
        Self {
            device_name: entry
                .device_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| entry.device_id.to_string()),
            device_id: entry.device_id.to_string(),
            device_archived: entry.device_archived,
            group_name: entry
                .group_name
                .unwrap_or_else(|| entry.group_master_key.clone()),
            group_master_key: entry.group_master_key,
            enabled: entry.enabled,
            version: entry.version.to_string(),
        }
    }
}

pub(super) async fn list<C: ConnectionTrait>(
    db: &C,
    actor: &login::Model,
    request: &ListDeviceAudioForwardingReq,
) -> Result<ListDeviceAudioForwardingRsp, AppError> {
    access::require_audio_edit(&actor.roles).c(h!())?;
    let devices =
        visible_devices_query(actor, DeviceReadScope::IncludeArchived)
            .c(h!())?
            .select_only()
            .column(device::Column::Id)
            .into_query();
    let groups = settings::available(db, actor)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| group.master_key);
    let query = binding::Entity::find()
        .join(JoinType::InnerJoin, binding::Relation::Device.def())
        .join(JoinType::InnerJoin, binding::Relation::SignalGroup.def())
        .join(
            JoinType::InnerJoin,
            device::Relation::DeviceAudioForwardingSettings.def(),
        )
        .filter(binding::Column::DeviceId.in_subquery(devices))
        .filter(binding::Column::GroupMasterKey.is_in(groups));
    let total_count = query.clone().count(db).await.c(h!())?;
    let mut query = query
        .select_only()
        .columns([binding::Column::DeviceId, binding::Column::GroupMasterKey])
        .column_as(device::Column::Name, "device_name")
        .column_as(device::Column::Archived, "device_archived")
        .column_as(signal_group::Column::Name, "group_name")
        .column(forwarding::Column::Enabled)
        .column(forwarding::Column::Version)
        .order_by_asc(binding::Column::DeviceId)
        .order_by_asc(binding::Column::GroupMasterKey)
        .limit(crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE + 1);
    if let Some((device_id, group_key)) = &request.cursor {
        query = query.filter(
            sea_query::Expr::tuple([
                sea_query::Expr::col((
                    binding::Entity,
                    binding::Column::DeviceId,
                )),
                sea_query::Expr::col((
                    binding::Entity,
                    binding::Column::GroupMasterKey,
                )),
            ])
            .gt(sea_query::Expr::tuple([
                sea_query::Expr::value(Uuid::parse_str(device_id).c(h!())?),
                sea_query::Expr::value(group_key.clone()),
            ])),
        );
    }
    let mut items: Vec<DeviceAudioForwardingEntry> = query
        .into_model::<Entry>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(Into::into)
        .collect();
    let next_cursor = if items.len()
        > crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE as usize
    {
        items.pop();
        items.last().map(|entry| {
            (entry.device_id.clone(), entry.group_master_key.clone())
        })
    } else {
        None
    };
    Ok(ListDeviceAudioForwardingRsp {
        items,
        next_cursor,
        total_count,
        page_size: crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE,
    })
}

pub(super) async fn remove(
    db: &DatabaseConnection,
    actor: &login::Model,
    request: &RemoveDeviceAudioForwardingReq,
) -> Result<(), AppError> {
    access::require_audio_edit(&actor.roles).c(h!())?;
    let device_id = Uuid::parse_str(&request.device_id).c(h!())?;
    let tx = db.begin().await.c(h!())?;
    visible_devices_query(actor, DeviceReadScope::IncludeArchived)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .lock_exclusive()
        .one(&tx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let current = settings::read(&tx, actor, device_id).await.c(h!())?;
    let remaining = binding::Entity::find()
        .filter(binding::Column::DeviceId.eq(device_id))
        .filter(binding::Column::GroupMasterKey.ne(&request.group_master_key))
        .one(&tx)
        .await
        .c(h!())?
        .is_some();
    settings::apply(
        &tx,
        actor,
        device_id,
        &DeviceAudioForwardingChange {
            version: Some(request.version.clone()),
            enabled: current.enabled && remaining,
            add_groups: vec![],
            remove_groups: vec![request.group_master_key.clone()],
        },
    )
    .await
    .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(())
}
