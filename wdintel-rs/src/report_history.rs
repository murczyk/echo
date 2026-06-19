use crate::config::REPORT_HISTORY_LIST_LIMIT;
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::{bgtask, prelude::*, report_history};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::ReportPreviewReq;
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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, FromQueryResult, IntoActiveModel, NotSet, QueryFilter,
    QueryOrder, QuerySelect, Set, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
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

const MAX_RETRY_COUNT: i32 = 0;
const WORKER_IDLE_SLEEP_SECS: u64 = 5;
const REPORT_OBJECT_PREFIX: &str = "reports";

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
    pub status: String,
    pub completed_at: Option<String>,
    pub has_file: bool,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub bgtask_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ReportHistoryIdReq {
    pub id: i64,
}

#[derive(Debug, Clone)]
struct GeneratedReport {
    file_name: String,
    content_type: String,
    bytes: Vec<u8>,
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

impl From<report_history::Model> for ReportHistoryRow {
    fn from(report_history: report_history::Model) -> Self {
        Self {
            id: report_history.id,
            report_kind: report_history.report_kind,
            requested_by: report_history.requested_by,
            created_at: report_history.created_at.to_string(),
            status: report_history.status,
            completed_at: report_history
                .completed_at
                .map(|completed_at| completed_at.to_string()),
            has_file: report_history.s3_id.is_some(),
            file_name: report_history.file_name,
            content_type: report_history.content_type,
            bgtask_id: report_history.bgtask_id,
        }
    }
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
    let report_history = insert_completed_report_row(
        env,
        requested_by,
        report_kind,
        request,
        file_name.clone(),
        content_type.clone(),
        None,
        None,
        json!([]),
        Some(file_path.to_string_lossy().to_string()),
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
    let Some(report_history) = ReportHistory::find_by_id(report_history_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        warn!(
            "completed report history row not found for archive update: {report_history_id}"
        );
        return Ok(());
    };
    let mut report_history = report_history.into_active_model();
    report_history.s3_id = Set(Some(s3_id));
    report_history.last_error = Set(None);
    report_history.update(&env.dbx).await.c(h!())?;
    Ok(())
}

async fn set_completed_report_archive_error(
    env: &Env,
    report_history_id: i64,
    err_msg: String,
) -> Result<(), AppError> {
    let Some(report_history) = ReportHistory::find_by_id(report_history_id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        warn!(
            "completed report history row not found for archive error update: {report_history_id}"
        );
        return Ok(());
    };
    let mut report_history = report_history.into_active_model();
    report_history.last_error = Set(Some(err_msg.clone()));
    report_history.log = Set(append_log_entry(
        report_history.log.unwrap(),
        "system",
        &err_msg,
    ));
    report_history.update(&env.dbx).await.c(h!())?;
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
    let rows = ReportHistory::find()
        .filter(report_history::Column::RequestedBy.eq(user_login))
        .order_by_desc(report_history::Column::CreatedAt)
        .limit(REPORT_HISTORY_LIST_LIMIT)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(ReportHistoryRow::from)
        .collect();
    Ok(Json(rows))
}

#[post("/api/admin/report-history/list")]
pub async fn report_history_admin_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<ReportHistoryRow>>, AppError> {
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Admin")
        .await
        .c(h!())?;
    let rows = ReportHistory::find()
        .order_by_desc(report_history::Column::CreatedAt)
        .limit(REPORT_HISTORY_LIST_LIMIT)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(ReportHistoryRow::from)
        .collect();
    Ok(Json(rows))
}

#[post("/api/report-history/status")]
pub async fn report_history_status(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<Json<ReportHistoryRow>, AppError> {
    let report_history = find_current_user_report(&env, &user, req.id).await?;
    Ok(Json(report_history.into()))
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
    Ok(Json(report_history.into()))
}

#[post("/api/report-history/download")]
pub async fn report_history_download(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportHistoryIdReq>,
) -> Result<HttpResponse, AppError> {
    let report_history = find_current_user_report(&env, &user, req.id).await?;
    if report_history.status != STATUS_DONE {
        return Err(AppError::BL {
            msg: "Report is not ready".to_string(),
        });
    }
    let s3_id = report_history.s3_id.clone().ok_or(AppError::NotFound)?;
    let bytes = download_report_bytes(&env, &s3_id).await?;
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
    let res = ReportHistory::update_many()
        .col_expr(
            report_history::Column::Status,
            Expr::value(STATUS_PLANNED.to_string()),
        )
        .col_expr(report_history::Column::BgtaskId, Expr::value(None::<i64>))
        .filter(report_history::Column::Status.eq(STATUS_IN_PROGRESS))
        .exec(&env.dbx)
        .await;
    if let Err(err) = res {
        error!("failed to reset in-progress report history rows: {err:?}");
    }
}

pub fn spawn_report_history_workers(
    bg_set: &mut JoinSet<()>,
    env: std::sync::Arc<Env>,
) {
    for (worker_name, report_kind) in worker_report_kinds() {
        let env = env.clone();
        let report_kind = report_kind.to_string();
        crate::utils::worker_watch::spawn_named_worker(
            worker_name,
            bg_set,
            async move {
                run_report_history_worker_nofail(env, report_kind).await;
            },
        );
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
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with next_report as (
            select id
            from report_history
            where status = 'planned'
              and report_kind = $1
              and (planned_for_ts is null or planned_for_ts <= now() at time zone 'utc')
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
        [report_kind.into()],
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
    let res = generate_and_store_report(env, &report_history, bgtask.id).await;
    let _ = finish_bgtask(Some(bgtask.id), &env.dbx, &res).await;
    match res {
        Ok(()) => Ok(()),
        Err(err) => {
            handle_report_failure(env, report_history.id, err).await?;
            Ok(())
        }
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

async fn generate_and_store_report(
    env: &Env,
    report_history: &report_history::Model,
    bgtask_id: i64,
) -> Result<(), AppError> {
    bgtask_log(Some(bgtask_id), "[1/3] Формування звіту", &env.dbx)
        .await
        .c(h!())?;
    let generated = generate_report(env, report_history, bgtask_id).await?;
    bgtask_log(Some(bgtask_id), "[2/3] Збереження звіту", &env.dbx)
        .await
        .c(h!())?;
    let s3_id = upload_report_bytes(env, &generated).await?;
    let mut report_history = report_history.clone().into_active_model();
    report_history.status = Set(STATUS_DONE.to_string());
    report_history.completed_at = Set(Some(Utc::now().naive_utc()));
    report_history.s3_id = Set(Some(s3_id));
    report_history.file_name = Set(Some(generated.file_name));
    report_history.content_type = Set(Some(generated.content_type));
    report_history.last_error = Set(None);
    report_history.update(&env.dbx).await.c(h!())?;
    bgtask_log(Some(bgtask_id), "[3/3] Готово до завантаження", &env.dbx)
        .await
        .c(h!())?;
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
            bgtask_log(Some(bgtask_id), "[1/5] Пошук мереж", &env.dbx)
                .await
                .c(h!())?;
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_data(
                    &env.dbx,
                    &report_history.requested_by,
                    &payload,
                    trace_id,
                )
                .await
                .c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                "[2/5] Формування еталонного опису",
                &env.dbx,
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
            bgtask_log(Some(bgtask_id), "[1/5] Пошук мереж", &env.dbx)
                .await
                .c(h!())?;
            let trace_id = Uuid::new_v4();
            let etalonka_data =
                crate::sigint::etalonka::bl_etalonka_report_networks_batch_id_data(
                    &env.dbx,
                    &report_history.requested_by,
                    &payload,
                    trace_id,
                )
                .await
                .c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                "[2/5] Формування еталонного опису",
                &env.dbx,
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
            let bytes =
                crate::sigint::network::goi::report_xlsx_networks_goi_to_buffer(
                    env,
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
    let err_msg = format!("{err:#?}");
    let retry_count = report_history.retry_count;
    let mut report_history = report_history.into_active_model();
    report_history.log = Set(append_log_entry(
        report_history.log.unwrap(),
        "system",
        &err_msg,
    ));
    if retry_count < MAX_RETRY_COUNT {
        let next_retry_count = retry_count + 1;
        report_history.status = Set(STATUS_PLANNED.to_string());
        report_history.retry_count = Set(next_retry_count);
        report_history.planned_for_ts = Set(Some(
            Utc::now().naive_utc()
                + Duration::minutes(5 * i64::from(next_retry_count)),
        ));
        report_history.started_at = Set(None);
        report_history.bgtask_id = Set(None);
        report_history.last_error = Set(Some(err_msg));
    } else {
        report_history.status = Set(STATUS_FAILED.to_string());
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
