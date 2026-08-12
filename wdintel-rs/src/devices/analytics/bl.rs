use super::query;
use super::queue;
use super::rules;
use super::types::{
    AdminAnalyticsTag, AnalyticsTag, DeviceAnalyticsFile,
    DeviceAnalyticsFilesRsp, DeviceAnalyticsSummaryItem,
    DeviceAnalyticsSummaryRsp, FileAnalysisInput, RuleExpression, RuleTestFile,
    RuleTestFileResult, RuleValidationError, TagFilter, TagMatch,
    TagRuleDefinition, TestAnalyticsTagRuleRsp,
};
use crate::devices::devices::query::{
    self as device_query, DeviceReadScope, FileRegistryDeviceAccess,
};
use crate::devices::files::{
    normalize_file_metadata, parse_source_path, FilesystemError,
};
use crate::entities::login;
use crate::error::AppError;
use crate::file_registry::{entities::analytics_tag, FileRegistryDb};
use crate::h;
use crate::types::ShortContext;
use chrono::{DateTime, SecondsFormat, Utc};
use sea_orm::{DatabaseConnection, DbErr, TransactionTrait};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error as StdError;
use std::sync::atomic::{AtomicU64, Ordering};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const TAG_NAME_MAX_CHARS: usize = 128;
const RULE_TEST_MAX_FILES: usize = 100;
const ANALYTICS_FILES_DEFAULT_LIMIT: u64 = 10;
const ANALYTICS_FILES_MAX_LIMIT: u64 = 100;
const ANALYTICS_FILE_LINK_CHUNK_SIZE: u64 = 101;
const ORPHAN_WARNING_INTERVAL_SECS: u64 = 60;

static LAST_ORPHAN_WARNING_AT: AtomicU64 = AtomicU64::new(0);

pub(super) async fn list_admin_tags(
    file_db: &DatabaseConnection,
) -> Result<Vec<AdminAnalyticsTag>, AppError> {
    let mut tags = query::list_tags(file_db).await.c(h!())?;
    sort_tags(&mut tags);
    tags.into_iter().map(map_admin_tag).collect()
}

pub(super) async fn list_tag_test_files(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
) -> Result<Vec<RuleTestFile>, AppError> {
    if query::find_tag(file_db, tag_id).await.c(h!())?.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(query::list_tag_test_files(file_db, tag_id)
        .await
        .c(h!())?
        .into_iter()
        .map(|file| RuleTestFile {
            absolute_path: file.absolute_path,
            expected_match: file.expected_match,
        })
        .collect())
}

pub(super) async fn create_tag(
    file_db: &DatabaseConnection,
    name: String,
) -> Result<AdminAnalyticsTag, AppError> {
    let name = normalize_tag_name(name)?;
    let tag = query::create_tag(file_db, Uuid::now_v7(), name)
        .await
        .map_err(map_tag_write_error)?;
    map_admin_tag(tag)
}

pub(super) async fn update_tag(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
    name: String,
) -> Result<AdminAnalyticsTag, AppError> {
    let name = normalize_tag_name(name)?;
    let tag = query::find_tag(file_db, tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let tag = query::update_tag_name(file_db, tag, name)
        .await
        .map_err(map_tag_write_error)?;
    map_admin_tag(tag)
}

pub(super) async fn save_rule(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
    rule_expression: Option<serde_json::Value>,
) -> Result<AdminAnalyticsTag, AppError> {
    let rule_expression = validate_rule_expression(tag_id, rule_expression)?;
    let transaction = file_db.begin().await.c(h!())?;
    let tag = query::lock_tag_for_rule_set_mutation(&transaction, tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let tag = query::save_tag_rule(
        &transaction,
        tag,
        rule_expression.map(|expression| {
            serde_json::to_value(expression).expect("RuleExpression serializes")
        }),
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    map_admin_tag(tag)
}

pub(super) async fn archive_tag(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
) -> Result<AdminAnalyticsTag, AppError> {
    let transaction = file_db.begin().await.c(h!())?;
    let tag = query::lock_tag_for_rule_set_mutation(&transaction, tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let tag = query::archive_tag(&transaction, tag).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    map_admin_tag(tag)
}

pub(super) async fn restore_tag(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
) -> Result<AdminAnalyticsTag, AppError> {
    let transaction = file_db.begin().await.c(h!())?;
    let tag = query::lock_tag_for_rule_set_mutation(&transaction, tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let tag = query::restore_tag(&transaction, tag).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    map_admin_tag(tag)
}

pub(super) async fn test_rule(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
    rule_expression: Option<serde_json::Value>,
    files: Vec<RuleTestFile>,
) -> Result<TestAnalyticsTagRuleRsp, AppError> {
    if files.len() > RULE_TEST_MAX_FILES {
        return Err(validation_app_error(validation_error(
            "files",
            "max_files_exceeded",
            "За один запит можна перевірити не більше 100 файлів",
        )));
    }

    let transaction = file_db.begin().await.c(h!())?;
    query::lock_tag(&transaction, tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let rule_expression = validate_rule_expression(tag_id, rule_expression)?;
    let files = prepare_rule_test_files(files)?;
    let results = match rule_expression {
        None => files
            .iter()
            .enumerate()
            .map(|(index, file)| RuleTestFileResult {
                index,
                matched: false,
                passed: !file.expected_match,
            })
            .collect(),
        Some(rule_expression) => {
            let compiled = rules::compile_tag_rules(vec![TagRuleDefinition {
                tag_id,
                rule_expression,
            }])
            .map_err(validation_app_error)?;
            files
                .iter()
                .enumerate()
                .map(|(index, file)| {
                    let result = rules::analyze(
                        &compiled,
                        &FileAnalysisInput {
                            name: &file.name,
                            absolute_path: &file.absolute_path,
                            extension: file.extension.as_deref(),
                        },
                    );
                    let matched = result.matched_tags == [tag_id];
                    RuleTestFileResult {
                        index,
                        matched,
                        passed: matched == file.expected_match,
                    }
                })
                .collect()
        }
    };
    query::replace_tag_test_files(&transaction, tag_id, &files)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(TestAnalyticsTagRuleRsp { results })
}

pub(super) async fn schedule_all_reanalysis(
    file_registry_db: &FileRegistryDb,
) -> Result<u64, AppError> {
    let rule_revision = query::rule_set_revision(file_registry_db.connection())
        .await
        .c(h!())?;
    Ok(queue::schedule_reanalysis(
        file_registry_db.connection(),
        None,
        rule_revision,
    )
    .await
    .c(h!())?)
}

pub(super) async fn schedule_device_reanalysis(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<u64, AppError> {
    device_query::find_visible_device(
        main_db,
        login,
        device_id,
        DeviceReadScope::IncludeArchived,
    )
    .await
    .c(h!())?;
    let rule_revision = query::rule_set_revision(file_registry_db.connection())
        .await
        .c(h!())?;
    Ok(queue::schedule_reanalysis(
        file_registry_db.connection(),
        Some(device_id),
        rule_revision,
    )
    .await
    .c(h!())?)
}

pub(in crate::devices) async fn hydrate_active_tags(
    file_db: &DatabaseConnection,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, Vec<AnalyticsTag>>, AppError> {
    Ok(query::load_active_tags_for_files(file_db, file_entry_ids)
        .await
        .c(h!())?
        .into_iter()
        .map(|(file_id, tags)| {
            (
                file_id,
                tags.into_iter().map(map_public_tag).collect::<Vec<_>>(),
            )
        })
        .collect())
}

pub(in crate::devices) async fn normalize_tag_filter(
    file_db: &DatabaseConnection,
    raw_tag_ids: Vec<String>,
    tag_match: Option<TagMatch>,
    untagged: bool,
) -> Result<Option<TagFilter>, AppError> {
    if untagged && !raw_tag_ids.is_empty() {
        return Err(validation_app_error(validation_error(
            "untagged",
            "conflicting_filter",
            "Фільтр без тегів не можна поєднувати з ідентифікаторами тегів",
        )));
    }
    if raw_tag_ids.is_empty() && tag_match.is_some() {
        return Err(validation_app_error(validation_error(
            "tag_match",
            "tag_ids_required",
            "Режим відповідності потребує хоча б одного тегу",
        )));
    }
    if raw_tag_ids.is_empty() && !untagged {
        return Ok(None);
    }

    let mut tag_ids = Vec::with_capacity(raw_tag_ids.len());
    let mut seen = BTreeSet::new();
    for (index, raw_tag_id) in raw_tag_ids.into_iter().enumerate() {
        let tag_id =
            parse_canonical_uuid(&raw_tag_id, &format!("tag_ids[{index}]"))?;
        if !seen.insert(tag_id) {
            return Err(validation_app_error(validation_error(
                &format!("tag_ids[{index}]"),
                "duplicate_tag_id",
                "Тег не можна вказувати повторно",
            )));
        }
        tag_ids.push(tag_id);
    }
    let active_tag_ids = query::find_active_tag_ids(file_db, &tag_ids)
        .await
        .c(h!())?;
    if let Some((index, _)) = tag_ids
        .iter()
        .enumerate()
        .find(|(_, tag_id)| !active_tag_ids.contains(tag_id))
    {
        return Err(validation_app_error(validation_error(
            &format!("tag_ids[{index}]"),
            "unknown_tag_id",
            "Тег не існує або архівований",
        )));
    }

    Ok(Some(TagFilter {
        tag_ids,
        tag_match: tag_match.unwrap_or(TagMatch::TagAny),
        untagged,
    }))
}

pub(in crate::devices) async fn load_active_tag_memberships(
    file_db: &DatabaseConnection,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, BTreeSet<Uuid>>, AppError> {
    Ok(query::load_active_tag_memberships(file_db, file_entry_ids)
        .await
        .c(h!())?)
}

pub(in crate::devices) fn matches_tag_filter(
    memberships: Option<&BTreeSet<Uuid>>,
    filter: &TagFilter,
) -> bool {
    let empty_memberships = BTreeSet::new();
    let memberships = memberships.unwrap_or(&empty_memberships);
    if filter.untagged {
        return memberships.is_empty();
    }
    match filter.tag_match {
        TagMatch::TagAny => filter
            .tag_ids
            .iter()
            .any(|tag_id| memberships.contains(tag_id)),
        TagMatch::TagAll => filter
            .tag_ids
            .iter()
            .all(|tag_id| memberships.contains(tag_id)),
    }
}

pub(super) async fn list_public_tags(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<Vec<AnalyticsTag>, AppError> {
    device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let mut tags = query::list_active_tags(file_registry_db.connection())
        .await
        .c(h!())?;
    sort_tags(&mut tags);
    Ok(tags.into_iter().map(map_public_tag).collect())
}

pub(super) async fn device_summary(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<DeviceAnalyticsSummaryRsp, AppError> {
    device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let mut summary =
        query::device_summary(file_registry_db.connection(), device_id)
            .await
            .c(h!())?;
    summary.items.sort_by(|left, right| {
        left.tag_name
            .cmp(&right.tag_name)
            .then_with(|| left.tag_id.cmp(&right.tag_id))
    });
    Ok(DeviceAnalyticsSummaryRsp {
        total_file_count: summary.total_file_count,
        analyzed_file_count: summary.analyzed_file_count,
        items: summary
            .items
            .into_iter()
            .map(|item| DeviceAnalyticsSummaryItem {
                tag: AnalyticsTag {
                    id: item.tag_id.to_string(),
                    name: item.tag_name,
                },
                file_count: item.file_count,
                latest_file_entry_created_at: format_datetime(
                    item.latest_file_entry_created_at,
                ),
            })
            .collect(),
    })
}

pub(super) async fn device_files(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
    tag_id: Uuid,
    limit: Option<u64>,
    cursor: Option<String>,
) -> Result<DeviceAnalyticsFilesRsp, AppError> {
    device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    query::find_active_tag(file_registry_db.connection(), tag_id)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let limit = normalize_files_limit(limit)?;
    let mut after = match cursor {
        Some(cursor) => {
            let cursor_id = parse_canonical_uuid(&cursor, "cursor")?;
            Some(
                query::resolve_file_link_cursor(
                    file_registry_db.connection(),
                    device_id,
                    tag_id,
                    cursor_id,
                )
                .await
                .c(h!())?
                .ok_or_else(|| {
                    validation_app_error(validation_error(
                        "cursor",
                        "invalid_cursor",
                        "Курсор не належить вибраному переліку",
                    ))
                })?,
            )
        }
        None => None,
    };

    let mut files = Vec::with_capacity(limit as usize);
    let mut next_cursor = None;
    let mut orphan_count = 0_u64;
    while files.len() < limit as usize {
        let remaining = limit - files.len() as u64;
        let chunk_limit = ANALYTICS_FILE_LINK_CHUNK_SIZE.max(remaining + 1);
        let links = query::list_file_links(
            file_registry_db.connection(),
            device_id,
            tag_id,
            after.as_ref(),
            chunk_limit,
        )
        .await
        .c(h!())?;
        if links.is_empty() {
            break;
        }
        let current_files = query::load_current_files(
            file_registry_db.connection(),
            device_id,
            &links
                .iter()
                .map(|link| link.file_entry_id)
                .collect::<Vec<_>>(),
        )
        .await
        .c(h!())?;
        let link_count = links.len();
        for (index, link) in links.into_iter().enumerate() {
            after = Some(link.clone());
            let Some(file) = current_files.get(&link.file_entry_id) else {
                orphan_count += 1;
                continue;
            };
            files.push(DeviceAnalyticsFile {
                file_id: file.id.to_string(),
                name: file.name.clone(),
                absolute_path: file.absolute_path.clone().unwrap_or_default(),
                file_entry_created_at: format_datetime(
                    link.file_entry_created_at,
                ),
            });
            if files.len() == limit as usize {
                if index + 1 < link_count || link_count == chunk_limit as usize
                {
                    next_cursor = Some(link.file_entry_id.to_string());
                }
                break;
            }
        }
        if files.len() == limit as usize || link_count < chunk_limit as usize {
            break;
        }
    }
    warn_about_orphan_links(orphan_count, device_id, tag_id);
    Ok(DeviceAnalyticsFilesRsp { files, next_cursor })
}

pub(super) fn validate_rule_expression(
    tag_id: Uuid,
    rule_expression: Option<serde_json::Value>,
) -> Result<Option<RuleExpression>, AppError> {
    let Some(rule_expression) = rule_expression else {
        return Ok(None);
    };
    let rule_expression = rules::deserialize_rule_expression(rule_expression)
        .map_err(validation_app_error)?;
    rules::compile_tag_rules(vec![TagRuleDefinition {
        tag_id,
        rule_expression: rule_expression.clone(),
    }])
    .map_err(validation_app_error)?;
    Ok(Some(rule_expression))
}

fn normalize_tag_name(name: String) -> Result<String, AppError> {
    let name = name.trim().nfc().collect::<String>();
    if name.is_empty() {
        return Err(validation_app_error(validation_error(
            "name",
            "required",
            "Назва тегу не може бути порожньою",
        )));
    }
    if name.chars().count() > TAG_NAME_MAX_CHARS {
        return Err(validation_app_error(validation_error(
            "name",
            "too_long",
            "Назва тегу не може містити більше 128 символів",
        )));
    }
    Ok(name)
}

fn normalize_files_limit(limit: Option<u64>) -> Result<u64, AppError> {
    let limit = limit.unwrap_or(ANALYTICS_FILES_DEFAULT_LIMIT);
    if !(1..=ANALYTICS_FILES_MAX_LIMIT).contains(&limit) {
        return Err(validation_app_error(validation_error(
            "limit",
            "out_of_range",
            "Ліміт має бути від 1 до 100",
        )));
    }
    Ok(limit)
}

pub(in crate::devices) fn parse_canonical_uuid(
    value: &str,
    path: &str,
) -> Result<Uuid, AppError> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        validation_app_error(validation_error(
            path,
            "invalid_uuid",
            "Значення має бути UUID у канонічному форматі",
        ))
    })?;
    if parsed.hyphenated().to_string() != value {
        return Err(validation_app_error(validation_error(
            path,
            "invalid_uuid",
            "Значення має бути UUID у канонічному форматі",
        )));
    }
    Ok(parsed)
}

fn map_admin_tag(
    tag: analytics_tag::Model,
) -> Result<AdminAnalyticsTag, AppError> {
    let rule_expression = tag
        .rule_expression
        .map(rules::deserialize_rule_expression)
        .transpose()
        .map_err(|error| AppError::AnyhowError {
            source: anyhow::anyhow!(
                "analytics tag {} contains an invalid rule: {} at {}",
                tag.id,
                error.code,
                error.path
            ),
        })?;
    Ok(AdminAnalyticsTag {
        id: tag.id.to_string(),
        name: tag.name,
        rule_expression,
        archived_at: tag.archived_at.map(format_datetime),
        created_at: format_datetime(tag.created_at),
        updated_at: format_datetime(tag.updated_at),
    })
}

fn map_public_tag(tag: analytics_tag::Model) -> AnalyticsTag {
    AnalyticsTag {
        id: tag.id.to_string(),
        name: tag.name,
    }
}

fn sort_tags(tags: &mut [analytics_tag::Model]) {
    tags.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn map_tag_write_error(error: DbErr) -> AppError {
    if is_postgres_unique_violation(&error) {
        AppError::ConflictJson {
            body: serde_json::to_value(validation_error(
                "name",
                "duplicate_name",
                "Тег із такою назвою вже існує",
            ))
            .expect("RuleValidationError serializes"),
        }
    } else {
        error.into()
    }
}

fn is_postgres_unique_violation(error: &DbErr) -> bool {
    let mut source: Option<&(dyn StdError + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(
            DbErr::Conn(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Exec(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Query(sea_orm::RuntimeErr::SqlxError(sqlx_error)),
        ) = current.downcast_ref::<DbErr>()
        {
            if let sqlx::Error::Database(database) = sqlx_error.as_ref() {
                if database.code().as_deref() == Some("23505") {
                    return true;
                }
            }
        }
        if let Some(sqlx::Error::Database(database)) =
            current.downcast_ref::<sqlx::Error>()
        {
            if database.code().as_deref() == Some("23505") {
                return true;
            }
        }
        source = current.source();
    }
    false
}

fn prepare_rule_test_files(
    files: Vec<RuleTestFile>,
) -> Result<Vec<query::PreparedRuleTestFile>, AppError> {
    files
        .into_iter()
        .enumerate()
        .map(|(index, file)| prepare_rule_test_file(index, file))
        .collect()
}

fn prepare_rule_test_file(
    index: usize,
    file: RuleTestFile,
) -> Result<query::PreparedRuleTestFile, AppError> {
    let field_prefix = format!("files[{index}]");
    let source_path = parse_source_path(
        file.absolute_path,
        &format!("{field_prefix}.absolute_path"),
    )
    .map_err(map_rule_test_file_error)?;
    let name = source_path.file_name().to_string();
    let metadata =
        normalize_file_metadata(&name, None, None, None, None, &field_prefix)
            .map_err(map_rule_test_file_error)?;
    Ok(query::PreparedRuleTestFile {
        name,
        absolute_path: source_path.absolute_path,
        extension: metadata.extension,
        expected_match: file.expected_match,
    })
}

fn map_rule_test_file_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => {
            let error = errors
                .into_iter()
                .next()
                .expect("filesystem validation has a field error");
            validation_app_error(validation_error(
                &error.path,
                "invalid_file_path",
                &error.message,
            ))
        }
        error => AppError::AnyhowError {
            source: anyhow::Error::new(error),
        },
    }
}

fn validation_app_error(error: RuleValidationError) -> AppError {
    AppError::BadRequestJson {
        body: serde_json::to_value(error)
            .expect("RuleValidationError serializes"),
    }
}

fn validation_error(
    path: &str,
    code: &str,
    message: &str,
) -> RuleValidationError {
    RuleValidationError {
        path: path.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn format_datetime<Tz>(value: DateTime<Tz>) -> String
where
    Tz: chrono::TimeZone,
    Tz::Offset: std::fmt::Display,
{
    value
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn warn_about_orphan_links(orphan_count: u64, device_id: Uuid, tag_id: Uuid) {
    if orphan_count == 0 {
        return;
    }
    let now = Utc::now().timestamp().max(0) as u64;
    let last = LAST_ORPHAN_WARNING_AT.load(Ordering::Relaxed);
    if now.saturating_sub(last) < ORPHAN_WARNING_INTERVAL_SECS {
        return;
    }
    if LAST_ORPHAN_WARNING_AT
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        log::warn!(
            "Skipped {orphan_count} orphan device_file_tag links for device {device_id} and tag {tag_id}"
        );
    }
}
