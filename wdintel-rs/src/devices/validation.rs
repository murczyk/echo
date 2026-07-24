use crate::config::{
    DEVICE_CUSTOM_FIELDS_MAX_COUNT, DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS,
    DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS, DEVICE_EXTERNAL_URL_MAX_CHARS,
    DEVICE_LIST_DEFAULT_LIMIT, DEVICE_LIST_MAX_LIMIT, DEVICE_NAME_MAX_CHARS,
    DEVICE_SOURCE_LABEL_MAX_CHARS,
};
use crate::types::{AppError, BTreeMap, BTreeSet};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedPagination {
    pub limit: u64,
    pub offset: u64,
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        field.to_string(),
        message.to_string(),
    )]))
}

fn validate_max_chars(
    field: &str,
    value: &str,
    max_chars: usize,
) -> Result<(), AppError> {
    if value.chars().count() > max_chars {
        return Err(form_error(field, "Значення занадто довге"));
    }
    Ok(())
}

pub fn normalize_device_name(name: &str) -> Result<String, AppError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(form_error("name", "Назва не може бути порожньою"));
    }
    validate_max_chars("name", &name, DEVICE_NAME_MAX_CHARS)?;
    Ok(name)
}

pub fn normalize_source_label(source_label: &str) -> Result<String, AppError> {
    let source_label = source_label.trim().to_string();
    if source_label.is_empty() {
        return Err(form_error(
            "source_label",
            "Джерельна мітка не може бути порожньою",
        ));
    }
    validate_max_chars(
        "source_label",
        &source_label,
        DEVICE_SOURCE_LABEL_MAX_CHARS,
    )?;
    Ok(source_label)
}

pub(in crate::devices) fn validate_custom_fields_count(
    custom_fields: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    if custom_fields.len() > DEVICE_CUSTOM_FIELDS_MAX_COUNT {
        return Err(form_error("custom_fields", "Забагато кастомних полів"));
    }
    Ok(())
}

pub fn normalize_custom_fields(
    custom_fields: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, AppError> {
    validate_custom_fields_count(&custom_fields)?;

    let mut normalized = BTreeMap::new();
    for (key, value) in custom_fields {
        let key = normalize_custom_field_key(&key)?;
        validate_max_chars(
            "custom_fields",
            &value,
            DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS,
        )?;
        if normalized.insert(key, value).is_some() {
            return Err(form_error(
                "custom_fields",
                "Ключі кастомних полів мають бути унікальними",
            ));
        }
    }
    Ok(normalized)
}

pub fn normalize_custom_fields_patch(
    custom_fields: BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<String>>, AppError> {
    if custom_fields.len() > DEVICE_CUSTOM_FIELDS_MAX_COUNT {
        return Err(form_error("custom_fields", "Забагато кастомних полів"));
    }

    let mut normalized = BTreeMap::new();
    for (key, value) in custom_fields {
        let key = normalize_custom_field_key(&key)?;
        if let Some(value) = &value {
            validate_max_chars(
                "custom_fields",
                value,
                DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS,
            )?;
        }
        if normalized.insert(key, value).is_some() {
            return Err(form_error(
                "custom_fields",
                "Ключі кастомних полів мають бути унікальними",
            ));
        }
    }
    Ok(normalized)
}

fn normalize_custom_field_key(key: &str) -> Result<String, AppError> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(form_error(
            "custom_fields",
            "Ключ кастомного поля не може бути порожнім",
        ));
    }
    validate_max_chars(
        "custom_fields",
        &key,
        DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS,
    )?;
    Ok(key)
}

pub fn normalize_present_external_url(
    external_url: String,
) -> Result<String, AppError> {
    let external_url = external_url.trim();
    if external_url.is_empty() {
        return Err(form_error(
            "external_url",
            "Посилання не може бути порожнім",
        ));
    }
    normalize_nonempty_external_url(external_url)
}

fn normalize_nonempty_external_url(
    external_url: &str,
) -> Result<String, AppError> {
    validate_max_chars(
        "external_url",
        external_url,
        DEVICE_EXTERNAL_URL_MAX_CHARS,
    )?;

    let external_url = Url::parse(external_url).map_err(|_| {
        form_error("external_url", "Посилання має бути абсолютним URL")
    })?;
    if !matches!(external_url.scheme(), "http" | "https")
        || external_url.host_str().is_none()
    {
        return Err(form_error(
            "external_url",
            "Посилання має починатися з http:// або https://",
        ));
    }

    let external_url = external_url.to_string();
    validate_max_chars(
        "external_url",
        &external_url,
        DEVICE_EXTERNAL_URL_MAX_CHARS,
    )?;
    Ok(external_url)
}

pub fn normalize_unique_aor_ids(
    aor_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError> {
    let mut unique_ids = BTreeSet::new();
    for aor_id in aor_ids {
        if !unique_ids.insert(aor_id) {
            return Err(form_error("aor_ids", "Смуги не можуть повторюватися"));
        }
    }
    Ok(unique_ids.into_iter().collect())
}

pub fn normalize_device_list_pagination(
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<NormalizedPagination, AppError> {
    normalize_pagination(
        limit,
        offset,
        DEVICE_LIST_DEFAULT_LIMIT,
        DEVICE_LIST_MAX_LIMIT,
        "limit",
    )
}

fn normalize_pagination(
    limit: Option<u64>,
    offset: Option<u64>,
    default_limit: u64,
    max_limit: u64,
    limit_field: &str,
) -> Result<NormalizedPagination, AppError> {
    let limit = limit.unwrap_or(default_limit);
    if limit > max_limit {
        return Err(form_error(limit_field, "Завеликий ліміт сторінки"));
    }
    Ok(NormalizedPagination {
        limit,
        offset: offset.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests;
