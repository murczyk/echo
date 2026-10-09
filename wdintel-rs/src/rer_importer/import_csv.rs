use crate::config::{
    Config, IMPORT_DIRECTION_FINDING_UUID, RER_CSV_IMPORT_SKIP_PREVIEW_CHARS,
    RER_CSV_PREFLIGHT_METADATA_HEADER,
};
use crate::delta::finish_bgtask;
use crate::messenger::id;
use crate::rer_importer::bgtask_log;
use crate::users::{ensure_admin, ensure_message_write};
use crate::utils::*;
use crate::{entities::*, error::*, types::*};
use actix_multipart::Multipart;
use actix_web::{get, post, web, web::Json, HttpResponse};
use anyhow::Context;
use chrono::prelude::*;
use chrono_tz::Tz;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::ActiveValue::Set;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::{io::Cursor, io::Read, path::Path};
use tempfile::TempDir;

#[cfg(test)]
mod duplicate_tests;
mod persistence;
use persistence::RerCsvPersistence;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RerCsvRecord {
    source_record: usize,
    body: String,
}

#[derive(Debug)]
struct HistoricalRecordValidation {
    timestamp: Option<NaiveDateTime>,
    invalid_message_size: bool,
}

impl HistoricalRecordValidation {
    fn missing_timestamp(&self) -> bool {
        self.timestamp.is_none()
    }

    fn should_skip(&self) -> bool {
        self.missing_timestamp() || self.invalid_message_size
    }
}

#[derive(Debug)]
struct HistoricalCsvPreflight {
    reference_timestamp_ms: i64,
    total: usize,
    valid: usize,
    missing_timestamp: usize,
    invalid_message_size: usize,
    skipped_records: Vec<RerCsvRecord>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct RerCsvPreflightMetadata {
    pub reference_timestamp_ms: i64,
    pub total: usize,
    pub valid: usize,
    pub missing_timestamp: usize,
    pub invalid_message_size: usize,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct RerCsvImportSignalGroup {
    pub master_key: String,
    pub name: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct RerCsvImportOptions {
    pub signal_groups: Vec<RerCsvImportSignalGroup>,
    pub default_target_signal_group_master_key: Option<String>,
}

fn read_rer_csv_records(
    reader: impl Read,
) -> anyhow::Result<Vec<RerCsvRecord>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(reader);
    let mut records = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.c(h!())?;
        anyhow::ensure!(
            record.len() == 1,
            "CSV record {} must contain exactly one column",
            index + 1,
        );
        let body = record
            .get(0)
            .unwrap_or_default()
            .trim()
            .replace("\r\n", "\n");
        if !body.is_empty() {
            records.push(RerCsvRecord {
                source_record: index + 1,
                body,
            });
        }
    }
    Ok(records)
}

fn validate_historical_record(
    lnow: DateTime<Tz>,
    record: &RerCsvRecord,
) -> HistoricalRecordValidation {
    let timestamp = crate::inbox::extract_message_datetime_with_precision(
        lnow,
        &record.body,
        false,
    )
    .ok()
    .and_then(|(datetime, _)| datetime)
    .filter(|datetime| !datetime.was_future_normalized)
    .map(|datetime| datetime.datetime.with_timezone(&Utc).naive_utc())
    .filter(|timestamp| id::is_message_uid_datetime_supported(*timestamp));
    let invalid_message_size =
        crate::rer_importer::multimessage::is_invalid_for_historical_csv_import(
            lnow,
            &record.body,
        );
    HistoricalRecordValidation {
        timestamp,
        invalid_message_size,
    }
}

fn preflight_historical_csv(
    lnow: DateTime<Tz>,
    records: Vec<RerCsvRecord>,
) -> HistoricalCsvPreflight {
    let total = records.len();
    let mut missing_timestamp = 0;
    let mut invalid_message_size = 0;
    let mut skipped_records = Vec::new();
    for record in records {
        let validation = validate_historical_record(lnow, &record);
        missing_timestamp += usize::from(validation.missing_timestamp());
        invalid_message_size += usize::from(validation.invalid_message_size);
        if validation.should_skip() {
            skipped_records.push(record);
        }
    }
    HistoricalCsvPreflight {
        reference_timestamp_ms: lnow.timestamp_millis(),
        total,
        valid: total - skipped_records.len(),
        missing_timestamp,
        invalid_message_size,
        skipped_records,
    }
}

#[cfg(test)]
fn write_rer_csv_records(records: &[RerCsvRecord]) -> anyhow::Result<Vec<u8>> {
    write_rer_csv_bodies(records.iter().map(|record| record.body.as_str()))
        .c(h!())
}

fn write_rer_csv_bodies<I, B>(bodies: I) -> anyhow::Result<Vec<u8>>
where
    I: IntoIterator<Item = B>,
    B: AsRef<str>,
{
    let mut bytes = Vec::new();
    {
        let mut writer = csv::WriterBuilder::new()
            .has_headers(false)
            .from_writer(&mut bytes);
        for body in bodies {
            writer.serialize((body.as_ref(),)).c(h!())?;
        }
        writer.flush().c(h!())?;
    }
    Ok(bytes)
}

fn prepare_historical_csv_preflight(
    lnow: DateTime<Tz>,
    reader: impl Read,
) -> anyhow::Result<(HistoricalCsvPreflight, Vec<u8>)> {
    let records = read_rer_csv_records(reader).c(h!())?;
    let mut preflight = preflight_historical_csv(lnow, records);
    let skipped_records = std::mem::take(&mut preflight.skipped_records);
    let body = write_rer_csv_bodies(
        skipped_records.into_iter().map(|record| record.body),
    )
    .c(h!())?;
    Ok((preflight, body))
}

fn skipped_messages_filename(field: &actix_multipart::Field) -> String {
    let source = field
        .content_disposition()
        .and_then(|disposition| disposition.get_filename())
        .or_else(|| field.name())
        .unwrap_or("upload.csv");
    skipped_messages_filename_from_source(source)
}

fn skipped_messages_filename_from_source(source: &str) -> String {
    let basename = source
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("upload.csv");
    let stem = Path::new(basename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty() && *stem != "." && *stem != "..")
        .unwrap_or("upload");
    format!("{stem}-skipped-messages.csv")
}

fn csv_import_log_preview(body: &str) -> String {
    let mut preview = String::with_capacity(
        RER_CSV_IMPORT_SKIP_PREVIEW_CHARS + '…'.len_utf8(),
    );
    let mut preview_chars = 0;
    for word in body.split_whitespace() {
        if !preview.is_empty() {
            if preview_chars == RER_CSV_IMPORT_SKIP_PREVIEW_CHARS {
                preview.push('…');
                return preview;
            }
            preview.push(' ');
            preview_chars += 1;
        }
        for character in word.chars() {
            if preview_chars == RER_CSV_IMPORT_SKIP_PREVIEW_CHARS {
                preview.push('…');
                return preview;
            }
            preview.push(character);
            preview_chars += 1;
        }
    }
    preview
}

fn historical_csv_preflight_response(
    preflight: HistoricalCsvPreflight,
    filename: String,
    body: Vec<u8>,
) -> anyhow::Result<HttpResponse> {
    let metadata = serde_json::to_string(&RerCsvPreflightMetadata {
        reference_timestamp_ms: preflight.reference_timestamp_ms,
        total: preflight.total,
        valid: preflight.valid,
        missing_timestamp: preflight.missing_timestamp,
        invalid_message_size: preflight.invalid_message_size,
    })
    .c(h!())?;
    Ok(HttpResponse::Ok()
        .insert_header((RER_CSV_PREFLIGHT_METADATA_HEADER, metadata))
        .insert_header(("cache-control", "private, no-store"))
        .insert_header(multipart::download_content_disposition(filename))
        .content_type("text/csv; charset=utf-8")
        .body(body))
}

#[derive(Debug)]
struct RerCsvImportStats {
    total: usize,
    imported: usize,
    reused: usize,
    duplicates: usize,
    skipped: usize,
    missing_timestamp: usize,
    invalid_message_size: usize,
}

struct RerCsvImportContext<'a> {
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    dbx: &'a DatabaseConnection,
    rq: &'a reqwest::Client,
    config: &'a Config,
    group_id: String,
    datasource_group_id: i64,
    source_uuid: String,
    import_as_new: bool,
    reconcile_target_group: bool,
    lnow: DateTime<Tz>,
}

impl RerCsvImportStats {
    fn new(total: usize) -> Self {
        Self {
            total,
            imported: 0,
            reused: 0,
            duplicates: 0,
            skipped: 0,
            missing_timestamp: 0,
            invalid_message_size: 0,
        }
    }
}

async fn rer_csv_import_record_timestamp(
    record: &RerCsvRecord,
    import_as_new: bool,
    lnow: DateTime<Tz>,
    bgid: Option<i64>,
    dbx: &DatabaseConnection,
    stats: &mut RerCsvImportStats,
) -> anyhow::Result<Option<NaiveDateTime>> {
    if import_as_new {
        return Ok(Some(Utc::now().naive_utc()));
    }

    let validation = validate_historical_record(lnow, record);
    if !validation.should_skip() {
        return Ok(validation.timestamp);
    }

    stats.skipped += 1;
    stats.missing_timestamp += usize::from(validation.missing_timestamp());
    stats.invalid_message_size += usize::from(validation.invalid_message_size);
    let mut reasons = Vec::new();
    if validation.missing_timestamp() {
        reasons.push("missing or unsupported timestamp");
    }
    if validation.invalid_message_size {
        reasons.push("invalid message size");
    }
    let warning = format!(
        "> warning: skipped CSV record {} ({}): {}",
        record.source_record,
        reasons.join(", "),
        csv_import_log_preview(&record.body),
    );
    warn!("{warning}");
    bgtask_log(bgid, &warning, dbx).await.context(h!())?;
    Ok(None)
}

async fn insert_rer_csv_message<C: ConnectionTrait>(
    context: &RerCsvImportContext<'_>,
    body: String,
    timestamp: NaiveDateTime,
    dbx: &C,
) -> anyhow::Result<i64> {
    let message = signal_message::ActiveModel {
        id: NotSet,
        id_uuid: Set(Some(crate::sigint::message_id::signal_message_uuid(
            Some(timestamp),
            timestamp,
        ))),
        body: Set(Some(body)),
        created_at: NotSet,
        timestamp: Set(Some(timestamp)),
        sender: Set(Some(context.source_uuid.clone())),
        login_id: NotSet,
        format: Set(Some(2)),
        deleted: Set(false),
        external_id: NotSet,
        echo_inbox_message_id: Set(None),
        message_uid: NotSet,
        datasource_group_id: Set(Some(context.datasource_group_id)),
        operator_tags: NotSet,
        attachments_hash: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?;
    let message_id = message.id;
    let message_uid = id::generate_message_id(
        id::MessageMeta {
            id: message.id,
            datetime: message.created_at,
        },
        context.config,
    )
    .c(h!())?;
    let mut message = message.into_active_model();
    if !context.import_as_new {
        message.created_at = Set(timestamp);
    }
    message.message_uid = Set(Some(message_uid));
    let message = message.update(dbx).await.c(h!())?;

    signal_message_group::ActiveModel {
        id: NotSet,
        signal_message_id: Set(message.id),
        signal_message_uuid: Set(message.id_uuid),
        group_master_key: Set(Some(context.group_id.clone())),
        sender: Set(message.sender.clone()),
        login_id: Set(message.login_id),
        message_uid: Set(message.message_uid.clone()),
        datasource_group_id: Set(message.datasource_group_id),
        created_at: Set(message.created_at),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    Ok(message_id)
}

async fn reconcile_rer_csv_message_target_group(
    context: &RerCsvImportContext<'_>,
    message_id: i64,
) -> anyhow::Result<()> {
    let txn = context.dbx.begin().await.context(h!())?;
    reconcile_rer_csv_message_target_group_in_transaction(
        &context.group_id,
        context.datasource_group_id,
        message_id,
        &txn,
    )
    .await
    .context(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn reconcile_rer_csv_message_target_group_in_transaction<
    C: ConnectionTrait,
>(
    group_id: &str,
    datasource_group_id: i64,
    message_id: i64,
    txn: &C,
) -> anyhow::Result<()> {
    let message = signal_message::Entity::find_by_id(message_id)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    let message = if message.datasource_group_id != Some(datasource_group_id) {
        let mut message_act = message.into_active_model();
        message_act.datasource_group_id = Set(Some(datasource_group_id));
        message_act.update(txn).await.context(h!())?
    } else {
        message
    };
    let group_link = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message.id))
        .filter(signal_message_group::Column::GroupMasterKey.eq(group_id))
        .order_by_asc(signal_message_group::Column::Id)
        .one(txn)
        .await
        .context(h!())?;
    match group_link {
        Some(group_link)
            if group_link.signal_message_uuid != message.id_uuid
                || group_link.sender != message.sender
                || group_link.login_id != message.login_id
                || group_link.message_uid != message.message_uid
                || group_link.datasource_group_id
                    != Some(datasource_group_id)
                || group_link.created_at != message.created_at =>
        {
            let mut group_link_act = group_link.into_active_model();
            group_link_act.signal_message_uuid = Set(message.id_uuid);
            group_link_act.sender = Set(message.sender.clone());
            group_link_act.login_id = Set(message.login_id);
            group_link_act.message_uid = Set(message.message_uid.clone());
            group_link_act.datasource_group_id = Set(Some(datasource_group_id));
            group_link_act.created_at = Set(message.created_at);
            group_link_act.update(txn).await.context(h!())?;
        }
        Some(_) => {}
        None => {
            signal_message_group::ActiveModel {
                id: NotSet,
                signal_message_id: Set(message.id),
                signal_message_uuid: Set(message.id_uuid),
                group_master_key: Set(Some(group_id.to_string())),
                sender: Set(message.sender.clone()),
                login_id: Set(message.login_id),
                message_uid: Set(message.message_uid.clone()),
                datasource_group_id: Set(Some(datasource_group_id)),
                created_at: Set(message.created_at),
            }
            .insert(txn)
            .await
            .context(h!())?;
        }
    }
    Ok(())
}

async fn process_imported_rer_csv_message(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    message_id: i64,
    timestamp: NaiveDateTime,
) -> anyhow::Result<()> {
    let changed_inbox_item_ids = if context.import_as_new {
        crate::rer_importer::bgworker::process_message_to_inbox_nofail(
            context.settlements.clone(),
            context.dbx,
            context.rq,
            context.config,
            message_id,
            None,
        )
        .await
    } else {
        crate::rer_importer::bgworker::process_historical_message_to_inbox_nofail(
            context.settlements.clone(),
            context.dbx,
            context.rq,
            context.config,
            message_id,
            timestamp,
            context.lnow,
        )
        .await
    };
    let processed_message_ids = if changed_inbox_item_ids.is_empty() {
        vec![message_id]
    } else {
        changed_inbox_item_ids.clone()
    };
    if context.reconcile_target_group {
        for processed_message_id in &processed_message_ids {
            reconcile_rer_csv_message_target_group(
                context,
                *processed_message_id,
            )
            .await
            .context(h!())?;
        }
    }
    crate::inbox::fanout_inbox_changes(redis, changed_inbox_item_ids)
        .await
        .context(h!())?;
    for processed_message_id in processed_message_ids {
        crate::sigint::worker::incoming_message_after_insert(
            context.dbx,
            processed_message_id,
        )
        .await
        .context(h!())?;
    }
    Ok(())
}

pub async fn oneoff_rer_csv_import_go(
    mode: Mode,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    ps: &crate::OneoffRerCsvImportPs,
    bgid: Option<i64>,
    lnow: DateTime<Tz>,
    target_signal_group_master_key: &str,
) -> Result<(), AppError> {
    let res = oneoff_rer_csv_import_at(
        mode,
        redis,
        ps,
        bgid,
        lnow,
        Some(target_signal_group_master_key),
    )
    .await;
    crate::delta::finish_bgtask(bgid, dbx, &res).await.c(h!())?;
    res
}

pub async fn oneoff_rer_csv_import_1(
    mode: Mode,
    redis: &mut redis::aio::ConnectionManager,
    ps: &crate::OneoffRerCsvImportPs,
    bgid: Option<i64>,
) -> Result<(), AppError> {
    let lnow = Local::now().with_timezone(&crate::config::get_tz());
    oneoff_rer_csv_import_at(mode, redis, ps, bgid, lnow, None).await
}

async fn load_rer_csv_import_options(
    dbx: &DatabaseConnection,
    config: &Config,
) -> anyhow::Result<RerCsvImportOptions> {
    let groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .order_by_asc(signal_group::Column::Name)
        .order_by_desc(signal_group::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    let default_target_signal_group_master_key = groups
        .iter()
        .find(|group| {
            group.name.as_deref()
                == Some(config.signal_import_group_name.as_str())
        })
        .map(|group| group.master_key.clone());
    let signal_groups = groups
        .into_iter()
        .map(|group| RerCsvImportSignalGroup {
            name: group
                .name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| group.master_key.clone()),
            master_key: group.master_key,
        })
        .collect();
    Ok(RerCsvImportOptions {
        signal_groups,
        default_target_signal_group_master_key,
    })
}

async fn find_target_rer_csv_import_group(
    dbx: &DatabaseConnection,
    master_key: &str,
) -> anyhow::Result<Option<signal_group::Model>> {
    let group = if master_key.trim().is_empty() {
        None
    } else {
        signal_group::Entity::find_by_id(master_key)
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::IsArchived.eq(false))
            .one(dbx)
            .await
            .c(h!())?
    };
    Ok(group)
}

fn target_rer_csv_import_group_error() -> AppError {
    AppError::BL {
        msg: "Target signal group is required or no longer available"
            .to_string(),
    }
}

async fn oneoff_rer_csv_import_at(
    mode: Mode,
    redis: &mut redis::aio::ConnectionManager,
    ps: &crate::OneoffRerCsvImportPs,
    bgid: Option<i64>,
    lnow: DateTime<Tz>,
    target_signal_group_master_key: Option<&str>,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    bgtask_log(
        bgid,
        &format!(
            "> rer_importer::oneoff_rer_importer_import starting; ps: {ps:?}"
        ),
        &dbx,
    )
    .await
    .c(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_settlements_data_config(
            config.settlement_paths().unwrap(),
            mode,
        )
        .unwrap(),
    ));
    crate::location::aor_config::init_aor_location_config(
        &dbx,
        settlements.clone(),
    )
    .await
    .c(h!())?;
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(
            crate::config::RQ_TIMEOUT_SIGNAL_API,
        ))
        .build()
        .c(h!())?;

    let csv_file = std::fs::File::open(&ps.input).c(h!())?;
    let records = read_rer_csv_records(csv_file).c(h!())?;

    bgtask_log(bgid, &format!("> gathered bodies: {}", records.len()), &dbx)
        .await
        .c(h!())?;

    let group = match target_signal_group_master_key {
        Some(master_key) => {
            let group = find_target_rer_csv_import_group(&dbx, master_key)
                .await
                .c(h!())?;
            let Some(group) = group else {
                return Err(target_rer_csv_import_group_error());
            };
            group
        }
        None => {
            let group_name = config.signal_import_group_name.clone();
            let group = signal_group::Entity::find()
                .filter(signal_group::Column::Deleted.eq(false))
                .filter(signal_group::Column::Name.eq(group_name))
                .order_by_desc(signal_group::Column::CreatedAt)
                .one(&dbx)
                .await
                .c(h!())?;
            let Some(group) = group else {
                return Err(AppError::BL {
                    msg: format!(
                        "Signal group for import not found: {}; create in signal_group table",
                        config.signal_import_group_name
                    ),
                });
            };
            group
        }
    };
    let group_id = group.master_key;
    let group_datasource_id = group.datasource_id;

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(&dbx)
        .await
        .c(h!())?;
    let Some(signal_profile) = signal_profile else {
        return Err(AppError::BL {
            msg: format!(
                "Signal profile for import not found: {}; create in signal_profile table",
                config.signal_import_fiven_name
            ),
        });
    };
    let source_uuid = signal_profile.uuid;

    // choose datasource for this group based on datasource_group mapping
    let datasource_id = match group_datasource_id {
        Some(datasource_id) => datasource_id,
        None => datasource_group::Entity::find()
            .filter(
                datasource_group::Column::GroupMasterKey.eq(group_id.clone()),
            )
            .filter(datasource_group::Column::Deleted.eq(false))
            .order_by_desc(datasource_group::Column::CreatedAt)
            .one(&dbx)
            .await
            .c(h!())?
            .map(|datasource_group| datasource_group.datasource_id)
            .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID),
    };
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            &dbx,
            group_id.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    let context = RerCsvImportContext {
        settlements,
        dbx: &dbx,
        rq: &rq,
        config: &config,
        group_id,
        datasource_group_id,
        source_uuid,
        import_as_new: ps.import_as_new,
        reconcile_target_group: target_signal_group_master_key.is_some(),
        lnow,
    };

    import_rer_csv_records(&context, redis, bgid, records)
        .await
        .c(h!())?;
    Ok(())
}

async fn import_rer_csv_records(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    bgid: Option<i64>,
    records: Vec<RerCsvRecord>,
) -> anyhow::Result<RerCsvImportStats> {
    let mut stats = RerCsvImportStats::new(records.len());
    for record in records {
        import_rer_csv_record(context, redis, bgid, record, &mut stats)
            .await
            .context(h!())?;
    }
    bgtask_log(
        bgid,
        &format!(
            "> CSV import finished: total={}, imported={}, skipped={}, missing_timestamp={}, invalid_message_size={}, duplicates={}, reused={}",
            stats.total,
            stats.imported,
            stats.skipped,
            stats.missing_timestamp,
            stats.invalid_message_size,
            stats.duplicates,
            stats.reused,
        ),
        context.dbx,
    )
    .await
    .c(h!())?;
    Ok(stats)
}

async fn import_rer_csv_record(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    bgid: Option<i64>,
    record: RerCsvRecord,
    stats: &mut RerCsvImportStats,
) -> anyhow::Result<()> {
    let timestamp = if context.import_as_new {
        Some(Utc::now().naive_utc())
    } else {
        let validation = validate_historical_record(context.lnow, &record);
        if validation.should_skip() {
            None
        } else {
            validation.timestamp
        }
    };
    let outcome = persistence::persist_rer_csv_message(
        context,
        record.body.clone(),
        timestamp,
    )
    .await
    .context(h!())?;
    let Some(outcome) = outcome else {
        rer_csv_import_record_timestamp(
            &record,
            context.import_as_new,
            context.lnow,
            bgid,
            context.dbx,
            stats,
        )
        .await
        .context(h!())?;
        return Ok(());
    };
    let message_id = outcome.message_id();
    let processed =
        process_persisted_rer_csv_message(context, redis, outcome, timestamp)
            .await
            .context(h!())?;
    match outcome {
        RerCsvPersistence::Inserted(_) => stats.imported += 1,
        RerCsvPersistence::Reused(_) if processed => stats.reused += 1,
        _ => {
            stats.duplicates += 1;
            stats.skipped += 1;
            bgtask_log(
                bgid,
                &format!("> duplicate CSV record {}: existing message id={message_id}", record.source_record),
                context.dbx,
            )
            .await
            .context(h!())?;
        }
    }
    Ok(())
}

async fn process_persisted_rer_csv_message(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    outcome: RerCsvPersistence,
    timestamp: Option<NaiveDateTime>,
) -> anyhow::Result<bool> {
    let message_id = outcome.message_id();
    match outcome {
        RerCsvPersistence::Duplicate(_) => Ok(false),
        _ if context.reconcile_target_group => {
            persistence::process_rer_csv_message(context, redis, message_id)
                .await
                .context(h!())
        }
        _ => {
            process_imported_rer_csv_message(
                context,
                redis,
                message_id,
                timestamp.context(h!())?,
            )
            .await
            .context(h!())?;
            Ok(true)
        }
    }
}

pub async fn oneoff_rer_csv_import(
    mode: Mode,
    ps: &crate::OneoffRerCsvImportPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode).c(h!())?;
    let mut redis = crate::new_redis(&config).await.c(h!())?;
    oneoff_rer_csv_import_1(mode, &mut redis, ps, None).await
}

#[get("/api/rer/csv-import/options")]
pub async fn rer_csv_import_options(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<RerCsvImportOptions>, AppError> {
    ensure_message_write(&env.dbx, &user).await.c(h!())?;
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let options = load_rer_csv_import_options(&env.dbx, &env.config)
        .await
        .c(h!())?;
    Ok(Json(options))
}

#[post("/api/rer/csv-import/preflight")]
pub async fn rer_csv_import_preflight(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    ensure_message_write(&env.dbx, &user).await.c(h!())?;
    let (field, value) = multipart::extract(&mut payload).await.c(h!())?;
    let lnow = Local::now().with_timezone(&crate::config::get_tz());
    let filename = skipped_messages_filename(&field);
    let (preflight, body) = web::block(move || {
        prepare_historical_csv_preflight(lnow, Cursor::new(value))
    })
    .await
    .c(h!())?
    .c(h!())?;
    Ok(historical_csv_preflight_response(preflight, filename, body).c(h!())?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerCsvImportQuery {
    is_historical: Option<bool>,
    reference_timestamp_ms: Option<i64>,
    target_signal_group_master_key: String,
}

fn rer_csv_import_reference_time(
    is_historical: bool,
    reference_timestamp_ms: Option<i64>,
) -> Result<DateTime<Tz>, AppError> {
    if !is_historical {
        return Ok(Local::now().with_timezone(&crate::config::get_tz()));
    }
    let Some(reference_timestamp_ms) = reference_timestamp_ms else {
        return Err(AppError::BL {
            msg: "Historical CSV import requires preflight".to_string(),
        });
    };
    let Some(reference_time) =
        DateTime::<Utc>::from_timestamp_millis(reference_timestamp_ms)
    else {
        return Err(AppError::BL {
            msg: "Invalid CSV preflight reference timestamp".to_string(),
        });
    };
    Ok(reference_time.with_timezone(&crate::config::get_tz()))
}

#[post("/api/rer/csv-import")]
pub async fn rer_csv_import(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    query: web::Query<RerCsvImportQuery>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    ensure_message_write(&env.dbx, &user).await.c(h!())?;
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let is_historical = query.is_historical.unwrap_or(true);
    let reference_time = rer_csv_import_reference_time(
        is_historical,
        query.reference_timestamp_ms,
    )
    .context(h!())?;
    let target_signal_group = find_target_rer_csv_import_group(
        &env.dbx,
        &query.target_signal_group_master_key,
    )
    .await
    .c(h!())?;
    if target_signal_group.is_none() {
        return Err(target_rer_csv_import_group_error());
    }
    let target_signal_group_master_key =
        query.target_signal_group_master_key.clone();
    let (_, val) = multipart::extract(&mut payload).await.c(h!())?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", tmp_dir.path().display());
    let csv_file =
        multipart::write_upload(tmp_dir.path(), "csv", &val).c(h!())?;
    println!("> csv_file: {}", csv_file.display());
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;

    let dbx2 = env.dbx.clone();
    let redis2 = env.redis.clone();
    let mode = env.mode;
    let mode2 = Box::new(mode);
    let bgtask_id2 = Box::new(bgtask_id);
    let import_as_new = Box::new(!is_historical);
    let reference_time = Box::new(reference_time);
    tokio::spawn(async move {
        let _tmp_dir = tmp_dir;
        let dbx3 = dbx2;
        let mut redis3 = redis2;
        let csv_file2 = csv_file;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let mode3 = mode2;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let bgtask_id3 = bgtask_id2;
        let import_as_new2 = import_as_new;
        let reference_time2 = reference_time;
        let res = oneoff_rer_csv_import_go(
            *mode3,
            &dbx3,
            &mut redis3,
            &crate::OneoffRerCsvImportPs {
                input: csv_file2.as_path().to_string_lossy().to_string(),
                import_as_new: *import_as_new2,
            },
            Some(*bgtask_id3),
            *reference_time2,
            &target_signal_group_master_key,
        )
        .await;
        let res = finish_bgtask(Some(*bgtask_id3), &dbx3, &res).await;
        res
    });

    Ok(Json(bgtask_id))
}

/// Import CSV with coordinates as exported from Delta [issue](https://github.com/k-bx/echo/issues/7)
#[post("/api/rer/delta-csv-import")]
pub async fn rer_delta_csv_import(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<i64>, AppError> {
    ensure_message_write(&env.dbx, &user).await.c(h!())?;
    let (_, val) = multipart::extract(&mut payload).await.c(h!())?;
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", tmp_dir.path().display());
    let csv_file =
        multipart::write_upload(tmp_dir.path(), "csv", &val).c(h!())?;
    println!("> csv_file: {}", csv_file.display());
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let loglines: Vec<String> = vec![];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;

    let dbx2 = env.dbx.clone();
    let config2 = env.config.clone();
    let rq2 = env.rq.clone();
    let redis2 = env.redis.clone();
    let settlements2 = env.settlements.clone();
    let bgtask_id2 = Box::new(bgtask_id);
    tokio::spawn(async {
        let _tmp_dir = tmp_dir;
        let dbx3 = dbx2;
        let config3 = config2;
        let rq3 = rq2;
        let mut redis3 = redis2;
        let settlements3 = settlements2;
        // crazy hacks due to bug in nightly. remove asap
        // possibly https://github.com/rust-lang/rust/issues/119757
        let bgtask_id3 = bgtask_id2;
        let res = rer_delta_csv_import_go(
            settlements3,
            &dbx3,
            &config3,
            &mut redis3,
            &rq3,
            csv_file,
            Some(*bgtask_id3),
        )
        .await;

        let res2 = finish_bgtask(Some(*bgtask_id3), &dbx3, &res).await;
        res2
    });

    Ok(Json(bgtask_id))
}

/// Record extracted from Delta's CSV with additional freq extraction
#[derive(Debug)]
pub struct DeltaCsvFreqRec {
    pub freq: String,
    pub lat: f64,
    pub lon: f64,
    pub time: NaiveDateTime,
    pub comment: String,
}

pub async fn rer_delta_csv_import_go(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    dbx: &sea_orm::DatabaseConnection,
    config: &Config,
    redis: &mut redis::aio::ConnectionManager,
    rq: &reqwest::Client,
    csv_file: std::path::PathBuf,
    bgtask_id: Option<i64>,
) -> Result<(), AppError> {
    bgtask_log(
        bgtask_id,
        &format!(
            "> rer_delta_csv_import_go starting; csv_file: {}",
            csv_file.display()
        ),
        dbx,
    )
    .await
    .c(h!())?;

    let recs = parse_delta_csv(csv_file)?;
    bgtask_log(bgtask_id, &format!("> parsed {} records", recs.len()), dbx)
        .await
        .c(h!())?;

    let group_name = config.signal_import_group_name.clone();
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.eq(group_name))
        .order_by_desc(signal_group::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let Some(group) = group else {
        return Err(AppError::BL {
            msg: format!(
                "Signal group for import not found: {}; edit config.signal_admin_api_recepients",
                config.signal_import_group_name
            ),
        });
    };
    let group_id = group.master_key;
    // choose datasource for this group based on datasource_group mapping
    let datasource_id = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(group_id.clone()))
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .unwrap_or(None)
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID);

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let Some(signal_profile) = signal_profile else {
        return Err(AppError::BL {
            msg: format!(
                "Signal profile for import not found: {}; edit config.signal_admin_api_recepients",
                config.signal_import_fiven_name
            ),
        });
    };
    let source_uuid = signal_profile.uuid;

    for rec in recs {
        bgtask_log(bgtask_id, &format!("> rec: {rec:?}"), dbx)
            .await
            .c(h!())?;

        let timestamp = Utc::now().naive_utc();
        let body: String = format!(
            "{} F={}(МГц)\n\n{:.6} {:.6}\n\n{}",
            rec.time.format("%Y-%m-%dT%H:%M:%S"),
            rec.freq.replace(".", ","),
            rec.lat,
            rec.lon,
            rec.comment
        );

        // Normalize body
        let body = body.replace("\r\n", "\n");

        let master_key = group_id.to_string();
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                dbx,
                master_key.to_string(),
                datasource_id,
            )
            .await
            .c(h!())?;

        let message = signal_message::ActiveModel {
            id: NotSet,
            id_uuid: Set(Some(crate::sigint::message_id::signal_message_uuid(
                Some(timestamp),
                timestamp,
            ))),
            body: Set(Some(body.clone())),
            created_at: NotSet,
            timestamp: Set(Some(timestamp)),
            sender: Set(Some(source_uuid.to_string())),
            login_id: NotSet,
            format: Set(Some(2)),
            deleted: Set(false),
            external_id: NotSet,
            echo_inbox_message_id: Set(None),
            message_uid: NotSet,
            datasource_group_id: Set(Some(datasource_group_id)),
            operator_tags: NotSet,
            attachments_hash: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;

        let db_message_id = message.id;

        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            group_master_key: Set(Some(group_id.to_string())),
            sender: Set(message.sender.clone()),
            login_id: Set(message.login_id),
            message_uid: Set(message.message_uid.clone()),
            datasource_group_id: Set(message.datasource_group_id),
            created_at: Set(message.created_at),
        }
        .insert(dbx)
        .await
        .c(h!())?;

        id::update_message_with_uid(dbx, config, message)
            .await
            .c(h!())?;
        let changed_inbox_item_ids =
            crate::rer_importer::bgworker::process_message_to_inbox_nofail(
                settlements.clone(),
                dbx,
                rq,
                config,
                db_message_id,
                None,
            )
            .await;
        crate::inbox::fanout_inbox_changes(redis, changed_inbox_item_ids)
            .await
            .c(h!())?;
        crate::sigint::worker::incoming_message_after_insert(
            dbx,
            db_message_id,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub fn parse_delta_csv(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    let mut errors: Vec<AppError> = vec![];
    match parse_delta_csv_method1(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    match parse_delta_csv_method2(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    match parse_delta_csv_method3(csv_file.clone()) {
        Ok(res) => return Ok(res),
        Err(e) => errors.push(e),
    };
    Err(AppError::BL {
        msg: format!(
            "Failed to parse Delta CSV file: {}; errors: {:?}",
            csv_file.display(),
            errors
        ),
    })
}

pub fn parse_delta_csv_method1(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        r#type: String,
        name: String,
        time: String,
        y: f64,
        x: f64,
        comment: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file).c(h!())?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec.c(h!())?;
        if rec.r#type != "10061500002001000000" {
            println!(
                "Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}"
            );
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: crate::rer_importer::frequency::round_to_nearest_005(freq),
            lat: rec.y,
            lon: rec.x,
            time: NaiveDateTime::parse_from_str(&rec.time, "%Y-%m-%dT%H:%M:%S")
                .c(h!())?,
            comment: rec.comment,
        };
        res.push(rec);
    }
    Ok(res)
}

pub fn parse_delta_csv_method2(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        sidc: String,
        name: String,
        observation_datetime: String,
        coordinates: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file).c(h!())?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec.c(h!())?;
        if rec.sidc != "10061500002001000000" {
            println!(
                "Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}"
            );
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"POINT \((?P<lng>\d\d\.\d\d\d\d?\d?\d?\d?\d?)\s+(?P<lat>\d\d\.\d\d\d\d?\d?\d?\d?\d?)\)")
                    .unwrap();
        }
        let Some(capts) = RE.captures(&rec.coordinates) else {
            continue;
        };
        let Some(lat) = m_cap_s(&capts, "lat") else {
            continue;
        };
        let lat: f64 = lat.parse().c(h!())?;
        let Some(lng) = m_cap_s(&capts, "lng") else {
            continue;
        };
        let lng: f64 = lng.parse().c(h!())?;
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: crate::rer_importer::frequency::round_to_nearest_005(freq),
            lat,
            lon: lng,
            time: NaiveDateTime::parse_from_str(
                &rec.observation_datetime,
                "%Y-%m-%dT%H:%M:%S",
            )
            .c(h!())?,
            comment: "".to_string(),
        };
        res.push(rec);
    }
    Ok(res)
}

pub fn parse_delta_csv_method3(
    csv_file: std::path::PathBuf,
) -> Result<Vec<DeltaCsvFreqRec>, AppError> {
    #[derive(Debug, serde::Deserialize)]
    struct Rec {
        #[serde(rename = "app6d sidc")]
        sidc: String,
        name: String,
        #[serde(rename = "observation date/time")]
        observation_datetime: String,
        #[serde(rename = "coordinates(wgs,yx)")]
        coordinates: String,
        comments: String,
    }

    let mut rdr = csv::Reader::from_path(&csv_file).c(h!())?;
    let mut res: Vec<DeltaCsvFreqRec> = vec![];
    for e_rec in rdr.deserialize() {
        let rec: Rec = e_rec.c(h!())?;
        println!("rec: {rec:?}");
        if rec.sidc != "10061500002001000000" {
            println!(
                "Only type 10061500002001000000 (Antennae) is supported. Skpiing record: {rec:?}"
            );
            continue;
        }
        let Some(freq) =
            crate::rer_importer::frequency::extract_freq(&rec.name)?
        else {
            continue;
        };
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<lat>\d\d\.\d\d\d\d?\d?\d?\d?\d?),\s+(?P<lng>\d\d\.\d\d\d\d?\d?\d?\d?\d?)")
                    .unwrap();
        }
        let Some(capts) = RE.captures(&rec.coordinates) else {
            continue;
        };
        let Some(lat) = m_cap_s(&capts, "lat") else {
            continue;
        };
        let lat: f64 = lat.parse().c(h!())?;
        let Some(lng) = m_cap_s(&capts, "lng") else {
            continue;
        };
        let lng: f64 = lng.parse().c(h!())?;
        println!("lat: {lat}, lng: {lng}");
        let rec: DeltaCsvFreqRec = DeltaCsvFreqRec {
            freq: super::frequency::round_to_nearest_005(freq),
            lat,
            lon: lng,
            time: crate::rer_importer::datetime::parse_delta_csv_dt(
                &rec.observation_datetime,
            )?,
            comment: rec.comments,
        };
        res.push(rec);
    }
    Ok(res)
}

pub async fn ensure_import_group_exists(
    dbx: &sea_orm::DatabaseConnection,
    config: &Config,
) -> Result<(), AppError> {
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::Id.eq(1_i64))
        .one(dbx)
        .await
        .c(h!())?;
    let datasource_id = match datasource {
        Some(datasource) => datasource.id,
        None => {
            warn!("No datasource found -- creating a default one!");
            datasource::ActiveModel {
                id: Set(1),
                kind: Set("signal".to_string()),
                display_name: Set("signal_phone".to_string()),
                signal_phone: Set(Some("+3800000000".to_string())),
                enabled: Set(Some(true)),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .c(h!())?
            .id
        }
    };

    let group_name = config.signal_import_group_name.clone();
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::Name.eq(group_name.clone()))
        .order_by_desc(signal_group::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let master_key = match group {
        Some(group) => group.master_key,
        None => {
            warn!("No signal_group found -- creating a default one!");
            let group = signal_group::ActiveModel {
                master_key: Set(Uuid::new_v4().to_string()),
                name: Set(Some(group_name.clone())),
                ..Default::default()
            };

            let inserted = crate::messenger::group::add_group(group, dbx)
                .await
                .c(h!())?;
            // ensure datasource_group mapping
            let _ = datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(inserted.master_key.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group_name.clone()),
                deleted: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            inserted.master_key
        }
    };

    let sender_name = config.signal_import_fiven_name.clone();
    let signal_profile = signal_profile::Entity::find()
        .filter(signal_profile::Column::GivenName.eq(sender_name.clone()))
        .order_by_desc(signal_profile::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let _signal_profile = match signal_profile {
        Some(signal_profile) => signal_profile,
        None => {
            warn!("No signal_profile found -- creating a default one!");
            signal_profile::ActiveModel {
                uuid: Set(uuid::Uuid::new_v4().to_string()),
                given_name: Set(Some(sender_name)),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .c(h!())?
        }
    };
    let sigint_zone_datasource = sigint_zone_datasource::Entity::find()
        .filter(sigint_zone_datasource::Column::DatasourceId.eq(datasource_id))
        .order_by_desc(sigint_zone_datasource::Column::CreatedAt)
        .one(dbx)
        .await
        .c(h!())?;
    let _sigint_zone_datasource = match sigint_zone_datasource {
        Some(sigint_zone_datasource) => sigint_zone_datasource,
        None => {
            warn!("No sigint_zone_datasource found -- creating a default one!");
            sigint_zone_datasource::ActiveModel {
                sigint_zone_id: Set(1),
                datasource_id: Set(datasource_id),
                group_master_key: Set(master_key),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .c(h!())?
        }
    };

    let group = signal_group::Entity::find_by_id(IMPORT_DIRECTION_FINDING_UUID)
        .one(dbx)
        .await
        .c(h!())?;
    let _master_key = match group {
        Some(group) => group.master_key,
        None => {
            warn!(
                "No signal_group found for direction finding imports -- creating a default one!"
            );
            let group = signal_group::ActiveModel {
                master_key: Set(IMPORT_DIRECTION_FINDING_UUID.to_string()),
                name: Set(Some("Імпорт Пеленгів".to_string())),
                ignore_operativny: Set(true),
                ..Default::default()
            };
            let inserted = crate::messenger::group::add_group(group, dbx)
                .await
                .c(h!())?;
            let _ = datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(inserted.master_key.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group_name),
                deleted: NotSet,
            }
            .insert(dbx)
            .await
            .ok();
            inserted.master_key
        }
    };

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        cookie::Key, test as actix_test, web, App, HttpMessage, HttpRequest,
        HttpResponse,
    };
    use chrono::TimeZone;
    use std::path::PathBuf;

    fn fixed_now() -> DateTime<Tz> {
        crate::config::get_tz()
            .with_ymd_and_hms(2026, 10, 2, 12, 0, 0)
            .unwrap()
    }

    fn write_test_rer_csv(path: &Path, bodies: &[&str]) {
        let mut writer = csv::WriterBuilder::new()
            .has_headers(false)
            .from_path(path)
            .unwrap();
        for body in bodies {
            writer.serialize((body,)).unwrap();
        }
        writer.flush().unwrap();
    }

    async fn rer_csv_import_test_login(
        request: HttpRequest,
        login_id: web::Path<Uuid>,
    ) -> HttpResponse {
        actix_identity::Identity::login(
            &request.extensions(),
            login_id.to_string(),
        )
        .unwrap();
        HttpResponse::NoContent().finish()
    }

    async fn assert_historical_import_reuses_split_reference_time(
        dbx: &DatabaseConnection,
        redis: &mut redis::aio::ConnectionManager,
        directory: &TempDir,
        marker: Uuid,
    ) {
        let runtime_now = Local::now().with_timezone(&crate::config::get_tz());
        let import_now = runtime_now - chrono::Duration::days(10);
        let split_filler = format!("{} ", "x".repeat(99)).repeat(52);
        let body = format!(
            "{}\n{}\none\ntwo\nthree\n{}\ntail {marker}",
            import_now.format("%d.%m.%Y %H:%M:%S"),
            split_filler,
            (runtime_now - chrono::Duration::hours(1))
                .format("%d.%m.%Y %H:%M:%S"),
        );
        assert!(
            !crate::rer_importer::multimessage::is_invalid_for_historical_csv_import(
                import_now,
                &body,
            )
        );
        assert!(
            crate::rer_importer::multimessage::is_invalid_for_historical_csv_import(
                runtime_now,
                &body,
            )
        );
        let expected = validate_historical_record(
            import_now,
            &RerCsvRecord {
                source_record: 1,
                body: body.clone(),
            },
        )
        .timestamp
        .unwrap();
        let path = directory.path().join("split-reference.csv");
        write_test_rer_csv(&path, &[&body]);

        oneoff_rer_csv_import_at(
            Mode::Test,
            redis,
            &crate::OneoffRerCsvImportPs {
                input: path.to_string_lossy().to_string(),
                import_as_new: false,
            },
            None,
            import_now,
            None,
        )
        .await
        .unwrap();

        let message = signal_message::Entity::find()
            .filter(signal_message::Column::Body.eq(body))
            .one(dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!message.deleted);
        assert_eq!(message.created_at, expected);
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.datetime, Some(expected));
    }

    async fn assert_historical_message_uids_are_unique(
        env: &Env,
        group_id: String,
        datasource_id: i64,
        source_uuid: String,
    ) {
        let timestamp = NaiveDate::from_ymd_opt(2026, 10, 2)
            .unwrap()
            .and_hms_opt(7, 30, 0)
            .unwrap();
        let marker = Uuid::new_v4();
        let bodies = (0..65)
            .map(|index| format!("historical UID {index} {marker}"))
            .collect::<Vec<_>>();
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                group_id.clone(),
                datasource_id,
            )
            .await
            .unwrap();
        let context = RerCsvImportContext {
            settlements: env.settlements.clone(),
            dbx: &env.dbx,
            rq: &env.rq,
            config: &env.config,
            group_id,
            datasource_group_id,
            source_uuid,
            import_as_new: false,
            reconcile_target_group: false,
            lnow: fixed_now(),
        };

        for body in &bodies {
            persistence::persist_rer_csv_message(
                &context,
                body.clone(),
                Some(timestamp),
            )
            .await
            .unwrap();
        }

        let messages = signal_message::Entity::find()
            .filter(signal_message::Column::Body.is_in(bodies))
            .order_by_asc(signal_message::Column::Id)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(messages.len(), 65);
        assert_eq!(messages.last().unwrap().id - messages[0].id, 64);
        assert!(messages.iter().all(|message| {
            message.created_at == timestamp
                && message.timestamp == Some(timestamp)
        }));
        let message_uids = messages
            .into_iter()
            .map(|message| message.message_uid.unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(message_uids.len(), 65);
    }

    #[test]
    fn rer_csv_records_preserve_multiline_messages_and_ignore_empty_rows() {
        let csv = "\"29.02.2024_15:50 first, line\r\nsecond line\"\r\n\r\n\"  Дата: 2024-03-02;\r\nЧас: 07:09;  \"\r\n";

        let records = read_rer_csv_records(csv.as_bytes()).unwrap();

        assert_eq!(
            records,
            vec![
                RerCsvRecord {
                    source_record: 1,
                    body: "29.02.2024_15:50 first, line\nsecond line"
                        .to_string(),
                },
                RerCsvRecord {
                    source_record: 2,
                    body: "Дата: 2024-03-02;\nЧас: 07:09;".to_string(),
                },
            ]
        );
    }

    #[test]
    fn rer_csv_records_reject_multiple_columns() {
        assert!(read_rer_csv_records("one,two\n".as_bytes()).is_err());
    }

    #[test]
    fn skipped_messages_filename_uses_a_safe_source_stem() {
        for (source, expected) in [
            ("source.csv", "source-skipped-messages.csv"),
            ("SOURCE.CSV", "SOURCE-skipped-messages.csv"),
            ("../archive.data.csv", "archive.data-skipped-messages.csv"),
            ("file", "file-skipped-messages.csv"),
            ("..", "upload-skipped-messages.csv"),
        ] {
            assert_eq!(skipped_messages_filename_from_source(source), expected);
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn issue_3650_csv_target_group_endpoints_require_admin_writer() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let writer = crate::functest::tests::mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let admin_writer = crate::functest::tests::mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(["Admin", "Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::from(env.clone()))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .route(
                    "/test/rer-csv-import-login/{login_id}",
                    web::post().to(rer_csv_import_test_login),
                )
                .service(rer_csv_import_options)
                .service(rer_csv_import),
        )
        .await;

        for (login_id, expected_status) in [
            (writer.id, actix_web::http::StatusCode::FORBIDDEN),
            (admin_writer.id, actix_web::http::StatusCode::OK),
        ] {
            let login_response = actix_test::call_service(
                &app,
                actix_test::TestRequest::post()
                    .uri(&format!("/test/rer-csv-import-login/{login_id}"))
                    .to_request(),
            )
            .await;
            let session_cookie = login_response
                .response()
                .cookies()
                .next()
                .unwrap()
                .into_owned();
            let options_response = actix_test::call_service(
                &app,
                actix_test::TestRequest::get()
                    .uri("/api/rer/csv-import/options")
                    .cookie(session_cookie.clone())
                    .to_request(),
            )
            .await;
            assert_eq!(options_response.status(), expected_status);

            if expected_status == actix_web::http::StatusCode::FORBIDDEN {
                let import_response = actix_test::call_service(
                    &app,
                    actix_test::TestRequest::post()
                        .uri(
                            "/api/rer/csv-import?isHistorical=true&referenceTimestampMs=1790974200000&targetSignalGroupMasterKey=forbidden-target",
                        )
                        .cookie(session_cookie)
                        .insert_header((
                            actix_web::http::header::CONTENT_TYPE,
                            "multipart/form-data; boundary=csv-import-boundary",
                        ))
                        .set_payload("--csv-import-boundary--\r\n")
                        .to_request(),
                )
                .await;
                assert_eq!(
                    import_response.status(),
                    actix_web::http::StatusCode::FORBIDDEN
                );
            }
        }
    }

    #[test]
    fn historical_validation_accepts_documented_formats() {
        let records = vec![
            RerCsvRecord {
                source_record: 1,
                body: "29.02.2024_15:50 F=446.1125(МГц) П54\nтекст".to_string(),
            },
            RerCsvRecord {
                source_record: 2,
                body: "Дата: 2024-03-02;\nЧас: 07:09;\nТекст:\n- Калуга"
                    .to_string(),
            },
        ];

        let preflight = preflight_historical_csv(fixed_now(), records);

        assert_eq!(preflight.total, 2);
        assert_eq!(preflight.valid, 2);
        assert_eq!(preflight.missing_timestamp, 0);
        assert_eq!(preflight.invalid_message_size, 0);
    }

    #[test]
    fn historical_validation_resolves_ambiguous_kyiv_timestamp() {
        let record = RerCsvRecord {
            source_record: 1,
            body: "Muraha\n26.10.2025, 03:30:00\nmessage".to_string(),
        };
        let between = Utc
            .with_ymd_and_hms(2025, 10, 26, 0, 45, 0)
            .unwrap()
            .with_timezone(&crate::config::get_tz());

        for (reference_time, expected) in [
            (
                between,
                NaiveDate::from_ymd_opt(2025, 10, 26)
                    .unwrap()
                    .and_hms_opt(0, 30, 0)
                    .unwrap(),
            ),
            (
                fixed_now(),
                NaiveDate::from_ymd_opt(2025, 10, 26)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap(),
            ),
        ] {
            let validation =
                validate_historical_record(reference_time, &record);

            assert_eq!(validation.timestamp, Some(expected));
        }
    }

    #[test]
    fn historical_validation_converts_date_only_to_local_midnight() {
        for (body, expected) in [
            (
                "Дата: 2024-01-15;",
                NaiveDate::from_ymd_opt(2024, 1, 14)
                    .unwrap()
                    .and_hms_opt(22, 0, 0)
                    .unwrap(),
            ),
            (
                "Дата: 2024-07-15;",
                NaiveDate::from_ymd_opt(2024, 7, 14)
                    .unwrap()
                    .and_hms_opt(21, 0, 0)
                    .unwrap(),
            ),
        ] {
            let validation = validate_historical_record(
                fixed_now(),
                &RerCsvRecord {
                    source_record: 1,
                    body: body.to_string(),
                },
            );

            assert_eq!(validation.timestamp, Some(expected));
        }
    }

    #[test]
    fn historical_validation_rejects_future_timestamp_requiring_normalization()
    {
        let lnow = fixed_now();
        let body = (lnow + chrono::Duration::hours(25))
            .format("%d.%m.%Y %H:%M:%S")
            .to_string();
        let validation = validate_historical_record(
            lnow,
            &RerCsvRecord {
                source_record: 1,
                body,
            },
        );

        assert!(validation.missing_timestamp());
    }

    #[actix_web::test]
    async fn historical_preflight_response_contains_counts_and_failed_csv() {
        let invalid_body =
            format!("missing, timestamp\n{}", "x".repeat(20_001));
        let records = vec![
            RerCsvRecord {
                source_record: 1,
                body: invalid_body.clone(),
            },
            RerCsvRecord {
                source_record: 2,
                body: "Дата: 2024-03-02;\nЧас: 07:09;".to_string(),
            },
        ];
        let preflight = preflight_historical_csv(fixed_now(), records);
        let body = write_rer_csv_records(&preflight.skipped_records).unwrap();

        let response = historical_csv_preflight_response(
            preflight,
            "source-skipped-messages.csv".to_string(),
            body,
        )
        .unwrap();

        let metadata: RerCsvPreflightMetadata = serde_json::from_str(
            response
                .headers()
                .get(RER_CSV_PREFLIGHT_METADATA_HEADER)
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            metadata,
            RerCsvPreflightMetadata {
                reference_timestamp_ms: fixed_now().timestamp_millis(),
                total: 2,
                valid: 1,
                missing_timestamp: 1,
                invalid_message_size: 1,
            }
        );
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "private, no-store"
        );
        assert!(response
            .headers()
            .get("content-disposition")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("source-skipped-messages.csv"));
        let bytes = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        let failed = read_rer_csv_records(bytes.as_ref()).unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].body, invalid_body);
    }

    #[serial_test::serial]
    #[tokio::test]
    async fn historical_import_persists_event_time_and_skips_invalid_rows() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let datasource = crate::functest::tests::find_test_datasource(&env.dbx)
            .await
            .unwrap();
        let group_id = Uuid::new_v4().to_string();
        let group = crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                name: Set(Some("Other CSV import group".to_string())),
                datasource_id: Set(Some(datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(group.master_key.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let target_group_id = Uuid::new_v4().to_string();
        let target_group = crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(target_group_id.clone()),
                name: Set(Some(env.config.signal_import_group_name.clone())),
                datasource_id: Set(Some(datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::functest::tests::mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                group_master_key: Set(target_group.master_key),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let archived_group_id = Uuid::new_v4().to_string();
        crate::functest::tests::mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(archived_group_id.clone()),
                name: Set(Some("Archived CSV import group".to_string())),
                is_archived: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let options = load_rer_csv_import_options(&env.dbx, &env.config)
            .await
            .unwrap();
        assert_eq!(
            options.default_target_signal_group_master_key,
            Some(target_group_id.clone())
        );
        assert!(options
            .signal_groups
            .iter()
            .any(|group| group.master_key == target_group_id));
        assert!(!options
            .signal_groups
            .iter()
            .any(|group| group.master_key == archived_group_id));
        assert!(
            find_target_rer_csv_import_group(&env.dbx, &archived_group_id)
                .await
                .unwrap()
                .is_none()
        );
        let source_uuid = Uuid::new_v4().to_string();
        signal_profile::ActiveModel {
            uuid: Set(source_uuid.clone()),
            given_name: Set(Some(env.config.signal_import_fiven_name.clone())),
            created_at: Set(Utc::now().naive_utc()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let marker = Uuid::new_v4();
        let valid_body = format!(
            "Час: 10:15:00\nF=146.5000\nvalid {marker}\n48.1434076, 37.7146826"
        );
        let ambiguous_body =
            format!("unit | 2024-10-27\n03-30\nambiguous {marker}");
        let missing_timestamp_body = format!("missing timestamp {marker}");
        let unsupported_timestamp_body =
            format!("01.01.2021 10:16:00\nunsupported timestamp {marker}");
        let oversized_body = format!(
            "02.10.2026 10:16:00\noversized {marker}\n{}",
            "x".repeat(20_001)
        );
        let directory = tempfile::tempdir().unwrap();
        let historical_path = directory.path().join("historical.csv");
        write_test_rer_csv(
            &historical_path,
            &[
                &valid_body,
                &ambiguous_body,
                &missing_timestamp_body,
                &unsupported_timestamp_body,
                &oversized_body,
            ],
        );
        let mut redis = env.redis.clone();
        let background_task = bgtask::ActiveModel {
            progress: Set(0),
            loglines: Set(serde_json::json!([])),
            running: Set(true),
            finished_with_error: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        oneoff_rer_csv_import_at(
            Mode::Test,
            &mut redis,
            &crate::OneoffRerCsvImportPs {
                input: historical_path.to_string_lossy().to_string(),
                import_as_new: false,
            },
            Some(background_task.id),
            fixed_now(),
            Some(&target_group_id),
        )
        .await
        .unwrap();

        let expected = NaiveDate::from_ymd_opt(2026, 10, 2)
            .unwrap()
            .and_hms_opt(7, 15, 0)
            .unwrap();
        let message = signal_message::Entity::find()
            .filter(signal_message::Column::Body.eq(valid_body.clone()))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message.created_at, expected);
        assert_eq!(message.timestamp, Some(expected));
        assert!(message.message_uid.is_some());
        let datasource_group = datasource_group::Entity::find_by_id(
            message.datasource_group_id.unwrap(),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(datasource_group.group_master_key, target_group_id);
        let message_group = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message_group.created_at, expected);
        assert_eq!(message_group.message_uid, message.message_uid);
        assert_eq!(
            message_group.group_master_key.as_deref(),
            Some(target_group_id.as_str())
        );
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.datetime, Some(expected));
        assert_eq!(inbox_item.date.as_deref(), Some("2026-10-02"));
        assert_eq!(inbox_item.time.as_deref(), Some("10:15:00"));
        assert!(inbox_item.coords.is_some());
        let ambiguous_expected = NaiveDate::from_ymd_opt(2024, 10, 27)
            .unwrap()
            .and_hms_opt(0, 30, 0)
            .unwrap();
        let ambiguous_message = signal_message::Entity::find()
            .filter(signal_message::Column::Body.eq(ambiguous_body.clone()))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ambiguous_message.created_at, ambiguous_expected);
        assert_eq!(ambiguous_message.timestamp, Some(ambiguous_expected));
        let ambiguous_inbox_item =
            sigint_inbox_item::Entity::find_by_id(ambiguous_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(ambiguous_inbox_item.datetime, Some(ambiguous_expected));
        for skipped_body in [
            &missing_timestamp_body,
            &unsupported_timestamp_body,
            &oversized_body,
        ] {
            assert!(signal_message::Entity::find()
                .filter(signal_message::Column::Body.eq(skipped_body.clone()))
                .one(&env.dbx)
                .await
                .unwrap()
                .is_none());
        }
        let background_task = bgtask::Entity::find_by_id(background_task.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let loglines: Vec<String> =
            serde_json::from_value(background_task.loglines).unwrap();
        assert!(loglines.iter().any(|line| {
            line.contains(
                "skipped CSV record 3 (missing or unsupported timestamp)",
            )
        }));
        assert!(loglines.iter().any(|line| {
            line.contains(
                "skipped CSV record 4 (missing or unsupported timestamp)",
            )
        }));
        assert!(loglines.iter().any(|line| {
            line.contains("skipped CSV record 5 (invalid message size)")
        }));
        assert!(loglines.iter().any(|line| {
            line.contains(
                "total=5, imported=2, skipped=3, missing_timestamp=2, invalid_message_size=1",
            )
        }));

        assert_historical_message_uids_are_unique(
            &env,
            group_id,
            datasource.id,
            source_uuid,
        )
        .await;

        assert_historical_import_reuses_split_reference_time(
            &env.dbx, &mut redis, &directory, marker,
        )
        .await;

        let new_body = format!("import as new {marker}");
        let new_path = directory.path().join("new.csv");
        write_test_rer_csv(&new_path, &[&new_body]);
        let before = Utc::now().naive_utc();
        oneoff_rer_csv_import_1(
            Mode::Test,
            &mut redis,
            &crate::OneoffRerCsvImportPs {
                input: new_path.to_string_lossy().to_string(),
                import_as_new: true,
            },
            None,
        )
        .await
        .unwrap();
        let after = Utc::now().naive_utc();
        let message = signal_message::Entity::find()
            .filter(signal_message::Column::Body.eq(new_body))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(message.created_at >= before && message.created_at <= after);
        assert!(message.timestamp.unwrap() >= before);
        assert!(message.timestamp.unwrap() <= after);
    }

    #[test]
    fn parse_delta_csv_01() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_01.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 47.3605);
        assert_eq!(res[0].lon, 36.05332);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 11, 6)
                .unwrap()
                .and_hms_opt(5, 14, 54)
                .unwrap()
        );
        assert_eq!(
            res[0].comment,
            "НВ(Викликаючий) УКХ НВ 139.3375 (33_ombr_T01)".to_string()
        );
    }

    #[test]
    fn parse_delta_csv_02() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_02.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 46.2054276);
        assert_eq!(res[0].lon, 33.2139756);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 12, 11)
                .unwrap()
                .and_hms_opt(19, 53, 00)
                .unwrap()
        );
    }

    #[test]
    fn parse_delta_csv_03() {
        let res = parse_delta_csv(PathBuf::from("data/parse_delta_csv_03.csv"))
            .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].freq, "139.3350".to_string());
        assert_eq!(res[0].lat, 46.2054276);
        assert_eq!(res[0].lon, 33.2139756);
        assert_eq!(
            res[0].time,
            NaiveDate::from_ymd_opt(2023, 12, 11)
                .unwrap()
                .and_hms_opt(19, 46, 00)
                .unwrap()
        );
    }
}
