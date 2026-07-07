#![allow(dead_code)]

use crate::config::{
    DEVICE_CUSTOM_FIELDS_MAX_COUNT, DEVICE_CUSTOM_FIELD_LABEL_MAX_CHARS,
    DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS, DEVICE_EXTERNAL_URL_MAX_CHARS,
    DEVICE_FILE_CREATE_BATCH_MAX_COUNT, DEVICE_FILE_LIST_DEFAULT_LIMIT,
    DEVICE_FILE_LIST_MAX_LIMIT, DEVICE_FILE_ORIGINAL_ABSOLUTE_PATH_MAX_CHARS,
    DEVICE_FILE_ORIGINAL_NAME_MAX_CHARS, DEVICE_LIST_DEFAULT_LIMIT,
    DEVICE_LIST_MAX_LIMIT, DEVICE_NAME_MAX_CHARS,
};
use crate::devices::types::{CreateDeviceFileItem, DeviceCustomField};
use crate::entities::{area_of_responsibility, sigint_unit};
use crate::types::{AppError, BTreeMap, BTreeSet, Uuid};
use chrono::{DateTime, Utc};
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

pub fn normalized_device_name_key(name: &str) -> Result<String, AppError> {
    Ok(normalize_device_name(name)?.to_lowercase())
}

pub fn normalize_custom_fields(
    custom_fields: Vec<DeviceCustomField>,
) -> Result<Vec<DeviceCustomField>, AppError> {
    if custom_fields.len() > DEVICE_CUSTOM_FIELDS_MAX_COUNT {
        return Err(form_error("custom_fields", "Забагато додаткових полів"));
    }

    let mut labels = BTreeSet::new();
    custom_fields
        .into_iter()
        .enumerate()
        .map(|(idx, custom_field)| {
            normalize_custom_field(idx, custom_field, &mut labels)
        })
        .collect()
}

fn normalize_custom_field(
    idx: usize,
    custom_field: DeviceCustomField,
    labels: &mut BTreeSet<String>,
) -> Result<DeviceCustomField, AppError> {
    let label_field = format!("custom_fields.{idx}.label");
    let value_field = format!("custom_fields.{idx}.value");
    let label = custom_field.label.trim().to_string();
    let value = custom_field.value.trim().to_string();

    if label.is_empty() {
        return Err(form_error(
            &label_field,
            "Назва додаткового поля не може бути порожньою",
        ));
    }
    validate_max_chars(
        &label_field,
        &label,
        DEVICE_CUSTOM_FIELD_LABEL_MAX_CHARS,
    )?;
    validate_max_chars(
        &value_field,
        &value,
        DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS,
    )?;
    if !labels.insert(label.clone()) {
        return Err(form_error(
            &label_field,
            "Додаткове поле з такою назвою вже існує",
        ));
    }

    Ok(DeviceCustomField { label, value })
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

pub async fn validate_aor_id<C>(
    db: &C,
    aor_id: Option<i64>,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    let Some(aor_id) = aor_id else {
        return Ok(None);
    };

    let exists = area_of_responsibility::Entity::find_by_id(aor_id)
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .one(db)
        .await?
        .is_some();
    if !exists {
        return Err(form_error("aor_id", "Район відповідальності не знайдено"));
    }

    Ok(Some(aor_id))
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

pub fn parse_file_id(file_id: &str) -> Result<Uuid, AppError> {
    parse_uuid_field("file_id", file_id)
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

pub fn normalize_file_list_pagination(
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<NormalizedPagination, AppError> {
    normalize_pagination(
        limit,
        offset,
        DEVICE_FILE_LIST_DEFAULT_LIMIT,
        DEVICE_FILE_LIST_MAX_LIMIT,
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

pub fn normalize_optional_file_create_items(
    files: Option<Vec<CreateDeviceFileItem>>,
) -> Result<Vec<CreateDeviceFileItem>, AppError> {
    let Some(files) = files else {
        return Ok(Vec::new());
    };
    normalize_file_create_items(files, false)
}

pub fn normalize_required_file_create_items(
    files: Vec<CreateDeviceFileItem>,
) -> Result<Vec<CreateDeviceFileItem>, AppError> {
    normalize_file_create_items(files, true)
}

fn normalize_file_create_items(
    files: Vec<CreateDeviceFileItem>,
    reject_empty: bool,
) -> Result<Vec<CreateDeviceFileItem>, AppError> {
    if reject_empty && files.is_empty() {
        return Err(form_error("files", "Список файлів не може бути порожнім"));
    }
    if files.len() > DEVICE_FILE_CREATE_BATCH_MAX_COUNT {
        return Err(form_error("files", "Забагато файлів у запиті"));
    }

    files
        .into_iter()
        .enumerate()
        .map(|(idx, file)| normalize_file_create_item(idx, file))
        .collect()
}

fn normalize_file_create_item(
    idx: usize,
    file: CreateDeviceFileItem,
) -> Result<CreateDeviceFileItem, AppError> {
    let original_name = normalize_optional_text(
        format!("files.{idx}.original_name"),
        file.original_name,
        DEVICE_FILE_ORIGINAL_NAME_MAX_CHARS,
    )?;
    let original_absolute_path = normalize_optional_text(
        format!("files.{idx}.original_absolute_path"),
        file.original_absolute_path,
        DEVICE_FILE_ORIGINAL_ABSOLUTE_PATH_MAX_CHARS,
    )?;
    if original_name.is_none() && original_absolute_path.is_none() {
        return Err(form_error(
            &format!("files.{idx}"),
            "Потрібна назва файлу або абсолютний шлях",
        ));
    }

    Ok(CreateDeviceFileItem {
        original_name,
        original_absolute_path,
        original_created_at_ms: validate_optional_timestamp_ms(
            format!("files.{idx}.original_created_at_ms"),
            file.original_created_at_ms,
        )?,
        original_modified_at_ms: validate_optional_timestamp_ms(
            format!("files.{idx}.original_modified_at_ms"),
            file.original_modified_at_ms,
        )?,
    })
}

fn normalize_optional_text(
    field: String,
    value: Option<String>,
    max_chars: usize,
) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    validate_max_chars(&field, &value, max_chars)?;
    Ok(Some(value))
}

fn validate_optional_timestamp_ms(
    field: String,
    timestamp_ms: Option<i64>,
) -> Result<Option<i64>, AppError> {
    let Some(timestamp_ms) = timestamp_ms else {
        return Ok(None);
    };
    if DateTime::<Utc>::from_timestamp_millis(timestamp_ms).is_none() {
        return Err(form_error(&field, "Некоректний час файлу"));
    }
    Ok(Some(timestamp_ms))
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
    fn normalized_device_name_key_is_trimmed_and_lowercase() {
        assert_eq!(
            normalized_device_name_key("  Device Alpha  ").unwrap(),
            "device alpha"
        );
    }

    #[test]
    fn custom_fields_are_trimmed_and_duplicate_labels_are_rejected() {
        let fields = normalize_custom_fields(vec![DeviceCustomField {
            label: "  Serial  ".to_string(),
            value: "  123  ".to_string(),
        }])
        .unwrap();
        assert_eq!(fields[0].label, "Serial");
        assert_eq!(fields[0].value, "123");

        let err = normalize_custom_fields(vec![
            DeviceCustomField {
                label: "Serial".to_string(),
                value: "1".to_string(),
            },
            DeviceCustomField {
                label: "Serial".to_string(),
                value: "2".to_string(),
            },
        ])
        .unwrap_err();
        assert_form_field(err, "custom_fields.1.label");
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
    fn optional_file_batch_allows_empty_and_duplicate_metadata() {
        assert!(normalize_optional_file_create_items(Some(Vec::new()))
            .unwrap()
            .is_empty());
        let files = normalize_optional_file_create_items(Some(vec![
            CreateDeviceFileItem {
                original_name: Some(" file.txt ".to_string()),
                original_absolute_path: None,
                original_created_at_ms: Some(0),
                original_modified_at_ms: None,
            },
            CreateDeviceFileItem {
                original_name: Some(" file.txt ".to_string()),
                original_absolute_path: None,
                original_created_at_ms: Some(0),
                original_modified_at_ms: None,
            },
        ]))
        .unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].original_name.as_deref(), Some("file.txt"));
    }

    #[test]
    fn required_file_batch_rejects_empty_missing_metadata_and_bad_timestamp() {
        assert_form_field(
            normalize_required_file_create_items(Vec::new()).unwrap_err(),
            "files",
        );
        assert_form_field(
            normalize_required_file_create_items(vec![CreateDeviceFileItem {
                original_name: Some("   ".to_string()),
                original_absolute_path: None,
                original_created_at_ms: None,
                original_modified_at_ms: None,
            }])
            .unwrap_err(),
            "files.0",
        );
        assert_form_field(
            normalize_required_file_create_items(vec![CreateDeviceFileItem {
                original_name: Some("file.txt".to_string()),
                original_absolute_path: None,
                original_created_at_ms: Some(i64::MAX),
                original_modified_at_ms: None,
            }])
            .unwrap_err(),
            "files.0.original_created_at_ms",
        );
    }
}
