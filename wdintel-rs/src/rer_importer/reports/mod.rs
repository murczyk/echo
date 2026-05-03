use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;

use crate::config::CLEANUP_REPORT_DAYS;
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_identity::Identity;
use actix_web::http::header;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use chrono::{Days, NaiveDateTime, Utc};
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use sea_orm::*;

mod active_networks;
pub mod babak;
mod digest;
pub mod interception;
pub mod mouse;
mod naushnom;
mod network_frequencies;
mod posts;
mod report_1213;
mod report_xlsx_kind_pelengs;
mod revo;
mod senders;
pub mod tag;
pub mod types;
mod util;

pub(crate) async fn cleanup_old_reports_nofail(
    dbx: &DatabaseConnection,
    config: &crate::Config,
) {
    if let Some(cleanup_until) = Utc::now()
        .naive_utc()
        .checked_sub_days(Days::new(CLEANUP_REPORT_DAYS))
    {
        match log_users_report_generation::Entity::find()
            .filter(
                log_users_report_generation::Column::CreatedAt
                    .lte(cleanup_until),
            )
            .filter(
                log_users_report_generation::Column::DeprecatedAt
                    .eq(None::<NaiveDateTime>),
            )
            .all(dbx)
            .await
        {
            Ok(logs) => {
                for one_log in logs {
                    let Ok(filepath) = PathBuf::from_str(&one_log.report_path);
                    let Ok(storage_path) =
                        PathBuf::from_str(&config.storage_dir);
                    if let Err(e) =
                        std::fs::remove_file(storage_path.join(&filepath))
                    {
                        warn!(
                            "Unable to delete file {filepath:?}: error {e:?}"
                        );
                    }
                    let mut log_active_model = one_log.into_active_model();
                    log_active_model.deprecated_at =
                        Set(Some(Utc::now().naive_utc()));
                    if let Err(e) = log_active_model.update(dbx).await {
                        warn!("Unable to update DB row, error {e:?}");
                    }
                }
            }
            Err(e) => {
                warn!("DB error in job that cleans up old reports: {e:?}")
            }
        }
    } else {
        warn!("Unable to get datetime in job that cleans up old reports");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReportTaskResultMeta {
    filename: String,
    content_type: String,
    user_login: String,
}

#[derive(Debug, Clone)]
struct ReportTaskGenerated {
    outpath: PathBuf,
    filename: String,
    content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportTaskDownloadReq {
    pub bgtask_id: i64,
}

fn report_file_extension(req: &types::ReportPreviewReq) -> &'static str {
    match req.kind.as_str() {
        "interception" | "pelengs" | "senders" | "posts" => "xlsx",
        "reo" => match req.report_type {
            Some(types::ReportType::Reo(_, types::ReoReportFileType::Xlsx)) => {
                "xlsx"
            }
            _ => "docx",
        },
        _ => "docx",
    }
}

fn report_content_type(file_extension: &str) -> &'static str {
    if file_extension == "xlsx" {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    } else {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }
}

async fn report_docx_generate_for_task(
    user_login: String,
    env: &Env,
    mut req: types::ReportPreviewReq,
) -> Result<ReportTaskGenerated, AppError> {
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    req.req.nolimit = Some(true);

    let storage_dir =
        std::path::PathBuf::from_str(&env.config.storage_dir).context(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);
    let file_extension = report_file_extension(&req);
    let content_type = report_content_type(file_extension).to_string();
    let filename = format!(
        "report_{}.{}",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f"),
        file_extension
    );
    let outpath = outfolder.join(&filename);
    if req.kind == "tags" {
        self::tag::report_docx_kind_tag(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "interception" {
        self::interception::report_xlsx_kind_interception(
            &user_login,
            env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "babak" {
        self::babak::report_docx_kind_babak(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "mouse" {
        self::mouse::report_docx_kind_mouse(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "pelengs" {
        self::report_xlsx_kind_pelengs::report_xlsx_kind_pelengs1(
            &user_login,
            env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "senders" || req.kind == "posts" {
        let (aggregation, advanced_freqs) = match &req.report_type {
            Some(types::ReportType::Senders(settings)) => {
                (settings.aggregation.clone(), settings.advanced_freqs)
            }
            _ => (
                if req.kind == "posts" {
                    types::ReportAggregation::ByPost
                } else {
                    types::ReportAggregation::ByProfile
                },
                false,
            ),
        };
        self::senders::report_xlsx_kind_senders(
            aggregation,
            advanced_freqs,
            &user_login,
            env,
            &req.req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "naushnom" {
        self::naushnom::report_docx_kind_naushnom(
            &user_login,
            env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "reo" {
        crate::users::has_any_role(
            &env.dbx,
            &user_login,
            vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
        )
        .await
        .c(h!())?;
        self::revo::report_docx_kind_revo(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "digest" {
        crate::users::has_any_role(
            &env.dbx,
            &user_login,
            vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
        )
        .await
        .c(h!())?;
        self::digest::report_docx_kind_digest(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "posts_docx" {
        self::posts::report_docx_kind_posts(&user_login, env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "active_networks" {
        crate::users::has_any_role(
            &env.dbx,
            &user_login,
            vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
        )
        .await
        .c(h!())?;
        self::active_networks::report_docx_kind_active_networks(
            env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "network_frequencies" {
        crate::users::has_any_role(
            &env.dbx,
            &user_login,
            vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
        )
        .await
        .c(h!())?;
        self::network_frequencies::report_docx_kind_network_frequencies(
            env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "report_1213" {
        crate::users::has_any_role(
            &env.dbx,
            &user_login,
            vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
        )
        .await
        .c(h!())?;
        self::report_1213::report_docx_kind_report_1213(
            &user_login,
            env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else {
        return Err(format!("Unknown report kind {}", req.kind).into());
    }

    let request_json = serde_json::to_string(&req).context(h!())?;
    save_report_log(
        &env.dbx,
        format!("reports_log/{filename}"),
        &request_json,
        &user_login,
    )
    .await
    .context(h!())?;

    Ok(ReportTaskGenerated {
        outpath,
        filename,
        content_type,
    })
}

#[post("/api/rer/report-docx-task-launch")]
pub async fn report_docx_task_launch(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<types::ReportPreviewReq>,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    let user_login = user.id().c(h!())?;
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
    let env_inner = env.get_ref().clone();
    let req_inner = req.into_inner();
    let task_owner_login = user_login.clone();
    actix_web::rt::spawn(async move {
        let dbx = env_inner.dbx.clone();
        let res = async {
            bgtask_log(Some(bgtask_id), "[1/4] Старт формування звіту", &dbx)
                .await
                .c(h!())?;
            let generated = report_docx_generate_for_task(
                user_login.clone(),
                &env_inner,
                req_inner,
            )
            .await
            .c(h!())?;
            bgtask_log(Some(bgtask_id), "[2/4] Звіт сформовано", &dbx)
                .await
                .c(h!())?;
            let bytes = std::fs::read(&generated.outpath).c(h!())?;
            bgtask_log(
                Some(bgtask_id),
                "[3/4] Збереження результату задачі",
                &dbx,
            )
            .await
            .c(h!())?;
            let result_meta = ReportTaskResultMeta {
                filename: generated.filename,
                content_type: generated.content_type,
                user_login: task_owner_login.clone(),
            };
            bgtask_res::ActiveModel {
                id: Set(bgtask_id),
                res_json: Set(Some(serde_json::to_value(result_meta).c(h!())?)),
                res_bytes: Set(Some(bytes)),
                res_s3_id: Set(None),
            }
            .insert(&dbx)
            .await
            .c(h!())?;
            bgtask_log(Some(bgtask_id), "[4/4] Готово до завантаження", &dbx)
                .await
                .c(h!())?;
            Ok::<(), AppError>(())
        }
        .await;
        let _ = finish_bgtask(Some(bgtask_id), &dbx, &res).await;
    });
    Ok(Json(bgtask_id))
}

#[post("/api/rer/report-docx-task-download")]
pub async fn report_docx_task_download(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReportTaskDownloadReq>,
) -> Result<HttpResponse, AppError> {
    let user_login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .c(h!())?;
    let bgtask_res = bgtask_res::Entity::find_by_id(req.bgtask_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(format!("Result not found for task id: {}", req.bgtask_id))?;
    let result_meta_value = bgtask_res.res_json.clone().ok_or(format!(
        "res_json must be non empty for task id: {}",
        req.bgtask_id
    ))?;
    let result_meta: ReportTaskResultMeta =
        serde_json::from_value(result_meta_value).c(h!())?;
    if result_meta.user_login != user_login {
        return Err(AppError::Forbidden(
            "Task result belongs to another user".to_string(),
        ));
    }
    let data = bgtask_res.res_bytes.clone().ok_or(format!(
        "res_bytes must be non empty for task id: {}",
        req.bgtask_id
    ))?;
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: result_meta.filename.clone().into_bytes(),
            },
        )],
    };
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, result_meta.content_type))
        .insert_header(content_disposition)
        .body(data))
}

pub(crate) async fn save_report_log(
    dbx: &DatabaseConnection,
    filepath_relative_to_storage: String,
    report_query: &str,
    login: &str,
) -> Result<(), AppError> {
    let log_active_model = log_users_report_generation::ActiveModel {
        id: NotSet,
        login: Set(login.to_string()),
        report_query: Set(report_query.to_string()),
        report_path: Set(filepath_relative_to_storage),
        created_at: Set(Utc::now().naive_utc()),
        deprecated_at: Set(None),
    };
    log_active_model.insert(dbx).await.context(h!())?;
    Ok(())
}

async fn ensure_editor_report_permissions(
    env: &Env,
    user_login: &str,
) -> Result<Option<HttpResponse>, AppError> {
    match crate::users::has_any_role(
        &env.dbx,
        user_login,
        vec!["UnitsEditor", "CallsignsEditor", "AdvancedReports", "Admin"],
    )
    .await
    {
        Ok(()) => Ok(None),
        Err(AppError::Forbidden(_)) => Ok(Some(
            HttpResponse::Forbidden()
                .insert_header((
                    crate::config::RER_REPORT_ERROR_CODE_HEADER_NAME,
                    crate::config::RER_REPORT_PERMISSION_DENIED_ERROR_CODE,
                ))
                .body("Forbidden"),
        )),
        Err(err) => Err(err),
    }
}

/// Generates report in docx format using docx-rs library looking similar to html produced by the report_generate_html function
#[post("/api/rer/report-docx")]
pub async fn report_docx(
    user: Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<types::ReportPreviewReq>,
) -> Result<HttpResponse, AppError> {
    info!("> Start RER report generation...");

    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;
    let mut req = req.into_inner().clone();
    req.req.nolimit = Some(true);

    let storage_dir =
        std::path::PathBuf::from_str(&env.config.storage_dir).context(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);
    let file_extension = match req.kind.as_str() {
        "interception" | "pelengs" | "senders" | "posts" => "xlsx",
        "reo" => match req.report_type {
            Some(types::ReportType::Reo(_, types::ReoReportFileType::Xlsx)) => {
                "xlsx"
            }
            _ => "docx",
        },
        _ => "docx",
    };
    let filename = format!(
        "report_{}.{}",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f"),
        file_extension
    );
    let outpath = outfolder.join(&filename);
    let user_login = user.id().context(h!())?;
    if req.kind == "tags" {
        self::tag::report_docx_kind_tag(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "interception" {
        self::interception::report_xlsx_kind_interception(
            &user_login,
            &env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "babak" {
        self::babak::report_docx_kind_babak(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "mouse" {
        self::mouse::report_docx_kind_mouse(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "pelengs" {
        self::report_xlsx_kind_pelengs::report_xlsx_kind_pelengs1(
            &user_login,
            &env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "senders" || req.kind == "posts" {
        let (aggregation, advanced_freqs) = match &req.report_type {
            Some(types::ReportType::Senders(settings)) => {
                (settings.aggregation.clone(), settings.advanced_freqs)
            }
            _ => (
                if req.kind == "posts" {
                    types::ReportAggregation::ByPost
                } else {
                    types::ReportAggregation::ByProfile
                },
                false,
            ),
        };
        self::senders::report_xlsx_kind_senders(
            aggregation,
            advanced_freqs,
            &user_login,
            &env,
            &req.req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "naushnom" {
        self::naushnom::report_docx_kind_naushnom(
            &user_login,
            &env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "reo" {
        if let Some(resp) =
            ensure_editor_report_permissions(&env, &user_login).await?
        {
            return Ok(resp);
        }
        self::revo::report_docx_kind_revo(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "digest" {
        if let Some(resp) =
            ensure_editor_report_permissions(&env, &user_login).await?
        {
            return Ok(resp);
        }
        self::digest::report_docx_kind_digest(
            &user_login,
            &env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "posts_docx" {
        self::posts::report_docx_kind_posts(&user_login, &env, &req, &outpath)
            .await
            .c(h!())?;
    } else if req.kind == "active_networks" {
        if let Some(resp) =
            ensure_editor_report_permissions(&env, &user_login).await?
        {
            return Ok(resp);
        }
        self::active_networks::report_docx_kind_active_networks(
            &env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "network_frequencies" {
        if let Some(resp) =
            ensure_editor_report_permissions(&env, &user_login).await?
        {
            return Ok(resp);
        }
        self::network_frequencies::report_docx_kind_network_frequencies(
            &env, &req, &outpath,
        )
        .await
        .c(h!())?;
    } else if req.kind == "report_1213" {
        if let Some(resp) =
            ensure_editor_report_permissions(&env, &user_login).await?
        {
            return Ok(resp);
        }
        self::report_1213::report_docx_kind_report_1213(
            &user_login,
            &env,
            &req,
            &outpath,
        )
        .await
        .c(h!())?;
    } else {
        return Err(format!("Unknown report kind {}", req.kind).into());
    }
    let file = actix_files::NamedFile::open(&outpath)?;
    save_report_log(
        &env.dbx,
        format!("reports_log/{filename}"),
        &serde_json::to_string(&req).context(h!())?,
        &user_login,
    )
    .await
    .context(h!())?;
    Ok(file.into_response(&http_req))
}

/// Fills the comp_freq table with data about when the frequency was first seen.
pub async fn oneoff_fill_comp_freq(
    mode: Mode,
    ps: &crate::OneoffFillCompFreqPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_fill_comp_freq");
    let start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    fill_comp_freq(&dbx, start_dt, end_dt).await.c(h!())?;
    Ok(())
}

async fn fill_comp_freq(
    dbx: &DatabaseConnection,
    start: NaiveDateTime,
    end: NaiveDateTime,
) -> Result<(), AppError> {
    // iterate over all messages in a streaming fashion
    let filter = Condition::all()
        .add(signal_message::Column::Deleted.eq(false))
        .add(sigint_inbox_item::Column::Datetime.gte(start))
        .add(sigint_inbox_item::Column::Datetime.lt(end));

    let count = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(filter.clone())
        .clone()
        .count(dbx)
        .await
        .c(h!())?;
    let pb = ProgressBar::new(count);

    let mut stream = signal_message::Entity::find()
        .find_with_related(datasource_group::Entity)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(filter)
        .order_by_asc(signal_message::Column::Id)
        .stream(dbx)
        .await
        .c(h!())?;
    let datasource_zones = crate::sigint::zone::get_datasources_zones(dbx)
        .await
        .c(h!())?;
    let mut per_freq_seen: BTreeMap<(i64, String), NaiveDateTime> =
        BTreeMap::new();
    let mut per_freq_callsign_seen: BTreeMap<
        (i64, String, String),
        NaiveDateTime,
    > = BTreeMap::new();
    while let Some((message, group)) = stream
        .try_next()
        .await
        .c(h!())?
        .and_then(|(m, m_g)| m_g.map(|g| (m, g)))
    {
        pb.inc(1);
        let Some(inbox) = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(freq) = inbox.freq else {
            continue;
        };
        let Some(timestamp) = message.timestamp else {
            continue;
        };
        for zone_id in datasource_zones
            .get(&group.datasource_id)
            .into_iter()
            .flatten()
        {
            let key = (*zone_id, freq.clone());
            match per_freq_seen.get(&key) {
                Some(first_seen) => {
                    if timestamp < *first_seen {
                        per_freq_seen.insert(key.clone(), timestamp);
                    }
                }
                None => {
                    per_freq_seen.insert(key.clone(), timestamp);
                }
            }
            for callsign in serde_json::from_value::<Vec<String>>(
                inbox.callsigns.clone().unwrap_or(serde_json::Value::Null),
            )
            .context(h!())?
            {
                let key = (*zone_id, freq.clone(), callsign.clone());
                match per_freq_callsign_seen.get(&key) {
                    Some(first_seen) => {
                        if timestamp < *first_seen {
                            per_freq_callsign_seen
                                .insert(key.clone(), timestamp);
                        }
                    }
                    None => {
                        per_freq_callsign_seen.insert(key.clone(), timestamp);
                    }
                }
            }
        }
    }
    pb.finish();
    let pb = ProgressBar::new(per_freq_seen.len() as u64);
    for ((zone_id, freq), first_seen) in per_freq_seen {
        pb.inc(1);
        let do_insert = async || {
            comp_freq::ActiveModel {
                id: NotSet,
                zone_id: Set(zone_id),
                freq: Set(freq.clone()),
                first_seen: Set(Some(first_seen)),
                updated_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            Ok::<(), AppError>(())
        };
        let existing = comp_freq::Entity::find()
            .filter(comp_freq::Column::ZoneId.eq(zone_id))
            .filter(comp_freq::Column::Freq.eq(freq.clone()))
            .one(dbx)
            .await
            .c(h!())?;
        match existing {
            None => do_insert().await.c(h!())?,
            Some(existing) => match existing.first_seen {
                None => do_insert().await.c(h!())?,
                Some(existing_first_seen) => {
                    if existing_first_seen > first_seen {
                        let mut existing: comp_freq::ActiveModel =
                            existing.into();
                        existing.first_seen = Set(Some(first_seen));
                        existing.update(dbx).await.c(h!())?;
                    }
                }
            },
        }
    }
    pb.finish();
    let pb = ProgressBar::new(per_freq_callsign_seen.len() as u64);
    for ((zone_id, freq, callsign), first_seen) in per_freq_callsign_seen {
        pb.inc(1);
        let do_insert = async || {
            comp_freq_callsign::ActiveModel {
                id: NotSet,
                zone_id: Set(zone_id),
                freq: Set(freq.clone()),
                callsign: Set(callsign.clone().to_lowercase()),
                first_seen: Set(Some(first_seen)),
                updated_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
            Ok::<(), AppError>(())
        };
        let existing = comp_freq_callsign::Entity::find()
            .filter(comp_freq_callsign::Column::ZoneId.eq(zone_id))
            .filter(comp_freq_callsign::Column::Freq.eq(freq.clone()))
            .filter(comp_freq_callsign::Column::Callsign.eq(callsign.clone()))
            .one(dbx)
            .await
            .c(h!())?;
        match existing {
            None => do_insert().await.c(h!())?,
            Some(existing) => match existing.first_seen {
                None => do_insert().await.c(h!())?,
                Some(existing_first_seen) => {
                    if existing_first_seen > first_seen {
                        let mut existing: comp_freq_callsign::ActiveModel =
                            existing.into();
                        existing.first_seen = Set(Some(first_seen));
                        existing.update(dbx).await.c(h!())?;
                    }
                }
            },
        }
    }
    pb.finish();
    Ok(())
}

/// Never-failing task that fills the comp_freq table every minute with fresh data.
pub async fn fill_comp_freq_worker(dbx: &DatabaseConnection) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("fill_comp_freq_worker");
        match fill_comp_freq_worker_1(dbx).await {
            Ok(_) => {}
            Err(e) => {
                println!("fill_comp_freq_worker error: {e:#?}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(10 * 60)).await;
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FillCompFreqWorkerState {
    pub processed_until: NaiveDateTime,
}

pub async fn fill_comp_freq_worker_1(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let mut state: FillCompFreqWorkerState =
        crate::kv::get_kv(dbx, "fill_comp_freq_worker_state")
            .await
            .c(h!())?
            .unwrap_or(FillCompFreqWorkerState {
                processed_until: Utc::now().naive_utc()
                    - chrono::Duration::hours(24),
            });
    let start = state.processed_until;
    let end = Utc::now().naive_utc();
    fill_comp_freq(dbx, start, end).await.c(h!())?;
    state.processed_until = end;
    crate::kv::put_kv(dbx, "fill_comp_freq_worker_state", state)
        .await
        .c(h!())?;
    Ok(())
}
