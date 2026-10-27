use super::types::*;
use crate::entities::{datasource, device, login, signal_group};
use crate::{error::AppError, h, types::ShortContext};
use sea_orm::*;
use std::collections::BTreeSet;
use uuid::Uuid;

pub(in crate::devices) async fn configured<C: ConnectionTrait>(
    db: &C,
    device_id: Uuid,
) -> anyhow::Result<bool> {
    db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select exists(select 1 from device_audio_forwarding_settings settings join device_audio_forwarding_group binding using(device_id) join signal_group g on g.master_key=binding.group_master_key join datasource source on source.id=g.datasource_id where settings.device_id=$1 and settings.enabled and not g.deleted and not g.is_archived and source.kind=$2) as configured",
        [device_id.into(), crate::config::DATASOURCE_ECHO_NATIVE_KIND.into()]))
        .await.c(h!())?.c(h!())?.try_get("", "configured").c(h!())
}

pub(super) async fn available<C: ConnectionTrait>(
    db: &C,
    actor: &login::Model,
) -> Result<Vec<signal_group::Model>, AppError> {
    if actor.sigint_zone_id.is_none() || actor.organism_id.is_none() {
        return Ok(vec![]);
    }
    let keys =
        crate::messenger::group::get_identity_sigint_groups(db, &actor.id)
            .await
            .c(h!())?;
    Ok(signal_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::Datasource.def(),
        )
        .filter(signal_group::Column::MasterKey.is_in(keys))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(
            datasource::Column::Kind
                .eq(crate::config::DATASOURCE_ECHO_NATIVE_KIND),
        )
        .order_by_asc(signal_group::Column::Name)
        .order_by_asc(signal_group::Column::MasterKey)
        .all(db)
        .await
        .c(h!())?)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    actor: &login::Model,
    device_id: Uuid,
) -> Result<DeviceAudioForwardingSettings, AppError> {
    let settings = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select enabled,version from device_audio_forwarding_settings where device_id=$1", [device_id.into()])).await.c(h!())?;
    let selected = db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select group_master_key from device_audio_forwarding_group where device_id=$1", [device_id.into()])).await.c(h!())?
        .into_iter().map(|row| row.try_get::<String>("", "group_master_key")).collect::<Result<BTreeSet<_>, _>>().c(h!())?;
    Ok(DeviceAudioForwardingSettings {
        enabled: settings
            .as_ref()
            .map(|row| row.try_get("", "enabled"))
            .transpose()
            .c(h!())?
            .unwrap_or(false),
        version: settings
            .map(|row| row.try_get::<Uuid>("", "version"))
            .transpose()
            .c(h!())?
            .map(|id| id.to_string()),
        groups: available(db, actor)
            .await
            .c(h!())?
            .into_iter()
            .map(|group| DeviceAudioForwardingGroup {
                selected: selected.contains(&group.master_key),
                name: group.name.unwrap_or_else(|| group.master_key.clone()),
                master_key: group.master_key,
            })
            .collect(),
    })
}

pub(in crate::devices) async fn apply(
    db: &DatabaseTransaction,
    actor: &login::Model,
    device_id: Uuid,
    change: &DeviceAudioForwardingChange,
) -> Result<(), AppError> {
    crate::devices::access::require_audio_edit(&actor.roles).c(h!())?;
    crate::battle_line::lock_updates_shared(db).await.c(h!())?;
    let current = read(db, actor, device_id).await.c(h!())?;
    if current.version != change.version {
        return Err(AppError::ConflictJson {
            body: serde_json::json!({"message": "Налаштування пересилання змінилися. Оновіть форму та повторіть зміни."}),
        });
    }
    let allowed: BTreeSet<_> = current
        .groups
        .iter()
        .map(|group| &group.master_key)
        .collect();
    let added: BTreeSet<_> = change.add_groups.iter().collect();
    let removed: BTreeSet<_> = change.remove_groups.iter().collect();
    if !added.is_disjoint(&removed)
        || added.union(&removed).any(|key| !allowed.contains(key))
    {
        return Err(AppError::Forbidden(
            "Група недоступна для налаштування пересилання".into(),
        ));
    }
    for key in removed {
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "delete from device_audio_forwarding_group where device_id=$1 and group_master_key=$2", [device_id.into(), key.clone().into()])).await.c(h!())?;
    }
    for key in added {
        // Hold the same group lock as archive/edit until the configuration commits.
        let group = signal_group::Entity::find_by_id(key.clone())
            .lock_shared()
            .one(db)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        if group.deleted || group.is_archived {
            return Err(AppError::Forbidden(
                "Група недоступна для налаштування пересилання".into(),
            ));
        }
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into device_audio_forwarding_group(device_id,group_master_key,created_by,created_at) values($1,$2,$3,now()) on conflict do nothing", [device_id.into(), key.clone().into(), actor.id.into()])).await.c(h!())?;
    }
    if change.enabled && db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select 1 from device_audio_forwarding_group where device_id=$1 limit 1", [device_id.into()])).await.c(h!())?.is_none() {
        return Err(AppError::BL { msg: "Оберіть принаймні одну групу для пересилання".into() });
    }
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into device_audio_forwarding_settings(device_id,enabled,version,updated_at,updated_by) values($1,$2,$3,now(),$4) on conflict(device_id) do update set enabled=excluded.enabled,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        [device_id.into(), change.enabled.into(), Uuid::new_v4().into(), actor.id.into()])).await.c(h!())?;
    Ok(())
}

pub(in crate::devices::audio) struct Snapshot {
    pub groups: Vec<String>,
    pub name: String,
    pub unit_id: Option<i64>,
}

pub(in crate::devices::audio) async fn snapshot(
    db: &DatabaseTransaction,
    device_id: Uuid,
) -> anyhow::Result<Snapshot> {
    let device = device::Entity::find_by_id(device_id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let groups = db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select binding.group_master_key from device_audio_forwarding_group binding join device_audio_forwarding_settings settings using(device_id) join signal_group g on g.master_key=binding.group_master_key where binding.device_id=$1 and settings.enabled and not g.deleted and not g.is_archived", [device_id.into()])).await.c(h!())?
        .into_iter().map(|row| row.try_get("", "group_master_key")).collect::<Result<Vec<String>, _>>().c(h!())?;
    Ok(Snapshot {
        groups,
        name: device
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| device.id.to_string()),
        unit_id: device.unit_id,
    })
}
