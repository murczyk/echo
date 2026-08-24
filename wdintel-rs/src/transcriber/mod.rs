pub mod backfill;
pub mod media_queue;
pub mod types;
pub mod worker;

use crate::entities::{
    echo_gpu_transcription_queue, signal_message, signal_message_media,
};
use crate::error::AppError;
use crate::h;
use crate::transcriber::types::*;
use crate::types::{Env, ShortContext, Uuid};
use actix_identity::Identity;
use actix_web::{get, post, web::Json, HttpRequest, HttpResponse};
use anyhow::Context;
use sea_orm::{
    AccessMode, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, IsolationLevel,
    QueryFilter, QuerySelect, RelationTrait, Statement, TransactionTrait,
    Value,
};
use std::collections::HashMap;
use tokio::process::Command;

#[async_trait::async_trait]
trait BgworkerRestarter {
    async fn request_restart(&self) -> std::io::Result<()>;
}

struct SystemdBgworkerRestarter;

#[async_trait::async_trait]
impl BgworkerRestarter for SystemdBgworkerRestarter {
    async fn request_restart(&self) -> std::io::Result<()> {
        let output = Command::new("systemctl")
            .args([
                "--no-block",
                "restart",
                crate::config::ECHO_AUDIO_TRANSCRIPTION_BGWORKER_SERVICE,
            ])
            .output()
            .await?;
        if output.status.success() {
            return Ok(());
        }
        let details = String::from_utf8_lossy(&output.stderr);
        Err(std::io::Error::other(format!(
            "systemctl restart failed with status {}: {}",
            output.status,
            details.trim()
        )))
    }
}

async fn mutation_restart_result(
    reload_error: Option<anyhow::Error>,
    restarter: &dyn BgworkerRestarter,
) -> (RestartStatus, Option<String>) {
    let mut errors = Vec::new();
    if let Some(error) = reload_error {
        errors.push(format!("failed to reload GPU instances: {error:#}"));
    }
    if let Err(error) = restarter.request_restart().await {
        errors.push(format!("failed to request bgworker restart: {error}"));
    }
    if errors.is_empty() {
        (RestartStatus::Requested, None)
    } else {
        let error = errors.join("; ");
        log::error!("GPU instance configuration was saved, but {error}");
        (RestartStatus::Failed, Some(error))
    }
}

async fn apply_instance_mutation(env: &Env) -> (RestartStatus, Option<String>) {
    let reload_error = env
        .echo_gpu_client
        .reload_instances()
        .await
        .map(|_| ())
        .err();
    mutation_restart_result(reload_error, &SystemdBgworkerRestarter).await
}

async fn ensure_admin_enabled(
    env: &Env,
    user: &Identity,
) -> Result<(), AppError> {
    crate::users::ensure_admin(&env.dbx, user).await.c(h!())?;
    crate::system_settings::ensure_audio_transcription_enabled(&env.dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn completed_transcriptions<C>(
    dbx: &C,
    source_ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(echo_gpu_client::lookup_completed(dbx, source_ids)
        .await
        .c(h!())?
        .into_iter()
        .map(|transcription| (transcription.source_id, transcription.value))
        .collect())
}

#[post("/api/admin/transcriber/instances/list")]
pub async fn list_instances(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<InstanceRsp>>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let instances = env
        .echo_gpu_client
        .list_instances()
        .await
        .context(h!())?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(instances))
}

#[post("/api/admin/transcriber/instances/create")]
pub async fn create_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateInstanceReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let instance = echo_gpu_client::create_instance(
        &txn,
        echo_gpu_client::CreateInstance {
            name: req.name.clone(),
            host: req.host.clone(),
            rs_port: req.rs_port,
            py_port: req.py_port,
            train: false,
            ordering: req.ordering,
        },
    )
    .await
    .context(h!())?;
    txn.commit().await.c(h!())?;
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
    Ok(Json(InstanceMutationRsp {
        instance: Some(instance.into()),
        deleted: false,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/update")]
pub async fn update_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateInstanceReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let instance = echo_gpu_client::update_instance(
        &txn,
        req.id,
        echo_gpu_client::UpdateInstance {
            name: req.name.clone(),
            host: req.host.clone(),
            is_active: req.is_active,
            rs_port: req.rs_port,
            py_port: req.py_port,
            train: None,
            ordering: req.ordering,
        },
    )
    .await
    .context(h!())?;
    txn.commit().await.c(h!())?;
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
    Ok(Json(InstanceMutationRsp {
        instance: Some(instance.into()),
        deleted: false,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/delete")]
pub async fn delete_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InstanceIdReq>,
) -> Result<Json<InstanceMutationRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    let txn = env.dbx.begin().await.c(h!())?;
    let deleted = echo_gpu_client::delete_instance(&txn, req.id)
        .await
        .context(h!())?;
    if !deleted {
        return Err(AppError::NotFound);
    }
    txn.commit().await.c(h!())?;
    let (restart_status, restart_error) = apply_instance_mutation(&env).await;
    Ok(Json(InstanceMutationRsp {
        instance: None,
        deleted,
        restart_status,
        restart_error,
    }))
}

#[post("/api/admin/transcriber/instances/check")]
pub async fn check_instance(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<InstanceIdReq>,
) -> Result<Json<InstanceHealthRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    Ok(Json(
        env.echo_gpu_client
            .check_instance(req.id)
            .await
            .context(h!())?
            .into(),
    ))
}

#[post("/api/admin/transcriber/status")]
pub async fn queue_status(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<QueueStatusRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await?;
    Ok(Json(
        echo_gpu_client::queue_status(&env.dbx)
            .await
            .context(h!())?
            .into(),
    ))
}

#[derive(Debug, FromQueryResult)]
struct TranscriptionResultRow {
    id: Uuid,
    source_id: Uuid,
    file_name: Option<String>,
    created_at: chrono::NaiveDateTime,
    started_transcription_at: Option<chrono::NaiveDateTime>,
    finished_at: Option<chrono::NaiveDateTime>,
    status: String,
    transcribed_value: Option<String>,
    error: Option<String>,
    instance_id: Option<Uuid>,
    instance_name: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct TranscriptionResultCount {
    total: i64,
}

const TRANSCRIPTION_RESULTS_QUEUE_COLUMNS: &str = r#"
id,
source_id,
created_at,
started_transcription_at,
finished_at,
state,
transcribed_value,
last_error,
actual_instance_id,
selected_instance_id
"#;

fn transcription_results_from_sql(filtered: bool) -> String {
    let queue_sql = if filtered {
        format!(
            r#"(
select {TRANSCRIPTION_RESULTS_QUEUE_COLUMNS}
from echo_gpu_transcription_queue
order by created_at desc, id desc
limit {}
)"#,
            crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_FILTER_ROW_LIMIT
        )
    } else {
        "echo_gpu_transcription_queue".to_string()
    };
    format!(
        r#"
from {queue_sql} queue
left join signal_message_media media on media.id = queue.source_id
left join gpu_config actual_instance on actual_instance.id = queue.actual_instance_id
left join gpu_config selected_instance on selected_instance.id = queue.selected_instance_id
"#
    )
}

const TRANSCRIPTION_RESULT_CREATED_AT_FILTER: &str = "to_char(queue.created_at at time zone 'UTC' at time zone 'Europe/Kyiv', 'DD.MM.YYYY, HH24:MI:SS')";
const TRANSCRIPTION_RESULT_STARTED_AT_FILTER: &str = "coalesce(to_char(queue.started_transcription_at at time zone 'UTC' at time zone 'Europe/Kyiv', 'DD.MM.YYYY, HH24:MI:SS'), '—')";
const TRANSCRIPTION_RESULT_COMPLETION_TIME_FILTER: &str = r#"
case
    when queue.finished_at is null or queue.started_transcription_at is null then '—'
    else
        lpad((greatest(extract(epoch from queue.finished_at - queue.started_transcription_at)::bigint, 0) / 3600)::text, 2, '0')
        || ':'
        || lpad(((greatest(extract(epoch from queue.finished_at - queue.started_transcription_at)::bigint, 0) % 3600) / 60)::text, 2, '0')
        || ':'
        || lpad((greatest(extract(epoch from queue.finished_at - queue.started_transcription_at)::bigint, 0) % 60)::text, 2, '0')
end
"#;
const TRANSCRIPTION_RESULT_STATUS_FILTER: &str = r#"
case queue.state
    when 'queued' then 'У черзі'
    when 'processing' then 'Транскрибується'
    when 'retrying' then 'Повторна спроба'
    when 'completed' then 'Завершено'
    when 'terminal' then 'Помилка'
    else queue.state
end
"#;
const TRANSCRIPTION_RESULT_INSTANCE_FILTER: &str = "coalesce(actual_instance.name, selected_instance.name, queue.actual_instance_id::text, queue.selected_instance_id::text, '—')";

const TRANSCRIPTION_RESULT_GLOBAL_FILTER_EXPRESSIONS: &[&str] = &[
    "coalesce(media.file_name, queue.source_id::text)",
    TRANSCRIPTION_RESULT_CREATED_AT_FILTER,
    TRANSCRIPTION_RESULT_STARTED_AT_FILTER,
    TRANSCRIPTION_RESULT_COMPLETION_TIME_FILTER,
    TRANSCRIPTION_RESULT_STATUS_FILTER,
    "queue.state",
    TRANSCRIPTION_RESULT_INSTANCE_FILTER,
    "coalesce(queue.transcribed_value, '—')",
    "coalesce(queue.last_error, '—')",
];

fn transcription_result_filter_expressions(
    id: &str,
) -> Option<&'static [&'static str]> {
    match id {
        "attachment" => {
            Some(&["coalesce(media.file_name, queue.source_id::text)"])
        }
        "created_at" => Some(&[TRANSCRIPTION_RESULT_CREATED_AT_FILTER]),
        "started_transcription_at" => {
            Some(&[TRANSCRIPTION_RESULT_STARTED_AT_FILTER])
        }
        "completion_time_seconds" => {
            Some(&[TRANSCRIPTION_RESULT_COMPLETION_TIME_FILTER])
        }
        "status" => Some(&[TRANSCRIPTION_RESULT_STATUS_FILTER, "queue.state"]),
        "instance" => Some(&[TRANSCRIPTION_RESULT_INSTANCE_FILTER]),
        "transcribed_value" => {
            Some(&["coalesce(queue.transcribed_value, '—')"])
        }
        "error" => Some(&["coalesce(queue.last_error, '—')"]),
        _ => None,
    }
}

fn transcription_result_filter_strings(
    value: &serde_json::Value,
) -> Result<Vec<String>, AppError> {
    let values = match value {
        serde_json::Value::String(value) => vec![value.clone()],
        serde_json::Value::Number(value) => vec![value.to_string()],
        serde_json::Value::Bool(value) => vec![value.to_string()],
        serde_json::Value::Array(values) => {
            let mut strings = Vec::new();
            for value in values {
                strings.extend(
                    transcription_result_filter_strings(value).context(h!())?,
                );
            }
            strings
        }
        serde_json::Value::Null => Vec::new(),
        _ => return Err(invalid_transcription_result_filter()),
    };
    Ok(values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect())
}

fn transcription_result_like_value(value: &str) -> String {
    let value = value
        .trim()
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{value}%")
}

fn push_transcription_result_filter(
    conditions: &mut Vec<String>,
    values: &mut Vec<Value>,
    expressions: &[&str],
    filter_values: Vec<String>,
) {
    let mut alternatives = Vec::new();
    for filter_value in filter_values {
        values.push(transcription_result_like_value(&filter_value).into());
        let placeholder = values.len();
        alternatives.push(format!(
            "({})",
            expressions
                .iter()
                .map(|expression| format!(
                    "lower({expression}) like ${placeholder}"
                ))
                .collect::<Vec<_>>()
                .join(" or ")
        ));
    }
    if !alternatives.is_empty() {
        conditions.push(format!("({})", alternatives.join(" or ")));
    }
}

fn transcription_result_filters_sql(
    req: &TranscriptionResultListReq,
) -> Result<(String, Vec<Value>), AppError> {
    if req.column_filters.len()
        > crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_COLUMN_FILTER_MAX_COUNT
    {
        return Err(invalid_transcription_result_filter());
    }
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if let Some(global_filter) = req
        .global_filter
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let global_filter = global_filter.to_string();
        validate_transcription_result_filter_values(std::slice::from_ref(
            &global_filter,
        ))
        .context(h!())?;
        push_transcription_result_filter(
            &mut conditions,
            &mut values,
            TRANSCRIPTION_RESULT_GLOBAL_FILTER_EXPRESSIONS,
            vec![global_filter],
        );
    }
    for filter in &req.column_filters {
        let Some(expressions) =
            transcription_result_filter_expressions(&filter.id)
        else {
            return Err(invalid_transcription_result_filter());
        };
        let filter_values =
            transcription_result_filter_strings(&filter.value).context(h!())?;
        validate_transcription_result_filter_values(&filter_values)
            .context(h!())?;
        push_transcription_result_filter(
            &mut conditions,
            &mut values,
            expressions,
            filter_values,
        );
    }
    if conditions.is_empty() {
        Ok((String::new(), values))
    } else {
        Ok((format!("where {}", conditions.join(" and ")), values))
    }
}

fn invalid_transcription_result_filter() -> AppError {
    AppError::BL {
        msg: "invalid transcription-result filter".to_string(),
    }
}

fn validate_transcription_result_filter_values(
    values: &[String],
) -> Result<(), AppError> {
    if values.len()
        > crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_FILTER_VALUE_MAX_COUNT
        || values.iter().any(|value| {
            value.chars().count()
                > crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_FILTER_MAX_CHARS
        })
    {
        return Err(invalid_transcription_result_filter());
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct TranscriptionResultCursor {
    created_at: chrono::NaiveDateTime,
    id: Uuid,
}

#[derive(Clone, Copy)]
enum TranscriptionResultPage {
    First,
    After(TranscriptionResultCursor),
    Before(TranscriptionResultCursor),
    Last,
}

fn invalid_transcription_result_cursor() -> AppError {
    AppError::BL {
        msg: "invalid transcription-result cursor".to_string(),
    }
}

fn parse_transcription_result_cursor(
    value: &str,
) -> Result<TranscriptionResultCursor, AppError> {
    let Some((created_at, id)) = value.split_once(':') else {
        return Err(invalid_transcription_result_cursor());
    };
    let Ok(created_at) = created_at.parse::<i64>() else {
        return Err(invalid_transcription_result_cursor());
    };
    let Some(created_at) = chrono::DateTime::from_timestamp_micros(created_at)
        .map(|created_at| created_at.naive_utc())
    else {
        return Err(invalid_transcription_result_cursor());
    };
    let Ok(id) = Uuid::parse_str(id) else {
        return Err(invalid_transcription_result_cursor());
    };
    Ok(TranscriptionResultCursor { created_at, id })
}

fn transcription_result_page(
    req: &TranscriptionResultListReq,
) -> Result<TranscriptionResultPage, AppError> {
    if req.last_page.unwrap_or(false) {
        if req.after.is_some() || req.before.is_some() {
            return Err(invalid_transcription_result_cursor());
        }
        return Ok(TranscriptionResultPage::Last);
    }
    match (req.after.as_deref(), req.before.as_deref()) {
        (None, None) => Ok(TranscriptionResultPage::First),
        (Some(after), None) => Ok(TranscriptionResultPage::After(
            parse_transcription_result_cursor(after).context(h!())?,
        )),
        (None, Some(before)) => Ok(TranscriptionResultPage::Before(
            parse_transcription_result_cursor(before).context(h!())?,
        )),
        (Some(_), Some(_)) => Err(invalid_transcription_result_cursor()),
    }
}

fn encode_transcription_result_cursor(row: &TranscriptionResultRow) -> String {
    format!("{}:{}", row.created_at.and_utc().timestamp_micros(), row.id)
}

impl From<TranscriptionResultRow> for TranscriptionResultRsp {
    fn from(row: TranscriptionResultRow) -> Self {
        let completion_time_seconds = row
            .finished_at
            .zip(row.started_transcription_at)
            .map(|(finished_at, started_at)| {
                (finished_at - started_at).num_seconds().max(0)
            });
        Self {
            id: row.id,
            source_id: row.source_id,
            file_name: row.file_name,
            created_at: row.created_at.and_utc().timestamp_millis(),
            started_transcription_at: row
                .started_transcription_at
                .map(|value| value.and_utc().timestamp_millis()),
            completion_time_seconds,
            status: row.status,
            transcribed_value: row.transcribed_value,
            error: row.error,
            instance_id: row.instance_id,
            instance_name: row.instance_name,
        }
    }
}

fn transcription_result_limit(req: &TranscriptionResultListReq) -> u64 {
    req.limit
        .unwrap_or(crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_LIST_LIMIT)
        .clamp(
            1,
            crate::config::ECHO_AUDIO_TRANSCRIPTION_RESULTS_LIST_LIMIT,
        )
}

async fn query_transcription_result_total<C>(
    dbx: &C,
    from_sql: &str,
    filters_sql: &str,
    values: &[Value],
) -> Result<u64, AppError>
where
    C: ConnectionTrait,
{
    let total = TranscriptionResultCount::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("select count(*) as total {from_sql} {filters_sql}"),
            values.to_vec(),
        ),
    )
    .one(dbx)
    .await
    .c(h!())?
    .context(h!())?;
    Ok(u64::try_from(total.total).c(h!())?)
}

fn transcription_result_page_sql(
    page: TranscriptionResultPage,
    values: &mut Vec<Value>,
) -> (String, &'static str, bool) {
    match page {
        TranscriptionResultPage::First => {
            (String::new(), "queue.created_at desc, queue.id desc", false)
        }
        TranscriptionResultPage::After(cursor) => {
            values.push(cursor.created_at.into());
            let created_at_placeholder = values.len();
            values.push(cursor.id.into());
            let id_placeholder = values.len();
            (
                format!(
                    "(queue.created_at, queue.id) < (${created_at_placeholder}, ${id_placeholder})"
                ),
                "queue.created_at desc, queue.id desc",
                false,
            )
        }
        TranscriptionResultPage::Before(cursor) => {
            values.push(cursor.created_at.into());
            let created_at_placeholder = values.len();
            values.push(cursor.id.into());
            let id_placeholder = values.len();
            (
                format!(
                    "(queue.created_at, queue.id) > (${created_at_placeholder}, ${id_placeholder})"
                ),
                "queue.created_at asc, queue.id asc",
                true,
            )
        }
        TranscriptionResultPage::Last => {
            (String::new(), "queue.created_at asc, queue.id asc", true)
        }
    }
}

fn transcription_result_page_filters_sql(
    filters_sql: &str,
    boundary_sql: &str,
) -> String {
    if boundary_sql.is_empty() {
        filters_sql.to_string()
    } else if filters_sql.is_empty() {
        format!("where {boundary_sql}")
    } else {
        format!("{filters_sql} and {boundary_sql}")
    }
}

fn transcription_result_fetch_limit(
    page: TranscriptionResultPage,
    total: u64,
    limit: u64,
) -> u64 {
    if !matches!(page, TranscriptionResultPage::Last) {
        return limit + 1;
    }
    if total == 0 {
        limit
    } else {
        (total - 1) % limit + 1
    }
}

async fn query_transcription_result_rows<C>(
    dbx: &C,
    from_sql: &str,
    filters_sql: &str,
    mut values: Vec<Value>,
    page: TranscriptionResultPage,
    total: u64,
    limit: u64,
) -> Result<(Vec<TranscriptionResultRow>, bool), AppError>
where
    C: ConnectionTrait,
{
    let (boundary_sql, order_sql, reverse_rows) =
        transcription_result_page_sql(page, &mut values);
    let page_filters_sql =
        transcription_result_page_filters_sql(filters_sql, &boundary_sql);
    let fetch_limit = transcription_result_fetch_limit(page, total, limit);
    values.push(i64::try_from(fetch_limit).c(h!())?.into());
    let limit_placeholder = values.len();
    let mut rows = TranscriptionResultRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                r#"
select
    queue.id,
    queue.source_id,
    media.file_name,
    queue.created_at,
    queue.started_transcription_at,
    queue.finished_at,
    queue.state as status,
    queue.transcribed_value,
    queue.last_error as error,
    coalesce(queue.actual_instance_id, queue.selected_instance_id) as instance_id,
    coalesce(actual_instance.name, selected_instance.name) as instance_name
{from_sql}
{page_filters_sql}
order by {order_sql}
limit ${limit_placeholder}
                "#,
            ),
            values,
        ),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let had_extra = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    if reverse_rows {
        rows.reverse();
    }
    Ok((rows, had_extra))
}

fn transcription_result_list_response(
    rows: Vec<TranscriptionResultRow>,
    total: u64,
    page: TranscriptionResultPage,
    had_extra: bool,
) -> TranscriptionResultListRsp {
    let (has_more, has_previous) = match page {
        TranscriptionResultPage::First => (had_extra, false),
        TranscriptionResultPage::After(_) => (had_extra, !rows.is_empty()),
        TranscriptionResultPage::Before(_) => (!rows.is_empty(), had_extra),
        TranscriptionResultPage::Last => (false, total > rows.len() as u64),
    };
    let next_cursor = has_more
        .then(|| rows.last().map(encode_transcription_result_cursor))
        .flatten();
    let previous_cursor = has_previous
        .then(|| rows.first().map(encode_transcription_result_cursor))
        .flatten();
    TranscriptionResultListRsp {
        has_more,
        rows: rows.into_iter().map(Into::into).collect(),
        total,
        next_cursor,
        previous_cursor,
    }
}

async fn query_transcription_results(
    dbx: &DatabaseConnection,
    req: &TranscriptionResultListReq,
) -> Result<TranscriptionResultListRsp, AppError> {
    let limit = transcription_result_limit(req);
    let (filters_sql, values) =
        transcription_result_filters_sql(req).context(h!())?;
    let from_sql = transcription_results_from_sql(!filters_sql.is_empty());
    let transaction = dbx
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let total = query_transcription_result_total(
        &transaction,
        &from_sql,
        &filters_sql,
        &values,
    )
    .await
    .c(h!())?;
    let page = transcription_result_page(req).context(h!())?;
    let (rows, had_extra) = query_transcription_result_rows(
        &transaction,
        &from_sql,
        &filters_sql,
        values,
        page,
        total,
        limit,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(transcription_result_list_response(
        rows, total, page, had_extra,
    ))
}

#[post("/api/admin/transcriber/results/list")]
pub async fn list_results(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<TranscriptionResultListReq>,
) -> Result<Json<TranscriptionResultListRsp>, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await.c(h!())?;
    Ok(Json(
        query_transcription_results(&env.dbx, &req).await.c(h!())?,
    ))
}

#[get("/api/admin/transcriber/results/{source_id}/media")]
pub async fn result_media(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: HttpRequest,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    ensure_admin_enabled(env.as_ref(), &user).await.c(h!())?;
    let source_id = path.0;
    echo_gpu_transcription_queue::Entity::find()
        .select_only()
        .column(echo_gpu_transcription_queue::Column::Id)
        .filter(echo_gpu_transcription_queue::Column::SourceId.eq(source_id))
        .into_tuple::<Uuid>()
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let media = signal_message_media::Entity::find_by_id(source_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(
        crate::rer_importer::serve_messenger_media(&req, env.as_ref(), &media)
            .await
            .c(h!())?,
    )
}

#[post("/api/transcriber/messages/{message_id}")]
pub async fn message_transcriptions(
    user: Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(i64,)>,
) -> Result<Json<Vec<MessageTranscriptionRsp>>, AppError> {
    let login = crate::users::login_id_from_identity(&user)?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    crate::system_settings::ensure_audio_transcription_enabled(&env.dbx)
        .await
        .c(h!())?;
    crate::messenger::media::ensure_media_access(&env.dbx, &login, path.0)
        .await?;

    let media = signal_message_media::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message_media::Relation::SignalMessage.def(),
        )
        .filter(signal_message_media::Column::SignalMessageId.eq(path.0))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let transcriptions_by_media = completed_transcriptions(
        &env.dbx,
        &media.iter().map(|media| media.id).collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    let transcriptions = media
        .into_iter()
        .filter_map(|media| {
            transcriptions_by_media.get(&media.id).map(|text| {
                MessageTranscriptionRsp {
                    media_id: media.id,
                    text: text.clone(),
                }
            })
        })
        .collect();
    Ok(Json(transcriptions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        echo_gpu_transcription_queue, login, signal_message_media,
        system_settings,
    };
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{cookie::Key, http::StatusCode, test, web, App};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
    };

    async fn insert_test_media(
        env: &Env,
        file_name: Option<&str>,
    ) -> signal_message_media::Model {
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("audio/ogg".to_string()),
            file_ext: Set(Some("ogg".to_string())),
            file_name: Set(file_name.map(str::to_string)),
            size_bytes: Set(0),
            created_at: Set(chrono::Utc::now().naive_utc()),
            is_encrypted: Set(false),
            storage_key: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }

    struct TranscriptionResultSeed<'a> {
        source_id: Uuid,
        state: &'a str,
        created_at: chrono::NaiveDateTime,
        started_at: Option<chrono::NaiveDateTime>,
        finished_at: Option<chrono::NaiveDateTime>,
        selected_instance_id: Option<Uuid>,
        actual_instance_id: Option<Uuid>,
        value: Option<&'a str>,
        error: Option<&'a str>,
    }

    async fn insert_transcription_result(
        env: &Env,
        seed: TranscriptionResultSeed<'_>,
    ) -> echo_gpu_transcription_queue::Model {
        echo_gpu_transcription_queue::ActiveModel {
            id: Set(Uuid::now_v7()),
            source_id: Set(seed.source_id),
            state: Set(seed.state.to_string()),
            transcribed_value: Set(seed.value.map(str::to_string)),
            selected_instance_id: Set(seed.selected_instance_id),
            actual_instance_id: Set(seed.actual_instance_id),
            last_error: Set(seed.error.map(str::to_string)),
            finished_at: Set(seed.finished_at),
            created_at: Set(seed.created_at),
            updated_at: Set(seed.finished_at.unwrap_or(seed.created_at)),
            started_transcription_at: Set(seed.started_at),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }

    async fn transition_transcription_result(
        env: &Env,
        source_id: Uuid,
        state: &str,
        updated_at: chrono::NaiveDateTime,
    ) -> echo_gpu_transcription_queue::Model {
        let queue = echo_gpu_transcription_queue::Entity::find()
            .filter(
                echo_gpu_transcription_queue::Column::SourceId.eq(source_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let mut queue = queue.into_active_model();
        queue.state = Set(state.to_string());
        queue.updated_at = Set(updated_at);
        queue.update(&env.dbx).await.unwrap()
    }

    struct FailedRestarter;

    #[async_trait::async_trait]
    impl BgworkerRestarter for FailedRestarter {
        async fn request_restart(&self) -> std::io::Result<()> {
            Err(std::io::Error::other("systemd unavailable"))
        }
    }

    struct SuccessfulRestarter;

    #[async_trait::async_trait]
    impl BgworkerRestarter for SuccessfulRestarter {
        async fn request_restart(&self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn restart_failure_is_reported_as_partial_success() {
        let (status, error) =
            mutation_restart_result(None, &FailedRestarter).await;
        assert!(matches!(status, RestartStatus::Failed));
        assert_eq!(
            error.as_deref(),
            Some("failed to request bgworker restart: systemd unavailable")
        );
    }

    #[tokio::test]
    async fn reload_failure_is_reported_after_the_mutation() {
        let (status, error) = mutation_restart_result(
            Some(anyhow::anyhow!("database unavailable")),
            &SuccessfulRestarter,
        )
        .await;
        assert!(matches!(status, RestartStatus::Failed));
        assert_eq!(
            error.as_deref(),
            Some("failed to reload GPU instances: database unavailable")
        );
    }

    #[actix_web::test]
    async fn endpoints_enforce_auth_role_feature_and_message_access() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let password = "transcriber-http-test";
        let salt = format!("{}Tester", crate::config::IDENTITY_SALT);
        let password_hash = argon2::hash_encoded(
            password.as_bytes(),
            salt.as_bytes(),
            &argon2::Config::original(),
        )
        .unwrap();
        let mut login: login::ActiveModel = login::Entity::find_by_id(login_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        login.password = Set(Some(password_hash));
        login.password_auth_enabled = Set(true);
        login.roles = Set(serde_json::json!(["Admin", "Api"]));
        login.update(&env.dbx).await.unwrap();
        let media = insert_test_media(&env, Some("authorized.ogg")).await;
        let unqueued_media =
            insert_test_media(&env, Some("not-queued.ogg")).await;
        echo_gpu_client::enqueue(&env.dbx, media.id).await.unwrap();

        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .app_data(web::Data::from(env.clone()))
                .service(crate::users::user_test_api_login)
                .service(queue_status)
                .service(list_results)
                .service(result_media)
                .service(message_transcriptions),
        )
        .await;

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/status")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/results/list")
                .set_json(serde_json::json!({}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/admin/transcriber/results/{}/media",
                    media.id
                ))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/user/test-api-login")
                .set_json(crate::users::types::LoginReq {
                    user: "Tester".into(),
                    password: password.into(),
                })
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.response().cookies().next().unwrap().into_owned();

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/status")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/results/list")
                .cookie(cookie.clone())
                .set_json(serde_json::json!({}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/admin/transcriber/results/{}/media",
                    media.id
                ))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        system_settings::ActiveModel {
            enable_audio_transcription: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/status")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/results/list")
                .cookie(cookie.clone())
                .set_json(serde_json::json!({}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/admin/transcriber/results/{}/media",
                    media.id
                ))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/admin/transcriber/results/{}/media",
                    unqueued_media.id
                ))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let mut login: login::ActiveModel = login::Entity::find_by_id(login_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        login.roles = Set(serde_json::json!(["Api"]));
        login.update(&env.dbx).await.unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/status")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/transcriber/results/list")
                .cookie(cookie.clone())
                .set_json(serde_json::json!({}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/admin/transcriber/results/{}/media",
                    media.id
                ))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/api/transcriber/messages/{}", message.id))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let mut login: login::ActiveModel = login::Entity::find_by_id(login_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        login.roles = Set(serde_json::json!(["Rer"]));
        login.update(&env.dbx).await.unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/api/transcriber/messages/{}", message.id))
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    struct TranscriptionResultsFixture {
        instance_id: Uuid,
        completed_source_id: Uuid,
        terminal_source_id: Uuid,
        pending_source_id: Uuid,
        now: chrono::NaiveDateTime,
    }

    async fn seed_transcription_results(
        env: &Env,
    ) -> TranscriptionResultsFixture {
        let instance = echo_gpu_client::create_instance(
            &env.dbx,
            echo_gpu_client::CreateInstance {
                name: "result-list-gpu".to_string(),
                host: "result-list.invalid".to_string(),
                rs_port: 1,
                py_port: 2,
                train: false,
                ordering: Some(1),
            },
        )
        .await
        .unwrap();
        let now = chrono::Utc::now().naive_utc();
        let completed_media =
            insert_test_media(env, Some("alpha-recording.ogg")).await;
        let terminal_media =
            insert_test_media(env, Some("beta-recording.ogg")).await;
        let pending_source_id = Uuid::now_v7();
        insert_transcription_result(
            env,
            TranscriptionResultSeed {
                source_id: completed_media.id,
                state: "completed",
                created_at: now - chrono::Duration::seconds(30),
                started_at: Some(now - chrono::Duration::seconds(28)),
                finished_at: Some(now - chrono::Duration::seconds(23)),
                selected_instance_id: None,
                actual_instance_id: Some(instance.id),
                value: Some("recognized alpha"),
                error: None,
            },
        )
        .await;
        insert_transcription_result(
            env,
            TranscriptionResultSeed {
                source_id: terminal_media.id,
                state: "terminal",
                created_at: now - chrono::Duration::seconds(20),
                started_at: Some(now - chrono::Duration::seconds(18)),
                finished_at: Some(now - chrono::Duration::seconds(15)),
                selected_instance_id: Some(instance.id),
                actual_instance_id: None,
                value: None,
                error: Some("transcription failed"),
            },
        )
        .await;
        insert_transcription_result(
            env,
            TranscriptionResultSeed {
                source_id: pending_source_id,
                state: "queued",
                created_at: now - chrono::Duration::seconds(10),
                started_at: None,
                finished_at: None,
                selected_instance_id: None,
                actual_instance_id: None,
                value: None,
                error: None,
            },
        )
        .await;
        TranscriptionResultsFixture {
            instance_id: instance.id,
            completed_source_id: completed_media.id,
            terminal_source_id: terminal_media.id,
            pending_source_id,
            now,
        }
    }

    async fn assert_transcription_result_filters(
        env: &Env,
        fixture: &TranscriptionResultsFixture,
    ) {
        let filtered = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                global_filter: Some("alpha".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.rows[0].source_id, fixture.completed_source_id);
        assert_eq!(filtered.rows[0].completion_time_seconds, Some(5));
        assert_eq!(filtered.rows[0].instance_id, Some(fixture.instance_id));
        assert_eq!(
            filtered.rows[0].instance_name.as_deref(),
            Some("result-list-gpu")
        );

        let terminal = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                column_filters: vec![TranscriptionResultColumnFilter {
                    id: "status".to_string(),
                    value: serde_json::json!("terminal"),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(terminal.total, 1);
        assert_eq!(terminal.rows[0].source_id, fixture.terminal_source_id);
        assert_eq!(
            terminal.rows[0].error.as_deref(),
            Some("transcription failed")
        );
        assert_eq!(
            terminal.rows[0].instance_name.as_deref(),
            Some("result-list-gpu")
        );

        let localized_status = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                column_filters: vec![TranscriptionResultColumnFilter {
                    id: "status".to_string(),
                    value: serde_json::json!("Завершено"),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(localized_status.total, 1);
        assert_eq!(
            localized_status.rows[0].source_id,
            fixture.completed_source_id
        );

        let completion_time = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                column_filters: vec![TranscriptionResultColumnFilter {
                    id: "completion_time_seconds".to_string(),
                    value: serde_json::json!("00:00:05"),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(completion_time.total, 1);
        assert_eq!(
            completion_time.rows[0].source_id,
            fixture.completed_source_id
        );

        let pending_created_at = (fixture.now - chrono::Duration::seconds(10))
            .and_utc()
            .with_timezone(&chrono_tz::Europe::Kyiv)
            .format("%d.%m.%Y, %H:%M:%S")
            .to_string();
        let created_at = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                column_filters: vec![TranscriptionResultColumnFilter {
                    id: "created_at".to_string(),
                    value: serde_json::json!(pending_created_at),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(created_at.total, 1);
        assert_eq!(created_at.rows[0].source_id, fixture.pending_source_id);

        let invalid_filter = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                column_filters: vec![TranscriptionResultColumnFilter {
                    id: "unknown".to_string(),
                    value: serde_json::json!("value"),
                }],
                ..Default::default()
            },
        )
        .await;
        assert!(matches!(invalid_filter, Err(AppError::BL { .. })));
    }

    async fn assert_transcription_result_cursors(
        env: &Env,
        fixture: &TranscriptionResultsFixture,
    ) {
        let first = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                limit: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(first.rows[0].source_id, fixture.pending_source_id);
        assert_eq!(first.rows[0].started_transcription_at, None);
        let first_cursor = first.next_cursor.unwrap();

        let inserted_source_id = Uuid::now_v7();
        insert_transcription_result(
            env,
            TranscriptionResultSeed {
                source_id: inserted_source_id,
                state: "queued",
                created_at: fixture.now,
                started_at: None,
                finished_at: None,
                selected_instance_id: None,
                actual_instance_id: None,
                value: None,
                error: None,
            },
        )
        .await;
        let second = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                limit: Some(1),
                after: Some(first_cursor),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(second.rows[0].source_id, fixture.terminal_source_id);
        assert_eq!(second.total, 4);

        let previous = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                limit: Some(1),
                before: second.previous_cursor,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(previous.rows[0].source_id, fixture.pending_source_id);

        let last = query_transcription_results(
            &env.dbx,
            &TranscriptionResultListReq {
                limit: Some(1),
                last_page: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(last.rows[0].source_id, fixture.completed_source_id);
        assert!(!last.has_more);
    }

    async fn assert_transcription_start_reconciliation(
        env: &Env,
        fixture: &TranscriptionResultsFixture,
    ) {
        fn assert_started_at(
            actual: Option<chrono::NaiveDateTime>,
            expected: chrono::NaiveDateTime,
        ) {
            assert_eq!(
                actual.map(|value| value.and_utc().timestamp_micros()),
                Some(expected.and_utc().timestamp_micros())
            );
        }

        let reset_at = fixture.now + chrono::Duration::seconds(1);
        let queue = transition_transcription_result(
            env,
            fixture.completed_source_id,
            "queued",
            reset_at,
        )
        .await;
        assert_eq!(queue.started_transcription_at, None);
        let started_at = fixture.now + chrono::Duration::seconds(2);
        let queue = transition_transcription_result(
            env,
            fixture.completed_source_id,
            "processing",
            started_at,
        )
        .await;
        assert_started_at(queue.started_transcription_at, started_at);
        let queue = transition_transcription_result(
            env,
            fixture.completed_source_id,
            "retrying",
            fixture.now + chrono::Duration::seconds(3),
        )
        .await;
        assert_started_at(queue.started_transcription_at, started_at);
        let queue = transition_transcription_result(
            env,
            fixture.completed_source_id,
            "processing",
            fixture.now + chrono::Duration::seconds(4),
        )
        .await;
        assert_started_at(queue.started_transcription_at, started_at);
        transition_transcription_result(
            env,
            fixture.completed_source_id,
            "terminal",
            fixture.now + chrono::Duration::seconds(5),
        )
        .await;
        let restarted_at = fixture.now + chrono::Duration::seconds(6);
        let queue = transition_transcription_result(
            env,
            fixture.completed_source_id,
            "processing",
            restarted_at,
        )
        .await;
        assert_started_at(queue.started_transcription_at, restarted_at);
    }

    #[tokio::test]
    async fn result_listing_is_filtered_cursor_stable_and_reconciles_starts() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let fixture = seed_transcription_results(&env).await;
        assert_transcription_result_filters(&env, &fixture).await;
        assert_transcription_result_cursors(&env, &fixture).await;
        assert_transcription_start_reconciliation(&env, &fixture).await;
    }

    #[tokio::test]
    async fn completed_transcriptions_omit_pending_results() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let completed_id = Uuid::now_v7();
        let pending_id = Uuid::now_v7();
        let instance = echo_gpu_client::create_instance(
            &env.dbx,
            echo_gpu_client::CreateInstance {
                name: format!("test-{}", Uuid::now_v7()),
                host: format!("test-{}.invalid", Uuid::now_v7()),
                rs_port: 1,
                py_port: 2,
                train: false,
                ordering: Some(1),
            },
        )
        .await
        .unwrap();
        echo_gpu_client::enqueue(&env.dbx, completed_id)
            .await
            .unwrap();
        let claim = echo_gpu_client::claim_one(&env.dbx, Uuid::now_v7())
            .await
            .unwrap()
            .unwrap();
        let audio_id = Uuid::now_v7();
        echo_gpu_client::complete(
            &env.dbx,
            claim.fence(),
            &echo_gpu_client::CompletedTranscription {
                value: "recognized speech".into(),
                instance_id: instance.id,
                audio_id,
                checksum: "a".repeat(64),
                response: echo_gpu_client::GuessResponse {
                    audio_id: audio_id.to_string(),
                    full_phrase: "recognized speech".into(),
                    segments: Vec::new(),
                },
            },
        )
        .await
        .unwrap();
        echo_gpu_client::enqueue(&env.dbx, pending_id)
            .await
            .unwrap();

        let transcriptions =
            completed_transcriptions(&env.dbx, &[completed_id, pending_id])
                .await
                .unwrap();

        assert_eq!(transcriptions.len(), 1);
        assert_eq!(
            transcriptions.get(&completed_id).map(String::as_str),
            Some("recognized speech")
        );
    }
}
