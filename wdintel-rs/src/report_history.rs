use crate::config::{
    DISCORD_WEBHOOK_ALERT, REPORT_HISTORY_DISCORD_ALERT_TIMEOUT_SEC,
    REPORT_HISTORY_ETALONKA_IN_PROGRESS_TIMEOUT_SECS,
    REPORT_HISTORY_ETALONKA_WORKER_COUNT,
    REPORT_HISTORY_IN_PROGRESS_TIMEOUT_SECS, REPORT_HISTORY_LIST_LIMIT,
    REPORT_HISTORY_TIMEOUT_WORKER_SLEEP_SECS,
};
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{
    area_of_responsibility, bgtask, prelude::*, report_history,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::{ReportPreviewReq, ReportType};
use crate::rer_importer::types::AnalysisStatsReq;
use crate::sigint::etalonka::types::{
    EtalonkaJimForksReq, EtalonkaNetworkBatchReq,
};
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::{post, HttpResponse};
use chrono::{Duration, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use log::{error, warn};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, IntoActiveModel, NotSet,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select, Set,
    Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration as StdDuration;
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

const REPORT_HISTORY_MAX_ATTEMPTS: i32 = 2;
const WORKER_IDLE_SLEEP_SECS: u64 = 5;
const REPORT_OBJECT_PREFIX: &str = "reports";
const REPORT_TIMEOUT_LOGIN: &str = "system";
const REPORT_CRASH_RECOVERY_LOGIN: &str = "system";

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
    pub completed_at: Option<String>,
    pub has_file: bool,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub bgtask_id: Option<i64>,
    pub last_error: Option<String>,
    pub is_cancelled: bool,
    pub details: String,
    pub progress: i64,
    pub error_log: Option<Vec<ReportHistoryLogEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportHistoryLogEntry {
    pub login: String,
    pub timestamp: String,
    pub message: String,
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
    requested_by: Option<String>,
}

fn report_history_queue_scope(
    report_kind: &str,
    requested_by: &str,
) -> ReportHistoryQueueScope {
    if report_kind == KIND_ETALONKA {
        ReportHistoryQueueScope {
            report_kind: report_kind.to_string(),
            requested_by: Some(requested_by.to_string()),
        }
    } else {
        ReportHistoryQueueScope {
            report_kind: report_kind.to_string(),
            requested_by: None,
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
        &report_history.requested_by,
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

    Ok(report_histories
        .into_iter()
        .zip(detail_refs.iter())
        .map(|(report_history, refs)| {
            let report_history_id = report_history.id;
            let progress = lookup.report_history_progress(&report_history);
            to_report_history_row(
                report_history,
                lookup.format_details(refs),
                progress,
                queue_meta_by_id.get(&report_history_id).cloned(),
                expose_last_error,
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
    details: String,
    progress: i64,
    queue_meta: Option<ReportHistoryQueueMetaRow>,
    expose_last_error: bool,
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
    ReportHistoryRow {
        id: report_history.id,
        report_kind: report_history.report_kind,
        requested_by: report_history.requested_by,
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
        progress,
        error_log,
    }
}

fn report_history_is_cancelled(report_history: &report_history::Model) -> bool {
    report_history.status == STATUS_FAILED
        && report_history
            .last_error
            .as_deref()
            .map(|last_error| last_error.contains("Скасовано користувачем"))
            .unwrap_or(false)
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
        with input_rows(id, report_kind, requested_by, status, queued_for, created_at) as (
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
        values.push(scope.requested_by.clone().into());
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
                          i.requested_by is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by = i.requested_by
                      )
                      or (
                          i.requested_by is null
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
                          i.requested_by is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by = i.requested_by
                      )
                      or (
                          i.requested_by is null
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
                          i.requested_by is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by = i.requested_by
                      )
                      or (
                          i.requested_by is null
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
                          i.requested_by is not null
                          and other.report_kind = i.report_kind
                          and other.requested_by = i.requested_by
                      )
                      or (
                          i.requested_by is null
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
    if !expose_last_error || report_history.last_error.is_none() {
        return None;
    }
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
    if entries.is_empty() {
        entries.push(ReportHistoryLogEntry {
            login: "system".to_string(),
            timestamp: report_history
                .completed_at
                .or(report_history.started_at)
                .unwrap_or(report_history.created_at)
                .to_string(),
            message: report_history.last_error.clone().unwrap_or_default(),
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
        ReportHistoryRequest::GoiReport { .. } => {}
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
        "requestedBy" => {
            report_history_text_condition("report_history.requested_by", values)
        }
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
            .add(report_history_like_expr(
                "report_history.requested_by",
                value,
            ))
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
        "requestedBy" => Some(report_history::Column::RequestedBy),
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
    dbx: &DatabaseConnection,
    req: &ReportHistoryAdminListReq,
) -> Result<ReportHistoryAdminListRsp, AppError> {
    let offset = report_history_list_offset(req);
    let limit = report_history_list_batch_size(req);
    let filtered_query =
        apply_report_history_admin_filters(ReportHistory::find(), req);
    let total = filtered_query.clone().count(dbx).await.c(h!())?;

    let report_histories =
        apply_report_history_admin_sorting(filtered_query, &req.sorting)
            .offset(offset)
            .limit(limit)
            .all(dbx)
            .await
            .c(h!())?;
    let next_offset = offset + report_histories.len() as u64;
    let rows = build_report_history_rows(dbx, report_histories, true).await?;

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
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    err_msg: String,
) {
    if let Err(err) =
        record_failed_report(env, requested_by, report_kind, request, err_msg)
            .await
    {
        error!("failed to record failed report history row: {err:?}");
    }
}

async fn record_failed_report(
    env: &Env,
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    err_msg: String,
) -> Result<report_history::Model, AppError> {
    let now = Utc::now().naive_utc();
    Ok(report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by: Set(requested_by.to_string()),
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

pub async fn enqueue_report(
    dbx: &DatabaseConnection,
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: Option<String>,
    content_type: Option<String>,
) -> Result<report_history::Model, AppError> {
    Ok(report_history::ActiveModel {
        id: NotSet,
        report_kind: Set(report_kind.to_string()),
        requested_by: Set(requested_by.to_string()),
        request: Set(serde_json::to_value(request).c(h!())?),
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
    .insert(dbx)
    .await
    .c(h!())?)
}

pub async fn record_completed_report_nofail(
    env: &Env,
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    bytes: &[u8],
) {
    if let Err(err) = record_completed_report(
        env,
        requested_by,
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
    requested_by: &str,
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
        requested_by,
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
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    file_path: &Path,
) {
    if let Err(err) = record_completed_report_file(
        env,
        requested_by,
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
    requested_by: &str,
    report_kind: &str,
    request: ReportHistoryRequest,
    file_name: String,
    content_type: String,
    file_path: &Path,
) -> Result<report_history::Model, AppError> {
    let report_history = insert_archiving_report_row(
        env,
        requested_by,
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
    requested_by: &str,
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
        requested_by: Set(requested_by.to_string()),
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
    requested_by: &str,
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
        requested_by: Set(requested_by.to_string()),
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let report_histories = ReportHistory::find()
        .filter(report_history::Column::RequestedBy.eq(user_login))
        .order_by_desc(report_history::Column::CreatedAt)
        .limit(REPORT_HISTORY_LIST_LIMIT)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let rows =
        build_report_history_rows(&env.dbx, report_histories, false).await?;
    Ok(Json(rows))
}

#[post("/api/admin/report-history/list")]
pub async fn report_history_admin_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryAdminListReq>,
) -> Result<Json<ReportHistoryAdminListRsp>, AppError> {
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Admin")
        .await
        .c(h!())?;
    Ok(Json(list_admin_report_histories(&env.dbx, &req).await?))
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let report_history = find_report_for_user(&env.dbx, req.id, &user_login)
        .await?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_FAILED {
        return Err(AppError::BL {
            msg: "Only failed reports can be retried".to_string(),
        });
    }

    let mut report_history = report_history.into_active_model();
    report_history.status = Set(STATUS_PLANNED.to_string());
    report_history.retry_count = Set(0);
    report_history.planned_for_ts = Set(None);
    report_history.started_at = Set(None);
    report_history.completed_at = Set(None);
    report_history.bgtask_id = Set(None);
    report_history.last_error = Set(None);
    report_history.log = Set(append_log_entry(
        report_history.log.unwrap(),
        &user_login,
        "user requested another attempt for a failed task",
    ));
    let report_history = report_history.update(&env.dbx).await.c(h!())?;
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let report_history = find_report_for_user(&env.dbx, req.id, &user_login)
        .await?
        .ok_or(AppError::NotFound)?;
    if report_history.status != STATUS_PLANNED
        && report_history.status != STATUS_IN_PROGRESS
    {
        return Err(AppError::BL {
            msg: "Only queued or running reports can be cancelled".to_string(),
        });
    }

    let reason = "Скасовано користувачем".to_string();
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
            report_history::Column::PlannedForTs,
            Expr::value(None::<chrono::NaiveDateTime>),
        )
        .col_expr(
            report_history::Column::LastError,
            Expr::value(Some(reason.clone())),
        )
        .filter(report_history::Column::Id.eq(report_history.id))
        .filter(
            report_history::Column::Status
                .is_in([STATUS_PLANNED, STATUS_IN_PROGRESS]),
        )
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if res.rows_affected == 0 {
        return Err(AppError::BL {
            msg: "Report could not be cancelled because it already finished"
                .to_string(),
        });
    }

    if let Some(bgtask_id) = report_history.bgtask_id {
        let res: Result<(), AppError> = Err(AppError::BL { msg: reason });
        finish_bgtask(Some(bgtask_id), &env.dbx, &res).await?;
    }

    let updated = ReportHistory::find_by_id(report_history.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(Json(
        build_report_history_row(&env.dbx, updated, true).await?,
    ))
}

#[post("/api/report-history/download")]
pub async fn report_history_download(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<HttpResponse, AppError> {
    let user_login = user.id().c(h!())?;
    download_report_for_user_login(&env, &user_login, req.id).await
}

pub async fn download_report_for_user_login(
    env: &Env,
    user_login: &str,
    report_history_id: i64,
) -> Result<HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, user_login, "Rer")
        .await
        .c(h!())?;
    let report_history =
        find_report_for_user(&env.dbx, report_history_id, user_login)
            .await?
            .ok_or(AppError::NotFound)?;
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
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    find_report_for_user(&env.dbx, id, &user_login)
        .await?
        .ok_or(AppError::NotFound)
}

async fn find_report_for_user(
    dbx: &DatabaseConnection,
    id: i64,
    user_login: &str,
) -> Result<Option<report_history::Model>, AppError> {
    match crate::users::has_role(dbx, user_login, "Admin").await {
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
    user_login: &str,
) -> Result<Option<report_history::Model>, AppError> {
    Ok(ReportHistory::find_by_id(id)
        .filter(report_history::Column::RequestedBy.eq(user_login))
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
                least(retry_count + 1, $1) as attempt_count,
                retry_count + 1 >= $1 as attempts_exhausted
            from report_history
            where status = $5
        )
        update report_history
        set
            status = case
                when recovered_report.attempts_exhausted then $2
                else $3
            end,
            retry_count = recovered_report.attempt_count,
            planned_for_ts = case
                when recovered_report.attempts_exhausted then null
                else now() at time zone 'utc'
                    + recovered_report.attempt_count * interval '5 minutes'
            end,
            started_at = case
                when recovered_report.attempts_exhausted then report_history.started_at
                else null
            end,
            completed_at = case
                when recovered_report.attempts_exhausted then now() at time zone 'utc'
                else null
            end,
            bgtask_id = null,
            last_error = format(
                'Report generation was interrupted while in progress; recorded attempt %s/%s during bgworker startup recovery',
                recovered_report.attempt_count,
                $1
            ),
            log = coalesce(report_history.log, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'login',
                    $4,
                    'timestamp',
                    now() at time zone 'utc',
                    'message',
                    format(
                        'Report generation was interrupted while in progress; recorded attempt %s/%s during bgworker startup recovery',
                        recovered_report.attempt_count,
                        $1
                    )
                ))
        from recovered_report
        where report_history.id = recovered_report.id
        "#,
        [
            REPORT_HISTORY_MAX_ATTEMPTS.into(),
            STATUS_FAILED.into(),
            STATUS_PLANNED.into(),
            REPORT_CRASH_RECOVERY_LOGIN.into(),
            STATUS_IN_PROGRESS.into(),
        ],
    );
    env.dbx.execute(stmt).await.c(h!())?;
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
        match take_next_report(&env.dbx, &report_kind).await {
            Ok(Some(report_history)) => {
                if let Err(err) =
                    process_report(env.as_ref(), report_history).await
                {
                    error!("report history worker failed: {err:?}");
                }
            }
            Ok(None) => {
                tokio::time::sleep(std::time::Duration::from_secs(
                    WORKER_IDLE_SLEEP_SECS,
                ))
                .await;
            }
            Err(err) => {
                error!("failed to take next report history row: {err:?}");
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
        ("report_history_worker_posts_docx", "posts_docx"),
        ("report_history_worker_active_networks", "active_networks"),
        (
            "report_history_worker_network_frequencies",
            "network_frequencies",
        ),
        ("report_history_worker_report_1213", "report_1213"),
        ("report_history_worker_summary_table", KIND_SUMMARY_TABLE),
        ("report_history_worker_kmz", KIND_KMZ),
        ("report_history_worker_geojson", KIND_GEOJSON),
        ("report_history_worker_etalonka", KIND_ETALONKA),
        ("report_history_worker_goi", KIND_GOI),
    ]
    .into_iter()
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
                            and active_report.requested_by = report_history.requested_by
                      )
                      and not exists (
                          select 1
                          from report_history earlier_report
                          where earlier_report.status = 'planned'
                            and earlier_report.report_kind = report_history.report_kind
                            and earlier_report.requested_by = report_history.requested_by
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

async fn process_report(
    env: &Env,
    report_history: report_history::Model,
) -> Result<(), AppError> {
    let bgtask = create_running_bgtask(&env.dbx).await?;
    set_report_bgtask(env, report_history.id, bgtask.id).await?;
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

async fn set_report_bgtask(
    env: &Env,
    report_history_id: i64,
    bgtask_id: i64,
) -> Result<(), AppError> {
    ReportHistory::update_many()
        .col_expr(report_history::Column::BgtaskId, Expr::value(bgtask_id))
        .filter(report_history::Column::Id.eq(report_history_id))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(())
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
) -> Result<(), AppError> {
    set_bgtask_progress(dbx, bgtask_id, progress).await?;
    bgtask_log(Some(bgtask_id), logline, dbx).await.c(h!())?;
    Ok(())
}

pub(crate) async fn ensure_report_history_in_progress(
    dbx: &DatabaseConnection,
    report_history_id: i64,
) -> Result<(), AppError> {
    let Some(report_history) = ReportHistory::find_by_id(report_history_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Err(AppError::NotFound);
    };
    if report_history.status == STATUS_IN_PROGRESS {
        return Ok(());
    }
    Err(AppError::BL {
        msg: report_history
            .last_error
            .unwrap_or_else(|| "Скасовано користувачем".to_string()),
    })
}

async fn generate_and_store_report(
    env: &Env,
    report_history: &report_history::Model,
    bgtask_id: i64,
) -> Result<(), AppError> {
    bgtask_log_progress(bgtask_id, 10, "[1/3] Формування звіту", &env.dbx)
        .await?;
    let generated = generate_report(env, report_history, bgtask_id).await?;
    ensure_report_history_in_progress(&env.dbx, report_history.id).await?;
    bgtask_log_progress(bgtask_id, 85, "[2/3] Збереження звіту", &env.dbx)
        .await?;
    ensure_report_history_in_progress(&env.dbx, report_history.id).await?;
    let s3_id = upload_report_bytes(env, &generated).await?;
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
    .await?;
    Ok(())
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
            ensure_report_history_in_progress(&env.dbx, report_history.id)
                .await?;
            let generated =
                crate::rer_importer::reports::report_docx_generate_file(
                    report_history.requested_by.clone(),
                    env,
                    *payload,
                    false,
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
            ensure_report_history_in_progress(&env.dbx, report_history.id)
                .await?;
            let (file_name, content_type, bytes) = match report_history.report_kind.as_str() {
                KIND_SUMMARY_TABLE => (
                    report_history
                        .file_name
                        .clone()
                        .unwrap_or_else(|| "summary-table.xlsx".to_string()),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
                    crate::rer_importer::analysis::summary_table_xlsx_bytes(
                        &report_history.requested_by,
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
                        &report_history.requested_by,
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
                        &report_history.requested_by,
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
            ensure_report_history_in_progress(&env.dbx, report_history.id)
                .await?;
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_data(
                    &env.dbx,
                    &report_history.requested_by,
                    &payload,
                    trace_id,
                    Some(report_history.id),
                    Some(bgtask_id),
                )
                .await
                .c(h!())?;
            bgtask_log_progress(
                bgtask_id,
                70,
                "[3/4] Формування еталонного опису",
                &env.dbx,
            )
            .await?;
            let bytes =
                crate::sigint::etalonka::task::render_networks_docx_report_bytes(
                    &payload.etalonka_type,
                    etalonka_data,
                )
                .await
                .c(h!())?;
            bgtask_log_progress(
                bgtask_id,
                90,
                "[4/4] Збереження файлу",
                &env.dbx,
            )
            .await?;
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
            ensure_report_history_in_progress(&env.dbx, report_history.id)
                .await?;
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_batch_id_data(
                    &env.dbx,
                    &report_history.requested_by,
                    &payload,
                    trace_id,
                    Some(report_history.id),
                    Some(bgtask_id),
                )
                .await
                .c(h!())?;
            bgtask_log_progress(
                bgtask_id,
                70,
                "[3/4] Формування еталонного опису",
                &env.dbx,
            )
            .await?;
            let bytes =
                crate::sigint::etalonka::task::render_networks_docx_report_bytes(
                    &payload.etalonka_type,
                    etalonka_data,
                )
                .await
                .c(h!())?;
            bgtask_log_progress(
                bgtask_id,
                90,
                "[4/4] Збереження файлу",
                &env.dbx,
            )
            .await?;
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
            ensure_report_history_in_progress(&env.dbx, report_history.id)
                .await?;
            let organism_id = crate::sigint::network::goi::login_organism_id(
                &env.dbx,
                &report_history.requested_by,
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
        "Report generation timed out after {} seconds: id={}, kind={}, requested_by={}",
        timeout_secs,
        report_history.id,
        report_history.report_kind,
        report_history.requested_by,
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
    Ok(report_history::Model::find_by_statement(stmt)
        .one(&env.dbx)
        .await
        .c(h!())?)
}

async fn notify_report_timeout_nofail(
    env: &Env,
    report_history: &report_history::Model,
    err_msg: &str,
) {
    let content = format!(
        "Report timed out at echo server {}: id={}, kind={}, requested_by={}\n{}",
        env.config.public_host,
        report_history.id,
        report_history.report_kind,
        report_history.requested_by,
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
        (report_history.retry_count + 1).min(REPORT_HISTORY_MAX_ATTEMPTS);
    let mut report_history = report_history.into_active_model();
    report_history.log = Set(append_log_entry(
        report_history.log.unwrap(),
        "system",
        &err_msg,
    ));
    if attempt_count < REPORT_HISTORY_MAX_ATTEMPTS {
        report_history.status = Set(STATUS_PLANNED.to_string());
        report_history.retry_count = Set(attempt_count);
        report_history.planned_for_ts = Set(Some(
            Utc::now().naive_utc()
                + Duration::minutes(5 * i64::from(attempt_count)),
        ));
        report_history.started_at = Set(None);
        report_history.completed_at = Set(None);
        report_history.bgtask_id = Set(None);
        report_history.last_error = Set(Some(err_msg));
    } else {
        report_history.status = Set(STATUS_FAILED.to_string());
        report_history.retry_count = Set(attempt_count);
        report_history.planned_for_ts = Set(None);
        report_history.completed_at = Set(Some(Utc::now().naive_utc()));
        report_history.last_error = Set(Some(err_msg));
    }
    report_history.update(&env.dbx).await.c(h!())?;
    Ok(())
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
    use crate::entities::login;
    use crate::functest::tests::{cleanup, mk_login};
    use chrono::Timelike;
    use sea_orm::ActiveValue::{NotSet, Set};
    use sea_orm::EntityTrait;
    use serde_json::json;
    use serial_test::serial;

    async fn insert_report_history(
        dbx: &DatabaseConnection,
        requested_by: &str,
        report_kind: &str,
        status: &str,
        created_at: chrono::NaiveDateTime,
        started_at: Option<chrono::NaiveDateTime>,
        planned_for_ts: Option<chrono::NaiveDateTime>,
    ) -> Result<report_history::Model, AppError> {
        Ok(report_history::ActiveModel {
            id: NotSet,
            report_kind: Set(report_kind.to_string()),
            requested_by: Set(requested_by.to_string()),
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
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
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
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
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
                login: Set("report-history-alice".to_string()),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let _bob = mk_login(
            &env.dbx,
            login::ActiveModel {
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
        let _login = mk_login(
            &env.dbx,
            login::ActiveModel {
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
                .filter(
                    report_history::Column::RequestedBy
                        .eq("report-history-cancel"),
                )
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
            .filter(
                report_history::Column::RequestedBy.eq("report-history-cancel"),
            )
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
}
