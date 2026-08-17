pub mod export;
pub mod package;
pub mod types;
pub mod worker;

use crate::config::{
    OCR_ADMIN_DEFAULT_LIMIT, OCR_ADMIN_MAX_LIMIT, OCR_DISCOVERY_DAYS,
    OCR_MAX_IN_FLIGHT_JOBS, OCR_SETTINGS_ID, OCR_TOKEN_ENV,
};
use crate::entities::{
    media_summary as media_summary_entity, ocr_job, ocr_settings,
    signal_message, signal_message_media,
};
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::ocr::package::sanitize_html;
use crate::ocr::types::{
    OcrCounts, OcrJobItem, OcrMediaSummary, OcrPageReq, OcrPageRsp,
    OcrSettingsItem, OcrStatusLogItem, SaveOcrSettingsReq,
};
use crate::storage;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_admin, ensure_rer_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{
    get, http::header, post, web::Json, HttpRequest, HttpResponse,
};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseBackend, DatabaseConnection, EntityTrait, FromQueryResult,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
    Statement, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct OcrRuntimeConfig {
    pub base_url: String,
    pub instance_id: String,
    pub token: String,
    pub max_in_flight_jobs: usize,
}

pub(crate) fn runtime_config(env: &Env) -> anyhow::Result<OcrRuntimeConfig> {
    let config = env.config.ocr.as_ref().c(h!())?;
    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    let base = url::Url::parse(&base_url).c(h!())?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || base.username() != ""
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        anyhow::bail!("OCR base URL is invalid");
    }
    let instance_id = config.instance_id.trim().to_string();
    if instance_id.is_empty()
        || instance_id.len() > 128
        || !instance_id.bytes().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.')
        })
    {
        anyhow::bail!("OCR instance ID is invalid");
    }
    if !(1..=OCR_MAX_IN_FLIGHT_JOBS).contains(&config.max_in_flight_jobs) {
        anyhow::bail!("OCR max in-flight jobs must be between 1 and {OCR_MAX_IN_FLIGHT_JOBS}");
    }
    let token = std::env::var(OCR_TOKEN_ENV).c(h!())?;
    let token = token.trim().to_string();
    if token.len() < 32 {
        anyhow::bail!("OCR bearer token is missing or too short");
    }
    let _s3 = env.s3.as_ref().c(h!())?;
    let s3_config = env.s3_config.as_ref().c(h!())?;
    let app_s3_config = env.config.s3_config.as_ref().c(h!())?;
    if !s3_config.is_configured()
        || app_s3_config.strongbox_key.trim().is_empty()
    {
        anyhow::bail!("encrypted B2/S3 storage is not configured for OCR");
    }
    Ok(OcrRuntimeConfig {
        base_url,
        instance_id,
        token,
        max_in_flight_jobs: config.max_in_flight_jobs,
    })
}

pub fn ocr_result_key(instance_id: &str, media_id: Uuid) -> String {
    let instance_hash = sha256::digest(instance_id.as_bytes());
    let media_prefix = media_id.to_string().chars().take(5).collect::<String>();
    format!(
        "ocr/{}/{media_prefix}/{media_id}.html",
        &instance_hash[..16]
    )
}

pub async fn load_result_keys<C>(
    dbx: &C,
    media_ids: &[Uuid],
) -> anyhow::Result<Vec<String>>
where
    C: ConnectionTrait,
{
    if media_ids.is_empty() {
        return Ok(vec![]);
    }
    Ok(ocr_job::Entity::find()
        .filter(ocr_job::Column::MediaId.is_in(media_ids.iter().copied()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|job| job.html_s3_key)
        .collect())
}

pub async fn load_media_summaries(
    dbx: &DatabaseConnection,
    media: &[signal_message_media::Model],
) -> anyhow::Result<HashMap<Uuid, OcrMediaSummary>> {
    if media.is_empty() {
        return Ok(HashMap::new());
    }
    let media_ids = media.iter().map(|media| media.id).collect::<Vec<_>>();
    let jobs = ocr_job::Entity::find()
        .filter(ocr_job::Column::MediaId.is_in(media_ids))
        .all(dbx)
        .await
        .c(h!())?;
    let worker_enabled = worker::worker_enabled(dbx).await.c(h!())?;
    let cutoff = discovery_cutoff();
    let discovered_media_ids =
        jobs.iter().map(|job| job.media_id).collect::<HashSet<_>>();
    let has_undiscovered = worker_enabled
        && media.iter().any(|media| {
            !discovered_media_ids.contains(&media.id)
                && media_is_pending_candidate(media, cutoff)
        });
    let has_active_job = jobs.iter().any(|job| job_is_pending(&job.state));
    let queue_positions = if has_undiscovered || has_active_job {
        load_queue_positions(dbx).await.c(h!())?
    } else {
        HashMap::new()
    };
    let mut summaries = jobs
        .into_iter()
        .map(|job| {
            let queue_ahead = queue_positions.get(&job.media_id).copied();
            (job.media_id, media_summary(job, queue_ahead))
        })
        .collect::<HashMap<_, _>>();
    if worker_enabled {
        for media in media {
            if media_is_pending_candidate(media, cutoff) {
                summaries.entry(media.id).or_insert_with(|| {
                    pending_media_summary(
                        queue_positions.get(&media.id).copied(),
                        media.created_at,
                    )
                });
            }
        }
    }
    Ok(summaries)
}

#[post("/api/admin/ocr/page")]
pub async fn get_ocr_page(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<OcrPageReq>,
) -> Result<Json<OcrPageRsp>, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let limit = req
        .limit
        .unwrap_or(OCR_ADMIN_DEFAULT_LIMIT)
        .clamp(1, OCR_ADMIN_MAX_LIMIT);
    Ok(Json(load_page(env.as_ref(), limit).await.c(h!())?))
}

#[post("/api/admin/ocr/settings")]
pub async fn save_ocr_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveOcrSettingsReq>,
) -> Result<Json<OcrSettingsItem>, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    if req.worker_enabled {
        runtime_config(env.as_ref()).c(h!())?;
    }
    let settings = ocr_settings::Entity::find_by_id(OCR_SETTINGS_ID)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let mut settings = settings.into_active_model();
    settings.worker_enabled = Set(req.worker_enabled);
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(&env.dbx).await.c(h!())?;
    Ok(Json(load_settings(env.as_ref()).await.c(h!())?))
}

#[post("/api/admin/ocr/{media_id}/reprocess")]
pub async fn reprocess_media_ocr(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<Json<OcrMediaSummary>, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let media = signal_message_media::Entity::find_by_id(path.0)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    if !media_is_ocr_eligible(&media) {
        return Err(crate::error::AppError::BL {
            msg: "Повторна OCR-обробка доступна лише для PDF, JPEG і PNG"
                .to_string(),
        });
    }
    let summary_settings = crate::media_summary::load_settings(&env.dbx)
        .await
        .c(h!())?;
    let has_enabled_engine =
        summary_settings.ai_engine_id.as_ref().is_some_and(|id| {
            summary_settings
                .engines
                .iter()
                .any(|engine| &engine.id == id)
        });
    if !summary_settings.enabled || !has_enabled_engine {
        return Err(crate::error::AppError::BL {
            msg: "Спочатку увімкніть стислий опис документів і оберіть увімкнений ШІ движок"
                .to_string(),
        });
    }
    let job = queue_media_reprocessing(&env.dbx, media.id).await.c(h!())?;
    fanout_mult(
        &mut env.redis.clone(),
        vec![EventMsg::new(EventType::ETInboxChanged(
            media.signal_message_id,
        ))],
    )
    .await
    .c(h!())?;
    let queue_ahead = load_queue_positions(&env.dbx)
        .await
        .c(h!())?
        .get(&media.id)
        .copied();
    Ok(Json(media_summary(job, queue_ahead)))
}

async fn queue_media_reprocessing(
    dbx: &DatabaseConnection,
    media_id: Uuid,
) -> anyhow::Result<ocr_job::Model> {
    let transaction = dbx.begin().await.c(h!())?;
    let now = Utc::now().naive_utc();
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
insert into ocr_job (
    media_id, next_attempt_at, discovered_at, updated_at, force_summary
)
values ($1, $2, $2, $2, true)
on conflict (media_id) do update
set state = 'queued',
    extractor_job_id = null,
    attempts = 0,
    next_attempt_at = excluded.next_attempt_at,
    last_error = null,
    quality_status = null,
    processed_pages = 0,
    total_pages = 0,
    html_s3_key = null,
    html_size_bytes = null,
    discovered_at = excluded.discovered_at,
    submitted_at = null,
    completed_at = null,
    updated_at = excluded.updated_at,
    force_summary = true
where ocr_job.state in ('completed', 'failed')
returning ocr_job.*
        "#,
        [media_id.into(), now.into()],
    );
    let job = ocr_job::Entity::find()
        .from_raw_sql(statement)
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or_else(|| crate::error::AppError::BL {
            msg: "OCR-обробка цього медіа вже виконується".to_string(),
        })
        .c(h!())?;
    media_summary_entity::Entity::delete_by_id(media_id)
        .exec(&transaction)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(job)
}

#[get("/api/messenger/media/{media_id}/ocr")]
pub async fn messenger_media_ocr(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, crate::error::AppError> {
    let media = authorized_media(env.as_ref(), &user, path.0)
        .await
        .c(h!())?;
    Ok(serve_ocr_html(env.as_ref(), media.id).await.c(h!())?)
}

#[get("/api/messenger/media/{media_id}/ocr/download/{format}")]
pub async fn messenger_media_ocr_download(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid, String)>,
) -> Result<HttpResponse, crate::error::AppError> {
    let (media_id, format) = path.into_inner();
    let media = authorized_media(env.as_ref(), &user, media_id)
        .await
        .c(h!())?;
    let format = export::ExportFormat::parse(&format)
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    let extension = format.extension();
    let content_type = format.content_type();
    let file_name = ocr_export_file_name(media.file_name.as_deref(), extension);
    let html = load_sanitized_ocr_html(env.as_ref(), media.id)
        .await
        .c(h!())?;
    let bytes =
        tokio::task::spawn_blocking(move || export::generate(&html, format))
            .await
            .c(h!())?
            .c(h!())?;
    let content_disposition = header::ContentDisposition {
        disposition: header::DispositionType::Attachment,
        parameters: vec![header::DispositionParam::FilenameExt(
            header::ExtendedValue {
                charset: header::Charset::Ext("UTF-8".into()),
                language_tag: None,
                value: file_name.into_bytes(),
            },
        )],
    };
    let mut response = HttpResponse::Ok();
    response
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header(content_disposition)
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"));
    if extension == "html" {
        response.insert_header((
            "Content-Security-Policy",
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        ));
    }
    Ok(response.body(bytes))
}

#[get("/api/messenger/media/{media_id}/ocr/status")]
pub async fn messenger_media_ocr_status(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<Json<OcrMediaSummary>, crate::error::AppError> {
    let media = authorized_media(env.as_ref(), &user, path.0)
        .await
        .c(h!())?;
    let job = ocr_job::Entity::find_by_id(media.id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(job) = job {
        let queue_ahead = if job_is_pending(&job.state) {
            load_queue_positions(&env.dbx)
                .await
                .c(h!())?
                .get(&job.media_id)
                .copied()
        } else {
            None
        };
        return Ok(Json(media_summary(job, queue_ahead)));
    }
    let worker_enabled = worker::worker_enabled(&env.dbx).await.c(h!())?;
    let message_exists =
        signal_message::Entity::find_by_id(media.signal_message_id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(&env.dbx)
            .await
            .c(h!())?
            .is_some();
    if !worker_enabled
        || !message_exists
        || !media_is_pending_candidate(&media, discovery_cutoff())
    {
        return Err(crate::error::AppError::NotFound);
    }
    let queue_ahead = load_queue_positions(&env.dbx)
        .await
        .c(h!())?
        .get(&media.id)
        .copied();
    Ok(Json(pending_media_summary(queue_ahead, media.created_at)))
}

#[get("/api/admin/ocr/{media_id}/preview")]
pub async fn admin_ocr_preview(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(serve_ocr_html(env.as_ref(), path.0).await.c(h!())?)
}

#[get("/api/admin/ocr/{media_id}/media")]
pub async fn admin_ocr_media(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: HttpRequest,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let media = signal_message_media::Entity::find_by_id(path.0)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    Ok(
        crate::rer_importer::serve_messenger_media(&req, env.as_ref(), &media)
            .await
            .c(h!())?,
    )
}

async fn serve_ocr_html(
    env: &Env,
    media_id: Uuid,
) -> Result<HttpResponse, crate::error::AppError> {
    let html = load_sanitized_ocr_html(env, media_id).await.c(h!())?;
    let body = render_document(&html);
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/html; charset=utf-8"))
        .insert_header(("Cache-Control", "private, no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .insert_header((
            "Content-Security-Policy",
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        ))
        .body(body))
}

async fn load_sanitized_ocr_html(
    env: &Env,
    media_id: Uuid,
) -> Result<String, crate::error::AppError> {
    let job = ocr_job::Entity::find_by_id(media_id)
        .filter(ocr_job::Column::State.eq("completed"))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    let object_key = job.html_s3_key.c(h!())?;
    let app_s3_config = env.config.s3_config.as_ref().c(h!())?;
    let bytes = storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &app_s3_config.strongbox_key,
        &object_key,
    )
    .await
    .c(h!())?;
    let html = String::from_utf8(bytes).c(h!())?;
    let html = tokio::task::spawn_blocking(move || sanitize_html(&html))
        .await
        .c(h!())?;
    Ok(html)
}

async fn load_page(env: &Env, limit: u64) -> anyhow::Result<OcrPageRsp> {
    let settings = load_settings(env).await.c(h!())?;
    let media_summary_settings = crate::media_summary::load_settings(&env.dbx)
        .await
        .c(h!())?;
    let counts = load_counts(&env.dbx).await.c(h!())?;
    let jobs = ocr_job::Entity::find()
        .order_by_desc(ocr_job::Column::UpdatedAt)
        .order_by_desc(ocr_job::Column::MediaId)
        .limit(limit)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let media_ids = jobs.iter().map(|job| job.media_id).collect::<Vec<_>>();
    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::Id.is_in(media_ids))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let summaries = crate::media_summary::load_statuses(&env.dbx, &media)
        .await
        .c(h!())?;
    let media = media
        .into_iter()
        .map(|media| (media.id, media))
        .collect::<HashMap<_, _>>();
    let jobs = jobs
        .into_iter()
        .filter_map(|job| {
            media.get(&job.media_id).map(|media| {
                let summary = summaries.get(&job.media_id).cloned();
                job_item(job, media, summary)
            })
        })
        .collect();
    Ok(OcrPageRsp {
        settings,
        media_summary_settings,
        counts,
        jobs,
    })
}

async fn load_settings(env: &Env) -> anyhow::Result<OcrSettingsItem> {
    let worker_enabled = ocr_settings::Entity::find_by_id(OCR_SETTINGS_ID)
        .one(&env.dbx)
        .await
        .c(h!())?
        .is_some_and(|settings| settings.worker_enabled);
    let config = runtime_config(env);
    let configured = config.is_ok();
    let readiness = match config {
        Ok(config) => worker::extractor_readiness(&env.rq, &config).await,
        Err(err) => Err(err),
    };
    Ok(OcrSettingsItem {
        worker_enabled,
        configured,
        extractor_ready: readiness.is_ok(),
        readiness_error: readiness
            .err()
            .map(|err| truncate_error(err.to_string())),
    })
}

async fn load_counts(dbx: &DatabaseConnection) -> anyhow::Result<OcrCounts> {
    Ok(OcrCounts {
        queued: count_state(dbx, "queued").await.c(h!())?,
        submitted: count_state(dbx, "submitted").await.c(h!())?,
        retry_wait: count_state(dbx, "retry_wait").await.c(h!())?,
        completed: count_state(dbx, "completed").await.c(h!())?,
        failed: count_state(dbx, "failed").await.c(h!())?,
    })
}

async fn count_state(
    dbx: &DatabaseConnection,
    state: &str,
) -> anyhow::Result<i64> {
    let count = ocr_job::Entity::find()
        .filter(ocr_job::Column::State.eq(state))
        .count(dbx)
        .await
        .c(h!())?;
    i64::try_from(count).c(h!())
}

fn job_item(
    job: ocr_job::Model,
    media: &signal_message_media::Model,
    summary: Option<crate::media_summary::types::MediaSummaryStatus>,
) -> OcrJobItem {
    let preview_url = (job.state == "completed" && job.html_s3_key.is_some())
        .then(|| format!("/api/admin/ocr/{}/preview", job.media_id));
    OcrJobItem {
        media_id: job.media_id.to_string(),
        signal_message_id: media.signal_message_id,
        file_name: media.file_name.clone(),
        content_type: media.content_type.clone(),
        size_bytes: media.size_bytes,
        source_created_at: timestamp_ms(media.created_at),
        state: job.state,
        quality_status: job.quality_status,
        processed_pages: job.processed_pages,
        total_pages: job.total_pages,
        attempts: job.attempts,
        last_error: job.last_error,
        duration_ms: job.completed_at.zip(job.submitted_at).map(
            |(completed_at, submitted_at)| {
                (completed_at - submitted_at).num_milliseconds().max(0)
            },
        ),
        updated_at: timestamp_ms(job.updated_at),
        completed_at: job.completed_at.map(timestamp_ms),
        preview_url,
        summary,
    }
}

fn media_summary(
    job: ocr_job::Model,
    queue_ahead: Option<i64>,
) -> OcrMediaSummary {
    let queue_size =
        job_is_pending(&job.state).then_some(queue_ahead).flatten();
    let status_log = job_status_log(&job);
    OcrMediaSummary {
        state: job.state,
        quality_status: job.quality_status,
        processed_pages: job.processed_pages,
        total_pages: job.total_pages,
        last_error: job.last_error,
        queue_size,
        attempts: job.attempts,
        status_log,
    }
}

fn pending_media_summary(
    queue_ahead: Option<i64>,
    created_at: NaiveDateTime,
) -> OcrMediaSummary {
    OcrMediaSummary {
        state: "pending".to_string(),
        quality_status: None,
        processed_pages: 0,
        total_pages: 0,
        last_error: None,
        queue_size: queue_ahead,
        attempts: 0,
        status_log: vec![OcrStatusLogItem {
            at: timestamp_ms(created_at),
            message: "Файл отримано; очікує додавання до OCR-черги."
                .to_string(),
        }],
    }
}

fn job_status_log(job: &ocr_job::Model) -> Vec<OcrStatusLogItem> {
    let mut log = vec![OcrStatusLogItem {
        at: timestamp_ms(job.discovered_at),
        message: "Додано до OCR-черги.".to_string(),
    }];
    if let Some(submitted_at) = job.submitted_at {
        log.push(OcrStatusLogItem {
            at: timestamp_ms(submitted_at),
            message: "Передано до OCR-extractor.".to_string(),
        });
    }
    let terminal_at = job.completed_at.unwrap_or(job.updated_at);
    let current = match job.state.as_str() {
        "queued" => None,
        "submitted" if job.last_error.is_some() => Some(format!(
            "OCR-extractor тимчасово недоступний; очікується повторна перевірка (спроб: {}).",
            job.attempts
        )),
        "submitted" if job.total_pages > 0 => Some(format!(
            "OCR-extractor обробляє сторінки: {} із {}.",
            job.processed_pages, job.total_pages
        )),
        "submitted" => Some("OCR-extractor обробляє документ.".to_string()),
        "retry_wait" => Some(format!(
            "Очікує повторного надсилання до OCR-extractor (спроб: {}).",
            job.attempts
        )),
        "completed" => Some(match job.quality_status.as_deref() {
            Some("accepted") => "OCR завершено; якість прийнятна.".to_string(),
            Some("degraded") => "OCR завершено зі зниженою якістю.".to_string(),
            _ => "OCR завершено.".to_string(),
        }),
        "failed" => Some(format!(
            "OCR завершився з помилкою після {} спроб.",
            job.attempts
        )),
        _ => None,
    };
    if let Some(message) = current {
        let at = if matches!(job.state.as_str(), "completed" | "failed") {
            terminal_at
        } else {
            job.updated_at
        };
        log.push(OcrStatusLogItem {
            at: timestamp_ms(at),
            message,
        });
    }
    log
}

fn job_is_pending(state: &str) -> bool {
    matches!(state, "pending" | "queued" | "submitted" | "retry_wait")
}

fn discovery_cutoff() -> NaiveDateTime {
    (Utc::now() - chrono::Duration::days(OCR_DISCOVERY_DAYS)).naive_utc()
}

fn media_is_pending_candidate(
    media: &signal_message_media::Model,
    cutoff: NaiveDateTime,
) -> bool {
    media.created_at >= cutoff && media_is_ocr_eligible(media)
}

fn media_is_ocr_eligible(media: &signal_message_media::Model) -> bool {
    let content_type = media
        .content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        content_type.as_str(),
        "application/pdf" | "image/jpeg" | "image/jpg" | "image/png"
    ) {
        return true;
    }
    if media.file_ext.as_deref().is_some_and(|extension| {
        matches!(
            extension.to_ascii_lowercase().as_str(),
            "pdf" | "jpg" | "jpeg" | "png"
        )
    }) {
        return true;
    }
    media.file_name.as_deref().is_some_and(|file_name| {
        let file_name = file_name.to_ascii_lowercase();
        [".pdf", ".jpg", ".jpeg", ".png"]
            .iter()
            .any(|extension| file_name.ends_with(extension))
    })
}

#[derive(FromQueryResult)]
struct OcrQueuePosition {
    media_id: Uuid,
    queue_ahead: i64,
}

async fn load_queue_positions(
    dbx: &DatabaseConnection,
) -> anyhow::Result<HashMap<Uuid, i64>> {
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
with active as (
  select job.media_id,
         0 as priority,
         job.submitted_at,
         null::timestamp without time zone as next_attempt_at,
         null::timestamp without time zone as discovered_at,
         null::timestamp without time zone as pending_created_at
  from ocr_job job
  join signal_message_media media on media.id = job.media_id
  join signal_message message on message.id = media.signal_message_id
  where job.state = 'submitted'
    and not message.deleted
  union all
  select job.media_id,
         1 as priority,
         null::timestamp without time zone as submitted_at,
         job.next_attempt_at,
         job.discovered_at,
         null::timestamp without time zone as pending_created_at
  from ocr_job job
  join signal_message_media media on media.id = job.media_id
  join signal_message message on message.id = media.signal_message_id
  where job.state in ('queued', 'retry_wait')
    and not message.deleted
  union all
  select media.id
       , 1 as priority
       , null::timestamp without time zone as submitted_at
       , now() at time zone 'utc' as next_attempt_at
       , now() at time zone 'utc' as discovered_at
       , media.created_at as pending_created_at
  from signal_message_media media
  join signal_message message on message.id = media.signal_message_id
  left join ocr_job job on job.media_id = media.id
  where job.media_id is null
    and not message.deleted
    and media.created_at >= $1
    and (
      lower(split_part(media.content_type, ';', 1)) in (
        'application/pdf', 'image/jpeg', 'image/jpg', 'image/png'
      )
      or lower(coalesce(media.file_ext, '')) in ('pdf', 'jpg', 'jpeg', 'png')
      or lower(coalesce(media.file_name, '')) ~ '\.(pdf|jpe?g|png)$'
    )
), ranked as (
  select media_id,
         row_number() over (
           order by priority,
                    submitted_at nulls last,
                    next_attempt_at nulls last,
                    discovered_at nulls last,
                    pending_created_at nulls first,
                    media_id
         )::bigint - 1 as queue_ahead
  from active
)
select media_id, queue_ahead
from ranked
        "#,
        [discovery_cutoff().into()],
    );
    Ok(OcrQueuePosition::find_by_statement(statement)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|position| (position.media_id, position.queue_ahead))
        .collect())
}

pub(crate) async fn authorized_media(
    env: &Env,
    user: &Identity,
    media_id: Uuid,
) -> Result<signal_message_media::Model, crate::error::AppError> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    crate::messenger::media::ensure_media_access(
        &env.dbx,
        &login,
        media.signal_message_id,
    )
    .await
    .c(h!())?;
    Ok(media)
}

fn timestamp_ms(value: NaiveDateTime) -> i64 {
    value.and_utc().timestamp_millis()
}

fn truncate_error(value: String) -> String {
    value
        .chars()
        .take(crate::config::OCR_MAX_ERROR_CHARS)
        .collect()
}

pub(super) fn render_document(fragment: &str) -> String {
    format!(
        r#"<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{{color-scheme:light dark}}body{{box-sizing:border-box;max-width:100%;margin:0;padding:1rem;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}}article{{max-width:100%;margin:auto}}section[data-page-id]{{margin:0 auto 1.5rem;padding:1rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:.5rem;background:Canvas}}table{{display:block;max-width:100%;overflow:auto;border-collapse:collapse;border-spacing:0;margin:.25rem 0;font:13px/1.1 system-ui,sans-serif}}th,td{{border:1px solid color-mix(in srgb,CanvasText 28%,transparent);padding:1px 3px;vertical-align:middle;text-align:left}}th p,td p{{margin:0;line-height:inherit}}img{{display:block;max-width:100%;height:auto;margin:.5rem auto}}figure{{margin:1rem 0}}p{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head><body>{fragment}</body></html>"#
    )
}

fn ocr_export_file_name(original: Option<&str>, extension: &str) -> String {
    let stem = original
        .and_then(|value| Path::new(value).file_stem())
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let stem = stem
        .chars()
        .filter(|value| {
            !value.is_control()
                && !matches!(
                    value,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        .take(120)
        .collect::<String>();
    let stem = stem.trim();
    format!(
        "{}-ocr.{extension}",
        if stem.is_empty() { "document" } else { stem }
    )
}

#[cfg(test)]
mod tests {
    use super::{
        load_queue_positions, media_is_ocr_eligible, ocr_export_file_name,
        pending_media_summary, queue_media_reprocessing, render_document,
    };
    use crate::entities::{
        media_summary as media_summary_entity, ocr_job, signal_message_media,
    };
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
    use serde_json::json;
    use uuid::Uuid;

    fn media(
        content_type: &str,
        file_ext: Option<&str>,
        file_name: Option<&str>,
    ) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::nil(),
            signal_message_id: 1,
            content_type: content_type.to_string(),
            file_ext: file_ext.map(str::to_string),
            file_name: file_name.map(str::to_string),
            size_bytes: 1,
            created_at: Utc::now().naive_utc(),
            is_encrypted: true,
        }
    }

    #[test]
    fn ocr_media_eligibility_matches_supported_upload_metadata() {
        assert!(media_is_ocr_eligible(&media(
            "image/png; charset=binary",
            None,
            None,
        )));
        assert!(media_is_ocr_eligible(&media(
            "application/octet-stream",
            Some("PDF"),
            None,
        )));
        assert!(media_is_ocr_eligible(&media(
            "application/octet-stream",
            None,
            Some("scan.JPEG"),
        )));
        assert!(!media_is_ocr_eligible(&media(
            "text/plain",
            Some("txt"),
            Some("note.txt"),
        )));
    }

    #[test]
    fn pending_summary_exposes_items_ahead_and_status_log() {
        let summary = pending_media_summary(Some(2), Utc::now().naive_utc());
        assert_eq!(summary.state, "pending");
        assert_eq!(summary.queue_size, Some(2));
        assert_eq!(summary.status_log.len(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn queue_positions_count_only_items_ahead() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let mut media_ids = Vec::new();
        for index in 0..3 {
            let media = signal_message_media::ActiveModel {
                id: Set(Uuid::now_v7()),
                signal_message_id: Set(message.id),
                content_type: Set("image/png".to_string()),
                file_ext: Set(Some("png".to_string())),
                file_name: Set(Some(format!("queue-{index}.png"))),
                size_bytes: Set(1),
                created_at: Set(now + chrono::Duration::milliseconds(index)),
                is_encrypted: Set(true),
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            media_ids.push(media.id);
        }
        ocr_job::ActiveModel {
            media_id: Set(media_ids[0]),
            state: Set("submitted".to_string()),
            submitted_at: Set(Some(now)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        ocr_job::ActiveModel {
            media_id: Set(media_ids[1]),
            state: Set("queued".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let positions = load_queue_positions(&env.dbx).await.unwrap();
        assert_eq!(positions.get(&media_ids[0]), Some(&0));
        assert_eq!(positions.get(&media_ids[1]), Some(&1));
        assert_eq!(positions.get(&media_ids[2]), Some(&2));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reprocessing_resets_terminal_ocr_and_removes_stale_summary() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let media = signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("application/pdf".to_string()),
            file_ext: Set(Some("pdf".to_string())),
            file_name: Set(Some("report.pdf".to_string())),
            size_bytes: Set(1),
            created_at: Set(now),
            is_encrypted: Set(true),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        ocr_job::ActiveModel {
            media_id: Set(media.id),
            state: Set("completed".to_string()),
            extractor_job_id: Set(Some(Uuid::now_v7())),
            attempts: Set(3),
            last_error: Set(Some("old error".to_string())),
            quality_status: Set(Some("accepted".to_string())),
            processed_pages: Set(4),
            total_pages: Set(4),
            html_s3_key: Set(Some("old-key".to_string())),
            html_size_bytes: Set(Some(100)),
            submitted_at: Set(Some(now)),
            completed_at: Set(Some(now)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        media_summary_entity::ActiveModel {
            media_id: Set(media.id),
            source_kind: Set("ocr_text".to_string()),
            source_digest: Set("a".repeat(64)),
            source_text: Set(None),
            source_char_count: Set(10),
            state: Set("completed".to_string()),
            ai_engine_id: Set(None),
            ai_engine_name: Set("engine".to_string()),
            model_name: Set("summary-model".to_string()),
            summary: Set(Some("old summary".to_string())),
            coordinates: Set(json!([{
                "title": "Old point",
                "coordinateSystem": "sk42",
                "value": "X=1234567 Y=2345678"
            }])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let job = queue_media_reprocessing(&env.dbx, media.id).await.unwrap();

        assert_eq!(job.state, "queued");
        assert_eq!(job.attempts, 0);
        assert_eq!(job.extractor_job_id, None);
        assert_eq!(job.quality_status, None);
        assert_eq!(job.processed_pages, 0);
        assert_eq!(job.total_pages, 0);
        assert_eq!(job.html_s3_key, None);
        assert_eq!(job.completed_at, None);
        assert!(job.force_summary);
        assert!(media_summary_entity::Entity::find_by_id(media.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn ocr_document_tables_use_compact_cells() {
        let document =
            render_document("<table><tr><td>value</td></tr></table>");
        assert!(document.contains("font:13px/1.1"));
        assert!(document.contains("padding:1px 3px"));
        assert!(document.contains("th p,td p{margin:0;line-height:inherit}"));
    }

    #[test]
    fn ocr_export_file_name_removes_path_and_control_characters() {
        assert_eq!(
            ocr_export_file_name(Some("../../bad\nname.pdf"), "docx"),
            "badname-ocr.docx"
        );
    }
}
