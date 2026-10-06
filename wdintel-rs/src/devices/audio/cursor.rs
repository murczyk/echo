use super::{
    types::ListDeviceAudioCommand, DEVICE_AUDIO_CURSOR_VERSION,
    DEVICE_AUDIO_MAX_CURSOR_BYTES,
};
use crate::{
    h,
    types::{ShortContext, Uuid},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    device_id: Uuid,
    unprocessed_only: bool,
    start_us: i64,
    id: Uuid,
}

pub(super) struct Boundary {
    pub start: DateTime<Utc>,
    pub id: Uuid,
}

fn invalid() -> anyhow::Error {
    crate::error::AppError::BadRequestJson {
        body: serde_json::json!({"message":"Некоректний cursor списку аудіо"}),
    }
    .into()
}

pub(super) fn decode(
    command: &ListDeviceAudioCommand,
) -> anyhow::Result<Option<Boundary>> {
    let Some(value) = &command.cursor else {
        return Ok(None);
    };
    if value.len() > DEVICE_AUDIO_MAX_CURSOR_BYTES {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid())
        .c(h!())?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| invalid())
        .c(h!())?;
    if cursor.version != DEVICE_AUDIO_CURSOR_VERSION
        || cursor.device_id != command.device_id
        || cursor.unprocessed_only != command.unprocessed_only
    {
        return Err(invalid());
    }
    let start = DateTime::from_timestamp_micros(cursor.start_us)
        .ok_or_else(invalid)
        .c(h!())?;
    super::probe::checked_recording_end(start, 1)
        .map_err(|_| invalid())
        .c(h!())?;
    Ok(Some(Boundary {
        start,
        id: cursor.id,
    }))
}

pub(super) fn encode(
    command: &ListDeviceAudioCommand,
    start: DateTime<Utc>,
    id: Uuid,
) -> anyhow::Result<String> {
    let cursor = Cursor {
        version: DEVICE_AUDIO_CURSOR_VERSION,
        device_id: command.device_id,
        unprocessed_only: command.unprocessed_only,
        start_us: start.timestamp_micros(),
        id,
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).c(h!())?))
}
