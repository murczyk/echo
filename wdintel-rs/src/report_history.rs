use crate::config::{
    DISCORD_WEBHOOK_ALERT, REPORT_HISTORY_CANCELLED_ERROR_STATUS,
    REPORT_HISTORY_DISCORD_ALERT_TIMEOUT_SEC,
    REPORT_HISTORY_ETALONKA_IN_PROGRESS_TIMEOUT_SECS,
    REPORT_HISTORY_ETALONKA_WORKER_COUNT, REPORT_HISTORY_GENERIC_ERROR_STATUS,
    REPORT_HISTORY_GLOBAL_WORKER_COUNT,
    REPORT_HISTORY_IN_PROGRESS_TIMEOUT_SECS, REPORT_HISTORY_LIST_LIMIT,
    REPORT_HISTORY_MESSAGE_LIMIT_ERROR_STATUS,
    REPORT_HISTORY_NO_DEFAULT_AOR_ERROR_STATUS, REPORT_HISTORY_RECORD_LIMIT,
    REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS,
    REPORT_HISTORY_TIMEOUT_ERROR_STATUS,
    REPORT_HISTORY_TIMEOUT_WORKER_SLEEP_SECS,
    REPORT_HISTORY_USER_RETRY_LOG_MESSAGE,
    REPORT_HISTORY_WORKER_INTERRUPTED_ERROR_STATUS,
    REPORT_HISTORY_WORKER_RESTART_LOG_MESSAGE,
    RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE,
    RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE,
};
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{
    area_of_responsibility, bgtask, login, prelude::*, report_download_history,
    report_history,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::{ReportPreviewReq, ReportType};
use crate::rer_importer::types::AnalysisStatsReq;
use crate::sigint::etalonka::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq,
};
use crate::types::{Env, ShortContext};
use crate::users::{
    ensure_admin, ensure_rer_role, ensure_rer_role_by_id, has_role,
    login_id_from_identity,
};
use actix_identity::Identity;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::{post, HttpResponse};
use anyhow::Context;
use chrono::{Datelike, Duration, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use log::{error, info, warn};
use sea_orm::sea_query::{Expr, NullOrdering, Order, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, IntoActiveModel,
    JoinType, NotSet, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
    RelationTrait, Select, Set, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration as StdDuration;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use uuid::Uuid;

pub const STATUS_PLANNED: &str = "planned";
pub const STATUS_IN_PROGRESS: &str = "in_progress";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_DONE: &str = "done";

pub const KIND_SUMMARY_TABLE: &str = "summary_table";
pub const KIND_KMZ: &str = "kmz";
pub const KIND_GEOJSON: &str = "geojson";
pub const KIND_ETALONKA: &str = "etalonka";
pub const KIND_GOI: &str = "goi";
pub const KIND_GOI_ASSOCIATIONS: &str = "goi_associations";
pub const KIND_RER_REPORT: &str = "rer_report";
pub const KIND_SPOSOB: &str = "sposob";

const REPORT_HISTORY_MAX_ATTEMPTS: i32 = 2;
const WORKER_IDLE_SLEEP_SECS: u64 = 5;
const REPORT_OBJECT_PREFIX: &str = "reports";
const REPORT_TIMEOUT_LOGIN: &str = "system";
const REPORT_CRASH_RECOVERY_LOGIN: &str = "system";

static REPORT_HISTORY_GLOBAL_GATE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(REPORT_HISTORY_GLOBAL_WORKER_COUNT));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ReportHistoryRequest {
    AnalysisReport {
        payload: Box<ReportPreviewReq>,
    },
    AnalysisExport {
        payload: Box<AnalysisStatsReq>,
    },
    EtalonkaFilter {
        payload: Box<EtalonkaJimForksReq>,
    },
    EtalonkaBatch {
        payload: Box<EtalonkaNetworkBatchReq>,
    },
    GoiReport {
        payload: serde_json::Value,
    },
    GoiAssociationsReport {
        payload: Box<crate::organism::goi::types::ListGoiAssociationsReq>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportHistoryRow {
    pub id: i64,
    pub report_kind: String,
    pub requested_by: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub planned_for_ts: Option<String>,
    pub queue_position: Option<i64>,
    pub blocked_by_report_id: Option<i64>,
    pub blocked_by_started_at: Option<String>,
    pub blocked_by_bgtask_id: Option<i64>,
    pub status: String,
    pub error_status: String,
    pub completed_at: Option<String>,
    pub has_file: bool,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub bgtask_id: Option<i64>,
    pub last_error: Option<String>,
    pub is_cancelled: bool,
    pub details: String,
    pub report_period: Option<String>,
    pub progress: i64,
    pub error_log: Option<Vec<ReportHistoryLogEntry>>,
    pub download_attempts: Vec<ReportDownloadHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportHistoryLogEntry {
    pub login: String,
    pub timestamp: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportDownloadHistoryEntry {
    pub login: String,
    pub requested_at: String,
    pub duration_ms: Option<i64>,
    pub successful: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportHistoryIdReq {
    pub id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReportHistoryAdminListReq {
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    pub global_filter: Option<String>,
    #[serde(default)]
    pub column_filters: Vec<ReportHistoryColumnFilter>,
    #[serde(default)]
    pub sorting: Vec<ReportHistorySorting>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReportHistoryColumnFilter {
    pub id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReportHistorySorting {
    pub id: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportHistoryAdminListRsp {
    pub rows: Vec<ReportHistoryRow>,
    pub total: u64,
    pub has_more: bool,
    pub next_offset: u64,
}

#[derive(Debug, Clone)]
struct GeneratedReport {
    file_name: String,
    content_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Default, Clone)]
struct ReportHistoryDetailRefs {
    aor_ids: Vec<i64>,
    network_ids: Vec<i64>,
}

#[derive(Debug, Default)]
struct ReportHistoryDetailLookup {
    aor_names_by_id: HashMap<i64, String>,
    network_labels_by_id: HashMap<i64, Vec<String>>,
    progress_by_bgtask_id: HashMap<i64, i64>,
}

#[derive(Debug, FromQueryResult)]
struct ReportHistoryNetworkDetailRow {
    network_id: i64,
    network_name: String,
    unit_name: Option<String>,
}

#[derive(Debug, Clone, FromQueryResult)]
struct ReportHistoryQueueMetaRow {
    id: i64,
    queue_position: i64,
    blocked_by_report_id: Option<i64>,
    blocked_by_started_at: Option<chrono::NaiveDateTime>,
    blocked_by_bgtask_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportHistoryQueueScope {
    report_kind: String,
    requested_by_login_id: Option<uuid::Uuid>,
}

fn report_history_queue_scope(
    report_kind: &str,
    requested_by_login_id: &uuid::Uuid,
) -> ReportHistoryQueueScope {
    if report_kind == KIND_ETALONKA {
        ReportHistoryQueueScope {
            report_kind: report_kind.to_string(),
            requested_by_login_id: Some(*requested_by_login_id),
        }
    } else {
        ReportHistoryQueueScope {
            report_kind: report_kind.to_string(),
            requested_by_login_id: None,
        }
    }
}

fn report_history_queue_scope_for_row(
    report_history: &report_history::Model,
) -> Option<ReportHistoryQueueScope> {
    if report_history.status != STATUS_PLANNED
        && report_history.status != STATUS_IN_PROGRESS
    {
        return None;
    }
    Some(report_history_queue_scope(
        &report_history.report_kind,
        &report_history.requested_by_login_id,
    ))
}

impl ReportHistoryDetailLookup {
    fn format_details(&self, refs: &ReportHistoryDetailRefs) -> String {
        let mut lines = vec![];

        let aor_names = refs
            .aor_ids
            .iter()
            .map(|id| {
                self.aor_names_by_id
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.to_string())
            })
            .collect::<Vec<_>>();
        if !aor_names.is_empty() {
            lines.push(format!("смуги: {}", aor_names.join(", ")));
        }

        let network_labels = refs
            .network_ids
            .iter()
            .flat_map(|id| {
                self.network_labels_by_id
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| vec![id.to_string()])
            })
            .collect::<Vec<_>>();
        if !network_labels.is_empty() {
            lines.push(format!("мережі: {}", network_labels.join(", ")));
        }

        lines.join("; ")
    }

    fn report_history_progress(
        &self,
        report_history: &report_history::Model,
    ) -> i64 {
        if report_history.status == STATUS_DONE {
            return 100;
        }
        let progress = report_history
            .bgtask_id
            .and_then(|bgtask_id| {
                self.progress_by_bgtask_id.get(&bgtask_id).copied()
            })
            .unwrap_or(0);
        progress.clamp(0, 100)
    }
}

async fn build_report_history_rows(
    dbx: &DatabaseConnection,
    report_histories: Vec<report_history::Model>,
    expose_last_error: bool,
) -> Result<Vec<ReportHistoryRow>, AppError> {
    let detail_refs = report_histories
        .iter()
        .map(|report_history| {
            report_history_detail_refs(&report_history.request)
        })
        .collect::<Vec<_>>();
    let lookup =
        load_report_history_detail_lookup(dbx, &report_histories, &detail_refs)
            .await?;
    let queue_meta_by_id =
        report_history_queue_meta(dbx, &report_histories).await?;
    let requested_by_by_id = crate::users::login_names_by_ids(
        dbx,
        report_histories
            .iter()
            .map(|report_history| report_history.requested_by_login_id)
            .collect(),
    )
    .await
    .c(h!())?;
    let mut download_attempts_by_report_id =
        load_report_download_attempts(dbx, &report_histories)
            .await
            .c(h!())?;

    Ok(report_histories
        .into_iter()
        .zip(detail_refs.iter())
        .map(|(report_history, refs)| {
            let report_history_id = report_history.id;
            let progress = lookup.report_history_progress(&report_history);
            let requested_by = requested_by_by_id
                .get(&report_history.requested_by_login_id)
                .cloned()
                .unwrap_or_else(|| {
                    report_history.requested_by_login_id.to_string()
                });
            to_report_history_row(
                report_history,
                requested_by,
                lookup.format_details(refs),
                progress,
                queue_meta_by_id.get(&report_history_id).cloned(),
                expose_last_error,
                download_attempts_by_report_id
                    .remove(&report_history_id)
                    .unwrap_or_default(),
            )
        })
        .collect())
}

async fn build_report_history_row(
    dbx: &DatabaseConnection,
    report_history: report_history::Model,
    expose_last_error: bool,
) -> Result<ReportHistoryRow, AppError> {
    let mut rows =
        build_report_history_rows(dbx, vec![report_history], expose_last_error)
            .await?;
    Ok(rows.remove(0))
}

fn to_report_history_row(
    report_history: report_history::Model,
    requested_by: String,
    details: String,
    progress: i64,
    queue_meta: Option<ReportHistoryQueueMetaRow>,
    expose_last_error: bool,
    download_attempts: Vec<ReportDownloadHistoryEntry>,
) -> ReportHistoryRow {
    let error_log =
        report_history_error_log(&report_history, expose_last_error);
    let (
        queue_position,
        blocked_by_report_id,
        blocked_by_started_at,
        blocked_by_bgtask_id,
    ) = match queue_meta {
        Some(queue_meta) => (
            Some(queue_meta.queue_position),
            queue_meta.blocked_by_report_id,
            queue_meta
                .blocked_by_started_at
                .map(|value| value.to_string()),
            queue_meta.blocked_by_bgtask_id,
        ),
        None => (None, None, None, None),
    };
    let is_cancelled = report_history_is_cancelled(&report_history);
    let error_status = report_history_error_status(&report_history);
    let report_period = report_history_period(&report_history.request);
    ReportHistoryRow {
        id: report_history.id,
        report_kind: report_history.report_kind,
        requested_by,
        created_at: report_history.created_at.to_string(),
        started_at: report_history
            .started_at
            .map(|started_at| started_at.to_string()),
        planned_for_ts: report_history
            .planned_for_ts
            .map(|planned_for_ts| planned_for_ts.to_string()),
        queue_position,
        blocked_by_report_id,
        blocked_by_started_at,
        blocked_by_bgtask_id,
        status: report_history.status,
        error_status,
        completed_at: report_history
            .completed_at
            .map(|completed_at| completed_at.to_string()),
        has_file: report_history.s3_id.is_some(),
        file_name: report_history.file_name,
        content_type: report_history.content_type,
        bgtask_id: report_history.bgtask_id,
        last_error: if expose_last_error {
            report_history.last_error
        } else {
            None
        },
        is_cancelled,
        details,
        report_period,
        progress,
        error_log,
        download_attempts,
    }
}

async fn load_report_download_attempts(
    dbx: &DatabaseConnection,
    report_histories: &[report_history::Model],
) -> Result<HashMap<i64, Vec<ReportDownloadHistoryEntry>>, AppError> {
    if report_histories.is_empty() {
        return Ok(HashMap::new());
    }
    let report_download_histories = ReportDownloadHistory::find()
        .filter(
            report_download_history::Column::ReportHistoryId.is_in(
                report_histories
                    .iter()
                    .map(|report_history| report_history.id),
            ),
        )
        .order_by_desc(report_download_history::Column::RequestedAt)
        .order_by_desc(report_download_history::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let login_names_by_id = crate::users::login_names_by_ids(
        dbx,
        report_download_histories
            .iter()
            .map(|report_download_history| {
                report_download_history.requested_by_login_id
            })
            .collect(),
    )
    .await
    .c(h!())?;

    let mut attempts_by_report_id = HashMap::new();
    for report_download_history in report_download_histories {
        let login = login_names_by_id
            .get(&report_download_history.requested_by_login_id)
            .cloned()
            .unwrap_or_else(|| {
                report_download_history.requested_by_login_id.to_string()
            });
        attempts_by_report_id
            .entry(report_download_history.report_history_id)
            .or_insert_with(Vec::new)
            .push(ReportDownloadHistoryEntry {
                login,
                requested_at: report_download_history.requested_at.to_string(),
                duration_ms: report_download_history.duration_ms,
                successful: report_download_history.successful,
            });
    }
    Ok(attempts_by_report_id)
}

fn report_history_is_cancelled(report_history: &report_history::Model) -> bool {
    report_history.status == STATUS_FAILED
        && report_history
            .last_error
            .as_deref()
            .map(|last_error| {
                last_error.contains(REPORT_HISTORY_CANCELLED_ERROR_STATUS)
            })
            .unwrap_or(false)
}

fn report_history_error_status(
    report_history: &report_history::Model,
) -> String {
    if report_history.status != STATUS_FAILED {
        return String::new();
    }
    if report_history_is_cancelled(report_history) {
        return REPORT_HISTORY_CANCELLED_ERROR_STATUS.to_string();
    }

    let last_error = report_history.last_error.as_deref().or_else(|| {
        report_history.log.as_array().and_then(|entries| {
            entries.iter().rev().find_map(|entry| {
                entry.get("message").and_then(serde_json::Value::as_str)
            })
        })
    });
    last_error
        .map(report_history_error_hint)
        .unwrap_or_else(|| REPORT_HISTORY_GENERIC_ERROR_STATUS.to_string())
}

fn report_history_error_hint(error: &str) -> String {
    if let Some(hint) = report_history_known_error_hint(error) {
        return hint.to_string();
    }

    let message = debug_msg_values(error)
        .last()
        .cloned()
        .or_else(|| nested_app_error_message(error));
    let Some(message) = message else {
        return REPORT_HISTORY_GENERIC_ERROR_STATUS.to_string();
    };
    report_history_known_error_hint(&message)
        .unwrap_or(REPORT_HISTORY_GENERIC_ERROR_STATUS)
        .to_string()
}

fn report_history_known_error_hint(error: &str) -> Option<&'static str> {
    let normalized = error.to_lowercase();
    if normalized.contains("mouse_report_message_limit")
        || normalized.contains("summary_table_report_message_limit")
    {
        Some(REPORT_HISTORY_MESSAGE_LIMIT_ERROR_STATUS)
    } else if error.contains(REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS) {
        Some(REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS)
    } else if normalized.contains("no default aor found") {
        Some(REPORT_HISTORY_NO_DEFAULT_AOR_ERROR_STATUS)
    } else if normalized
        .contains("report generation was interrupted while in progress")
        && normalized.contains("report worker startup recovery")
    {
        Some(REPORT_HISTORY_WORKER_INTERRUPTED_ERROR_STATUS)
    } else if normalized.starts_with("report generation timed out after")
        || normalized.contains("canceling statement due to statement timeout")
        || normalized
            .starts_with("аналітичний запит перевищив допустимий час виконання")
    {
        Some(REPORT_HISTORY_TIMEOUT_ERROR_STATUS)
    } else {
        None
    }
}

fn debug_msg_values(error: &str) -> Vec<String> {
    error
        .match_indices("msg")
        .filter_map(|(index, _)| {
            let before = error[..index].chars().next_back();
            if before.is_some_and(|character| {
                character.is_ascii_alphanumeric() || character == '_'
            }) {
                return None;
            }
            let value = error[index + 3..].trim_start().strip_prefix(':')?;
            parse_debug_string(value.trim_start())
        })
        .collect()
}

fn parse_debug_string(value: &str) -> Option<String> {
    if !value.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (index, character) in value.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => return serde_json::from_str(&value[..=index]).ok(),
            _ => {}
        }
    }
    None
}

fn nested_app_error_message(error: &str) -> Option<String> {
    const PREFIXES: [&str; 2] =
        ["Business-logic error:", "Service unavailable:"];

    error.lines().rev().find_map(|line| {
        let line = line.trim().trim_end_matches(',');
        PREFIXES.iter().find_map(|prefix| {
            line.strip_prefix(prefix)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
        })
    })
}

async fn report_history_queue_meta(
    dbx: &DatabaseConnection,
    report_histories: &[report_history::Model],
) -> Result<HashMap<i64, ReportHistoryQueueMetaRow>, AppError> {
    let queued_histories = report_histories
        .iter()
        .filter_map(|report_history| {
            let scope = report_history_queue_scope_for_row(report_history)?;
            let queued_for = match report_history.status.as_str() {
                STATUS_IN_PROGRESS => report_history
                    .started_at
                    .or(Some(report_history.created_at)),
                STATUS_PLANNED => report_history
                    .planned_for_ts
                    .or(Some(report_history.created_at)),
                _ => None,
            };
            Some((report_history, scope, queued_for))
        })
        .collect::<Vec<_>>();
    if queued_histories.is_empty() {
        return Ok(HashMap::new());
    }

    let mut sql = String::from(
        r#"
        with input_rows(id, report_kind, requested_by_login_id, status, queued_for, created_at) as (
            values
"#,
    );
    let mut values = Vec::with_capacity(queued_histories.len() * 6);
    for (index, (report_history, scope, queued_for)) in
        queued_histories.iter().enumerate()
    {
        if index > 0 {
            sql.push_str(",\n");
        }
        sql.push_str(&format!(
            "                (${}, ${}, ${}, ${}, ${}, ${})",
            index * 6 + 1,
            index * 6 + 2,
            index * 6 + 3,
            index * 6 + 4,
            index * 6 + 5,
            index * 6 + 6,
        ));
        values.push(report_history.id.into());
        values.push(scope.report_kind.clone().into());
        values.push(scope.requested_by_login_id.into());
        values.push(report_history.status.clone().into());
        values.push((*queued_for).into());
        values.push(report_history.created_at.into());
    }
    sql.push_str(
        r#"
            )
        select
            i.id,
            1 + (
                select count(*)
                from report_history other
                where other.status in ('planned', 'in_progress')
                  and (
                      (
                          i.requested_by_login_id is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by_login_id = i.requested_by_login_id
                      )
                      or (
                          i.requested_by_login_id is null
                          and other.report_kind = i.report_kind
                      )
                  )
                  and (
                      case when other.status = 'in_progress' then 0 else 1 end,
                      coalesce(
                          case
                              when other.status = 'in_progress' then other.started_at
                              else other.planned_for_ts
                          end,
                          other.created_at
                      ),
                      other.created_at,
                      other.id
                  ) < (
                      case when i.status = 'in_progress' then 0 else 1 end,
                      coalesce(i.queued_for, i.created_at),
                      i.created_at,
                      i.id
                  )
            ) as queue_position,
            (
                select other.id
                from report_history other
                where other.status in ('planned', 'in_progress')
                  and (
                      (
                          i.requested_by_login_id is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by_login_id = i.requested_by_login_id
                      )
                      or (
                          i.requested_by_login_id is null
                          and other.report_kind = i.report_kind
                      )
                  )
                  and (
                      case when other.status = 'in_progress' then 0 else 1 end,
                      coalesce(
                          case
                              when other.status = 'in_progress' then other.started_at
                              else other.planned_for_ts
                          end,
                          other.created_at
                      ),
                      other.created_at,
                      other.id
                  ) < (
                      case when i.status = 'in_progress' then 0 else 1 end,
                      coalesce(i.queued_for, i.created_at),
                      i.created_at,
                      i.id
                  )
                order by
                    case when other.status = 'in_progress' then 0 else 1 end desc,
                    coalesce(
                        case
                            when other.status = 'in_progress' then other.started_at
                            else other.planned_for_ts
                        end,
                        other.created_at
                    ) desc,
                    other.created_at desc,
                    other.id desc
                limit 1
            ) as blocked_by_report_id,
            (
                select other.started_at
                from report_history other
                where other.status in ('planned', 'in_progress')
                  and (
                      (
                          i.requested_by_login_id is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by_login_id = i.requested_by_login_id
                      )
                      or (
                          i.requested_by_login_id is null
                          and other.report_kind = i.report_kind
                      )
                  )
                  and (
                      case when other.status = 'in_progress' then 0 else 1 end,
                      coalesce(
                          case
                              when other.status = 'in_progress' then other.started_at
                              else other.planned_for_ts
                          end,
                          other.created_at
                      ),
                      other.created_at,
                      other.id
                  ) < (
                      case when i.status = 'in_progress' then 0 else 1 end,
                      coalesce(i.queued_for, i.created_at),
                      i.created_at,
                      i.id
                  )
                order by
                    case when other.status = 'in_progress' then 0 else 1 end desc,
                    coalesce(
                        case
                            when other.status = 'in_progress' then other.started_at
                            else other.planned_for_ts
                        end,
                        other.created_at
                    ) desc,
                    other.created_at desc,
                    other.id desc
                limit 1
            ) as blocked_by_started_at,
            (
                select other.bgtask_id
                from report_history other
                where other.status in ('planned', 'in_progress')
                  and (
                      (
                          i.requested_by_login_id is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by_login_id = i.requested_by_login_id
                      )
                      or (
                          i.requested_by_login_id is null
                          and other.report_kind = i.report_kind
                      )
                  )
                  and (
                      case when other.status = 'in_progress' then 0 else 1 end,
                      coalesce(
                          case
                              when other.status = 'in_progress' then other.started_at
                              else other.planned_for_ts
                          end,
                          other.created_at
                      ),
                      other.created_at,
                      other.id
                  ) < (
                      case when i.status = 'in_progress' then 0 else 1 end,
                      coalesce(i.queued_for, i.created_at),
                      i.created_at,
                      i.id
                  )
                order by
                    case when other.status = 'in_progress' then 0 else 1 end desc,
                    coalesce(
                        case
                            when other.status = 'in_progress' then other.started_at
                            else other.planned_for_ts
                        end,
                        other.created_at
                    ) desc,
                    other.created_at desc,
                    other.id desc
                limit 1
            ) as blocked_by_bgtask_id
        from input_rows i
        "#,
    );

    let stmt =
        Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values);
    let rows = ReportHistoryQueueMetaRow::find_by_statement(stmt)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(rows.into_iter().map(|row| (row.id, row)).collect())
}

fn report_history_error_log(
    report_history: &report_history::Model,
    expose_last_error: bool,
) -> Option<Vec<ReportHistoryLogEntry>> {
    if !expose_last_error {
        return None;
    }
    let last_error = report_history.last_error.as_deref()?;
    let mut entries = report_history
        .log
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(report_history_log_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if entries.last().map(|entry| entry.message.as_str()) != Some(last_error) {
        entries.push(ReportHistoryLogEntry {
            login: "system".to_string(),
            timestamp: report_history
                .completed_at
                .or(report_history.started_at)
                .unwrap_or(report_history.created_at)
                .to_string(),
            message: last_error.to_string(),
        });
    }
    Some(entries)
}

fn report_history_log_entry(
    value: &serde_json::Value,
) -> Option<ReportHistoryLogEntry> {
    Some(ReportHistoryLogEntry {
        login: value.get("login")?.as_str()?.to_string(),
        timestamp: value.get("timestamp")?.as_str()?.to_string(),
        message: value.get("message")?.as_str()?.to_string(),
    })
}

fn report_history_period(request: &serde_json::Value) -> Option<String> {
    let request =
        serde_json::from_value::<ReportHistoryRequest>(request.clone()).ok()?;
    match request {
        ReportHistoryRequest::AnalysisReport { payload } => {
            report_history_period_from_ms(
                payload.req.since_date_inclusive_ms?,
                payload.req.till_date_inclusive_ms?,
            )
        }
        ReportHistoryRequest::AnalysisExport { payload } => {
            report_history_period_from_ms(
                payload.since_date_inclusive_ms,
                payload.till_date_noninclusive_ms,
            )
        }
        ReportHistoryRequest::EtalonkaFilter { payload } => {
            report_history_etalonka_period(&payload.etalonka_type)
        }
        ReportHistoryRequest::EtalonkaBatch { payload } => {
            report_history_etalonka_period(&payload.etalonka_type)
        }
        ReportHistoryRequest::GoiReport { .. } => None,
        ReportHistoryRequest::GoiAssociationsReport { payload } => {
            report_history_period_from_ms(
                payload.since_date_inclusive_ms?,
                payload.till_date_inclusive_ms?,
            )
        }
    }
}

fn report_history_etalonka_period(
    etalonka_type: &crate::sigint::etalonka::types::EtalonkaReportType,
) -> Option<String> {
    match etalonka_type {
        crate::sigint::etalonka::types::EtalonkaReportType::ExtendedReport(
            settings,
        ) => report_history_period_from_ms(
            settings.since_date_inclusive_ms,
            settings.till_date_inclusive_ms?,
        ),
        _ => None,
    }
}

fn report_history_period_from_ms(
    since_ms: i64,
    till_ms: i64,
) -> Option<String> {
    let since = crate::utils::dt_zoned_from_millis(since_ms).ok()?;
    let till = crate::utils::dt_zoned_from_millis(till_ms).ok()?;
    let fmt = if since.year() == till.year() {
        "%d.%m %H:%M"
    } else {
        "%d.%m.%Y %H:%M"
    };
    Some(format!("{} - {}", since.format(fmt), till.format(fmt)))
}

#[cfg(test)]
mod period_tests {
    use super::*;
    use chrono::TimeZone;

    fn kyiv_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        chrono_tz::Europe::Kyiv
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn report_history_period_omits_year_for_same_year_range() {
        let since = kyiv_ms(2026, 6, 30, 14, 15);
        let till = kyiv_ms(2026, 7, 1, 8, 45);

        assert_eq!(
            report_history_period_from_ms(since, till),
            Some("30.06 14:15 - 01.07 08:45".to_string())
        );
    }

    #[test]
    fn report_history_period_includes_year_for_cross_year_range() {
        let since = kyiv_ms(2026, 12, 31, 23, 15);
        let till = kyiv_ms(2027, 1, 1, 1, 45);

        assert_eq!(
            report_history_period_from_ms(since, till),
            Some("31.12.2026 23:15 - 01.01.2027 01:45".to_string())
        );
    }
}

fn report_history_detail_refs(
    request: &serde_json::Value,
) -> ReportHistoryDetailRefs {
    let Ok(request) =
        serde_json::from_value::<ReportHistoryRequest>(request.clone())
    else {
        return ReportHistoryDetailRefs::default();
    };

    let mut refs = ReportHistoryDetailRefs::default();
    match request {
        ReportHistoryRequest::AnalysisReport { payload } => {
            extend_unique_i64(
                &mut refs.aor_ids,
                payload.req.selected_aors.iter().flatten().copied(),
            );
            extend_unique_i64(
                &mut refs.network_ids,
                payload.req.selected_networks.iter().flatten().copied(),
            );
            if let Some(report_type) = &payload.report_type {
                match report_type {
                    ReportType::ActiveNetworks(settings) => {
                        extend_unique_i64(
                            &mut refs.aor_ids,
                            settings.aor_ids.iter().copied(),
                        );
                    }
                    ReportType::NetworkFrequencies(settings) => {
                        extend_unique_i64(
                            &mut refs.aor_ids,
                            settings.aor_ids.iter().copied(),
                        );
                    }
                    _ => {}
                }
            }
        }
        ReportHistoryRequest::AnalysisExport { payload } => {
            extend_unique_i64(
                &mut refs.aor_ids,
                payload.selected_aors.iter().flatten().copied(),
            );
            extend_unique_i64(
                &mut refs.network_ids,
                payload.selected_networks.iter().flatten().copied(),
            );
        }
        ReportHistoryRequest::EtalonkaFilter { payload } => {
            extend_unique_i64(
                &mut refs.aor_ids,
                payload.req.aor_ids.iter().flatten().copied(),
            );
            extend_unique_i64(
                &mut refs.network_ids,
                payload.req.ids.iter().flatten().copied(),
            );
        }
        ReportHistoryRequest::EtalonkaBatch { payload } => {
            extend_unique_i64(
                &mut refs.network_ids,
                payload.network_ids.iter().copied(),
            );
        }
        ReportHistoryRequest::GoiReport { .. }
        | ReportHistoryRequest::GoiAssociationsReport { .. } => {}
    }
    refs
}

fn extend_unique_i64(
    target: &mut Vec<i64>,
    values: impl IntoIterator<Item = i64>,
) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

async fn load_report_history_detail_lookup(
    dbx: &DatabaseConnection,
    report_histories: &[report_history::Model],
    detail_refs: &[ReportHistoryDetailRefs],
) -> Result<ReportHistoryDetailLookup, AppError> {
    let mut aor_ids = vec![];
    let mut network_ids = vec![];
    for refs in detail_refs {
        extend_unique_i64(&mut aor_ids, refs.aor_ids.iter().copied());
        extend_unique_i64(&mut network_ids, refs.network_ids.iter().copied());
    }

    Ok(ReportHistoryDetailLookup {
        aor_names_by_id: load_report_history_aor_names(dbx, &aor_ids).await?,
        network_labels_by_id: load_report_history_network_labels(
            dbx,
            &network_ids,
        )
        .await?,
        progress_by_bgtask_id: load_report_history_bgtask_progress(
            dbx,
            report_histories,
        )
        .await?,
    })
}

async fn load_report_history_aor_names(
    dbx: &DatabaseConnection,
    aor_ids: &[i64],
) -> Result<HashMap<i64, String>, AppError> {
    if aor_ids.is_empty() {
        return Ok(HashMap::new());
    }

    Ok(AreaOfResponsibility::find()
        .filter(area_of_responsibility::Column::Id.is_in(aor_ids.to_vec()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|aor| (aor.id, aor.name))
        .collect())
}

async fn load_report_history_network_labels(
    dbx: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        select
            sn.id as network_id,
            sn.name as network_name,
            nullif(trim(su.name), '') as unit_name
        from sigint_network sn
        left join sigint_network_unit snu on snu.network_id = sn.id
        left join sigint_unit su on su.id = snu.unit_id
        where sn.id = any($1)
        order by sn.id, su.name
        "#,
        vec![network_ids.to_vec().into()],
    );
    let rows = ReportHistoryNetworkDetailRow::find_by_statement(stmt)
        .all(dbx)
        .await
        .c(h!())?;
    let mut seen = HashSet::new();
    let mut labels_by_id: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let unit_name = row.unit_name.as_deref().unwrap_or("НВ");
        let label = format!("{} {}", row.network_name.trim(), unit_name.trim())
            .trim()
            .to_string();
        if seen.insert((row.network_id, label.clone())) {
            labels_by_id.entry(row.network_id).or_default().push(label);
        }
    }
    Ok(labels_by_id)
}

async fn load_report_history_bgtask_progress(
    dbx: &DatabaseConnection,
    report_histories: &[report_history::Model],
) -> Result<HashMap<i64, i64>, AppError> {
    let mut bgtask_ids = vec![];
    for report_history in report_histories {
        if let Some(bgtask_id) = report_history.bgtask_id {
            extend_unique_i64(&mut bgtask_ids, [bgtask_id]);
        }
    }
    if bgtask_ids.is_empty() {
        return Ok(HashMap::new());
    }

    Ok(Bgtask::find()
        .filter(bgtask::Column::Id.is_in(bgtask_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|bgtask| (bgtask.id, bgtask.progress.clamp(0, 100)))
        .collect())
}

fn report_history_list_offset(req: &ReportHistoryAdminListReq) -> u64 {
    req.offset.unwrap_or(0)
}

fn report_history_list_batch_size(req: &ReportHistoryAdminListReq) -> u64 {
    req.limit
        .unwrap_or(REPORT_HISTORY_LIST_LIMIT)
        .clamp(1, REPORT_HISTORY_LIST_LIMIT)
}

fn report_history_escape_like(value: &str) -> String {
    value
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
}

fn report_history_like_value(value: &str) -> String {
    format!(
        "%{}%",
        report_history_escape_like(&value.trim().to_lowercase())
    )
}

fn report_history_like_expr(sql: &str, value: &str) -> SimpleExpr {
    Expr::cust_with_values(
        format!("lower({sql}) like $1"),
        vec![report_history_like_value(value)],
    )
}

fn report_history_filter_strings(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(value) => vec![value.clone()],
        serde_json::Value::Number(value) => vec![value.to_string()],
        serde_json::Value::Bool(value) => vec![value.to_string()],
        serde_json::Value::Array(values) => values
            .iter()
            .flat_map(report_history_filter_strings)
            .collect(),
        _ => vec![],
    }
    .into_iter()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .collect()
}

fn report_history_text_condition(
    sql: &str,
    values: Vec<String>,
) -> Option<Condition> {
    if values.is_empty() {
        return None;
    }
    let mut condition = Condition::any();
    for value in values {
        condition = condition.add(report_history_like_expr(sql, &value));
    }
    Some(condition)
}

fn report_history_column_filter_condition(
    filter: &ReportHistoryColumnFilter,
) -> Option<Condition> {
    let values = report_history_filter_strings(&filter.value);
    match filter.id.as_str() {
        "id" => {
            report_history_text_condition("report_history.id::text", values)
        }
        "reportKind" => {
            report_history_text_condition("report_history.report_kind", values)
        }
        "requestedBy" => report_history_text_condition("login.login", values),
        "createdAt" => report_history_text_condition(
            "report_history.created_at::text",
            values,
        ),
        "status" => {
            report_history_text_condition("report_history.status", values)
        }
        "completedAt" => report_history_text_condition(
            "report_history.completed_at::text",
            values,
        ),
        "fileName" => {
            report_history_text_condition("report_history.file_name", values)
        }
        "contentType" => {
            report_history_text_condition("report_history.content_type", values)
        }
        "bgtaskId" => report_history_text_condition(
            "report_history.bgtask_id::text",
            values,
        ),
        "lastError" => {
            report_history_text_condition("report_history.last_error", values)
        }
        _ => None,
    }
}

fn report_history_global_filter_condition(value: &str) -> Option<Condition> {
    if value.trim().is_empty() {
        return None;
    }
    Some(
        Condition::any()
            .add(report_history_like_expr("report_history.id::text", value))
            .add(report_history_like_expr(
                "report_history.report_kind",
                value,
            ))
            .add(report_history_like_expr("login.login", value))
            .add(report_history_like_expr(
                "report_history.created_at::text",
                value,
            ))
            .add(report_history_like_expr("report_history.status", value))
            .add(report_history_like_expr(
                "report_history.completed_at::text",
                value,
            ))
            .add(report_history_like_expr("report_history.file_name", value))
            .add(report_history_like_expr(
                "report_history.content_type",
                value,
            ))
            .add(report_history_like_expr(
                "report_history.bgtask_id::text",
                value,
            ))
            .add(report_history_like_expr("report_history.last_error", value)),
    )
}

fn apply_report_history_admin_filters(
    mut query: Select<report_history::Entity>,
    req: &ReportHistoryAdminListReq,
) -> Select<report_history::Entity> {
    if let Some(global_filter) = req.global_filter.as_deref() {
        if let Some(condition) =
            report_history_global_filter_condition(global_filter)
        {
            query = query.filter(condition);
        }
    }

    for filter in &req.column_filters {
        if let Some(condition) = report_history_column_filter_condition(filter)
        {
            query = query.filter(condition);
        }
    }

    query
}

fn report_history_sort_column(id: &str) -> Option<report_history::Column> {
    match id {
        "id" => Some(report_history::Column::Id),
        "reportKind" => Some(report_history::Column::ReportKind),
        "createdAt" => Some(report_history::Column::CreatedAt),
        "status" => Some(report_history::Column::Status),
        "completedAt" => Some(report_history::Column::CompletedAt),
        "fileName" => Some(report_history::Column::FileName),
        "contentType" => Some(report_history::Column::ContentType),
        "bgtaskId" => Some(report_history::Column::BgtaskId),
        "lastError" => Some(report_history::Column::LastError),
        _ => None,
    }
}

fn apply_report_history_admin_sorting(
    mut query: Select<report_history::Entity>,
    sorting: &[ReportHistorySorting],
) -> Select<report_history::Entity> {
    let mut applied_sorting = false;
    for sorting in sorting {
        if sorting.id == "requestedBy" {
            query = if sorting.desc {
                query.order_by_desc(login::Column::Login)
            } else {
                query.order_by_asc(login::Column::Login)
            };
            applied_sorting = true;
            continue;
        }
        if sorting.id == "startedAt" {
            query = query.order_by_with_nulls(
                report_history::Column::StartedAt,
                if sorting.desc {
                    Order::Desc
                } else {
                    Order::Asc
                },
                NullOrdering::Last,
            );
            applied_sorting = true;
            continue;
        }
        let Some(column) = report_history_sort_column(&sorting.id) else {
            continue;
        };
        query = if sorting.desc {
            query.order_by_desc(column)
        } else {
            query.order_by_asc(column)
        };
        applied_sorting = true;
    }

    if !applied_sorting {
        query = query.order_by_desc(report_history::Column::CreatedAt);
    }
    query.order_by_desc(report_history::Column::Id)
}

async fn list_admin_report_histories(
    list_db: &DatabaseConnection,
    detail_db: &DatabaseConnection,
    req: &ReportHistoryAdminListReq,
) -> Result<ReportHistoryAdminListRsp, AppError> {
    let offset = report_history_list_offset(req);
    let limit = report_history_list_batch_size(req);
    let filtered_query = apply_report_history_admin_filters(
        ReportHistory::find()
            .join(JoinType::LeftJoin, report_history::Relation::Login.def()),
        req,
    );
    let total = filtered_query.clone().count(list_db).await.c(h!())?;

    let report_histories =
        apply_report_history_admin_sorting(filtered_query, &req.sorting)
            .offset(offset)
            .limit(limit)
            .all(list_db)
            .await
            .c(h!())?;
    let next_offset = offset + report_histories.len() as u64;
    let report_histories =
        reload_report_histories(detail_db, report_histories).await?;
    let rows =
        build_report_history_rows(detail_db, report_histories, true).await?;

    Ok(ReportHistoryAdminListRsp {
        rows,
        total,
        has_more: next_offset < total,
        next_offset,
    })
}

async fn read_and_remove_generated_report_file(
    path: &Path,
) -> Result<Vec<u8>, AppError> {
    let bytes = tokio::fs::read(path).await.c(h!())?;
    if let Err(err) = tokio::fs::remove_file(path).await {
        warn!(
            "failed to remove generated queued report file {:?}: {err:?}",
            path
        );
    }
    Ok(bytes)
}

pub async fn record_failed_report_nofail(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    err_msg: String,
) {
    if let Err(err) = record_failed_report(
        env,
        requested_by_login_id,
        report_kind,
        request,
        err_msg,
    )
    .await
    {
        error!("failed to record failed report history row: {err:?}");
    }
}

async fn record_failed_report(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    err_msg: String,
) -> Result<report_history::Model, AppError> {
    let now = Utc::now().naive_utc();
    Ok(report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by_login_id: Set(*requested_by_login_id),
        request: Set(serde_json::to_value(request).c(h!())?),
        created_at: Set(now),
        status: Set(STATUS_FAILED.to_string()),
        retry_count: Set(0),
        planned_for_ts: Set(None),
        started_at: Set(Some(now)),
        completed_at: Set(Some(now)),
        s3_id: Set(None),
        bgtask_id: Set(None),
        file_name: Set(None),
        content_type: Set(None),
        last_error: Set(Some(err_msg.clone())),
        log: Set(append_log_entry(json!([]), "system", &err_msg)),
        legacy_log_id: Set(None),
        legacy_report_path: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?)
}

async fn insert_report_download_attempt<C>(
    dbx: &C,
    report_history_id: i64,
    requested_by_login_id: &uuid::Uuid,
    started_at: Option<chrono::NaiveDateTime>,
) -> Result<report_download_history::Model, AppError>
where
    C: ConnectionTrait,
{
    let requested_at = Utc::now().naive_utc();
    Ok(report_download_history::ActiveModel {
        id: NotSet,
        report_history_id: Set(report_history_id),
        requested_by_login_id: Set(*requested_by_login_id),
        requested_at: Set(requested_at),
        started_at: Set(started_at),
        completed_at: Set(None),
        duration_ms: Set(None),
        successful: Set(None),
    }
    .insert(dbx)
    .await
    .c(h!())?)
}

pub async fn enqueue_report(
    dbx: &DatabaseConnection,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: Option<String>,
    content_type: Option<String>,
) -> Result<report_history::Model, AppError> {
    let request = serde_json::to_value(request).c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    lock_report_request(&txn, requested_by_login_id, report_kind, &request)
        .await?;

    if let Some(report_history) = find_active_duplicate_report(
        &txn,
        requested_by_login_id,
        report_kind,
        &request,
    )
    .await
    .c(h!())?
    {
        let message = duplicate_report_log_message(&report_history);
        let report_log = append_log_entry(
            report_history.log.clone(),
            &requested_by_login_id.to_string(),
            &message,
        );
        let mut report_history = report_history.into_active_model();
        report_history.log = Set(report_log);
        let report_history = report_history.update(&txn).await.c(h!())?;
        insert_report_download_attempt(
            &txn,
            report_history.id,
            requested_by_login_id,
            None,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        info!("{message}");
        return Ok(report_history);
    }

    if let Some(report_history) = find_failed_duplicate_report(
        &txn,
        requested_by_login_id,
        report_kind,
        &request,
    )
    .await?
    {
        let report_history =
            reset_failed_report(&txn, report_history, requested_by_login_id)
                .await?;
        insert_report_download_attempt(
            &txn,
            report_history.id,
            requested_by_login_id,
            None,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(report_history);
    }

    let report_history = report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by_login_id: Set(*requested_by_login_id),
        request: Set(request),
        created_at: Set(Utc::now().naive_utc()),
        status: Set(STATUS_PLANNED.to_string()),
        retry_count: Set(0),
        planned_for_ts: Set(None),
        started_at: Set(None),
        completed_at: Set(None),
        s3_id: Set(None),
        bgtask_id: Set(None),
        file_name: Set(file_name),
        content_type: Set(content_type),
        last_error: Set(None),
        log: Set(json!([])),
        legacy_log_id: Set(None),
        legacy_report_path: Set(None),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    insert_report_download_attempt(
        &txn,
        report_history.id,
        requested_by_login_id,
        None,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(report_history)
}

async fn lock_report_request<C>(
    dbx: &C,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: &serde_json::Value,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        select pg_advisory_xact_lock(
            hashtextextended(
                jsonb_build_array($1::text, $2::text, $3::jsonb)::text,
                0
            )
        )
        "#,
        [
            requested_by_login_id.to_string().into(),
            report_kind.into(),
            request.clone().into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn find_active_duplicate_report<C>(
    dbx: &C,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: &serde_json::Value,
) -> Result<Option<report_history::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(ReportHistory::find()
        .filter(
            report_history::Column::RequestedByLoginId
                .eq(*requested_by_login_id),
        )
        .filter(report_history::Column::ReportKind.eq(report_kind))
        .filter(report_history::Column::Request.eq(request.clone()))
        .filter(
            report_history::Column::Status
                .is_in([STATUS_PLANNED, STATUS_IN_PROGRESS]),
        )
        .order_by_asc(report_history::Column::CreatedAt)
        .order_by_asc(report_history::Column::Id)
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())?)
}

async fn find_failed_duplicate_report<C>(
    dbx: &C,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: &serde_json::Value,
) -> Result<Option<report_history::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(ReportHistory::find()
        .filter(
            report_history::Column::RequestedByLoginId
                .eq(*requested_by_login_id),
        )
        .filter(report_history::Column::ReportKind.eq(report_kind))
        .filter(report_history::Column::Request.eq(request.clone()))
        .filter(report_history::Column::Status.eq(STATUS_FAILED))
        .order_by_desc(report_history::Column::CreatedAt)
        .order_by_desc(report_history::Column::Id)
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())?)
}

fn duplicate_report_log_message(
    report_history: &report_history::Model,
) -> String {
    format!(
        "skipping duplicate report: id={}, kind={}, requested_by_login_id={}, status={}, request={}",
        report_history.id,
        report_history.report_kind,
        report_history.requested_by_login_id,
        report_history.status,
        report_history.request,
    )
}

async fn reset_failed_report<C>(
    dbx: &C,
    report_history: report_history::Model,
    retried_by_login_id: &uuid::Uuid,
) -> Result<report_history::Model, AppError>
where
    C: ConnectionTrait,
{
    if report_history.status != STATUS_FAILED {
        return Err(AppError::BL {
            msg: "Only failed reports can be retried".to_string(),
        });
    }
    let report_log = append_log_entry(
        report_history.log.clone(),
        &retried_by_login_id.to_string(),
        REPORT_HISTORY_USER_RETRY_LOG_MESSAGE,
    );
    let mut report_history = report_history.into_active_model();
    report_history.status = Set(STATUS_PLANNED.to_string());
    report_history.retry_count = Set(0);
    report_history.planned_for_ts = Set(None);
    report_history.started_at = Set(None);
    report_history.completed_at = Set(None);
    report_history.bgtask_id = Set(None);
    report_history.last_error = Set(None);
    report_history.log = Set(report_log);
    Ok(report_history.update(dbx).await.c(h!())?)
}

fn completed_report_rerun(
    report_history: &report_history::Model,
    rerun_by_login_id: &uuid::Uuid,
) -> report_history::ActiveModel {
    report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_history.report_kind.clone()),
        requested_by_login_id: Set(report_history.requested_by_login_id),
        request: Set(report_history.request.clone()),
        created_at: Set(Utc::now().naive_utc()),
        status: Set(STATUS_PLANNED.to_string()),
        retry_count: Set(0),
        planned_for_ts: Set(None),
        started_at: Set(None),
        completed_at: Set(None),
        s3_id: Set(None),
        bgtask_id: Set(None),
        file_name: Set(report_history.file_name.clone()),
        content_type: Set(report_history.content_type.clone()),
        last_error: Set(None),
        log: Set(append_log_entry(
            json!([]),
            &rerun_by_login_id.to_string(),
            &format!(
                "admin requested rerun of successful report #{}",
                report_history.id
            ),
        )),
        legacy_log_id: Set(None),
        legacy_report_path: Set(None),
    }
}

async fn rerun_completed_report(
    dbx: &DatabaseConnection,
    report_history_id: i64,
    rerun_by_login_id: &uuid::Uuid,
) -> Result<report_history::Model, AppError> {
    let report_history = ReportHistory::find_by_id(report_history_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_DONE {
        return Err(AppError::BL {
            msg: "Only successful reports can be rerun by an admin".to_string(),
        });
    }

    let txn = dbx.begin().await.c(h!())?;
    lock_report_request(
        &txn,
        &report_history.requested_by_login_id,
        &report_history.report_kind,
        &report_history.request,
    )
    .await?;
    let report_history = ReportHistory::find_by_id(report_history_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_DONE {
        return Err(AppError::BL {
            msg: "Only successful reports can be rerun by an admin".to_string(),
        });
    }

    if let Some(active_report) = find_active_duplicate_report(
        &txn,
        &report_history.requested_by_login_id,
        &report_history.report_kind,
        &report_history.request,
    )
    .await?
    {
        txn.commit().await.c(h!())?;
        return Ok(active_report);
    }

    let report_history =
        completed_report_rerun(&report_history, rerun_by_login_id)
            .insert(&txn)
            .await
            .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(report_history)
}

pub async fn record_completed_report_nofail(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    bytes: &[u8],
) {
    if let Err(err) = record_completed_report(
        env,
        requested_by_login_id,
        report_kind,
        request,
        file_name,
        content_type,
        bytes,
    )
    .await
    {
        error!("failed to record completed report history row: {err:?}");
    }
}

async fn record_completed_report(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    bytes: &[u8],
) -> Result<report_history::Model, AppError> {
    let generated = GeneratedReport {
        file_name,
        content_type,
        bytes: bytes.to_vec(),
    };
    let upload_res = upload_report_bytes(env, &generated).await;
    let (s3_id, last_error, log) = match upload_res {
        Ok(s3_id) => (Some(s3_id), None, json!([])),
        Err(err) => {
            let msg = format!(
                "completed direct report was not stored in S3: {err:#?}"
            );
            (
                None,
                Some(msg.clone()),
                append_log_entry(json!([]), "system", &msg),
            )
        }
    };
    insert_completed_report_row(
        env,
        requested_by_login_id,
        report_kind,
        request,
        generated.file_name,
        generated.content_type,
        s3_id,
        last_error,
        log,
        None,
    )
    .await
}

pub async fn record_completed_report_file_nofail(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    file_path: &Path,
) {
    if let Err(err) = record_completed_report_file(
        env,
        requested_by_login_id,
        report_kind,
        request,
        file_name,
        content_type,
        file_path,
    )
    .await
    {
        error!("failed to record completed report history row: {err:?}");
    }
}

async fn record_completed_report_file(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    file_path: &Path,
) -> Result<report_history::Model, AppError> {
    let report_history = insert_archiving_report_row(
        env,
        requested_by_login_id,
        report_kind,
        request,
        file_name.clone(),
        content_type.clone(),
        file_path.to_string_lossy().to_string(),
    )
    .await?;
    spawn_completed_report_file_archive(
        env.clone(),
        report_history.id,
        file_name,
        content_type,
        file_path.to_path_buf(),
    );
    Ok(report_history)
}

async fn insert_archiving_report_row(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    legacy_report_path: String,
) -> Result<report_history::Model, AppError> {
    let now = Utc::now().naive_utc();
    Ok(report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by_login_id: Set(*requested_by_login_id),
        request: Set(serde_json::to_value(request).c(h!())?),
        created_at: Set(now),
        status: Set(STATUS_IN_PROGRESS.to_string()),
        retry_count: Set(0),
        planned_for_ts: Set(None),
        started_at: Set(Some(now)),
        completed_at: Set(None),
        s3_id: Set(None),
        bgtask_id: Set(None),
        file_name: Set(Some(file_name)),
        content_type: Set(Some(content_type)),
        last_error: Set(None),
        log: Set(json!([])),
        legacy_log_id: Set(None),
        legacy_report_path: Set(Some(legacy_report_path)),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?)
}

async fn insert_completed_report_row(
    env: &Env,
    requested_by_login_id: &uuid::Uuid,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    s3_id: Option<String>,
    last_error: Option<String>,
    log: serde_json::Value,
    legacy_report_path: Option<String>,
) -> Result<report_history::Model, AppError> {
    let now = Utc::now().naive_utc();
    Ok(report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by_login_id: Set(*requested_by_login_id),
        request: Set(serde_json::to_value(request).c(h!())?),
        created_at: Set(now),
        status: Set(STATUS_DONE.to_string()),
        retry_count: Set(0),
        planned_for_ts: Set(None),
        started_at: Set(Some(now)),
        completed_at: Set(Some(now)),
        s3_id: Set(s3_id),
        bgtask_id: Set(None),
        file_name: Set(Some(file_name)),
        content_type: Set(Some(content_type)),
        last_error: Set(last_error),
        log: Set(log),
        legacy_log_id: Set(None),
        legacy_report_path: Set(legacy_report_path),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?)
}

fn spawn_completed_report_file_archive(
    env: Env,
    report_history_id: i64,
    file_name: String,
    content_type: String,
    file_path: PathBuf,
) {
    tokio::spawn(async move {
        if let Err(err) = archive_completed_report_file(
            &env,
            report_history_id,
            file_name,
            content_type,
            file_path,
        )
        .await
        {
            let msg = format!(
                "completed direct report was not stored in S3: {err:#?}"
            );
            error!("{msg}");
            if let Err(err) =
                set_completed_report_archive_error(&env, report_history_id, msg)
                    .await
            {
                error!(
                    "failed to update completed report archive error: {err:?}"
                );
            }
        }
    });
}

async fn archive_completed_report_file(
    env: &Env,
    report_history_id: i64,
    file_name: String,
    content_type: String,
    file_path: PathBuf,
) -> Result<(), AppError> {
    let bytes = tokio::fs::read(&file_path).await.c(h!())?;
    let generated = GeneratedReport {
        file_name,
        content_type,
        bytes,
    };
    let s3_id = upload_report_bytes(env, &generated).await?;
    let Some(_report_history) = ReportHistory::find_by_id(report_history_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        warn!(
            "completed report history row not found for archive update: {report_history_id}"
        );
        return Ok(());
    };
    let res = ReportHistory::update_many()
        .col_expr(
            report_history::Column::Status,
            Expr::value(STATUS_DONE.to_string()),
        )
        .col_expr(
            report_history::Column::CompletedAt,
            Expr::value(Some(Utc::now().naive_utc())),
        )
        .col_expr(report_history::Column::S3Id, Expr::value(Some(s3_id)))
        .col_expr(
            report_history::Column::LastError,
            Expr::value(None::<String>),
        )
        .filter(report_history::Column::Id.eq(report_history_id))
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if res.rows_affected == 0 {
        warn!(
            "completed report history row {} was already finished, cancelled, or timed out",
            report_history_id
        );
    }
    Ok(())
}

async fn set_completed_report_archive_error(
    env: &Env,
    report_history_id: i64,
    err_msg: String,
) -> Result<(), AppError> {
    let Some(_report_history) = ReportHistory::find_by_id(report_history_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        warn!(
            "completed report history row not found for archive error update: {report_history_id}"
        );
        return Ok(());
    };
    let res = ReportHistory::update_many()
        .col_expr(
            report_history::Column::Status,
            Expr::value(STATUS_FAILED.to_string()),
        )
        .col_expr(
            report_history::Column::CompletedAt,
            Expr::value(Some(Utc::now().naive_utc())),
        )
        .col_expr(
            report_history::Column::LastError,
            Expr::value(Some(err_msg.clone())),
        )
        .filter(report_history::Column::Id.eq(report_history_id))
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if res.rows_affected == 0 {
        warn!(
            "failed report history row {} was already finished, cancelled, or timed out",
            report_history_id
        );
    }
    Ok(())
}

#[post("/api/report-history/list")]
pub async fn report_history_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<ReportHistoryRow>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_login = login_id_from_identity(&user)?;
    let report_histories =
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env.get_ref(),
            "report history dashboard",
            true,
            |db| async move { load_report_history_list(&db, user_login).await },
            |db| async move { load_report_history_list(&db, user_login).await },
        )
        .await?;
    let report_histories =
        reload_report_histories(&env.dbx, report_histories).await?;
    let rows =
        build_report_history_rows(&env.dbx, report_histories, false).await?;
    Ok(Json(rows))
}

async fn reload_report_histories(
    db: &DatabaseConnection,
    report_histories: Vec<report_history::Model>,
) -> Result<Vec<report_history::Model>, AppError> {
    if report_histories.is_empty() {
        return Ok(report_histories);
    }
    let ids = report_histories
        .iter()
        .map(|report_history| report_history.id)
        .collect::<Vec<_>>();
    let mut current_by_id = ReportHistory::find()
        .filter(report_history::Column::Id.is_in(ids))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|report_history| (report_history.id, report_history))
        .collect::<HashMap<_, _>>();
    Ok(report_histories
        .into_iter()
        .map(|report_history| {
            current_by_id
                .remove(&report_history.id)
                .unwrap_or(report_history)
        })
        .collect())
}

async fn load_report_history_list(
    db: &DatabaseConnection,
    user_login: uuid::Uuid,
) -> Result<Vec<report_history::Model>, AppError> {
    Ok(ReportHistory::find()
        .filter(report_history::Column::RequestedByLoginId.eq(user_login))
        .order_by_desc(report_history::Column::CreatedAt)
        .limit(REPORT_HISTORY_LIST_LIMIT)
        .all(db)
        .await
        .c(h!())?)
}

#[post("/api/admin/report-history/list")]
pub async fn report_history_admin_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryAdminListReq>,
) -> Result<Json<ReportHistoryAdminListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let analytics_req = &req;
    let postgres_req = &req;
    let analytics_detail_db = &env.dbx;
    let postgres_detail_db = &env.dbx;
    Ok(Json(
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env.get_ref(),
            "admin report history dashboard",
            true,
            |db| async move {
                list_admin_report_histories(
                    &db,
                    analytics_detail_db,
                    analytics_req,
                )
                .await
            },
            |db| async move {
                list_admin_report_histories(
                    &db,
                    postgres_detail_db,
                    postgres_req,
                )
                .await
            },
        )
        .await?,
    ))
}

#[post("/api/admin/report-history/rerun")]
pub async fn report_history_admin_rerun(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<Json<ReportHistoryRow>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let rerun_by_login_id = login_id_from_identity(&user).c(h!())?;
    let report_history =
        rerun_completed_report(&env.dbx, req.id, &rerun_by_login_id)
            .await
            .c(h!())?;
    Ok(Json(
        build_report_history_row(&env.dbx, report_history, true)
            .await
            .c(h!())?,
    ))
}

#[post("/api/report-history/status")]
pub async fn report_history_status(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<Json<ReportHistoryRow>, AppError> {
    let report_history = find_current_user_report(&env, &user, req.id).await?;
    Ok(Json(
        build_report_history_row(&env.dbx, report_history, true).await?,
    ))
}

#[post("/api/report-history/retry")]
pub async fn report_history_retry(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<Json<ReportHistoryRow>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_login = login_id_from_identity(&user)?;
    let report_history = find_report_for_user(&env.dbx, req.id, &user_login)
        .await?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_FAILED {
        return Err(AppError::BL {
            msg: "Only failed reports can be retried".to_string(),
        });
    }
    let txn = env.dbx.begin().await.c(h!())?;
    lock_report_request(
        &txn,
        &report_history.requested_by_login_id,
        &report_history.report_kind,
        &report_history.request,
    )
    .await?;
    let report_history = ReportHistory::find_by_id(report_history.id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let report_history =
        reset_failed_report(&txn, report_history, &user_login).await?;
    txn.commit().await.c(h!())?;
    Ok(Json(
        build_report_history_row(&env.dbx, report_history, false).await?,
    ))
}

#[post("/api/report-history/cancel")]
pub async fn report_history_cancel(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<Json<ReportHistoryRow>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let user_login = login_id_from_identity(&user)?;
    let report_history = find_report_for_user(&env.dbx, req.id, &user_login)
        .await?
        .ok_or(AppError::NotFound)?;
    let reason = REPORT_HISTORY_CANCELLED_ERROR_STATUS.to_string();
    let txn = env.dbx.begin().await.c(h!())?;
    lock_report_request(
        &txn,
        &report_history.requested_by_login_id,
        &report_history.report_kind,
        &report_history.request,
    )
    .await?;
    let updated =
        mark_report_cancelled(&txn, report_history.id, &reason).await?;
    txn.commit().await.c(h!())?;

    if let Some(bgtask_id) = updated.bgtask_id {
        let res: Result<(), AppError> = Err(AppError::BL { msg: reason });
        finish_bgtask(Some(bgtask_id), &env.dbx, &res).await?;
    }

    Ok(Json(
        build_report_history_row(&env.dbx, updated, true).await?,
    ))
}

async fn mark_report_cancelled<C>(
    dbx: &C,
    report_history_id: i64,
    reason: &str,
) -> Result<report_history::Model, AppError>
where
    C: ConnectionTrait,
{
    let report_history = ReportHistory::find_by_id(report_history_id)
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_PLANNED
        && report_history.status != STATUS_IN_PROGRESS
    {
        return Err(AppError::BL {
            msg: "Only queued or running reports can be cancelled".to_string(),
        });
    }

    let mut report_history = report_history.into_active_model();
    report_history.status = Set(STATUS_FAILED.to_string());
    report_history.completed_at = Set(Some(Utc::now().naive_utc()));
    report_history.planned_for_ts = Set(None);
    report_history.last_error = Set(Some(reason.to_string()));
    let report_history = report_history.update(dbx).await.c(h!())?;
    complete_pending_report_download_attempts(
        dbx,
        report_history.id,
        report_history
            .completed_at
            .unwrap_or_else(|| Utc::now().naive_utc()),
    )
    .await
    .context(h!())?;
    Ok(report_history)
}

#[post("/api/report-history/download")]
pub async fn report_history_download(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<HttpResponse, AppError> {
    let user_login = login_id_from_identity(&user)?;
    download_report_for_user_login(&env, &user_login, req.id).await
}

async fn claim_report_download_attempt(
    dbx: &DatabaseConnection,
    report_history_id: i64,
    requested_by_login_id: &uuid::Uuid,
) -> Result<report_download_history::Model, AppError> {
    let started_at = Utc::now().naive_utc();
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update report_download_history
        set started_at = $1
        where id = (
            select id
            from report_download_history
            where report_history_id = $2
              and requested_by_login_id = $3
              and started_at is null
              and completed_at is null
            order by requested_at, id
            for update skip locked
            limit 1
        )
        returning *
        "#,
        [
            started_at.into(),
            report_history_id.into(),
            (*requested_by_login_id).into(),
        ],
    );
    if let Some(report_download_history) =
        report_download_history::Model::find_by_statement(stmt)
            .one(dbx)
            .await
            .c(h!())?
    {
        return Ok(report_download_history);
    }
    insert_report_download_attempt(
        dbx,
        report_history_id,
        requested_by_login_id,
        Some(started_at),
    )
    .await
}

async fn complete_report_download_attempt<C>(
    dbx: &C,
    report_download_history_id: i64,
    successful: bool,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let completed_at = Utc::now().naive_utc();
    let result = dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            update report_download_history
            set
                completed_at = $1,
                duration_ms = greatest(
                    0,
                    floor(extract(epoch from ($1 - requested_at)) * 1000)::bigint
                ),
                successful = $2
            where id = $3
              and completed_at is null
            "#,
            [
                completed_at.into(),
                successful.into(),
                report_download_history_id.into(),
            ],
        ))
        .await
        .c(h!())?;
    if result.rows_affected() == 0 {
        warn!(
            "report download attempt {} was already completed",
            report_download_history_id
        );
    }
    Ok(())
}

async fn complete_pending_report_download_attempts<C>(
    dbx: &C,
    report_history_id: i64,
    completed_at: chrono::NaiveDateTime,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update report_download_history
        set
            completed_at = $1,
            duration_ms = greatest(
                0,
                floor(extract(epoch from ($1 - requested_at)) * 1000)::bigint
            ),
            successful = false
        where report_history_id = $2
          and completed_at is null
        "#,
        [completed_at.into(), report_history_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn complete_failed_pending_report_download_attempts<C>(
    dbx: &C,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_unprepared(
        r#"
        update report_download_history
        set
            completed_at = report_history.completed_at,
            duration_ms = greatest(
                0,
                floor(extract(epoch from (
                    report_history.completed_at - report_download_history.requested_at
                )) * 1000)::bigint
            ),
            successful = false
        from report_history
        where report_download_history.report_history_id = report_history.id
          and report_download_history.completed_at is null
          and report_history.status = 'failed'
          and report_history.completed_at is not null
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn download_report_for_user_login(
    env: &Env,
    user_login: &uuid::Uuid,
    report_history_id: i64,
) -> Result<HttpResponse, AppError> {
    ensure_rer_role_by_id(&env.dbx, user_login).await.c(h!())?;
    let report_history =
        find_report_for_user(&env.dbx, report_history_id, user_login)
            .await?
            .ok_or(AppError::NotFound)?;
    let report_download_history =
        claim_report_download_attempt(&env.dbx, report_history_id, user_login)
            .await
            .c(h!())?;
    let response = download_report(env, report_history).await;
    if let Err(err) = complete_report_download_attempt(
        &env.dbx,
        report_download_history.id,
        response.is_ok(),
    )
    .await
    {
        error!(
            "failed to complete report download history row {}: {err:?}",
            report_download_history.id
        );
        if response.is_ok() {
            return Err(err);
        }
    }
    response
}

async fn download_report(
    env: &Env,
    report_history: report_history::Model,
) -> Result<HttpResponse, AppError> {
    if report_history.status != STATUS_DONE {
        return Err(AppError::BL {
            msg: "Report is not ready".to_string(),
        });
    }
    let s3_id = report_history.s3_id.clone().ok_or(AppError::NotFound)?;
    let bytes = download_report_bytes(env, &s3_id).await?;
    Ok(make_download_response(
        report_history
            .file_name
            .unwrap_or_else(|| format!("report-{}.bin", report_history.id)),
        report_history
            .content_type
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        bytes,
    ))
}

async fn find_current_user_report(
    env: &Env,
    user: &Identity,
    id: i64,
) -> Result<report_history::Model, AppError> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let user_login = login_id_from_identity(user)?;
    find_report_for_user(&env.dbx, id, &user_login)
        .await?
        .ok_or(AppError::NotFound)
}

async fn find_report_for_user(
    dbx: &DatabaseConnection,
    id: i64,
    user_login: &uuid::Uuid,
) -> Result<Option<report_history::Model>, AppError> {
    match has_role(dbx, user_login, "Admin").await {
        Ok(()) => Ok(ReportHistory::find_by_id(id).one(dbx).await.c(h!())?),
        Err(AppError::Forbidden(_)) => {
            find_report_for_login(dbx, id, user_login).await
        }
        Err(err) => Err(err),
    }
}

async fn find_report_for_login(
    dbx: &DatabaseConnection,
    id: i64,
    user_login: &uuid::Uuid,
) -> Result<Option<report_history::Model>, AppError> {
    Ok(ReportHistory::find_by_id(id)
        .filter(report_history::Column::RequestedByLoginId.eq(*user_login))
        .one(dbx)
        .await
        .c(h!())?)
}

fn make_download_response(
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
) -> HttpResponse {
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: filename.into_bytes(),
            },
        )],
    };
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header(content_disposition)
        .body(bytes)
}

pub async fn reset_in_progress_nofail(env: &Env) {
    if let Err(err) = fail_timed_out_reports(env).await {
        error!("failed to fail timed-out report history rows: {err:?}");
    }
    if let Err(err) = recover_interrupted_reports(env).await {
        error!("failed to recover interrupted report history rows: {err:?}");
    }
}

async fn recover_interrupted_reports(env: &Env) -> Result<(), AppError> {
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with recovered_report as (
            select
                id,
                (
                    select count(*)::integer
                    from jsonb_array_elements(
                        coalesce(report_history.log, '[]'::jsonb)
                    ) with ordinality as entry(value, position)
                    where entry.value->>'message' = $1
                      and entry.position > coalesce((
                          select max(retry_entry.position)
                          from jsonb_array_elements(
                              coalesce(report_history.log, '[]'::jsonb)
                          ) with ordinality as retry_entry(value, position)
                          where retry_entry.value->>'message' = $2
                      ), 0)
                ) + 1 as recovery_count
            from report_history
            where status = $7
        )
        update report_history
        set
            status = case
                when recovered_report.recovery_count >= $3 then $4
                else $5
            end,
            planned_for_ts = case
                when recovered_report.recovery_count >= $3 then null
                else now() at time zone 'utc'
            end,
            started_at = case
                when recovered_report.recovery_count >= $3
                    then report_history.started_at
                else null
            end,
            completed_at = case
                when recovered_report.recovery_count >= $3
                    then now() at time zone 'utc'
                else null
            end,
            bgtask_id = null,
            last_error = case
                when recovered_report.recovery_count >= $3 then format(
                    'Report generation was interrupted while in progress; recorded recovery %s/%s during report worker startup recovery',
                    recovered_report.recovery_count,
                    $3
                )
                else null
            end,
            log = coalesce(report_history.log, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'login',
                    $6,
                    'timestamp',
                    now() at time zone 'utc',
                    'message',
                    $1
                ))
        from recovered_report
        where report_history.id = recovered_report.id
        "#,
        [
            REPORT_HISTORY_WORKER_RESTART_LOG_MESSAGE.into(),
            REPORT_HISTORY_USER_RETRY_LOG_MESSAGE.into(),
            REPORT_HISTORY_MAX_ATTEMPTS.into(),
            STATUS_FAILED.into(),
            STATUS_PLANNED.into(),
            REPORT_CRASH_RECOVERY_LOGIN.into(),
            STATUS_IN_PROGRESS.into(),
        ],
    );
    env.dbx.execute_raw(stmt).await.c(h!())?;
    complete_failed_pending_report_download_attempts(&env.dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub fn spawn_report_history_workers(
    bg_set: &mut JoinSet<()>,
    env: std::sync::Arc<Env>,
) {
    for (worker_name, report_kind) in worker_report_kinds() {
        for worker_idx in 0..report_worker_count(report_kind) {
            let env = env.clone();
            let report_kind = report_kind.to_string();
            let worker_name = report_worker_name(worker_name, worker_idx);
            crate::utils::worker_watch::spawn_named_worker(
                worker_name,
                bg_set,
                async move {
                    run_report_history_worker_nofail(env, report_kind).await;
                },
            );
        }
    }
    let unknown_env = env.clone();
    crate::utils::worker_watch::spawn_named_worker(
        "report_history_worker_unknown",
        bg_set,
        async move {
            run_unknown_report_history_worker_nofail(unknown_env).await;
        },
    );
    let timeout_env = env.clone();
    crate::utils::worker_watch::spawn_named_worker(
        "report_history_timeout_worker",
        bg_set,
        async move {
            run_report_history_timeout_worker_nofail(timeout_env).await;
        },
    );
}

fn report_worker_count(report_kind: &str) -> usize {
    if report_kind == KIND_ETALONKA {
        REPORT_HISTORY_ETALONKA_WORKER_COUNT
    } else {
        1
    }
}

fn report_worker_name(worker_name: &str, worker_idx: usize) -> String {
    if worker_idx == 0 {
        worker_name.to_string()
    } else {
        format!("{worker_name}_{worker_idx}")
    }
}

async fn run_report_history_worker_nofail(
    env: std::sync::Arc<Env>,
    report_kind: String,
) {
    loop {
        let permit = match REPORT_HISTORY_GLOBAL_GATE.acquire().await {
            Ok(permit) => permit,
            Err(err) => {
                error!("report history global gate closed: {err:?}");
                return;
            }
        };
        match take_next_report(&env.dbx, &report_kind).await {
            Ok(Some(report_history)) => {
                let report_id = report_history.id;
                let rss_before = report_worker_rss_kib();
                log::info!(
                    "report history job starting: id={report_id}, kind={report_kind}, rss_kib={rss_before:?}"
                );
                if let Err(err) =
                    process_report(env.as_ref(), report_history).await
                {
                    error!("report history worker failed: {err:?}");
                }
                drop(permit);
                let rss_before_trim = report_worker_rss_kib();
                let trim_result = report_worker_malloc_trim();
                let rss_after_trim = report_worker_rss_kib();
                log::info!(
                    "report history job released memory: id={report_id}, kind={report_kind}, rss_before_kib={rss_before:?}, rss_before_trim_kib={rss_before_trim:?}, rss_after_trim_kib={rss_after_trim:?}, malloc_trim={trim_result:?}"
                );
            }
            Ok(None) => {
                drop(permit);
                tokio::time::sleep(std::time::Duration::from_secs(
                    WORKER_IDLE_SLEEP_SECS,
                ))
                .await;
            }
            Err(err) => {
                drop(permit);
                error!("failed to take next report history row: {err:?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    WORKER_IDLE_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

fn report_worker_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn report_worker_malloc_trim() -> Option<bool> {
    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    Some(unsafe { malloc_trim(0) != 0 })
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn report_worker_malloc_trim() -> Option<bool> {
    None
}

async fn run_unknown_report_history_worker_nofail(env: std::sync::Arc<Env>) {
    loop {
        match fail_next_unknown_report(env.as_ref()).await {
            Ok(Some(report_history)) => {
                error!(
                    "unsupported report kind requested: id={}, kind={}, requested_by_login_id={}",
                    report_history.id,
                    report_history.report_kind,
                    report_history.requested_by_login_id
                );
            }
            Ok(None) => {
                tokio::time::sleep(std::time::Duration::from_secs(
                    WORKER_IDLE_SLEEP_SECS,
                ))
                .await;
            }
            Err(err) => {
                error!("failed to handle unknown report history row: {err:?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    WORKER_IDLE_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

async fn run_report_history_timeout_worker_nofail(env: std::sync::Arc<Env>) {
    loop {
        if let Err(err) = fail_timed_out_reports(env.as_ref()).await {
            error!("report history timeout worker failed: {err:?}");
        }
        tokio::time::sleep(StdDuration::from_secs(
            REPORT_HISTORY_TIMEOUT_WORKER_SLEEP_SECS,
        ))
        .await;
    }
}

fn worker_report_kinds() -> Vec<(&'static str, &'static str)> {
    [
        ("report_history_worker_tags", "tags"),
        ("report_history_worker_interception", "interception"),
        ("report_history_worker_babak", "babak"),
        ("report_history_worker_mouse", "mouse"),
        ("report_history_worker_pelengs", "pelengs"),
        ("report_history_worker_senders", "senders"),
        ("report_history_worker_posts", "posts"),
        ("report_history_worker_naushnom", "naushnom"),
        ("report_history_worker_reo", "reo"),
        ("report_history_worker_digest", "digest"),
        ("report_history_worker_rer_report", KIND_RER_REPORT),
        ("report_history_worker_sposob", KIND_SPOSOB),
        ("report_history_worker_posts_docx", "posts_docx"),
        ("report_history_worker_active_networks", "active_networks"),
        (
            "report_history_worker_network_frequencies",
            "network_frequencies",
        ),
        ("report_history_worker_report_125", "report_125"),
        ("report_history_worker_report_1213", "report_1213"),
        ("report_history_worker_summary_table", KIND_SUMMARY_TABLE),
        ("report_history_worker_kmz", KIND_KMZ),
        ("report_history_worker_geojson", KIND_GEOJSON),
        ("report_history_worker_etalonka", KIND_ETALONKA),
        ("report_history_worker_goi", KIND_GOI),
        (
            "report_history_worker_goi_associations",
            KIND_GOI_ASSOCIATIONS,
        ),
    ]
    .into_iter()
    .collect()
}

fn known_report_kinds() -> Vec<String> {
    worker_report_kinds()
        .into_iter()
        .map(|(_, report_kind)| report_kind.to_string())
        .collect()
}

async fn take_next_report(
    dbx: &DatabaseConnection,
    report_kind: &str,
) -> Result<Option<report_history::Model>, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let serialize_by_user = report_kind == KIND_ETALONKA;
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with next_report as (
            select id
            from report_history
            where status = 'planned'
              and report_kind = $1
              and (planned_for_ts is null or planned_for_ts <= now() at time zone 'utc')
              and (
                  $2 = false
                  or (
                      not exists (
                          select 1
                          from report_history active_report
                          where active_report.status = 'in_progress'
                            and active_report.report_kind = report_history.report_kind
                            and active_report.requested_by_login_id = report_history.requested_by_login_id
                      )
                      and not exists (
                          select 1
                          from report_history earlier_report
                          where earlier_report.status = 'planned'
                            and earlier_report.report_kind = report_history.report_kind
                            and earlier_report.requested_by_login_id = report_history.requested_by_login_id
                            and (
                                earlier_report.planned_for_ts is null
                                or earlier_report.planned_for_ts <= now() at time zone 'utc'
                            )
                            and (
                                coalesce(earlier_report.planned_for_ts, earlier_report.created_at),
                                earlier_report.created_at,
                                earlier_report.id
                            ) < (
                                coalesce(report_history.planned_for_ts, report_history.created_at),
                                report_history.created_at,
                                report_history.id
                            )
                      )
                  )
              )
            order by coalesce(planned_for_ts, created_at), created_at, id
            for update skip locked
            limit 1
        )
        update report_history
        set
            status = 'in_progress',
            started_at = now() at time zone 'utc',
            completed_at = null,
            bgtask_id = null,
            last_error = null
        where id in (select id from next_report)
        returning *
        "#,
        [report_kind.into(), serialize_by_user.into()],
    );
    let report_history = report_history::Model::find_by_statement(stmt)
        .one(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(report_history)
}

async fn fail_next_unknown_report(
    env: &Env,
) -> Result<Option<report_history::Model>, AppError> {
    let known_report_kinds = known_report_kinds();
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with next_report as (
            select id
            from report_history
            where status = 'planned'
              and not (report_kind = any($1))
              and (planned_for_ts is null or planned_for_ts <= now() at time zone 'utc')
            order by coalesce(planned_for_ts, created_at), created_at, id
            for update skip locked
            limit 1
        )
        update report_history
        set
            status = $2,
            started_at = now() at time zone 'utc',
            completed_at = now() at time zone 'utc',
            bgtask_id = null,
            last_error = format('Unsupported report kind: %s', report_kind),
            log = coalesce(log, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'login', $3,
                    'timestamp', now() at time zone 'utc',
                    'message', format('Unsupported report kind: %s', report_kind)
                )
            )
        where id in (select id from next_report)
        returning *
        "#,
        [
            known_report_kinds.into(),
            STATUS_FAILED.into(),
            REPORT_TIMEOUT_LOGIN.into(),
        ],
    );
    let report_history = report_history::Model::find_by_statement(stmt)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(report_history) = &report_history {
        complete_pending_report_download_attempts(
            &env.dbx,
            report_history.id,
            report_history
                .completed_at
                .unwrap_or_else(|| Utc::now().naive_utc()),
        )
        .await
        .c(h!())?;
    }
    Ok(report_history)
}

async fn process_report(
    env: &Env,
    report_history: report_history::Model,
) -> Result<(), AppError> {
    let bgtask = create_running_bgtask(&env.dbx).await?;
    if !attach_report_bgtask(env, &report_history, &bgtask).await? {
        return Ok(());
    }
    let (res, timed_out) =
        run_report_with_timeout(env, &report_history, bgtask.id).await;
    let _ = finish_bgtask(Some(bgtask.id), &env.dbx, &res).await;
    match res {
        Ok(()) => Ok(()),
        Err(err) => {
            if timed_out {
                handle_report_timeout(env, &report_history, err).await?;
            } else {
                handle_report_failure(env, report_history.id, err).await?;
            }
            Ok(())
        }
    }
}

async fn run_report_with_timeout(
    env: &Env,
    report_history: &report_history::Model,
    bgtask_id: i64,
) -> (Result<(), AppError>, bool) {
    match tokio::time::timeout(
        StdDuration::from_secs(report_timeout_secs(
            &report_history.report_kind,
        )),
        generate_and_store_report(env, report_history, bgtask_id),
    )
    .await
    {
        Ok(res) => (res, false),
        Err(_) => (Err(report_timeout_error(report_history)), true),
    }
}

async fn create_running_bgtask(
    dbx: &DatabaseConnection,
) -> Result<bgtask::Model, AppError> {
    Ok(bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(json!([])),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(dbx)
    .await
    .c(h!())?)
}

async fn attach_report_bgtask(
    env: &Env,
    report_history: &report_history::Model,
    bgtask: &bgtask::Model,
) -> Result<bool, AppError> {
    if !set_report_bgtask(env, report_history.id, bgtask.id).await? {
        let res: Result<(), AppError> = Err(AppError::BL {
            msg: format!(
                "Report history row {} was already finished or cancelled before bgtask attachment",
                report_history.id
            ),
        });
        let _ = finish_bgtask(Some(bgtask.id), &env.dbx, &res).await;
        return Ok(false);
    }
    Ok(true)
}

async fn set_report_bgtask(
    env: &Env,
    report_history_id: i64,
    bgtask_id: i64,
) -> Result<bool, AppError> {
    let res = ReportHistory::update_many()
        .col_expr(report_history::Column::BgtaskId, Expr::value(bgtask_id))
        .filter(report_history::Column::Id.eq(report_history_id))
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(res.rows_affected > 0)
}

pub(crate) async fn set_bgtask_progress(
    dbx: &DatabaseConnection,
    bgtask_id: i64,
    progress: i64,
) -> Result<(), AppError> {
    Bgtask::update_many()
        .col_expr(
            bgtask::Column::Progress,
            Expr::value(progress.clamp(0, 100)),
        )
        .filter(bgtask::Column::Id.eq(bgtask_id))
        .filter(bgtask::Column::Running.eq(true))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn bgtask_log_progress(
    bgtask_id: i64,
    progress: i64,
    logline: &str,
    dbx: &DatabaseConnection,
) {
    if let Err(err) = set_bgtask_progress(dbx, bgtask_id, progress).await {
        warn!(
            "failed to update bgtask progress for {} to {}: {err:?}",
            bgtask_id, progress
        );
    }
    if let Err(err) = bgtask_log(Some(bgtask_id), logline, dbx).await.c(h!()) {
        warn!("failed to append bgtask log for {}: {err:?}", bgtask_id);
    }
}

async fn generate_and_store_report(
    env: &Env,
    report_history: &report_history::Model,
    bgtask_id: i64,
) -> Result<(), AppError> {
    bgtask_log_progress(bgtask_id, 10, "[1/3] Формування звіту", &env.dbx)
        .await;
    let generated = generate_report(env, report_history, bgtask_id).await?;
    log::info!(
        "report history stage complete: id={}, kind={}, stage=generated, bytes={}, rss_kib={:?}",
        report_history.id,
        report_history.report_kind,
        generated.bytes.len(),
        report_worker_rss_kib()
    );
    bgtask_log_progress(bgtask_id, 85, "[2/3] Збереження звіту", &env.dbx)
        .await;
    let s3_id = upload_report_bytes(env, &generated).await?;
    log::info!(
        "report history stage complete: id={}, kind={}, stage=uploaded, bytes={}, rss_kib={:?}",
        report_history.id,
        report_history.report_kind,
        generated.bytes.len(),
        report_worker_rss_kib()
    );
    let res = ReportHistory::update_many()
        .col_expr(
            report_history::Column::Status,
            Expr::value(STATUS_DONE.to_string()),
        )
        .col_expr(
            report_history::Column::CompletedAt,
            Expr::value(Some(Utc::now().naive_utc())),
        )
        .col_expr(report_history::Column::S3Id, Expr::value(Some(s3_id)))
        .col_expr(
            report_history::Column::FileName,
            Expr::value(Some(generated.file_name)),
        )
        .col_expr(
            report_history::Column::ContentType,
            Expr::value(Some(generated.content_type)),
        )
        .col_expr(
            report_history::Column::LastError,
            Expr::value(None::<String>),
        )
        .filter(report_history::Column::Id.eq(report_history.id))
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if res.rows_affected == 0 {
        return Err(AppError::BL {
            msg: format!(
                "Report history row {} was already finished or timed out",
                report_history.id
            ),
        });
    }
    bgtask_log_progress(
        bgtask_id,
        100,
        "[3/3] Готово до завантаження",
        &env.dbx,
    )
    .await;
    Ok(())
}

pub(crate) fn ensure_report_record_count(
    record_count: usize,
) -> Result<(), AppError> {
    if record_count <= REPORT_HISTORY_RECORD_LIMIT {
        return Ok(());
    }
    Err(AppError::BL {
        msg: REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS.to_string(),
    })
}

async fn generate_report(
    env: &Env,
    report_history: &report_history::Model,
    bgtask_id: i64,
) -> Result<GeneratedReport, AppError> {
    let request: ReportHistoryRequest =
        serde_json::from_value(report_history.request.clone()).c(h!())?;
    match request {
        ReportHistoryRequest::AnalysisReport { payload } => {
            let generated =
                crate::rer_importer::reports::report_docx_generate_file(
                    report_history.requested_by_login_id,
                    env,
                    *payload,
                    false,
                    Some(bgtask_id),
                )
                .await
                .c(h!())?;
            let bytes =
                read_and_remove_generated_report_file(&generated.path).await?;
            Ok(GeneratedReport {
                file_name: generated.filename,
                content_type: generated.content_type,
                bytes,
            })
        }
        ReportHistoryRequest::AnalysisExport { payload } => {
            let (file_name, content_type, bytes) = match report_history.report_kind.as_str() {
                KIND_SUMMARY_TABLE => (
                    report_history
                        .file_name
                        .clone()
                        .unwrap_or_else(|| "summary-table.xlsx".to_string()),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
                    crate::rer_importer::analysis::summary_table_xlsx_bytes(
                        &report_history.requested_by_login_id,
                        env,
                        *payload,
                    )
                    .await
                    .c(h!())?,
                ),
                KIND_KMZ => (
                    report_history
                        .file_name
                        .clone()
                        .unwrap_or_else(|| "analysis.kmz".to_string()),
                    "application/vnd.google-earth.kmz".to_string(),
                    crate::rer_importer::analysis::kmz::rer_analysis_kmz_bytes(
                        &report_history.requested_by_login_id,
                        env,
                        *payload,
                    )
                    .await
                    .c(h!())?,
                ),
                KIND_GEOJSON => (
                    report_history
                        .file_name
                        .clone()
                        .unwrap_or_else(|| "analysis.geojson".to_string()),
                    "application/geo+json".to_string(),
                    crate::rer_importer::analysis::geojson::rer_analysis_geojson_bytes(
                        &report_history.requested_by_login_id,
                        env,
                        *payload,
                    )
                    .await
                    .c(h!())?,
                ),
                _ => {
                    return Err(AppError::BL {
                        msg: format!(
                            "Unsupported analysis export kind: {}",
                            report_history.report_kind
                        ),
                    })
                }
            };
            Ok(GeneratedReport {
                file_name,
                content_type,
                bytes,
            })
        }
        ReportHistoryRequest::EtalonkaFilter { payload } => {
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_data(
                    &env.dbx,
                    &report_history.requested_by_login_id,
                    &payload,
                    trace_id,
                )
                .await
                .c(h!())?;
            let bytes =
                crate::sigint::etalonka::task::render_networks_docx_report_bytes(
                    &payload.etalonka_type,
                    etalonka_data,
                )
                .await
                .c(h!())?;
            Ok(GeneratedReport {
                file_name: report_history.file_name.clone().unwrap_or_else(
                    || format!("etalonka_networks_{}.docx", report_history.id),
                ),
                content_type: crate::sigint::etalonka::task::DOCX_CONTENT_TYPE
                    .to_string(),
                bytes,
            })
        }
        ReportHistoryRequest::EtalonkaBatch { payload } => {
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_batch_id_data(
                    &env.dbx,
                    &report_history.requested_by_login_id,
                    &payload,
                    trace_id,
                )
                .await
                .c(h!())?;
            let bytes =
                crate::sigint::etalonka::task::render_networks_docx_report_bytes(
                    &payload.etalonka_type,
                    etalonka_data,
                )
                .await
                .c(h!())?;
            Ok(GeneratedReport {
                file_name: report_history.file_name.clone().unwrap_or_else(
                    || format!("etalonka_networks_{}.docx", report_history.id),
                ),
                content_type: crate::sigint::etalonka::task::DOCX_CONTENT_TYPE
                    .to_string(),
                bytes,
            })
        }
        ReportHistoryRequest::GoiReport { .. } => {
            let organism_id = crate::sigint::network::goi::login_organism_id(
                &env.dbx,
                &report_history.requested_by_login_id,
            )
            .await
            .c(h!())?;
            let bytes =
                crate::sigint::network::goi::report_xlsx_networks_goi_to_buffer(
                    env,
                    organism_id,
                )
                .await
                .c(h!())?;
            Ok(GeneratedReport {
                file_name: report_history.file_name.clone().unwrap_or_else(
                    || {
                        format!(
                            "goi_report_{}.xlsx",
                            Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f")
                        )
                    },
                ),
                content_type:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .to_string(),
                bytes,
            })
        }
        ReportHistoryRequest::GoiAssociationsReport { payload } => {
            let bytes = crate::organism::goi::integrations::goi_associations_report_xlsx(
                env,
                &report_history.requested_by_login_id,
                &payload,
            )
            .await
            .c(h!())?;
            Ok(GeneratedReport {
                file_name: report_history.file_name.clone().unwrap_or_else(
                    || {
                        format!(
                            "goi_associations_{}.xlsx",
                            Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f")
                        )
                    },
                ),
                content_type:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .to_string(),
                bytes,
            })
        }
    }
}

async fn upload_report_bytes(
    env: &Env,
    generated: &GeneratedReport,
) -> Result<String, AppError> {
    let Some(config) = env.config.s3_config.as_ref() else {
        return Err(AppError::BL {
            msg: "S3 is not configured".to_string(),
        });
    };
    let Some(s3_config) = env.s3_config.as_ref() else {
        return Err(AppError::BL {
            msg: "S3 operator config is not available".to_string(),
        });
    };
    let report_id = Uuid::now_v7();
    let mut object_key = format!(
        "{REPORT_OBJECT_PREFIX}/{}",
        crate::storage::nested_object_key(&report_id)
    );
    if let Some(ext) = Path::new(&generated.file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
    {
        object_key = format!("{object_key}.{ext}");
    }
    crate::storage::upload_encrypted_to_s3_with_operator(
        &env.s3,
        s3_config,
        &config.strongbox_key,
        &object_key,
        &generated.bytes,
    )
    .await
    .c(h!())?;
    Ok(object_key)
}

async fn download_report_bytes(
    env: &Env,
    s3_id: &str,
) -> Result<Vec<u8>, AppError> {
    let Some(config) = env.config.s3_config.as_ref() else {
        return Err(AppError::BL {
            msg: "S3 is not configured".to_string(),
        });
    };
    crate::storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &config.strongbox_key,
        s3_id,
    )
    .await
}

fn report_timeout_message(report_history: &report_history::Model) -> String {
    let timeout_secs = report_timeout_secs(&report_history.report_kind);
    format!(
        "Report generation timed out after {} seconds: id={}, kind={}, requested_by_login_id={}",
        timeout_secs,
        report_history.id,
        report_history.report_kind,
        report_history.requested_by_login_id,
    )
}

fn report_timeout_error(report_history: &report_history::Model) -> AppError {
    AppError::BL {
        msg: report_timeout_message(report_history),
    }
}

fn report_timeout_secs(report_kind: &str) -> u64 {
    if report_kind == KIND_ETALONKA {
        REPORT_HISTORY_ETALONKA_IN_PROGRESS_TIMEOUT_SECS
    } else {
        REPORT_HISTORY_IN_PROGRESS_TIMEOUT_SECS
    }
}

async fn fail_timed_out_reports(env: &Env) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    let timed_out_reports = ReportHistory::find()
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter(|report_history| {
            let Some(started_at) = report_history.started_at else {
                return false;
            };
            let timeout = Duration::seconds(report_timeout_secs(
                &report_history.report_kind,
            ) as i64);
            started_at <= now - timeout
        })
        .collect::<Vec<_>>();

    for report_history in timed_out_reports {
        let err_msg = report_timeout_message(&report_history);
        if let Some(report_history) =
            fail_in_progress_report(env, report_history.id, err_msg.clone())
                .await?
        {
            let res: Result<(), AppError> = Err(AppError::BL {
                msg: err_msg.clone(),
            });
            let _ =
                finish_bgtask(report_history.bgtask_id, &env.dbx, &res).await;
            notify_report_timeout_nofail(env, &report_history, &err_msg).await;
        }
    }
    Ok(())
}

async fn handle_report_timeout(
    env: &Env,
    report_history: &report_history::Model,
    err: AppError,
) -> Result<(), AppError> {
    let err_msg = format!("{err:#?}");
    if let Some(report_history) =
        fail_in_progress_report(env, report_history.id, err_msg.clone()).await?
    {
        notify_report_timeout_nofail(env, &report_history, &err_msg).await;
    }
    Ok(())
}

async fn fail_in_progress_report(
    env: &Env,
    report_history_id: i64,
    err_msg: String,
) -> Result<Option<report_history::Model>, AppError> {
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update report_history
        set
            status = $1,
            completed_at = now() at time zone 'utc',
            last_error = $2,
            log = coalesce(log, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'login', $3,
                    'timestamp', now() at time zone 'utc',
                    'message', $2
                )
            )
        where id = $4
          and status = $5
        returning *
        "#,
        [
            STATUS_FAILED.into(),
            err_msg.into(),
            REPORT_TIMEOUT_LOGIN.into(),
            report_history_id.into(),
            STATUS_IN_PROGRESS.into(),
        ],
    );
    let report_history = report_history::Model::find_by_statement(stmt)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(report_history) = &report_history {
        complete_pending_report_download_attempts(
            &env.dbx,
            report_history.id,
            report_history
                .completed_at
                .unwrap_or_else(|| Utc::now().naive_utc()),
        )
        .await
        .c(h!())?;
    }
    Ok(report_history)
}

async fn notify_report_timeout_nofail(
    env: &Env,
    report_history: &report_history::Model,
    err_msg: &str,
) {
    let content = format!(
        "Report timed out at echo server {}: id={}, kind={}, requested_by_login_id={}\n{}",
        env.config.public_host,
        report_history.id,
        report_history.report_kind,
        report_history.requested_by_login_id,
        err_msg,
    );
    let result = tokio::time::timeout(
        StdDuration::from_secs(REPORT_HISTORY_DISCORD_ALERT_TIMEOUT_SEC),
        crate::server::discord::discord_notify(
            &env.config,
            DISCORD_WEBHOOK_ALERT,
            &content,
        ),
    )
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => error!(
            "failed to send report timeout discord alert for report {}: {err:?}",
            report_history.id
        ),
        Err(err) => error!(
            "timed out sending report timeout discord alert for report {}: {err:?}",
            report_history.id
        ),
    }
}

async fn handle_report_failure(
    env: &Env,
    report_history_id: i64,
    err: AppError,
) -> Result<(), AppError> {
    let Some(report_history) = ReportHistory::find_by_id(report_history_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    if report_history.status != STATUS_IN_PROGRESS {
        warn!(
            "skipping retry planning for report {} because status is {}",
            report_history_id, report_history.status
        );
        return Ok(());
    }
    let err_msg = format!("{err:#?}");
    let attempt_count =
        report_failure_attempt_count(report_history.retry_count, &err_msg);
    let report_log = append_log_entry(report_history.log, "system", &err_msg);
    let now = Utc::now().naive_utc();
    if attempt_count < REPORT_HISTORY_MAX_ATTEMPTS {
        let res = ReportHistory::update_many()
            .col_expr(
                report_history::Column::Status,
                Expr::value(STATUS_PLANNED.to_string()),
            )
            .col_expr(
                report_history::Column::RetryCount,
                Expr::value(attempt_count),
            )
            .col_expr(
                report_history::Column::PlannedForTs,
                Expr::value(Some(
                    now + Duration::minutes(5 * i64::from(attempt_count)),
                )),
            )
            .col_expr(
                report_history::Column::StartedAt,
                Expr::value(None::<chrono::NaiveDateTime>),
            )
            .col_expr(
                report_history::Column::CompletedAt,
                Expr::value(None::<chrono::NaiveDateTime>),
            )
            .col_expr(
                report_history::Column::BgtaskId,
                Expr::value(None::<i64>),
            )
            .col_expr(
                report_history::Column::LastError,
                Expr::value(Some(err_msg)),
            )
            .col_expr(report_history::Column::Log, Expr::value(report_log))
            .filter(report_history::Column::Id.eq(report_history_id))
            .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
            .exec(&env.dbx)
            .await
            .c(h!())?;
        if res.rows_affected == 0 {
            warn!(
                "skipping retry planning for report {} because it finished while preparing retry",
                report_history_id
            );
            return Ok(());
        }
    } else {
        let res = ReportHistory::update_many()
            .col_expr(
                report_history::Column::Status,
                Expr::value(STATUS_FAILED.to_string()),
            )
            .col_expr(
                report_history::Column::RetryCount,
                Expr::value(attempt_count),
            )
            .col_expr(
                report_history::Column::PlannedForTs,
                Expr::value(None::<chrono::NaiveDateTime>),
            )
            .col_expr(
                report_history::Column::CompletedAt,
                Expr::value(Some(now)),
            )
            .col_expr(
                report_history::Column::LastError,
                Expr::value(Some(err_msg)),
            )
            .col_expr(report_history::Column::Log, Expr::value(report_log))
            .filter(report_history::Column::Id.eq(report_history_id))
            .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
            .exec(&env.dbx)
            .await
            .c(h!())?;
        if res.rows_affected == 0 {
            warn!(
                "skipping failure finalization for report {} because it finished while preparing failure",
                report_history_id
            );
            return Ok(());
        }
        complete_pending_report_download_attempts(
            &env.dbx,
            report_history_id,
            now,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

fn report_failure_attempt_count(retry_count: i32, error: &str) -> i32 {
    if error.contains(REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS)
        || error.contains(RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE)
        || error.contains(RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE)
    {
        REPORT_HISTORY_MAX_ATTEMPTS
    } else {
        (retry_count + 1).min(REPORT_HISTORY_MAX_ATTEMPTS)
    }
}

fn append_log_entry(
    log: serde_json::Value,
    login: &str,
    message: &str,
) -> serde_json::Value {
    let mut log = log.as_array().cloned().unwrap_or_default();
    log.push(json!({
        "login": login,
        "timestamp": Utc::now().naive_utc(),
        "message": message,
    }));
    json!(log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{bgtask_res, login};
    use crate::functest::tests::{cleanup, mk_login};
    use chrono::Timelike;
    use sea_orm::ActiveValue::{NotSet, Set};
    use sea_orm::{EntityTrait, QueryTrait};
    use serde_json::json;
    use serial_test::serial;

    #[test]
    fn admin_started_at_sort_keeps_unlaunched_reports_last() {
        let query = apply_report_history_admin_sorting(
            ReportHistory::find(),
            &[ReportHistorySorting {
                id: "startedAt".to_string(),
                desc: true,
            }],
        );
        let sql = query.build(DatabaseBackend::Postgres).to_string();

        assert!(
            sql.contains(
                "ORDER BY \"report_history\".\"started_at\" DESC NULLS LAST, \"report_history\".\"id\" DESC"
            ),
            "{sql}"
        );
    }

    #[test]
    fn report_error_hint_exposes_only_known_nested_messages() {
        let cases = [
            (
                r#"BL { msg: "Оберіть інший період" }"#,
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                r#"Outer { msg: "зовнішня", source: BL { msg: "внутрішня" } }"#,
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                "AnyhowError { source: context\n\nCaused by:\n    Service unavailable: Сервіс тимчасово недоступний,\n}",
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                r#"BL { msg: "geo-screenshot failed. Exit code: Some(1). Stdout: secret. Stderr: internal details" }"#,
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                r#"OuterError { source: "Коротке пояснення" }"#,
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                r#"DatabaseError { table: "report_history", constraint: "private_constraint" }"#,
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                "Report generation timed out after 3600 seconds",
                REPORT_HISTORY_TIMEOUT_ERROR_STATUS,
            ),
            (
                r#"BL { msg: "Report generation timed out after 3600 seconds: id=8771, kind=reo, requested_by_login_id=019f9010-ba23-7d95-9905-c689dc4b17dc" }"#,
                REPORT_HISTORY_TIMEOUT_ERROR_STATUS,
            ),
            (
                r#"AnyhowError { source: Query(SqlxError(Database(PgDatabaseError { code: "57014", message: "canceling statement due to statement timeout" }))) }"#,
                REPORT_HISTORY_TIMEOUT_ERROR_STATUS,
            ),
            (
                "Service unavailable: Аналітичний запит перевищив допустимий час виконання. Спробуйте звузити параметри пошуку.",
                REPORT_HISTORY_TIMEOUT_ERROR_STATUS,
            ),
            (
                "Object storage upload timed out after 30 seconds",
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                "AnyhowError { source: deadline has elapsed }",
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
            (
                r#"BL { msg: "summary_table_report_message_limit" }"#,
                REPORT_HISTORY_MESSAGE_LIMIT_ERROR_STATUS,
            ),
            (
                "Report generation was interrupted while in progress; recorded attempt 2/2 during report worker startup recovery",
                REPORT_HISTORY_WORKER_INTERRUPTED_ERROR_STATUS,
            ),
            (
                "CustomInfrastructureError { source: DatabaseError }",
                REPORT_HISTORY_GENERIC_ERROR_STATUS,
            ),
        ];

        for (error, expected) in cases {
            assert_eq!(report_history_error_hint(error), expected);
        }
    }

    #[test]
    fn report_record_limit_fails_without_retry() {
        assert!(ensure_report_record_count(REPORT_HISTORY_RECORD_LIMIT).is_ok());
        let error = ensure_report_record_count(REPORT_HISTORY_RECORD_LIMIT + 1)
            .unwrap_err();
        let error = format!("{error:#?}");
        assert_eq!(
            report_history_error_hint(&error),
            REPORT_HISTORY_RECORD_LIMIT_ERROR_STATUS
        );
        assert_eq!(
            report_failure_attempt_count(0, &error),
            REPORT_HISTORY_MAX_ATTEMPTS
        );
    }

    #[test]
    fn report_message_limits_fail_without_retry() {
        for error in [
            RER_MOUSE_REPORT_MESSAGE_LIMIT_ERROR_CODE,
            RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE,
        ] {
            assert_eq!(
                report_failure_attempt_count(0, error),
                REPORT_HISTORY_MAX_ATTEMPTS
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn startup_recovery_uses_separate_bounded_attempts(
    ) -> Result<(), AppError> {
        let env = cleanup().await.c(h!())?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-startup-recovery",
        )
        .await
        .c(h!())?;
        let now = Utc::now().naive_utc();
        let report = insert_report_history(
            &env.dbx,
            &login.login,
            KIND_GOI,
            STATUS_IN_PROGRESS,
            now - Duration::minutes(1),
            Some(now),
            None,
        )
        .await
        .c(h!())?;
        let bgtask = create_running_bgtask(&env.dbx).await.c(h!())?;
        let mut report = report.into_active_model();
        report.retry_count = Set(1);
        report.bgtask_id = Set(Some(bgtask.id));
        report.last_error = Set(Some("previous attempt failed".to_string()));
        let report = report.update(&env.dbx).await.c(h!())?;

        recover_interrupted_reports(&env).await.c(h!())?;

        let recovered = ReportHistory::find_by_id(report.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert_eq!(recovered.status, STATUS_PLANNED);
        assert_eq!(recovered.retry_count, 1);
        assert!(recovered.planned_for_ts.is_some());
        assert_eq!(recovered.started_at, None);
        assert_eq!(recovered.completed_at, None);
        assert_eq!(recovered.bgtask_id, None);
        assert_eq!(recovered.last_error, None);
        assert_eq!(
            recovered
                .log
                .as_array()
                .and_then(|entries| entries.last())
                .and_then(|entry| entry.get("message"))
                .and_then(serde_json::Value::as_str),
            Some(REPORT_HISTORY_WORKER_RESTART_LOG_MESSAGE)
        );

        let mut recovered = recovered.into_active_model();
        recovered.status = Set(STATUS_IN_PROGRESS.to_string());
        recovered.started_at = Set(Some(now));
        let recovered = recovered.update(&env.dbx).await.c(h!())?;

        recover_interrupted_reports(&env).await.c(h!())?;

        let exhausted = ReportHistory::find_by_id(recovered.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert_eq!(exhausted.status, STATUS_FAILED);
        assert_eq!(exhausted.retry_count, 1);
        assert_eq!(exhausted.planned_for_ts, None);
        assert!(exhausted.completed_at.is_some());
        assert_eq!(
            report_history_error_status(&exhausted),
            REPORT_HISTORY_WORKER_INTERRUPTED_ERROR_STATUS
        );
        let error_log = report_history_error_log(&exhausted, true)
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert_eq!(
            error_log.last().map(|entry| entry.message.as_str()),
            exhausted.last_error.as_deref()
        );

        let retried = reset_failed_report(&env.dbx, exhausted, &login.id)
            .await
            .c(h!())?;
        let mut retried = retried.into_active_model();
        retried.status = Set(STATUS_IN_PROGRESS.to_string());
        retried.started_at = Set(Some(now));
        let retried = retried.update(&env.dbx).await.c(h!())?;

        recover_interrupted_reports(&env).await.c(h!())?;

        let recovered_after_retry = ReportHistory::find_by_id(retried.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert_eq!(recovered_after_retry.status, STATUS_PLANNED);
        assert_eq!(recovered_after_retry.retry_count, 0);
        Ok(())
    }

    async fn insert_report_history(
        dbx: &DatabaseConnection,
        requested_by_login: &str,
        report_kind: &str,
        status: &str,
        created_at: chrono::NaiveDateTime,
        started_at: Option<chrono::NaiveDateTime>,
        planned_for_ts: Option<chrono::NaiveDateTime>,
    ) -> Result<report_history::Model, AppError> {
        Ok(report_history::ActiveModel {
            id: NotSet,
            report_kind: Set(report_kind.to_string()),
            requested_by_login_id: Set(crate::users::login_id_by_name(
                dbx,
                requested_by_login,
            )
            .await?),
            request: Set(serde_json::to_value(
                ReportHistoryRequest::GoiReport { payload: json!({}) },
            )
            .c(h!())?),
            created_at: Set(created_at),
            status: Set(status.to_string()),
            retry_count: Set(0),
            planned_for_ts: Set(planned_for_ts),
            started_at: Set(started_at),
            completed_at: Set(None),
            s3_id: Set(None),
            bgtask_id: Set(None),
            file_name: Set(None),
            content_type: Set(None),
            last_error: Set(None),
            log: Set(json!([])),
            legacy_log_id: Set(None),
            legacy_report_path: Set(None),
        }
        .insert(dbx)
        .await
        .c(h!())?)
    }

    fn timestamp_to_db_precision(
        timestamp: chrono::NaiveDateTime,
    ) -> chrono::NaiveDateTime {
        timestamp
            .with_nanosecond((timestamp.nanosecond() / 1_000) * 1_000)
            .unwrap_or(timestamp)
    }

    async fn create_report_history_test_login(
        dbx: &DatabaseConnection,
        name: &str,
    ) -> Result<login::Model, AppError> {
        Ok(mk_login(
            dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set(name.to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?)
    }

    fn goi_report_request(payload: serde_json::Value) -> ReportHistoryRequest {
        ReportHistoryRequest::GoiReport { payload }
    }

    async fn report_history_count_for_login(
        dbx: &DatabaseConnection,
        login_id: uuid::Uuid,
    ) -> Result<u64, AppError> {
        Ok(ReportHistory::find()
            .filter(report_history::Column::RequestedByLoginId.eq(login_id))
            .count(dbx)
            .await
            .c(h!())?)
    }

    // Regression: https://github.com/echoua/echo/issues/3279
    #[tokio::test]
    #[serial]
    async fn download_attempt_includes_generation_wait_and_transfer(
    ) -> Result<(), AppError> {
        let env = cleanup().await.c(h!())?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-download-history",
        )
        .await
        .c(h!())?;
        let report_history = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            Some("report.xlsx".to_string()),
            Some("application/octet-stream".to_string()),
        )
        .await
        .c(h!())?;

        let pending = ReportDownloadHistory::find()
            .filter(
                report_download_history::Column::ReportHistoryId
                    .eq(report_history.id),
            )
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert_eq!(pending.started_at, None);
        assert_eq!(pending.successful, None);

        let claimed = claim_report_download_attempt(
            &env.dbx,
            report_history.id,
            &login.id,
        )
        .await
        .c(h!())?;
        assert_eq!(claimed.id, pending.id);
        assert!(claimed.started_at.is_some());
        complete_report_download_attempt(&env.dbx, claimed.id, true)
            .await
            .c(h!())?;

        let completed = ReportDownloadHistory::find_by_id(claimed.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        assert!(completed.completed_at.is_some());
        assert!(completed.duration_ms.is_some_and(|duration| duration >= 0));
        assert_eq!(completed.successful, Some(true));

        let direct = claim_report_download_attempt(
            &env.dbx,
            report_history.id,
            &login.id,
        )
        .await
        .c(h!())?;
        assert_ne!(direct.id, completed.id);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_reuses_queued_delayed_and_running_duplicate(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-duplicate-active",
        )
        .await?;

        let report = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            Some("first.xlsx".to_string()),
            Some("application/octet-stream".to_string()),
        )
        .await?;
        let report_id = report.id;

        let duplicate = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            Some("ignored.xlsx".to_string()),
            None,
        )
        .await?;
        assert_eq!(duplicate.id, report_id);
        assert_eq!(duplicate.file_name.as_deref(), Some("first.xlsx"));

        let mut duplicate = duplicate.into_active_model();
        duplicate.planned_for_ts =
            Set(Some(Utc::now().naive_utc() + Duration::minutes(5)));
        duplicate.update(&env.dbx).await.c(h!())?;
        let delayed_duplicate = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;
        assert_eq!(delayed_duplicate.id, report_id);

        let mut delayed_duplicate = delayed_duplicate.into_active_model();
        delayed_duplicate.status = Set(STATUS_IN_PROGRESS.to_string());
        delayed_duplicate.started_at = Set(Some(Utc::now().naive_utc()));
        delayed_duplicate.planned_for_ts = Set(None);
        let running = delayed_duplicate.update(&env.dbx).await.c(h!())?;
        let running_duplicate = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;
        assert_eq!(running_duplicate.id, report_id);

        let bgtask = create_running_bgtask(&env.dbx).await?;
        let mut running = running.into_active_model();
        running.bgtask_id = Set(Some(bgtask.id));
        running.update(&env.dbx).await.c(h!())?;
        let attached_duplicate = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;

        assert_eq!(attached_duplicate.id, report_id);
        assert_eq!(attached_duplicate.bgtask_id, Some(bgtask.id));
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            1
        );
        assert!(attached_duplicate
            .log
            .as_array()
            .and_then(|entries| entries.last())
            .and_then(|entry| entry.get("message"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|message| {
                message.starts_with("skipping duplicate report:")
            }));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_retries_newest_failed_duplicate_including_cancelled(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-duplicate-failed",
        )
        .await?;
        let created_at = Utc::now().naive_utc();
        let older = insert_report_history(
            &env.dbx,
            &login.login,
            KIND_GOI,
            STATUS_FAILED,
            created_at,
            Some(created_at),
            None,
        )
        .await?;
        let newer = insert_report_history(
            &env.dbx,
            &login.login,
            KIND_GOI,
            STATUS_FAILED,
            created_at + Duration::seconds(1),
            Some(created_at + Duration::seconds(1)),
            None,
        )
        .await?;
        let mut newer = newer.into_active_model();
        newer.retry_count = Set(2);
        newer.completed_at = Set(Some(created_at + Duration::seconds(2)));
        newer.last_error = Set(Some("Скасовано користувачем".to_string()));
        let newer = newer.update(&env.dbx).await.c(h!())?;

        let retried = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;

        assert_eq!(retried.id, newer.id);
        assert_ne!(retried.id, older.id);
        assert_eq!(retried.status, STATUS_PLANNED);
        assert_eq!(retried.retry_count, 0);
        assert_eq!(retried.planned_for_ts, None);
        assert_eq!(retried.started_at, None);
        assert_eq!(retried.completed_at, None);
        assert_eq!(retried.bgtask_id, None);
        assert_eq!(retried.last_error, None);
        assert!(!report_history_is_cancelled(&retried));
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            2
        );
        assert!(retried
            .log
            .as_array()
            .and_then(|entries| entries.last())
            .and_then(|entry| entry.get("message"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|message| message.contains("another attempt")));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_reuses_oldest_preexisting_active_duplicate(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-duplicate-oldest-active",
        )
        .await?;
        let created_at = Utc::now().naive_utc();
        let older = insert_report_history(
            &env.dbx,
            &login.login,
            KIND_GOI,
            STATUS_IN_PROGRESS,
            created_at,
            Some(created_at),
            None,
        )
        .await?;
        let newer = insert_report_history(
            &env.dbx,
            &login.login,
            KIND_GOI,
            STATUS_PLANNED,
            created_at + Duration::seconds(1),
            None,
            None,
        )
        .await?;

        let reused = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;

        assert_eq!(reused.id, older.id);
        assert_ne!(reused.id, newer.id);
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            2
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_creates_new_row_after_success() -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-duplicate-done",
        )
        .await?;
        let report = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;
        let mut report = report.into_active_model();
        report.status = Set(STATUS_DONE.to_string());
        report.completed_at = Set(Some(Utc::now().naive_utc()));
        let report = report.update(&env.dbx).await.c(h!())?;

        let repeated = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;

        assert_ne!(repeated.id, report.id);
        assert_eq!(repeated.status, STATUS_PLANNED);
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            2
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn admin_rerun_copies_success_into_new_planned_row(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let owner = create_report_history_test_login(
            &env.dbx,
            "report-history-admin-rerun-owner",
        )
        .await?;
        let admin = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-admin-rerun-admin".to_string()),
                roles: Set(json!(["Admin"])),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let created_at = Utc::now().naive_utc();
        let report = insert_report_history(
            &env.dbx,
            &owner.login,
            KIND_GOI,
            STATUS_DONE,
            created_at,
            Some(created_at),
            None,
        )
        .await?;
        let mut report = report.into_active_model();
        report.completed_at = Set(Some(created_at));
        report.s3_id = Set(Some("reports/original.xlsx".to_string()));
        report.file_name = Set(Some("original.xlsx".to_string()));
        report.content_type = Set(Some("application/octet-stream".to_string()));
        let report = report.update(&env.dbx).await.c(h!())?;

        let rerun =
            rerun_completed_report(&env.dbx, report.id, &admin.id).await?;

        assert_ne!(rerun.id, report.id);
        assert_eq!(rerun.report_kind, report.report_kind);
        assert_eq!(rerun.requested_by_login_id, report.requested_by_login_id);
        assert_eq!(rerun.request, report.request);
        assert_eq!(rerun.status, STATUS_PLANNED);
        assert_eq!(rerun.retry_count, 0);
        assert_eq!(rerun.planned_for_ts, None);
        assert_eq!(rerun.started_at, None);
        assert_eq!(rerun.completed_at, None);
        assert_eq!(rerun.s3_id, None);
        assert_eq!(rerun.bgtask_id, None);
        assert_eq!(rerun.file_name, report.file_name);
        assert_eq!(rerun.content_type, report.content_type);
        assert_eq!(rerun.last_error, None);
        assert!(rerun
            .log
            .as_array()
            .and_then(|entries| entries.last())
            .is_some_and(|entry| {
                entry.get("login").and_then(serde_json::Value::as_str)
                    == Some(admin.id.to_string().as_str())
                    && entry
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|message| {
                            message.contains(&format!("report #{}", report.id))
                        })
            }));

        let preserved = ReportHistory::find_by_id(report.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        assert_eq!(preserved.status, STATUS_DONE);
        assert_eq!(preserved.s3_id, report.s3_id);

        let duplicate =
            rerun_completed_report(&env.dbx, report.id, &admin.id).await?;
        assert_eq!(duplicate.id, rerun.id);
        assert_eq!(
            report_history_count_for_login(&env.dbx, owner.id).await?,
            2
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_matches_exact_user_kind_and_array_order(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let alice = create_report_history_test_login(
            &env.dbx,
            "report-history-exact-alice",
        )
        .await?;
        let bob = create_report_history_test_login(
            &env.dbx,
            "report-history-exact-bob",
        )
        .await?;
        let first = enqueue_report(
            &env.dbx,
            &alice.id,
            KIND_GOI,
            goi_report_request(json!({ "values": [1, 2] })),
            None,
            None,
        )
        .await?;
        let reordered = enqueue_report(
            &env.dbx,
            &alice.id,
            KIND_GOI,
            goi_report_request(json!({ "values": [2, 1] })),
            None,
            None,
        )
        .await?;
        let other_kind = enqueue_report(
            &env.dbx,
            &alice.id,
            KIND_ETALONKA,
            goi_report_request(json!({ "values": [1, 2] })),
            None,
            None,
        )
        .await?;
        let other_user = enqueue_report(
            &env.dbx,
            &bob.id,
            KIND_GOI,
            goi_report_request(json!({ "values": [1, 2] })),
            None,
            None,
        )
        .await?;

        let ids = HashSet::from([
            first.id,
            reordered.id,
            other_kind.id,
            other_user.id,
        ]);
        assert_eq!(ids.len(), 4);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_identical_enqueues_return_one_report_id(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-duplicate-concurrent",
        )
        .await?;
        let mut handles = vec![];
        for _ in 0..8 {
            let dbx = env.dbx.clone();
            let login_id = login.id;
            handles.push(tokio::spawn(async move {
                enqueue_report(
                    &dbx,
                    &login_id,
                    KIND_GOI,
                    goi_report_request(json!({})),
                    None,
                    None,
                )
                .await
            }));
        }

        let mut ids = HashSet::new();
        for handle in handles {
            ids.insert(handle.await.expect("enqueue task failed")?.id);
        }

        assert_eq!(ids.len(), 1);
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            1
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn enqueue_waits_for_cancellation_and_retries_cancelled_report(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        let login = create_report_history_test_login(
            &env.dbx,
            "report-history-cancel-enqueue-race",
        )
        .await?;
        let report = enqueue_report(
            &env.dbx,
            &login.id,
            KIND_GOI,
            goi_report_request(json!({})),
            None,
            None,
        )
        .await?;

        let txn = env.dbx.begin().await.c(h!())?;
        lock_report_request(
            &txn,
            &report.requested_by_login_id,
            &report.report_kind,
            &report.request,
        )
        .await?;

        let dbx = env.dbx.clone();
        let login_id = login.id;
        let mut enqueue = tokio::spawn(async move {
            enqueue_report(
                &dbx,
                &login_id,
                KIND_GOI,
                goi_report_request(json!({})),
                None,
                None,
            )
            .await
        });
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            &mut enqueue,
        )
        .await
        .is_err());

        let cancelled =
            mark_report_cancelled(&txn, report.id, "Скасовано користувачем")
                .await?;
        assert_eq!(cancelled.status, STATUS_FAILED);
        txn.commit().await.c(h!())?;

        let requeued = enqueue.await.expect("enqueue task failed")?;
        assert_eq!(requeued.id, report.id);
        assert_eq!(requeued.status, STATUS_PLANNED);
        assert_eq!(requeued.last_error, None);
        assert_eq!(
            report_history_count_for_login(&env.dbx, login.id).await?,
            1
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn planned_row_after_same_user_in_progress_gets_second_queue_position(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let blocker = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_IN_PROGRESS,
            created_at,
            Some(created_at + Duration::minutes(1)),
            None,
        )
        .await?;
        let blocker_id = blocker.id;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_PLANNED,
            created_at + Duration::minutes(2),
            None,
            Some(created_at + Duration::minutes(2)),
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![blocker, planned], false)
                .await?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[1].queue_position, Some(2));
        assert_eq!(rows[1].blocked_by_report_id, Some(blocker_id));
        assert_eq!(
            rows[1].blocked_by_started_at,
            Some(
                timestamp_to_db_precision(created_at + Duration::minutes(1))
                    .to_string()
            )
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn queue_positions_are_independent_across_users_and_kinds(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-bob".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let blocker = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_IN_PROGRESS,
            created_at,
            Some(created_at + Duration::minutes(1)),
            None,
        )
        .await?;
        let alice_planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_PLANNED,
            created_at + Duration::minutes(2),
            None,
            Some(created_at + Duration::minutes(2)),
        )
        .await?;
        let bob_planned = insert_report_history(
            &env.dbx,
            "report-history-bob",
            KIND_ETALONKA,
            STATUS_PLANNED,
            created_at + Duration::minutes(3),
            None,
            Some(created_at + Duration::minutes(3)),
        )
        .await?;
        let alice_other_kind = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_GOI,
            STATUS_PLANNED,
            created_at + Duration::minutes(4),
            None,
            Some(created_at + Duration::minutes(4)),
        )
        .await?;

        let rows = build_report_history_rows(
            &env.dbx,
            vec![blocker, alice_planned, bob_planned, alice_other_kind],
            false,
        )
        .await?;

        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[1].queue_position, Some(2));
        assert_eq!(rows[2].queue_position, Some(1));
        assert_eq!(rows[3].queue_position, Some(1));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn non_etalonka_planned_row_counts_same_kind_blocker(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-bob".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let blocker = insert_report_history(
            &env.dbx,
            "report-history-bob",
            KIND_GOI,
            STATUS_IN_PROGRESS,
            created_at,
            Some(created_at + Duration::minutes(1)),
            None,
        )
        .await?;
        let blocker_id = blocker.id;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_GOI,
            STATUS_PLANNED,
            created_at + Duration::minutes(2),
            None,
            Some(created_at + Duration::minutes(2)),
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![blocker, planned], false)
                .await?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[1].queue_position, Some(2));
        assert_eq!(rows[1].blocked_by_report_id, Some(blocker_id));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn non_etalonka_planned_row_counts_cross_user_planned_blocker(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-bob".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let blocker = insert_report_history(
            &env.dbx,
            "report-history-bob",
            KIND_GOI,
            STATUS_PLANNED,
            created_at,
            None,
            Some(created_at),
        )
        .await?;
        let blocker_id = blocker.id;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_GOI,
            STATUS_PLANNED,
            created_at + Duration::minutes(1),
            None,
            Some(created_at + Duration::minutes(1)),
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![blocker, planned], false)
                .await?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[1].queue_position, Some(2));
        assert_eq!(rows[1].blocked_by_report_id, Some(blocker_id));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn non_etalonka_future_planned_retry_does_not_block_following_row(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-bob".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _future_retry = insert_report_history(
            &env.dbx,
            "report-history-bob",
            KIND_GOI,
            STATUS_PLANNED,
            created_at - Duration::minutes(10),
            None,
            Some(created_at + Duration::minutes(5)),
        )
        .await?;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_GOI,
            STATUS_PLANNED,
            created_at,
            None,
            None,
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![planned], false).await?;

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[0].blocked_by_report_id, None);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn non_etalonka_due_retry_blocks_following_row(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-bob".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let retry = insert_report_history(
            &env.dbx,
            "report-history-bob",
            KIND_GOI,
            STATUS_PLANNED,
            created_at - Duration::minutes(10),
            None,
            Some(created_at - Duration::minutes(1)),
        )
        .await?;
        let retry_id = retry.id;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_GOI,
            STATUS_PLANNED,
            created_at,
            None,
            None,
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![retry, planned], false)
                .await?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].queue_position, Some(1));
        assert_eq!(rows[1].queue_position, Some(2));
        assert_eq!(rows[1].blocked_by_report_id, Some(retry_id));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn page_slice_still_sees_earlier_blocker_from_database(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _alice = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _blocker = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_IN_PROGRESS,
            created_at,
            Some(created_at + Duration::minutes(1)),
            None,
        )
        .await?;
        let planned = insert_report_history(
            &env.dbx,
            "report-history-alice",
            KIND_ETALONKA,
            STATUS_PLANNED,
            created_at + Duration::minutes(2),
            None,
            Some(created_at + Duration::minutes(2)),
        )
        .await?;

        let rows =
            build_report_history_rows(&env.dbx, vec![planned], false).await?;

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].queue_position, Some(2));
        assert_eq!(rows[0].blocked_by_report_id, Some(_blocker.id));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn cancelled_failed_row_is_not_replanned_on_failure_handler(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-cancel".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let report = insert_report_history(
            &env.dbx,
            "report-history-cancel",
            KIND_ETALONKA,
            STATUS_FAILED,
            created_at,
            None,
            None,
        )
        .await?;
        let mut report = report.into_active_model();
        report.last_error = Set(Some("Скасовано користувачем".to_string()));
        report.update(&env.dbx).await.c(h!())?;

        handle_report_failure(
            &env,
            report_history::Entity::find()
                .filter(report_history::Column::RequestedByLoginId.eq(login.id))
                .one(&env.dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?
                .id,
            AppError::BL {
                msg: "should not requeue".to_string(),
            },
        )
        .await?;

        let refreshed = ReportHistory::find()
            .filter(report_history::Column::RequestedByLoginId.eq(login.id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        assert_eq!(refreshed.status, STATUS_FAILED);
        assert_eq!(
            refreshed.last_error.as_deref(),
            Some("Скасовано користувачем")
        );
        assert!(report_history_is_cancelled(&refreshed));
        assert_eq!(refreshed.planned_for_ts, None);
        assert_eq!(refreshed.retry_count, 0);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_rows_mark_cancelled_without_exposing_last_error(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-cancel-list".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let report = insert_report_history(
            &env.dbx,
            "report-history-cancel-list",
            KIND_GOI,
            STATUS_FAILED,
            created_at,
            None,
            None,
        )
        .await?;
        let mut report = report.into_active_model();
        let report_id = report.id.clone().unwrap();
        report.last_error = Set(Some("Скасовано користувачем".to_string()));
        report.update(&env.dbx).await.c(h!())?;

        let rows = build_report_history_rows(
            &env.dbx,
            vec![report_history::Entity::find_by_id(report_id)
                .one(&env.dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?],
            false,
        )
        .await?;

        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_cancelled);
        assert_eq!(rows[0].last_error, None);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn guarded_bgtask_attach_skips_cancelled_report(
    ) -> Result<(), AppError> {
        let env = cleanup().await?;
        report_history::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        bgtask_res::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .c(h!())?;
        bgtask::Entity::delete_many().exec(&env.dbx).await.c(h!())?;

        let created_at = Utc::now().naive_utc();
        let _login = mk_login(
            &env.dbx,
            login::ActiveModel {
                id: NotSet,
                login: Set("report-history-guard".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let report = insert_report_history(
            &env.dbx,
            "report-history-guard",
            KIND_ETALONKA,
            STATUS_FAILED,
            created_at,
            None,
            None,
        )
        .await?;
        let mut report = report.into_active_model();
        report.last_error = Set(Some("Скасовано користувачем".to_string()));
        let report = report.update(&env.dbx).await.c(h!())?;

        let bgtask = create_running_bgtask(&env.dbx).await?;
        let attached = attach_report_bgtask(&env, &report, &bgtask).await?;
        assert!(!attached);

        let refreshed_report = report_history::Entity::find_by_id(report.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        assert_eq!(refreshed_report.bgtask_id, None);

        let refreshed_bgtask = bgtask::Entity::find_by_id(bgtask.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        assert!(!refreshed_bgtask.running);
        assert!(refreshed_bgtask
            .finished_with_error
            .as_deref()
            .unwrap_or("")
            .contains(
                "already finished or cancelled before bgtask attachment"
            ));
        Ok(())
    }
}
