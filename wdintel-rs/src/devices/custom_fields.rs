use crate::h;
use crate::types::{AppError, BTreeMap, ShortContext};
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
    let custom_fields = custom_fields
        .as_object()
        .ok_or_else(|| {
            AppError::from(anyhow::anyhow!(
                "device custom_fields must be a JSON object"
            ))
        })
        .c(h!())?;

    custom_fields
        .iter()
        .map(|(key, value)| {
            let value = value
                .as_str()
                .ok_or_else(|| {
                    AppError::from(anyhow::anyhow!(
                        "device custom_fields value for {key:?} must be a string"
                    ))
                })
                .c(h!())?;
            Ok((key.clone(), value.to_owned()))
        })
        .collect()
}

pub(super) fn apply_custom_fields_patch(
    current: &Value,
    patch: BTreeMap<String, Option<String>>,
) -> Result<Value, AppError> {
    let mut custom_fields = custom_fields_from_json(current).c(h!())?;
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn custom_fields_round_trip_and_patch_keep_arbitrary_keys() {
        let fields = BTreeMap::from([
            ("inventory_id".to_string(), "node-1".to_string()),
            ("source_port".to_string(), "not-a-port".to_string()),
            ("source_version".to_string(), "2026.07".to_string()),
        ]);
        let value = custom_fields_to_json(fields.clone());
        assert_eq!(custom_fields_from_json(&value).unwrap(), fields);

        let patched = apply_custom_fields_patch(
            &value,
            BTreeMap::from([
                ("source_port".to_string(), None),
                ("source_version".to_string(), Some("2026.08".to_string())),
            ]),
        )
        .unwrap();
        assert_eq!(
            patched,
            json!({
                "inventory_id": "node-1",
                "source_version": "2026.08",
            })
        );
    }

    #[test]
    fn custom_fields_reject_non_string_values() {
        assert!(custom_fields_from_json(&json!({"inventory_id": 22})).is_err());
    }
}
