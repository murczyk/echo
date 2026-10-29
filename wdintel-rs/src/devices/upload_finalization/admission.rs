use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use uuid::Uuid;

use super::{query, types::*};
use crate::{h, types::DeviceUploadFinalizationSettings};

pub(crate) async fn admit(
    db: &DatabaseConnection,
    command: &FinalizationCommand,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<FinalizationJobSnapshot> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let snapshot = admit_in(&mut transaction, command, settings)
        .await
        .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(snapshot)
}

pub(crate) async fn admit_in(
    transaction: &mut sqlx::PgConnection,
    command: &FinalizationCommand,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<FinalizationJobSnapshot> {
    admit_with_id_in(transaction, command, settings, Uuid::now_v7())
        .await
        .context(h!())
}

pub(crate) async fn admit_with_id_in(
    transaction: &mut sqlx::PgConnection,
    command: &FinalizationCommand,
    settings: &DeviceUploadFinalizationSettings,
    id: Uuid,
) -> Result<FinalizationJobSnapshot> {
    if let Some(snapshot) =
        replay_in(transaction, command).await.context(h!())?
    {
        return Ok(snapshot);
    }
    anyhow::ensure!(
        settings.enabled && settings.is_valid(),
        FinalizationFailure::DependencyUnavailable
    );
    anyhow::ensure!(
        command.source_size_bytes >= 0,
        FinalizationFailure::CommandConflict
    );
    let (global, actor) = query::lock_budgets(
        &mut *transaction,
        command.kind(),
        command.created_by_login_id,
    )
    .await
    .context(h!())?;
    let (global_jobs, actor_jobs, global_bytes, actor_bytes) =
        match command.kind() {
            FinalizationKind::FinalizationFileKind => (
                settings.file_global_jobs,
                settings.file_actor_jobs,
                settings.file_global_bytes,
                settings.file_actor_bytes,
            ),
            FinalizationKind::FinalizationAudioKind => (
                settings.audio_global_jobs,
                settings.audio_actor_jobs,
                settings.audio_global_bytes,
                settings.audio_actor_bytes,
            ),
        };
    for (scope, jobs, bytes) in [
        (global, global_jobs, global_bytes),
        (actor, actor_jobs, actor_bytes),
    ] {
        let reserved = sqlx::query("update device_upload_finalization_budget set reserved_jobs=reserved_jobs+1,reserved_source_bytes=reserved_source_bytes+$2 where scope=$1 and reserved_jobs<$3 and reserved_source_bytes<=$4-$2")
            .bind(scope).bind(command.source_size_bytes).bind(i64::from(jobs)).bind(i64::try_from(bytes).context(h!())?)
            .execute(&mut *transaction).await.context(h!())?;
        anyhow::ensure!(
            reserved.rows_affected() == 1,
            FinalizationFailure::CapacityUnavailable
        );
    }
    insert_job(&mut *transaction, id, command, None)
        .await
        .context(h!())?;
    let row = sqlx::query("select to_jsonb(j) as job,clock_timestamp() as now from device_upload_finalization_job j where id=$1")
        .bind(id).fetch_one(&mut *transaction).await.context(h!())?;
    let (job, now) = query::decode_job(row).context(h!())?;
    let snapshot = job.snapshot(now).context(h!())?;
    Ok(snapshot)
}

pub(crate) async fn adopt_completed_in(
    transaction: &mut sqlx::PgConnection,
    command: &FinalizationCommand,
    result: &FinalizationResult,
) -> Result<FinalizationJobSnapshot> {
    if let Some(snapshot) =
        replay_in(transaction, command).await.context(h!())?
    {
        return Ok(snapshot);
    }
    let id = Uuid::now_v7();
    insert_job(transaction, id, command, Some(result))
        .await
        .context(h!())?;
    let row = sqlx::query("select to_jsonb(j) as job,clock_timestamp() as now from device_upload_finalization_job j where id=$1")
        .bind(id).fetch_one(transaction).await.context(h!())?;
    let (job, now) = query::decode_job(row).context(h!())?;
    job.snapshot(now).context(h!())
}

pub(crate) async fn replay_in(
    transaction: &mut sqlx::PgConnection,
    command: &FinalizationCommand,
) -> Result<Option<FinalizationJobSnapshot>> {
    if let FinalizationTarget::File {
        file_id, upload_id, ..
    } = &command.target
    {
        sqlx::query("select id from file_entry where id=$1 for update")
            .bind(file_id)
            .fetch_optional(&mut *transaction)
            .await
            .context(h!())?;
        sqlx::query(
            "select id from file_content_upload where id=$1 for update",
        )
        .bind(upload_id)
        .fetch_optional(&mut *transaction)
        .await
        .context(h!())?;
    }
    let identity = command.source_identity();
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "device-finalization:{}:{identity}",
            command.kind().as_str()
        ))
        .execute(&mut *transaction)
        .await
        .context(h!())?;
    if let Some(row) = sqlx::query("select to_jsonb(j) as job,clock_timestamp() as now from device_upload_finalization_job j where kind=$1 and source_identity=$2")
        .bind(command.kind().as_str()).bind(&identity).fetch_optional(&mut *transaction).await.context(h!())? {
        let (job, now) = query::decode_job(row).context(h!())?;
        anyhow::ensure!(job.created_by_login_id == command.created_by_login_id, FinalizationFailure::SourceOwned);
        anyhow::ensure!(job.matches(command), FinalizationFailure::CommandConflict);
        return Ok(Some(job.snapshot(now).context(h!())?));
    }
    Ok(None)
}

async fn insert_job(
    connection: &mut sqlx::PgConnection,
    id: Uuid,
    command: &FinalizationCommand,
    completed: Option<&FinalizationResult>,
) -> Result<()> {
    let (file_upload_id, file_id, revision, audio_id, name, started, pin, url) =
        match &command.target {
            FinalizationTarget::File {
                upload_id,
                file_id,
                revision,
            } => (
                Some(*upload_id),
                Some(*file_id),
                Some(*revision),
                None,
                None,
                None,
                None,
                None,
            ),
            FinalizationTarget::Audio {
                tus_id,
                audio_id,
                name,
                recording_started_at,
                pin_token,
            } => (
                None,
                None,
                None,
                Some(*audio_id),
                Some(name.as_str()),
                Some(
                    chrono::DateTime::from_timestamp_micros(
                        recording_started_at.timestamp_micros(),
                    )
                    .context(h!())?,
                ),
                Some(*pin_token),
                Some(format!(
                    "/api/device/audio/{}/uploads/{tus_id}.{}",
                    command.device_id, command.source_size_bytes
                )),
            ),
        };
    sqlx::query("insert into device_upload_finalization_job(id,kind,source_identity,created_by_login_id,device_id,file_upload_id,file_id,revision,audio_id,audio_name,audio_name_key,recording_started_at,upload_url,source_size_bytes,source_locator,pin_token,status,result,finished_at,source_release_state,source_released_at,quota_released_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,convert_to($10,'UTF8'),$11,$12,$13,$14,$15,case when $16::jsonb is null then 'queued' else 'completed' end,$16,case when $16::jsonb is not null then clock_timestamp() end,case when $16::jsonb is null then 'held' else 'released' end,case when $16::jsonb is not null then clock_timestamp() end,case when $16::jsonb is not null then clock_timestamp() end)")
        .bind(id).bind(command.kind().as_str()).bind(command.source_identity()).bind(command.created_by_login_id)
        .bind(command.device_id).bind(file_upload_id).bind(file_id).bind(revision).bind(audio_id).bind(name)
        .bind(started).bind(url).bind(command.source_size_bytes).bind(&command.source_locator).bind(pin)
        .bind(completed.map(|value| serde_json::json!({"version": 1, "value": value})))
        .execute(connection).await.context(h!())?;
    Ok(())
}
