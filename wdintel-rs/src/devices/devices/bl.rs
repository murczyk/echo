mod read {
    use super::super::query::{self, DeviceReadScope};
    use super::super::types::{
        DeviceCurrentState, DeviceListSort,
        DomainDeviceUnitStat as DeviceUnitStat, ListDevicesCommand,
        ListDevicesResult,
    };
    use super::validation::normalize_device_list_pagination;
    use crate::config::DEVICE_NAME_MAX_CHARS;
    use crate::entities::login;
    use crate::error::AppError;
    use crate::h;
    use crate::types::{BTreeMap, BTreeSet, ShortContext, Uuid};
    use sea_orm::DatabaseConnection;

    pub(in crate::devices) async fn read(
        main_db: &DatabaseConnection,
        login: &login::Model,
        device_id: Uuid,
        scope: DeviceReadScope,
    ) -> Result<DeviceCurrentState, AppError> {
        Ok(query::read(main_db, login, device_id, scope)
            .await
            .c(h!())?)
    }

    pub(in crate::devices) async fn list(
        main_db: &DatabaseConnection,
        login: &login::Model,
        command: ListDevicesCommand,
    ) -> Result<ListDevicesResult, AppError> {
        let command = normalize_list_command(command).c(h!())?;
        Ok(query::list(main_db, login, command).await.c(h!())?)
    }

    pub(in crate::devices) async fn unit_stats(
        main_db: &DatabaseConnection,
        login: &login::Model,
    ) -> Result<Vec<DeviceUnitStat>, AppError> {
        Ok(query::unit_stats(main_db, login).await.c(h!())?)
    }

    fn normalize_list_command(
        command: ListDevicesCommand,
    ) -> Result<query::ListDevicesQuery, AppError> {
        let pagination =
            normalize_device_list_pagination(command.limit, command.offset)
                .c(h!())?;
        let filter_text = command
            .filter_text
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if filter_text
            .as_ref()
            .is_some_and(|value| value.chars().count() > DEVICE_NAME_MAX_CHARS)
        {
            return Err(form_error("filter_text", "Значення пошуку задовге"));
        }

        Ok(query::ListDevicesQuery {
            filter_text,
            archived_scope: command.archived_scope,
            aor_ids: command
                .aor_ids
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            unit_ids: command
                .unit_ids
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            limit: pagination.limit,
            offset: pagination.offset,
            sort_by: normalize_list_sort(command.sort_by).c(h!())?,
        })
    }

    fn normalize_list_sort(
        sort_by: Vec<DeviceListSort>,
    ) -> Result<Vec<DeviceListSort>, AppError> {
        let sort_by = if sort_by.is_empty() {
            vec![DeviceListSort::UpdatedAtDesc]
        } else {
            sort_by
        };
        let mut directions = BTreeMap::new();
        let mut normalized = Vec::with_capacity(sort_by.len());
        for sort in sort_by {
            let (field, descending) = match sort {
                DeviceListSort::DisplayTitleAsc => {
                    (DeviceSortField::DisplayTitle, false)
                }
                DeviceListSort::DisplayTitleDesc => {
                    (DeviceSortField::DisplayTitle, true)
                }
                DeviceListSort::CreatedAtAsc => {
                    (DeviceSortField::CreatedAt, false)
                }
                DeviceListSort::CreatedAtDesc => {
                    (DeviceSortField::CreatedAt, true)
                }
                DeviceListSort::UpdatedAtAsc => {
                    (DeviceSortField::UpdatedAt, false)
                }
                DeviceListSort::UpdatedAtDesc => {
                    (DeviceSortField::UpdatedAt, true)
                }
            };
            match directions.get(&field) {
                Some(previous) if *previous != descending => {
                    return Err(form_error(
                        "sort_by",
                        "Один критерій сортування не може мати різні напрямки",
                    ));
                }
                Some(_) => continue,
                None => {
                    directions.insert(field, descending);
                    normalized.push(sort);
                }
            }
        }
        Ok(normalized)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    enum DeviceSortField {
        DisplayTitle,
        CreatedAt,
        UpdatedAt,
    }

    fn form_error(path: &str, message: &str) -> AppError {
        AppError::Form(BTreeMap::from([(
            path.to_string(),
            message.to_string(),
        )]))
    }
}

mod write {
    use super::super::query::{self, DeviceChanges};
    use super::super::types::{
        CreateDeviceCommand, DeviceCurrentState, DevicePatchField,
        UpdateDeviceCommand,
    };
    use super::custom_fields::{
        apply_custom_fields_patch, custom_fields_from_json,
        custom_fields_to_json,
    };
    use super::validation::{
        normalize_custom_fields, normalize_custom_fields_patch,
        normalize_device_name, normalize_present_external_url,
        normalize_unique_aor_ids, validate_custom_fields_count,
    };
    use crate::devices::access;
    use crate::entities::{device, login};
    use crate::error::AppError;
    use crate::h;
    use crate::types::{BTreeMap, ShortContext, Utc, Uuid};
    use sea_orm::{
        DatabaseConnection, DatabaseTransaction, Set, TransactionTrait,
    };

    pub(in crate::devices) async fn create(
        main_db: &DatabaseConnection,
        login: &login::Model,
        command: CreateDeviceCommand,
    ) -> Result<DeviceCurrentState, AppError> {
        access::require_create(&login.roles).c(h!())?;

        let CreateDeviceCommand {
            name,
            external_url,
            custom_fields,
        } = command;
        let name = normalize_device_name(&name).c(h!())?;
        let external_url = external_url
            .map(normalize_present_external_url)
            .transpose()
            .c(h!())?;
        let custom_fields =
            normalize_custom_fields(custom_fields.unwrap_or_default())
                .c(h!())?;
        let device_id = Uuid::now_v7();
        let now = Utc::now().naive_utc();

        let transaction = main_db.begin().await.c(h!())?;
        let state = {
            let transaction_db = &transaction;
            let device = query::insert_device(
                transaction_db,
                device::ActiveModel {
                    id: Set(device_id),
                    name: Set(name),
                    created_by: Set(login.login.clone()),
                    organism_id: Set(access::organism_id(login).c(h!())?),
                    unit_id: Set(None),
                    tags: Set(serde_json::json!([])),
                    external_url: Set(external_url),
                    custom_fields: Set(custom_fields_to_json(custom_fields)),
                    archived: Set(false),
                    archived_at: Set(None),
                    created_at: Set(now),
                    updated_at: Set(now),
                },
            )
            .await
            .c(h!())?;
            let mut states =
                query::hydrate_devices(transaction_db, vec![device])
                    .await
                    .c(h!())?;
            states
                .pop()
                .ok_or_else(|| {
                    anyhow::anyhow!("device hydrator lost inserted device")
                })
                .c(h!())?
        };
        transaction.commit().await.c(h!())?;
        Ok(state)
    }
    pub(in crate::devices) async fn update(
        main_db: &DatabaseConnection,
        login: &login::Model,
        command: UpdateDeviceCommand,
    ) -> Result<DeviceCurrentState, AppError> {
        let field_groups = command.field_groups();
        access::require_field_groups(&login.roles, field_groups).c(h!())?;
        if command.is_structurally_empty() {
            return Err(empty_patch_error());
        }
        let command = normalize_update_command(command).c(h!())?;

        let transaction = main_db.begin().await.c(h!())?;
        let state = {
            let transaction_db = &transaction;
            let device = query::lock_active_visible_device(
                transaction_db,
                login,
                command.device_id,
            )
            .await
            .c(h!())?;
            lock_references(transaction_db, &command).await.c(h!())?;
            let current_aor_ids =
                query::load_current_aor_ids(transaction_db, device.id)
                    .await
                    .c(h!())?;
            let changes =
                collect_device_changes(&device, current_aor_ids, command)
                    .c(h!())?;

            let next_device = if changes.is_empty() {
                device
            } else {
                let now = Utc::now().naive_utc();
                if let Some(aor_ids) = &changes.aor_ids {
                    query::replace_device_aors(
                        transaction_db,
                        device.id,
                        aor_ids,
                        now,
                    )
                    .await
                    .c(h!())?;
                }
                query::apply_device_changes(
                    transaction_db,
                    device.id,
                    changes,
                    now,
                )
                .await
                .c(h!())?
            };
            let mut states =
                query::hydrate_devices(transaction_db, vec![next_device])
                    .await
                    .c(h!())?;
            states
                .pop()
                .ok_or_else(|| {
                    anyhow::anyhow!("device hydrator lost updated device")
                })
                .c(h!())?
        };
        transaction.commit().await.c(h!())?;
        Ok(state)
    }

    struct NormalizedUpdateDevice {
        device_id: Uuid,
        external_url: DevicePatchField<Option<String>>,
        custom_fields: DevicePatchField<BTreeMap<String, Option<String>>>,
        name: DevicePatchField<String>,
        aor_ids: DevicePatchField<Vec<i64>>,
        unit_id: DevicePatchField<Option<i64>>,
    }

    fn normalize_update_command(
        command: UpdateDeviceCommand,
    ) -> Result<NormalizedUpdateDevice, AppError> {
        Ok(NormalizedUpdateDevice {
            device_id: command.device_id,
            external_url: normalize_patch_field(
                command.external_url,
                |external_url| {
                    external_url.map(normalize_present_external_url).transpose()
                },
            )
            .c(h!())?,
            custom_fields: normalize_patch_field(
                command.custom_fields,
                normalize_custom_fields_patch,
            )
            .c(h!())?,
            name: normalize_patch_field(command.name, |name| {
                normalize_device_name(&name)
            })
            .c(h!())?,
            aor_ids: normalize_patch_field(
                command.aor_ids,
                normalize_unique_aor_ids,
            )
            .c(h!())?,
            unit_id: command.unit_id,
        })
    }

    fn normalize_patch_field<T, U>(
        field: DevicePatchField<T>,
        normalize: impl FnOnce(T) -> Result<U, AppError>,
    ) -> Result<DevicePatchField<U>, AppError> {
        match field {
            DevicePatchField::Missing => Ok(DevicePatchField::Missing),
            DevicePatchField::Value(value) => {
                Ok(DevicePatchField::Value(normalize(value).c(h!())?))
            }
        }
    }

    async fn lock_references(
        main_db: &DatabaseTransaction,
        command: &NormalizedUpdateDevice,
    ) -> Result<(), AppError> {
        if let DevicePatchField::Value(aor_ids) = &command.aor_ids {
            if !aor_ids.is_empty()
                && query::active_aor_count(main_db, aor_ids).await.c(h!())?
                    != aor_ids.len()
            {
                return Err(form_error("aor_ids", "Смугу не знайдено"));
            }
        }

        if let DevicePatchField::Value(Some(unit_id)) = &command.unit_id {
            if !query::active_unit_exists(main_db, *unit_id).await.c(h!())? {
                return Err(form_error("unit_id", "Підрозділ не знайдено"));
            }
        }

        Ok(())
    }

    fn collect_device_changes(
        device: &device::Model,
        current_aor_ids: Vec<i64>,
        command: NormalizedUpdateDevice,
    ) -> Result<DeviceChanges, AppError> {
        let external_url = match command.external_url {
            DevicePatchField::Value(external_url)
                if external_url != device.external_url =>
            {
                Some(external_url)
            }
            _ => None,
        };
        let custom_fields = match command.custom_fields {
            DevicePatchField::Value(custom_fields) => {
                let custom_fields = apply_custom_fields_patch(
                    &device.custom_fields,
                    custom_fields,
                )
                .c(h!())?;
                let final_custom_fields =
                    custom_fields_from_json(&custom_fields).c(h!())?;
                validate_custom_fields_count(&final_custom_fields).c(h!())?;
                (custom_fields != device.custom_fields).then_some(custom_fields)
            }
            DevicePatchField::Missing => None,
        };
        let name = match command.name {
            DevicePatchField::Value(name) if name != device.name => Some(name),
            _ => None,
        };
        let aor_ids = match command.aor_ids {
            DevicePatchField::Value(aor_ids) if aor_ids != current_aor_ids => {
                Some(aor_ids)
            }
            _ => None,
        };
        let unit_id = match command.unit_id {
            DevicePatchField::Value(unit_id) if unit_id != device.unit_id => {
                Some(unit_id)
            }
            _ => None,
        };

        Ok(DeviceChanges {
            external_url,
            custom_fields,
            name,
            aor_ids,
            unit_id,
        })
    }

    fn empty_patch_error() -> AppError {
        form_error("patch", "Потрібно передати хоча б одне поле для зміни")
    }

    fn form_error(field: &str, message: &str) -> AppError {
        AppError::Form(BTreeMap::from([(
            field.to_string(),
            message.to_string(),
        )]))
    }
}

mod mapping {
    use super::super::types::{
        AorSummary, DeviceAorReference, DeviceCurrentState,
        DeviceUnitReference, DomainDeviceUnitStat as DeviceUnitStat,
        ListDevicesResult,
    };
    use super::super::types::{
        DeviceDetails, DeviceListItem, DeviceStatusCounts,
        DeviceUnitStat as DeviceUnitStatDto, DeviceUnitStatsRsp,
        ListDevicesRsp, UnitSummary,
    };
    use crate::devices::types::format_datetime;

    pub(in crate::devices) fn map_device_details(
        device: DeviceCurrentState,
    ) -> DeviceDetails {
        DeviceDetails {
            id: device.id.hyphenated().to_string(),
            name: device.name,
            aors: device.aors.into_iter().map(map_aor).collect(),
            unit: device.unit.map(map_unit),
            external_url: device.external_url,
            custom_fields: device.custom_fields,
            created_by: device.created_by,
            archived: device.archived,
            created_at: format_datetime(device.created_at),
            updated_at: format_datetime(device.updated_at),
            archived_at: device.archived_at.map(format_datetime),
        }
    }

    pub(in crate::devices) fn map_device_list(
        result: ListDevicesResult,
    ) -> ListDevicesRsp {
        ListDevicesRsp {
            list: result
                .devices
                .into_iter()
                .map(map_device_list_item)
                .collect(),
            total: result.total,
            has_more: result.has_more,
            status_counts: DeviceStatusCounts {
                active: result.status_counts.active,
                archived: result.status_counts.archived,
            },
        }
    }

    pub(in crate::devices) fn map_device_unit_stats(
        units: Vec<DeviceUnitStat>,
    ) -> DeviceUnitStatsRsp {
        DeviceUnitStatsRsp {
            units: units
                .into_iter()
                .map(|unit| DeviceUnitStatDto {
                    unit: map_unit(unit.unit),
                    count: unit.count,
                })
                .collect(),
        }
    }

    fn map_device_list_item(device: DeviceCurrentState) -> DeviceListItem {
        DeviceListItem {
            id: device.id.hyphenated().to_string(),
            name: device.name,
            aors: device.aors.into_iter().map(map_aor).collect(),
            unit: device.unit.map(map_unit),
            created_by: device.created_by,
            archived: device.archived,
            created_at: format_datetime(device.created_at),
            updated_at: format_datetime(device.updated_at),
            archived_at: device.archived_at.map(format_datetime),
        }
    }

    fn map_aor(aor: DeviceAorReference) -> AorSummary {
        AorSummary {
            id: aor.id,
            name: aor.name,
        }
    }

    fn map_unit(unit: DeviceUnitReference) -> UnitSummary {
        UnitSummary {
            id: unit.id,
            name: unit.name,
        }
    }
}

pub(in crate::devices) use mapping::{
    map_device_details, map_device_list, map_device_unit_stats,
};
pub(in crate::devices) use read::{list, read, unit_stats};
pub(in crate::devices) use write::{create, update};

pub(super) mod custom_fields {
    use crate::h;
    use crate::types::{AppError, BTreeMap, ShortContext};
    use serde_json::{Map, Value};

    pub(in crate::devices::devices) fn custom_fields_to_json(
        custom_fields: BTreeMap<String, String>,
    ) -> Value {
        Value::Object(
            custom_fields
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect::<Map<_, _>>(),
        )
    }

    pub(in crate::devices::devices) fn custom_fields_from_json(
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

    pub(in crate::devices::devices) fn apply_custom_fields_patch(
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
}

pub(super) mod validation {
    use crate::config::{
        DEVICE_CUSTOM_FIELDS_MAX_COUNT, DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS,
        DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS, DEVICE_EXTERNAL_URL_MAX_CHARS,
        DEVICE_LIST_DEFAULT_LIMIT, DEVICE_LIST_MAX_LIMIT,
        DEVICE_NAME_MAX_CHARS,
    };
    use crate::h;
    use crate::types::{AppError, BTreeMap, BTreeSet, ShortContext};
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
        validate_max_chars("name", &name, DEVICE_NAME_MAX_CHARS).c(h!())?;
        Ok(name)
    }

    pub(in crate::devices) fn validate_custom_fields_count(
        custom_fields: &BTreeMap<String, String>,
    ) -> Result<(), AppError> {
        if custom_fields.len() > DEVICE_CUSTOM_FIELDS_MAX_COUNT {
            return Err(form_error(
                "custom_fields",
                "Забагато кастомних полів",
            ));
        }
        Ok(())
    }

    pub fn normalize_custom_fields(
        custom_fields: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, AppError> {
        validate_custom_fields_count(&custom_fields).c(h!())?;

        let mut normalized = BTreeMap::new();
        for (key, value) in custom_fields {
            let key = normalize_custom_field_key(&key).c(h!())?;
            validate_max_chars(
                "custom_fields",
                &value,
                DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS,
            )
            .c(h!())?;
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
            return Err(form_error(
                "custom_fields",
                "Забагато кастомних полів",
            ));
        }

        let mut normalized = BTreeMap::new();
        for (key, value) in custom_fields {
            let key = normalize_custom_field_key(&key).c(h!())?;
            if let Some(value) = &value {
                validate_max_chars(
                    "custom_fields",
                    value,
                    DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS,
                )
                .c(h!())?;
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
        )
        .c(h!())?;
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
        )
        .c(h!())?;

        let external_url = Url::parse(external_url)
            .map_err(|_| {
                form_error("external_url", "Посилання має бути абсолютним URL")
            })
            .c(h!())?;
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
        )
        .c(h!())?;
        Ok(external_url)
    }

    pub fn normalize_unique_aor_ids(
        aor_ids: Vec<i64>,
    ) -> Result<Vec<i64>, AppError> {
        let mut unique_ids = BTreeSet::new();
        for aor_id in aor_ids {
            if !unique_ids.insert(aor_id) {
                return Err(form_error(
                    "aor_ids",
                    "Смуги не можуть повторюватися",
                ));
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
}
