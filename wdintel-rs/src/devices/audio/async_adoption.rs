use base64::Engine;
use uuid::Uuid;

use super::{query, types::ReceiveDeviceAudioCommand, unavailable};
use crate::devices::upload_finalization::{
    self as finalization, admission, types::*,
};
use crate::{
    error::AppError,
    h,
    types::{Env, ShortContext},
};

pub(super) async fn adopt(
    env: &Env,
    actor: Uuid,
    upload_id: Uuid,
    size: u64,
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<Option<FinalizationJobSnapshot>> {
    let db = env.device_audio.file_database().c(h!())?;
    let Some(attempt) = query::find_upload_attempt(db, upload_id)
        .await
        .map_err(|_| unavailable("audio publication proof is unavailable"))
        .c(h!())?
    else {
        return Ok(None);
    };
    if attempt.actor_id != actor || attempt.device_id != command.device_id {
        return Err(AppError::NotFound.into());
    }
    finalization::authorize_read(
        env,
        actor,
        command.device_id,
        FinalizationKind::FinalizationAudioKind,
    )
    .await
    .c(h!())?;
    if attempt.name != command.name
        || attempt.recording_started_at != command.recording_started_at
        || query::attempt_source_size(&attempt) != Some(size)
    {
        return Err(query::conflict(
            "command_conflict",
            "Метадані прийнятого завантаження не можна змінити",
        ));
    }
    if attempt.status != "ready" {
        return Err(unavailable(
            "source already belongs to synchronous finalization",
        )
        .into());
    }
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .map_err(|_| unavailable("audio publication proof is unavailable"))
        .c(h!())?;
    let receipt = query::own_ready_in(&mut transaction, &attempt)
        .await
        .map_err(|_| unavailable("audio publication proof is unavailable"))
        .c(h!())?;
    let adopted = FinalizationCommand {
        created_by_login_id: actor,
        device_id: command.device_id,
        source_size_bytes: i64::try_from(size).c(h!())?,
        source_locator: Some(format!(
            "device-audio-tus/{}/file_upload_tus/completed/{}/{upload_id}.{size}",
            command.device_id,
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(actor.as_bytes()),
        )),
        target: FinalizationTarget::Audio {
            tus_id: upload_id,
            audio_id: attempt.audio_id,
            name: command.name.clone(),
            recording_started_at: command.recording_started_at,
            pin_token: Uuid::now_v7(),
        },
    };
    let snapshot = admission::adopt_completed_in(
        &mut transaction,
        &adopted,
        &FinalizationResult::FinalizationAudioResult(receipt),
    )
    .await
    .map_err(super::async_ingest::admission_error)
    .c(h!())?;
    transaction
        .commit()
        .await
        .map_err(|_| unavailable("finalization adoption must be retried"))
        .c(h!())?;
    Ok(Some(snapshot))
}
