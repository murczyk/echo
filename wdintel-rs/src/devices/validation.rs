#![allow(dead_code)]

use crate::config::{
    DEVICE_CUSTOM_FIELDS_MAX_COUNT, DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS,
    DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS, DEVICE_EXTERNAL_URL_MAX_CHARS,
    DEVICE_LIST_DEFAULT_LIMIT, DEVICE_LIST_MAX_LIMIT, DEVICE_NAME_MAX_CHARS,
    DEVICE_SOURCE_LABEL_MAX_CHARS, DEVICE_TAGS_MAX_COUNT,
    DEVICE_TAG_LABEL_MAX_CHARS, DEVICE_TAG_VALUE_MAX_CHARS,
};
use crate::devices::types::DeviceTag;
use crate::entities::{area_of_responsibility, sigint_unit};
use crate::types::{AppError, BTreeMap, BTreeSet, Uuid};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
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

pub fn normalize_custom_fields(
    custom_fields: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, AppError> {
    if custom_fields.len() > DEVICE_CUSTOM_FIELDS_MAX_COUNT {
        return Err(form_error("custom_fields", "Забагато кастомних полів"));
    }

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

pub fn normalize_tags(
    tags: Vec<DeviceTag>,
) -> Result<Vec<DeviceTag>, AppError> {
    if tags.len() > DEVICE_TAGS_MAX_COUNT {
        return Err(form_error("tags", "Забагато тегів"));
    }

    let mut labels = BTreeSet::new();
    tags.into_iter()
        .enumerate()
        .map(|(idx, tag)| normalize_tag(idx, tag, &mut labels))
        .collect()
}

fn normalize_tag(
    idx: usize,
    tag: DeviceTag,
    labels: &mut BTreeSet<String>,
) -> Result<DeviceTag, AppError> {
    let label_field = format!("tags.{idx}.label");
    let value_field = format!("tags.{idx}.value");
    let label = tag.label.trim().to_string();
    let value = tag.value.trim().to_string();

    if label.is_empty() {
        return Err(form_error(
            &label_field,
            "Назва тегу не може бути порожньою",
        ));
    }
    validate_max_chars(&label_field, &label, DEVICE_TAG_LABEL_MAX_CHARS)?;
    validate_max_chars(&value_field, &value, DEVICE_TAG_VALUE_MAX_CHARS)?;
    if !labels.insert(label.clone()) {
        return Err(form_error(&label_field, "Тег з такою назвою вже існує"));
    }

    Ok(DeviceTag { label, value })
}

pub fn normalize_external_url(
    external_url: Option<String>,
) -> Result<Option<String>, AppError> {
    let Some(external_url) = external_url else {
        return Ok(None);
    };

    let external_url = external_url.trim();
    if external_url.is_empty() {
        return Ok(None);
    }
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
    Ok(Some(external_url))
}

pub async fn validate_aor_ids<C>(
    db: &C,
    aor_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    let mut unique_ids = Vec::new();
    let mut seen_ids = BTreeSet::new();
    for smuha_id in aor_ids {
        if seen_ids.insert(smuha_id) {
            unique_ids.push(smuha_id);
        }
    }
    if unique_ids.is_empty() {
        return Ok(unique_ids);
    }

    let found_ids = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.is_in(unique_ids.clone()))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(db)
        .await?
        .into_iter()
        .map(|aor| aor.id)
        .collect::<BTreeSet<_>>();
    if found_ids.len() != unique_ids.len() {
        return Err(form_error("aor_ids", "Смугу не знайдено"));
    }

    Ok(unique_ids)
}

pub async fn validate_unit_id<C>(
    db: &C,
    unit_id: Option<i64>,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    let Some(unit_id) = unit_id else {
        return Ok(None);
    };

    let exists = sigint_unit::Entity::find_by_id(unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(db)
        .await?
        .is_some();
    if !exists {
        return Err(form_error("unit_id", "Підрозділ не знайдено"));
    }

    Ok(Some(unit_id))
}

pub fn parse_device_id(device_id: &str) -> Result<Uuid, AppError> {
    parse_uuid_field("device_id", device_id)
}

fn parse_uuid_field(field: &str, value: &str) -> Result<Uuid, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(form_error(field, "Ідентифікатор не може бути порожнім"));
    }
    Uuid::parse_str(value).map_err(|_| form_error(field, "Некоректний UUID"))
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
mod tests {
    use super::*;

    fn assert_form_field(err: AppError, field: &str) {
        match err {
            AppError::Form(errors) => assert!(errors.contains_key(field)),
            err => panic!("unexpected error: {err:?}"),
        }
    }

    #[test]
    fn device_name_is_trimmed_and_required() {
        assert_eq!(normalize_device_name("  Device  ").unwrap(), "Device");
        assert_form_field(normalize_device_name("   ").unwrap_err(), "name");
    }

    #[test]
    fn tags_are_trimmed_and_duplicate_labels_are_rejected() {
        let fields = normalize_tags(vec![DeviceTag {
            label: "  Serial  ".to_string(),
            value: "  123  ".to_string(),
        }])
        .unwrap();
        assert_eq!(fields[0].label, "Serial");
        assert_eq!(fields[0].value, "123");

        let err = normalize_tags(vec![
            DeviceTag {
                label: "Serial".to_string(),
                value: "1".to_string(),
            },
            DeviceTag {
                label: "Serial".to_string(),
                value: "2".to_string(),
            },
        ])
        .unwrap_err();
        assert_form_field(err, "tags.1.label");
    }

    #[test]
    fn external_url_empty_becomes_none_and_relative_url_is_rejected() {
        assert_eq!(
            normalize_external_url(Some("   ".to_string())).unwrap(),
            None
        );
        assert_eq!(
            normalize_external_url(Some(
                "https://example.com/path".to_string()
            ))
            .unwrap()
            .as_deref(),
            Some("https://example.com/path")
        );
        assert_form_field(
            normalize_external_url(Some("/relative".to_string())).unwrap_err(),
            "external_url",
        );
    }

    #[test]
    fn source_label_and_custom_fields_are_normalized_without_special_keys() {
        assert_eq!(
            normalize_source_label("  source-device  ").unwrap(),
            "source-device"
        );
        assert_form_field(
            normalize_source_label("   ").unwrap_err(),
            "source_label",
        );

        let fields = normalize_custom_fields(BTreeMap::from([
            (" inventory_id ".to_string(), "node-1".to_string()),
            ("source_port".to_string(), "not-a-port".to_string()),
        ]))
        .unwrap();
        assert_eq!(
            fields,
            BTreeMap::from([
                ("inventory_id".to_string(), "node-1".to_string()),
                ("source_port".to_string(), "not-a-port".to_string()),
            ])
        );

        let patch = normalize_custom_fields_patch(BTreeMap::from([
            (" inventory_id ".to_string(), Some("node-2".to_string())),
            ("source_port".to_string(), None),
        ]))
        .unwrap();
        assert_eq!(
            patch,
            BTreeMap::from([
                ("inventory_id".to_string(), Some("node-2".to_string())),
                ("source_port".to_string(), None),
            ])
        );
        assert_form_field(
            normalize_custom_fields(BTreeMap::from([(
                " ".to_string(),
                "value".to_string(),
            )]))
            .unwrap_err(),
            "custom_fields",
        );
    }
}
