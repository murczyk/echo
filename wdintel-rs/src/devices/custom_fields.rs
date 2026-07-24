use crate::types::{AppError, BTreeMap};
use serde_json::{Map, Value};

pub(super) fn custom_fields_to_json(
    custom_fields: BTreeMap<String, String>,
) -> Value {
    Value::Object(
        custom_fields
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect::<Map<_, _>>(),
    )
}

pub(super) fn custom_fields_from_json(
    custom_fields: &Value,
) -> Result<BTreeMap<String, String>, AppError> {
    let custom_fields = custom_fields.as_object().ok_or_else(|| {
        AppError::from(anyhow::anyhow!(
            "device custom_fields must be a JSON object"
        ))
    })?;

    custom_fields
        .iter()
        .map(|(key, value)| {
            let value = value.as_str().ok_or_else(|| {
                AppError::from(anyhow::anyhow!(
                    "device custom_fields value for {key:?} must be a string"
                ))
            })?;
            Ok((key.clone(), value.to_owned()))
        })
        .collect()
}

pub(super) fn apply_custom_fields_patch(
    current: &Value,
    patch: BTreeMap<String, Option<String>>,
) -> Result<Value, AppError> {
    let mut custom_fields = custom_fields_from_json(current)?;
    for (key, value) in patch {
        match value {
            Some(value) => {
                custom_fields.insert(key, value);
            }
            None => {
                custom_fields.remove(&key);
            }
        }
    }
    Ok(custom_fields_to_json(custom_fields))
}

#[cfg(test)]
mod tests;
