use crate::{config, error::AppError, h, types::ShortContext};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Cursor<T> {
    version: u8,
    scope: String,
    boundary: T,
}

pub(super) fn encode<T: Serialize>(
    scope: &str,
    boundary: T,
) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            version: 1,
            scope: scope.to_owned(),
            boundary,
        })
        .c(h!())?,
    ))
}

pub(super) fn decode<T: DeserializeOwned>(
    value: &str,
    scope: &str,
) -> Result<T, AppError> {
    if value.len() > config::DEVICE_FILE_SESSION_CURSOR_MAX_BYTES {
        return Err(invalid("cursor"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid("cursor"))
        .c(h!())?;
    let cursor: Cursor<T> = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("cursor"))
        .c(h!())?;
    if cursor.version != 1 || cursor.scope != scope {
        return Err(invalid("cursor"));
    }
    Ok(cursor.boundary)
}

pub(super) fn invalid(field: &str) -> AppError {
    AppError::Form(std::collections::BTreeMap::from([(
        field.to_owned(),
        "Некоректне значення або область запиту".to_owned(),
    )]))
}
