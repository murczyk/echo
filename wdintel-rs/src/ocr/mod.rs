pub mod package;
pub mod types;
pub mod worker;

use crate::config::{
    OCR_ADMIN_DEFAULT_LIMIT, OCR_ADMIN_MAX_LIMIT, OCR_SETTINGS_ID,
    OCR_TOKEN_ENV,
};
use crate::entities::{ocr_job, ocr_settings, signal_message_media};
use crate::h;
use crate::ocr::package::sanitize_html;
use crate::ocr::types::{
    OcrCounts, OcrJobItem, OcrMediaSummary, OcrPageReq, OcrPageRsp,
    OcrSettingsItem, SaveOcrSettingsReq,
};
use crate::storage;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_admin, ensure_rer_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{get, post, web::Json, HttpResponse};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct OcrRuntimeConfig {
    pub base_url: String,
    pub instance_id: String,
    pub token: String,
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

pub async fn load_media_summaries(
    dbx: &DatabaseConnection,
    media_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, OcrMediaSummary>> {
    if media_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let jobs = ocr_job::Entity::find()
        .filter(ocr_job::Column::MediaId.is_in(media_ids.iter().copied()))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(jobs
        .into_iter()
        .map(|job| {
            (
                job.media_id,
                OcrMediaSummary {
                    state: job.state,
                    quality_status: job.quality_status,
                    processed_pages: job.processed_pages,
                    total_pages: job.total_pages,
                    last_error: job.last_error,
                },
            )
        })
        .collect())
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

#[get("/api/messenger/media/{media_id}/ocr")]
pub async fn messenger_media_ocr(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, crate::error::AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    let media = signal_message_media::Entity::find_by_id(path.0)
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
    serve_ocr_html(env.as_ref(), media.id).await
}

#[get("/api/admin/ocr/{media_id}/preview")]
pub async fn admin_ocr_preview(
    env: actix_web::web::Data<Env>,
    user: Identity,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, crate::error::AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    serve_ocr_html(env.as_ref(), path.0).await
}

async fn serve_ocr_html(
    env: &Env,
    media_id: Uuid,
) -> Result<HttpResponse, crate::error::AppError> {
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

async fn load_page(env: &Env, limit: u64) -> anyhow::Result<OcrPageRsp> {
    let settings = load_settings(env).await.c(h!())?;
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
        .c(h!())?
        .into_iter()
        .map(|media| (media.id, media))
        .collect::<HashMap<_, _>>();
    let jobs = jobs
        .into_iter()
        .filter_map(|job| {
            media.get(&job.media_id).map(|media| job_item(job, media))
        })
        .collect();
    Ok(OcrPageRsp {
        settings,
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
        updated_at: timestamp_ms(job.updated_at),
        completed_at: job.completed_at.map(timestamp_ms),
        preview_url,
    }
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

fn render_document(fragment: &str) -> String {
    format!(
        r#"<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{{color-scheme:light dark}}body{{box-sizing:border-box;max-width:100%;margin:0;padding:1rem;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}}article{{max-width:100%;margin:auto}}section[data-page-id]{{margin:0 auto 1.5rem;padding:1rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:.5rem;background:Canvas}}table{{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:1rem 0}}th,td{{border:1px solid color-mix(in srgb,CanvasText 28%,transparent);padding:.35rem .5rem;vertical-align:top}}img{{display:block;max-width:100%;height:auto;margin:.5rem auto}}figure{{margin:1rem 0}}p{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head><body>{fragment}</body></html>"#
    )
}
