use super::settings::Snapshot;
use crate::entities::{sigint_inbox_item, sigint_unit, signal_group};
use crate::file_registry::entities::device_audio;
use crate::{
    h,
    types::{Env, ShortContext},
};
use sea_orm::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(FromQueryResult)]
pub(super) struct Delivery {
    pub audio_id: Uuid,
    pub group_master_key: String,
    pub device_name: String,
    pub unit_id: Option<i64>,
    pub actor_id: Uuid,
    pub lease_token: Uuid,
}

pub(in crate::devices::audio) async fn publish(
    files: &DatabaseTransaction,
    audio: &device_audio::Model,
    actor: Uuid,
    snapshot: &Snapshot,
) -> anyhow::Result<()> {
    for key in &snapshot.groups {
        files.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into device_audio_forwarding_outbox(audio_id,group_master_key,device_name,unit_id,actor_id) values($1,$2,$3,$4,$5) on conflict do nothing",
            [audio.id.into(), key.clone().into(), snapshot.name.clone().into(), snapshot.unit_id.into(), actor.into()])).await.c(h!())?;
    }
    Ok(())
}

pub(crate) async fn run(env: Arc<Env>, cancel: CancellationToken) {
    while !cancel.is_cancelled() {
        match batch(&env).await {
            Ok(true) => continue,
            Ok(false) => (),
            Err(error) => {
                log::error!("device audio forwarding failed: {error:#}")
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_millis(crate::config::DEVICE_AUDIO_FORWARDING_IDLE_MS)) => (),
        }
    }
}

pub(super) async fn batch(env: &Env) -> anyhow::Result<bool> {
    let files = env.file_registry_db().c(h!())?.connection();
    let delivery = Delivery::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "update device_audio_forwarding_outbox job set lease_token=$1,attempts=job.attempts+1,next_attempt_at=now()+make_interval(secs => $2) from (select audio_id,group_master_key from device_audio_forwarding_outbox where completed_at is null and next_attempt_at<=now() order by next_attempt_at,audio_id,group_master_key limit 1 for update skip locked) candidate where job.audio_id=candidate.audio_id and job.group_master_key=candidate.group_master_key returning job.*",
        [Uuid::new_v4().into(), crate::config::DEVICE_AUDIO_FORWARDING_LEASE_SECS.into()])).one(files).await.c(h!())?;
    let Some(delivery) = delivery else {
        return Ok(false);
    };
    match deliver(env, &delivery).await {
        Ok(message_id) => {
            if let Some(message_id) = message_id {
                crate::inbox::fanout_inbox_changed(
                    &mut env.redis.clone(),
                    message_id,
                )
                .await
                .c(h!())?;
            }
            files.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "update device_audio_forwarding_outbox set completed_at=now(),last_error=null where audio_id=$1 and group_master_key=$2 and lease_token=$3",
                [delivery.audio_id.into(), delivery.group_master_key.into(), delivery.lease_token.into()])).await.c(h!())?;
        }
        Err(error) => {
            log::error!(
                "audio forwarding failed audio_id={} group={}: {error:#}",
                delivery.audio_id,
                delivery.group_master_key
            );
            files.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "update device_audio_forwarding_outbox set last_error=$4,next_attempt_at=now()+make_interval(secs => $5) where audio_id=$1 and group_master_key=$2 and lease_token=$3 and completed_at is null",
                [delivery.audio_id.into(), delivery.group_master_key.into(), delivery.lease_token.into(), "Delivery failed; see worker log".into(), crate::config::DEVICE_AUDIO_FORWARDING_RETRY_SECS.into()])).await.c(h!())?;
        }
    }
    Ok(true)
}

pub(super) async fn deliver(
    env: &Env,
    delivery: &Delivery,
) -> anyhow::Result<Option<i64>> {
    let transaction = env.dbx.begin().await.c(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_advisory_xact_lock(hashtextextended($1, 3646))",
            [
                format!("{}:{}", delivery.audio_id, delivery.group_master_key)
                    .into(),
            ],
        ))
        .await
        .c(h!())?;
    if let Some(receipt) = transaction.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select signal_message_id from device_audio_forwarding_delivery where audio_id=$1 and group_master_key=$2", [delivery.audio_id.into(), delivery.group_master_key.clone().into()])).await.c(h!())? {
        return receipt.try_get("", "signal_message_id").c(h!());
    }
    crate::battle_line::lock_updates_shared(&transaction)
        .await
        .c(h!())?;
    let group = signal_group::Entity::find_by_id(&delivery.group_master_key)
        .lock_shared()
        .one(&transaction)
        .await
        .c(h!())?;
    let group = match group {
        Some(group)
            if !group.deleted
                && !group.is_archived
                && crate::datasource::native::is_native_group(
                    &transaction,
                    &group.master_key,
                )
                .await
                .c(h!())? =>
        {
            Some(group)
        }
        _ => None,
    };
    let message = if let Some(group) = group {
        Some(
            create_message(env, &transaction, delivery, group)
                .await
                .c(h!())?,
        )
    } else {
        None
    };
    transaction.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into device_audio_forwarding_delivery(audio_id,group_master_key,signal_message_id,outcome) values($1,$2,$3,$4)",
        [delivery.audio_id.into(), delivery.group_master_key.clone().into(), message.into(), if message.is_some() { "delivered" } else { "group_unavailable" }.into()])).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(message)
}

async fn create_message(
    env: &Env,
    transaction: &DatabaseTransaction,
    delivery: &Delivery,
    group: signal_group::Model,
) -> anyhow::Result<i64> {
    let audio = device_audio::Entity::find_by_id(delivery.audio_id)
        .one(env.file_registry_db().c(h!())?.connection())
        .await
        .c(h!())?
        .c(h!())?;
    let datasource_id = group.datasource_id.c(h!())?;
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            transaction,
            group.master_key.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    let submitted = crate::rer_importer::inbox::submit_bl::submit_inbox_item_with_groups_location_mode(
        env, transaction, Some(datasource_id), &[(group.master_key, datasource_group_id)], &delivery.actor_id, &vec![delivery.actor_id],
        crate::rer_importer::types::InboxSubmitItem {
            text: Some(audio.transcription.clone()),
            timestamp: audio.recording_started_at.to_rfc3339(),
            parse_body_coordinates: false,
            ..Default::default()
        }, true, false, crate::rer_importer::inbox::bl::InboxLocationSubmitMode::PreserveTyped,
    ).await.c(h!())?;
    for table in ["signal_message", "signal_message_group"] {
        let column = if table == "signal_message" {
            "id"
        } else {
            "signal_message_id"
        };
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("update {table} set sender=$2 where {column}=$1"),
                [
                    submitted.signal_message_id.into(),
                    delivery.device_name.clone().into(),
                ],
            ))
            .await
            .c(h!())?;
    }
    if let Some(unit_id) = delivery.unit_id {
        set_unit(transaction, submitted.signal_message_id, unit_id)
            .await
            .c(h!())?;
    }
    crate::messenger::audio_ref::attach(
        env,
        transaction,
        submitted.signal_message_id,
        &audio,
    )
    .await
    .c(h!())?;
    crate::sigint::worker::incoming_message_after_insert(
        transaction,
        submitted.signal_message_id,
    )
    .await
    .c(h!())?;
    Ok(submitted.signal_message_id)
}

async fn set_unit(
    db: &DatabaseTransaction,
    message: i64,
    unit_id: i64,
) -> anyhow::Result<()> {
    let Some(unit) = sigint_unit::Entity::find_by_id(unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update sigint_inbox_item set unit=$2,unit_v2=$2,parsed_unit_v2=true where id=$1", [message.into(), unit.name.clone().into()])).await.c(h!())?;
    let item = sigint_inbox_item::Entity::find_by_id(message)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    crate::inbox::unit_selection::store_selection(db, &item, unit_id)
        .await
        .c(h!())?;
    crate::inbox::unit_resolution::sync_selected_inbox_unit(
        db,
        message,
        item.id_uuid,
        unit_id,
        &unit.name,
    )
    .await
    .c(h!())?;
    Ok(())
}
