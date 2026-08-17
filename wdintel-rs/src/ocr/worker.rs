use super::package::stored_html_from_zip;
use super::{ocr_result_key, runtime_config, OcrRuntimeConfig};
use crate::config::{
    OCR_DISCOVERY_BATCH_SIZE, OCR_DISCOVERY_DAYS, OCR_IDLE_SLEEP_MS,
    OCR_MAX_ATTEMPTS, OCR_MAX_ERROR_CHARS, OCR_MAX_RESULT_BYTES,
    OCR_MAX_SOURCE_BYTES, OCR_POLL_SLEEP_MS, OCR_RETRY_BASE_SECS,
    OCR_RETRY_MAX_SECS, OCR_SETTINGS_ID,
};
use crate::entities::{ocr_job, ocr_settings, signal_message_media};
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::messenger::media::{
    fetch_media_bytes, stream_plaintext_media_range,
};
use crate::storage;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use anyhow::Context;
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseBackend, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Statement,
};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct ExtractorJobRsp {
    id: String,
    state: String,
    quality_status: Option<String>,
    error_summary: Option<String>,
    page_progress: ExtractorPageProgress,
}

#[derive(Debug, Deserialize)]
struct ExtractorPageProgress {
    processed: i32,
    total: i32,
}

#[derive(Debug, Deserialize)]
struct ExtractorStatusRsp {
    worker: ExtractorWorkers,
    paddle: ExtractorPaddle,
    routers: Vec<ExtractorRouter>,
}

#[derive(Debug, Deserialize)]
struct ExtractorWorkers {
    instances: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ExtractorPaddle {
    required: bool,
    ready: bool,
}

#[derive(Debug, Deserialize)]
struct ExtractorRouter {
    name: String,
    healthy: bool,
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    info!("ocr_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            info!("ocr_worker received cancellation token");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("ocr_worker");
        let processed = match process_iteration(&env).await {
            Ok(processed) => processed,
            Err(err) => {
                error!("ocr_worker failed: {err:#?}");
                false
            }
        };
        let sleep_ms = if processed {
            OCR_POLL_SLEEP_MS
        } else {
            OCR_IDLE_SLEEP_MS
        };
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
        }
    }
}

async fn process_iteration(env: &Env) -> anyhow::Result<bool> {
    let worker_enabled = worker_enabled(&env.dbx).await.c(h!())?;
    let discovered = if worker_enabled {
        discover_jobs(&env.dbx).await.c(h!())?
    } else {
        0
    };
    if let Some(job) = load_submitted(&env.dbx).await.c(h!())? {
        if job.next_attempt_at > Utc::now().naive_utc() {
            return Ok(discovered > 0);
        }
        return poll_submitted_job(env, job).await;
    }
    if !worker_enabled {
        return Ok(false);
    }
    let Some(job) = load_due_queued(&env.dbx).await.c(h!())? else {
        return Ok(discovered > 0);
    };
    let config = match runtime_config(env) {
        Ok(config) => config,
        Err(err) => {
            postpone_for_dependency(&env.dbx, job, err.to_string())
                .await
                .c(h!())?;
            return Ok(true);
        }
    };
    if let Err(err) = extractor_readiness(&env.rq, &config).await {
        postpone_for_dependency(&env.dbx, job, err.to_string())
            .await
            .c(h!())?;
        return Ok(true);
    }
    submit_job(env, &config, job).await.c(h!())?;
    Ok(true)
}

pub(crate) async fn extractor_readiness(
    client: &reqwest::Client,
    config: &OcrRuntimeConfig,
) -> anyhow::Result<()> {
    let response = client
        .get(format!("{}/v1/status", config.base_url))
        .bearer_auth(&config.token)
        .timeout(Duration::from_secs(crate::config::OCR_STATUS_TIMEOUT_SECS))
        .send()
        .await
        .context(h!())?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("OCR extractor status returned HTTP {status}");
    }
    let status: ExtractorStatusRsp = response.json().await.context(h!())?;
    if status.worker.instances.is_empty() {
        anyhow::bail!("OCR extractor worker is unavailable");
    }
    if status.paddle.required && !status.paddle.ready {
        anyhow::bail!("OCR extractor Paddle runtime is unavailable");
    }
    let unhealthy = status
        .routers
        .iter()
        .filter(|router| !router.healthy)
        .map(|router| router.name.as_str())
        .collect::<Vec<_>>();
    if !unhealthy.is_empty() {
        anyhow::bail!(
            "OCR extractor routers are unavailable: {}",
            unhealthy.join(", ")
        );
    }
    Ok(())
}

pub(crate) async fn worker_enabled(
    dbx: &DatabaseConnection,
) -> anyhow::Result<bool> {
    Ok(ocr_settings::Entity::find_by_id(OCR_SETTINGS_ID)
        .one(dbx)
        .await
        .context(h!())?
        .is_some_and(|settings| settings.worker_enabled))
}

async fn discover_jobs(dbx: &DatabaseConnection) -> anyhow::Result<usize> {
    let cutoff =
        (Utc::now() - ChronoDuration::days(OCR_DISCOVERY_DAYS)).naive_utc();
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
select media.*
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
order by media.created_at, media.id
limit $2
        "#,
        [cutoff.into(), OCR_DISCOVERY_BATCH_SIZE.into()],
    );
    let media = signal_message_media::Entity::find()
        .from_raw_sql(statement)
        .all(dbx)
        .await
        .context(h!())?;
    let mut inserted = 0;
    for media in media {
        ocr_job::Entity::insert(ocr_job::ActiveModel {
            media_id: Set(media.id),
            state: NotSet,
            extractor_job_id: NotSet,
            attempts: NotSet,
            next_attempt_at: NotSet,
            last_error: NotSet,
            quality_status: NotSet,
            processed_pages: NotSet,
            total_pages: NotSet,
            html_s3_key: NotSet,
            html_size_bytes: NotSet,
            discovered_at: NotSet,
            submitted_at: NotSet,
            completed_at: NotSet,
            updated_at: NotSet,
            force_summary: NotSet,
        })
        .on_conflict_do_nothing()
        .exec(dbx)
        .await
        .context(h!())?;
        inserted += 1;
    }
    Ok(inserted)
}

async fn load_submitted(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ocr_job::Model>> {
    ocr_job::Entity::find()
        .filter(ocr_job::Column::State.eq("submitted"))
        .order_by_asc(ocr_job::Column::SubmittedAt)
        .order_by_asc(ocr_job::Column::MediaId)
        .one(dbx)
        .await
        .context(h!())
}

async fn load_due_queued(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ocr_job::Model>> {
    ocr_job::Entity::find()
        .filter(ocr_job::Column::State.is_in(["queued", "retry_wait"]))
        .filter(ocr_job::Column::NextAttemptAt.lte(Utc::now().naive_utc()))
        .order_by_asc(ocr_job::Column::NextAttemptAt)
        .order_by_asc(ocr_job::Column::DiscoveredAt)
        .order_by_asc(ocr_job::Column::MediaId)
        .one(dbx)
        .await
        .context(h!())
}

async fn submit_job(
    env: &Env,
    config: &OcrRuntimeConfig,
    job: ocr_job::Model,
) -> anyhow::Result<()> {
    let media = signal_message_media::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .context(h!())?;
    let Some(media) = media else {
        ocr_job::Entity::delete_by_id(job.media_id)
            .exec(&env.dbx)
            .await
            .context(h!())?;
        return Ok(());
    };
    let bytes = fetch_source(env, &media).await.context(h!())?;
    let part = Part::bytes(bytes)
        .file_name(source_file_name(&media))
        .mime_str(source_mime(&media))
        .context(h!())?;
    let response = env
        .rq
        .post(format!("{}/v1/jobs", config.base_url))
        .bearer_auth(&config.token)
        .header("Idempotency-Key", idempotency_key(config, &job))
        .multipart(Form::new().part("files", part))
        .timeout(Duration::from_secs(crate::config::OCR_HTTP_TIMEOUT_SECS))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            retry_job(&env.dbx, job, err.to_string(), false)
                .await
                .context(h!())?;
            return Ok(());
        }
    };
    let status = response.status();
    if !status.is_success() {
        let error = response.text().await.unwrap_or_default();
        retry_job(
            &env.dbx,
            job,
            format!("OCR submission returned HTTP {status}: {error}"),
            false,
        )
        .await
        .context(h!())?;
        return Ok(());
    }
    let response: ExtractorJobRsp = response.json().await.context(h!())?;
    let extractor_job_id = Uuid::parse_str(&response.id).context(h!())?;
    let now = Utc::now().naive_utc();
    let mut job = job.into_active_model();
    job.state = Set("submitted".to_string());
    job.extractor_job_id = Set(Some(extractor_job_id));
    job.last_error = Set(None);
    job.processed_pages = Set(response.page_progress.processed);
    job.total_pages = Set(response.page_progress.total);
    job.submitted_at = Set(Some(now));
    job.next_attempt_at = Set(now + poll_delay());
    job.updated_at = Set(now);
    job.update(&env.dbx).await.context(h!())?;
    Ok(())
}

async fn poll_submitted_job(
    env: &Env,
    job: ocr_job::Model,
) -> anyhow::Result<bool> {
    let config = match runtime_config(env) {
        Ok(config) => config,
        Err(err) => {
            postpone_for_dependency(&env.dbx, job, err.to_string())
                .await
                .context(h!())?;
            return Ok(true);
        }
    };
    let Some(extractor_job_id) = job.extractor_job_id else {
        retry_job(
            &env.dbx,
            job,
            "submitted OCR job has no extractor job ID".to_string(),
            true,
        )
        .await
        .context(h!())?;
        return Ok(true);
    };
    let response = env
        .rq
        .get(format!("{}/v1/jobs/{extractor_job_id}", config.base_url))
        .bearer_auth(&config.token)
        .timeout(Duration::from_secs(crate::config::OCR_STATUS_TIMEOUT_SECS))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            retry_job(&env.dbx, job, err.to_string(), true)
                .await
                .context(h!())?;
            return Ok(true);
        }
    };
    let status = response.status();
    if !status.is_success() {
        let error = response.text().await.unwrap_or_default();
        retry_job(
            &env.dbx,
            job,
            format!("OCR status returned HTTP {status}: {error}"),
            true,
        )
        .await
        .context(h!())?;
        return Ok(true);
    }
    let response: ExtractorJobRsp = response.json().await.context(h!())?;
    match response.state.as_str() {
        "queued" | "running" | "retry_wait" => {
            update_submitted_progress(&env.dbx, job, &response)
                .await
                .context(h!())?;
        }
        "completed" => {
            finalize_job(env, &config, job, extractor_job_id, response)
                .await
                .context(h!())?;
        }
        "failed" | "cancelled" => {
            mark_failed(
                &env.dbx,
                job,
                response.error_summary.unwrap_or_else(|| {
                    format!("OCR extractor job ended as {}", response.state)
                }),
                response.quality_status,
            )
            .await
            .context(h!())?;
        }
        state => {
            retry_job(
                &env.dbx,
                job,
                format!("OCR extractor returned unknown state {state}"),
                true,
            )
            .await
            .context(h!())?;
        }
    }
    Ok(true)
}

async fn finalize_job(
    env: &Env,
    config: &OcrRuntimeConfig,
    job: ocr_job::Model,
    extractor_job_id: Uuid,
    response: ExtractorJobRsp,
) -> anyhow::Result<()> {
    let stored =
        prepare_and_store_result(env, config, job.media_id, extractor_job_id)
            .await;
    let (object_key, html_size_bytes, html) = match stored {
        Ok(stored) => stored,
        Err(err) => {
            retry_job(&env.dbx, job, err.to_string(), true)
                .await
                .context(h!())?;
            return Ok(());
        }
    };
    let now = Utc::now().naive_utc();
    let media_id = job.media_id;
    let force_summary = job.force_summary;
    let mut job = job.into_active_model();
    job.state = Set("completed".to_string());
    let quality_status = response.quality_status;
    job.quality_status = Set(quality_status.clone());
    job.processed_pages = Set(response.page_progress.processed);
    job.total_pages = Set(response.page_progress.total);
    job.html_s3_key = Set(Some(object_key));
    job.html_size_bytes = Set(Some(html_size_bytes));
    job.last_error = Set(response.error_summary.map(truncate_error));
    job.completed_at = Set(Some(now));
    job.updated_at = Set(now);
    job.force_summary = Set(false);
    job.update(&env.dbx).await.context(h!())?;
    if matches!(quality_status.as_deref(), Some("accepted" | "degraded")) {
        enqueue_media_summary(env, media_id, &html, force_summary)
            .await
            .unwrap_or_else(|err| {
                error!("failed to enqueue media summary: {err:#?}")
            });
    }
    Ok(())
}

async fn enqueue_media_summary(
    env: &Env,
    media_id: Uuid,
    html: &str,
    force: bool,
) -> anyhow::Result<()> {
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    if !matches!(
        source_mime(&media),
        "application/pdf" | "image/jpeg" | "image/png"
    ) {
        return Ok(());
    }
    let text = crate::media_summary::plain_text_from_sanitized_html(html)
        .context(h!())?;
    let enqueued = if force {
        crate::media_summary::enqueue_for_reprocessing(
            &env.dbx, media_id, "ocr_text", &text,
        )
        .await
        .context(h!())?
    } else {
        crate::media_summary::enqueue(&env.dbx, media_id, "ocr_text", &text)
            .await
            .context(h!())?
    };
    if enqueued {
        fanout_mult(
            &mut env.redis.clone(),
            vec![EventMsg::new(EventType::ETInboxChanged(
                media.signal_message_id,
            ))],
        )
        .await
        .context(h!())?;
    }
    Ok(())
}

async fn prepare_and_store_result(
    env: &Env,
    config: &OcrRuntimeConfig,
    media_id: Uuid,
    extractor_job_id: Uuid,
) -> anyhow::Result<(String, i64, String)> {
    let result = download_result(&env.rq, config, extractor_job_id)
        .await
        .context(h!())?;
    let html =
        tokio::task::spawn_blocking(move || stored_html_from_zip(result))
            .await
            .context(h!())?
            .context(h!())?;
    let object_key = ocr_result_key(&config.instance_id, media_id);
    let app_s3_config = env.config.s3_config.as_ref().context(h!())?;
    let s3_config = env.s3_config.as_ref().context(h!())?;
    storage::upload_encrypted_to_s3_with_operator(
        &env.s3,
        s3_config,
        &app_s3_config.strongbox_key,
        &object_key,
        html.as_bytes(),
    )
    .await
    .context(h!())?;
    let html_size_bytes = i64::try_from(html.len()).context(h!())?;
    Ok((object_key, html_size_bytes, html))
}

async fn download_result(
    client: &reqwest::Client,
    config: &OcrRuntimeConfig,
    extractor_job_id: Uuid,
) -> anyhow::Result<Vec<u8>> {
    let response = client
        .get(format!(
            "{}/v1/jobs/{extractor_job_id}/result",
            config.base_url
        ))
        .bearer_auth(&config.token)
        .timeout(Duration::from_secs(crate::config::OCR_HTTP_TIMEOUT_SECS))
        .send()
        .await
        .context(h!())?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("OCR result returned HTTP {status}");
    }
    if response
        .content_length()
        .is_some_and(|length| length > OCR_MAX_RESULT_BYTES)
    {
        anyhow::bail!("OCR result exceeds the download size limit");
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.try_next().await.context(h!())? {
        if bytes.len().saturating_add(chunk.len())
            > usize::try_from(OCR_MAX_RESULT_BYTES).context(h!())?
        {
            anyhow::bail!("OCR result exceeds the download size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch_source(
    env: &Env,
    media: &signal_message_media::Model,
) -> anyhow::Result<Vec<u8>> {
    let size = u64::try_from(media.size_bytes).context(h!())?;
    if size > OCR_MAX_SOURCE_BYTES {
        anyhow::bail!("OCR source exceeds the input size limit");
    }
    if media.is_encrypted {
        return fetch_media_bytes(env, media).await.context(h!());
    }
    let mut stream = stream_plaintext_media_range(env, media, 0..size)
        .await
        .context(h!())?;
    let mut bytes = Vec::with_capacity(usize::try_from(size).context(h!())?);
    while let Some(chunk) = stream.try_next().await.context(h!())? {
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != usize::try_from(size).context(h!())? {
        anyhow::bail!("OCR source changed while downloading");
    }
    Ok(bytes)
}

async fn update_submitted_progress(
    dbx: &DatabaseConnection,
    job: ocr_job::Model,
    response: &ExtractorJobRsp,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    let mut job = job.into_active_model();
    job.processed_pages = Set(response.page_progress.processed);
    job.total_pages = Set(response.page_progress.total);
    job.quality_status = Set(response.quality_status.clone());
    job.last_error = Set(response.error_summary.clone().map(truncate_error));
    job.next_attempt_at = Set(now + poll_delay());
    job.updated_at = Set(now);
    job.update(dbx).await.context(h!())?;
    Ok(())
}

async fn postpone_for_dependency(
    dbx: &DatabaseConnection,
    job: ocr_job::Model,
    error: String,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    let preserve_submitted = job.state == "submitted";
    let mut job = job.into_active_model();
    if !preserve_submitted {
        job.state = Set("retry_wait".to_string());
    }
    job.last_error = Set(Some(truncate_error(error)));
    job.next_attempt_at =
        Set(now + ChronoDuration::seconds(OCR_RETRY_MAX_SECS));
    job.updated_at = Set(now);
    job.update(dbx).await.context(h!())?;
    Ok(())
}

async fn retry_job(
    dbx: &DatabaseConnection,
    job: ocr_job::Model,
    error: String,
    preserve_submitted: bool,
) -> anyhow::Result<()> {
    let attempts = job.attempts + 1;
    if attempts >= OCR_MAX_ATTEMPTS {
        return mark_failed(dbx, job, error, None).await.context(h!());
    }
    let now = Utc::now().naive_utc();
    let mut job = job.into_active_model();
    job.state = Set(if preserve_submitted {
        "submitted".to_string()
    } else {
        "retry_wait".to_string()
    });
    job.attempts = Set(attempts);
    job.last_error = Set(Some(truncate_error(error)));
    job.next_attempt_at =
        Set(now + ChronoDuration::seconds(retry_delay(attempts)));
    job.updated_at = Set(now);
    job.update(dbx).await.context(h!())?;
    Ok(())
}

async fn mark_failed(
    dbx: &DatabaseConnection,
    job: ocr_job::Model,
    error: String,
    quality_status: Option<String>,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    let mut job = job.into_active_model();
    job.state = Set("failed".to_string());
    job.quality_status =
        Set(quality_status.or_else(|| Some("failed".to_string())));
    job.last_error = Set(Some(truncate_error(error)));
    job.completed_at = Set(Some(now));
    job.updated_at = Set(now);
    job.update(dbx).await.context(h!())?;
    Ok(())
}

fn source_mime(media: &signal_message_media::Model) -> &'static str {
    let value = media.content_type.to_ascii_lowercase();
    let extension = media
        .file_ext
        .as_deref()
        .or_else(|| {
            media
                .file_name
                .as_deref()
                .and_then(|name| std::path::Path::new(name).extension())
                .and_then(|extension| extension.to_str())
        })
        .unwrap_or_default();
    if value.starts_with("application/pdf")
        || extension.eq_ignore_ascii_case("pdf")
    {
        "application/pdf"
    } else if value.starts_with("image/png")
        || extension.eq_ignore_ascii_case("png")
    {
        "image/png"
    } else {
        "image/jpeg"
    }
}

fn source_file_name(media: &signal_message_media::Model) -> String {
    let extension = match source_mime(media) {
        "application/pdf" => "pdf",
        "image/png" => "png",
        _ => "jpg",
    };
    format!("{}.{}", media.id, extension)
}

fn idempotency_key(config: &OcrRuntimeConfig, job: &ocr_job::Model) -> String {
    format!(
        "echo-ocr:{}",
        sha256::digest(format!(
            "{}:{}:{}",
            config.instance_id,
            job.media_id,
            job.discovered_at.and_utc().timestamp_micros()
        ))
    )
}

fn retry_delay(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1)).unwrap_or(0);
    OCR_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(OCR_RETRY_MAX_SECS)
}

fn poll_delay() -> ChronoDuration {
    ChronoDuration::milliseconds(
        i64::try_from(OCR_POLL_SLEEP_MS).unwrap_or(5_000),
    )
}

fn truncate_error(error: String) -> String {
    error.chars().take(OCR_MAX_ERROR_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::{idempotency_key, retry_delay};
    use crate::entities::ocr_job;
    use crate::ocr::OcrRuntimeConfig;
    use chrono::Utc;
    use uuid::Uuid;

    #[test]
    fn ocr_retry_delay_is_bounded() {
        assert_eq!(retry_delay(1), 10);
        assert_eq!(retry_delay(2), 20);
        assert_eq!(retry_delay(20), 900);
    }

    #[test]
    fn ocr_reprocessing_generation_changes_idempotency_key() {
        let config = OcrRuntimeConfig {
            base_url: "https://ocr.example.test".to_string(),
            instance_id: "test-instance".to_string(),
            token: "token".to_string(),
        };
        let now = Utc::now().naive_utc();
        let job = ocr_job::Model {
            media_id: Uuid::now_v7(),
            state: "queued".to_string(),
            extractor_job_id: None,
            attempts: 0,
            next_attempt_at: now,
            last_error: None,
            quality_status: None,
            processed_pages: 0,
            total_pages: 0,
            html_s3_key: None,
            html_size_bytes: None,
            discovered_at: now,
            submitted_at: None,
            completed_at: None,
            updated_at: now,
            force_summary: false,
        };
        let first = idempotency_key(&config, &job);
        let mut reprocessed = job;
        reprocessed.discovered_at += chrono::Duration::microseconds(1);

        assert_ne!(first, idempotency_key(&config, &reprocessed));
    }
}
