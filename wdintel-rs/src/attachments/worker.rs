use super::store::{execute, queue, rows};
use crate::{
    config::*,
    entities::{
        attachment_document, attachment_settings, signal_message_media,
    },
    h,
    types::{Env, ShortContext},
};
use futures_util::TryStreamExt;
use sea_orm::{EntityTrait, FromQueryResult, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(FromQueryResult, Clone)]
pub struct Job {
    pub id: Uuid,
    pub media_id: Uuid,
    pub generation: Uuid,
    pub kind: String,
    pub lease: Uuid,
    pub attempts: i32,
    pub payload: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct Package {
    pub sections: Vec<Section>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub images: Vec<serde_json::Value>,
    #[serde(default)]
    pub complete: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Section {
    pub member: String,
    pub locator: String,
    pub text: String,
    pub markdown: String,
    pub html: String,
}

pub async fn run(env: Arc<Env>, cancel: CancellationToken, kind: &'static str) {
    let mut next_search_cleanup = std::time::Instant::now();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        if kind == "extract" && std::time::Instant::now() >= next_search_cleanup
        {
            if let Err(error) =
                super::analytics::reconcile_search_changes(&env.dbx).await
            {
                crate::types::error!(
                    "attachment search change reconciliation: {error:#}"
                );
            }
            next_search_cleanup = std::time::Instant::now()
                + Duration::from_secs(
                    ATTACHMENT_SEARCH_CHANGE_CLEANUP_INTERVAL_SECS,
                );
        }
        match step(&env, kind).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                crate::types::error!("attachment {kind} worker: {error:#}")
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(ATTACHMENT_WORKER_SLEEP_SECS)) => {},
        }
    }
}

async fn step(env: &Env, kind: &str) -> anyhow::Result<bool> {
    let settings = attachment_settings::Entity::find_by_id(1i16)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    if !settings.enabled
        || (kind == "positions" && !settings.positions_enabled)
        || (kind == "summary" && !settings.summaries_enabled)
    {
        return Ok(false);
    }
    if kind == "extract" && !settings.backfill_complete {
        discover(env).await.c(h!())?;
    }
    let Some(job) = claim_job(&env.dbx, kind).await.c(h!())? else {
        return Ok(false);
    };
    process_job(env, kind, &settings, job).await.c(h!())?;
    Ok(true)
}

async fn claim_job<C>(db: &C, kind: &str) -> anyhow::Result<Option<Job>>
where
    C: sea_orm::ConnectionTrait,
{
    let lease = Uuid::now_v7();
    rows::<Job,_>(db, "with selected as (
      select job.id from attachment_job job
      where job.kind=$1 and job.next_attempt_at <= now() at time zone 'utc'
      and job.state in ('queued','retry_wait','running')
      and (job.state in ('queued','retry_wait') or job.state='running' and job.lease_until < now() at time zone 'utc')
      and exists (
        select 1 from attachment_document doc
        join signal_message_media media on media.id=doc.media_id
        join signal_message message on message.id=media.signal_message_id and not message.deleted
        where doc.media_id=job.media_id and doc.generation=job.generation
        offset 0
      )
      order by job.created_at desc,job.id limit 1 for update of job skip locked
    ) update attachment_job job set state='running',lease=$2,
       lease_until=(now() at time zone 'utc') + make_interval(secs=>$3),
       attempts=attempts+1,updated_at=now() at time zone 'utc'
      from selected where job.id=selected.id returning job.*",
      vec![kind.into(),lease.into(),(ATTACHMENT_LEASE_SECS as f64).into()]).await.c(h!()).map(|mut jobs| jobs.pop())
}

async fn process_job(
    env: &Env,
    kind: &str,
    settings: &attachment_settings::Model,
    job: Job,
) -> anyhow::Result<()> {
    let outcome = match kind {
        "extract" => extract(env, &job).await,
        "summary" => {
            super::enrich::summarize(env, &job, settings.ai_engine_id).await
        }
        "positions" => {
            super::enrich::positions(env, &job, settings.position_engine_id)
                .await
        }
        "inspect" => super::inspection::process(env, &job).await,
        _ => unreachable!(),
    };
    match outcome {
        Ok(done) => {
            execute(&env.dbx, "update attachment_job set state=$3,lease=null,lease_until=null,
              attempts=case when $3='queued' then greatest(attempts-1,0) else attempts end,
              next_attempt_at=(now() at time zone 'utc') + interval '10 seconds',
              updated_at=now() at time zone 'utc' where id=$1 and lease=$2",
              vec![job.id.into(),job.lease.into(),(if done { "completed" } else { "queued" }).into()]).await.c(h!())?;
        }
        Err(error) => {
            let error: String = format!("{error:#}")
                .chars()
                .take(OCR_MAX_ERROR_CHARS)
                .collect();
            let terminal = job.attempts >= ATTACHMENT_MAX_ATTEMPTS;
            let changed = execute(&env.dbx, "update attachment_job set state=$3,last_error=$4,lease=null,lease_until=null,
              next_attempt_at=(now() at time zone 'utc') + make_interval(secs=>$5),
              updated_at=now() at time zone 'utc' where id=$1 and lease=$2",
              vec![job.id.into(),job.lease.into(),(if terminal { "failed" } else { "retry_wait" }).into(),
                error.clone().into(),(10.0*2f64.powi(job.attempts.min(6))).into()]).await.c(h!())?;
            if changed == 0 {
                return Ok(());
            }
            execute(&env.dbx, "update attachment_document set last_error=$3,updated_at=now() at time zone 'utc',
              state=case when $4='extract' and $5 then 'failed' else state end,
              summary_state=case when $4='summary' and $5 then 'failed' else summary_state end,
              position_state=case when $4='positions' and $5 then 'failed' else position_state end
              where media_id=$1 and generation=$2",
              vec![job.media_id.into(),job.generation.into(),error.into(),kind.into(),terminal.into()]).await.c(h!())?;
        }
    }
    Ok(())
}

async fn discover(env: &Env) -> anyhow::Result<()> {
    let tx = env.dbx.begin().await.c(h!())?;
    execute(&tx,"with batch as (
      select media.id from signal_message_media media,attachment_settings settings
      where settings.id=1 and (settings.backfill_cursor is null or media.id<settings.backfill_cursor)
      order by media.id desc limit $1
    ), inserted as (
      insert into attachment_document(media_id) select id from batch on conflict do nothing returning media_id,generation
    ), jobs as (
      insert into attachment_job(media_id,generation,kind,created_at)
      select inserted.media_id,inserted.generation,'extract',media.created_at
      from inserted join signal_message_media media on media.id=inserted.media_id on conflict do nothing
    ) update attachment_settings set backfill_cursor=coalesce((select id from batch order by id limit 1),backfill_cursor),
      backfill_complete=not exists(select 1 from batch) where id=1",vec![ATTACHMENT_BATCH_SIZE.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(())
}

async fn extract(env: &Env, job: &Job) -> anyhow::Result<bool> {
    let media = signal_message_media::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    anyhow::ensure!(
        media.size_bytes >= 0
            && media.size_bytes as u64 <= OCR_MAX_SOURCE_BYTES,
        "attachment exceeds input limit"
    );
    let name = media.file_name.clone().unwrap_or_else(|| {
        format!(
            "{}.{}",
            media.id,
            media.file_ext.as_deref().unwrap_or("bin")
        )
    });
    let extension = std::path::Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .or(media.file_ext.as_deref())
        .unwrap_or("")
        .to_ascii_lowercase();
    let document = attachment_document::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    if matches!(extension.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "jpe")
        || media.content_type.starts_with("image/")
        || media.content_type == "application/pdf"
    {
        return extract_ocr(env, job, &name).await.c(h!());
    }
    if !matches!(
        extension.as_str(),
        "docx"
            | "doc"
            | "rtf"
            | "odt"
            | "xlsx"
            | "xlsm"
            | "xls"
            | "ods"
            | "pptx"
            | "ppt"
            | "odp"
            | "txt"
            | "md"
            | "markdown"
            | "html"
            | "htm"
            | "csv"
            | "json"
            | "xml"
            | "zip"
            | "rar"
            | "7z"
    ) {
        if crate::config::SIGINT_MEDIA_KMZ_CONVERSION_EXTENSIONS
            .contains(&extension.as_str())
        {
            return super::enrich::extract_map(env, job, &media, &name)
                .await
                .c(h!());
        }
        execute(&env.dbx,"update attachment_document set state='unsupported',last_error='Unsupported content format' where media_id=$1 and generation=$2",vec![job.media_id.into(),job.generation.into()]).await.c(h!())?;
        return Ok(true);
    }
    let config = super::store::extractor_config(env).c(h!())?;
    if let Some(id) = document.extractor_job_id {
        let response = env
            .rq
            .get(format!("{}/v1/jobs/{id}", config.base_url))
            .bearer_auth(&config.token)
            .send()
            .await
            .c(h!())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            execute(&env.dbx,"update attachment_document set extractor_job_id=null where media_id=$1 and generation=$2",vec![job.media_id.into(),job.generation.into()]).await.c(h!())?;
            return Ok(false);
        }
        let response: serde_json::Value =
            response.error_for_status().c(h!())?.json().await.c(h!())?;
        match response["state"].as_str() {
            Some("completed") => {
                let response = env
                    .rq
                    .get(format!("{}/v1/jobs/{id}/result", config.base_url))
                    .bearer_auth(&config.token)
                    .send()
                    .await
                    .c(h!())?
                    .error_for_status()
                    .c(h!())?;
                let bytes = bounded_response(response).await.c(h!())?;
                let mut package = unpack(&bytes).c(h!())?;
                for section in &mut package.sections {
                    section.member = match section.member.split_once("!/") {
                        Some((_, member)) => format!("{name}!/{member}"),
                        None => name.clone(),
                    };
                }
                publish(env, job, package, bytes).await.c(h!())?;
                return Ok(true);
            }
            Some("failed" | "cancelled") => {
                anyhow::bail!("extractor failed: {}", response["error_summary"])
            }
            _ => return Ok(false),
        }
    }
    let bytes = source_bytes(env, &media).await.c(h!())?;
    let safe_name = format!("attachment.{extension}");
    let manifest = serde_json::json!({"schema_version":1,"inputs":[safe_name],"metadata":{"attachment_native":true}});
    let part = reqwest::multipart::Part::bytes(bytes).file_name(safe_name);
    let response = env
        .rq
        .post(format!("{}/v1/jobs", config.base_url))
        .bearer_auth(&config.token)
        .header(
            "Idempotency-Key",
            format!(
                "attachment-{}-{}-{}",
                config.instance_id, job.media_id, job.generation
            ),
        )
        .multipart(
            reqwest::multipart::Form::new()
                .part("files", part)
                .text("manifest", manifest.to_string()),
        )
        .send()
        .await
        .c(h!())?;
    if matches!(
        response.status(),
        reqwest::StatusCode::TOO_MANY_REQUESTS
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
    ) {
        return Ok(false);
    }
    let response = response.error_for_status().c(h!())?;
    let response: serde_json::Value = response.json().await.c(h!())?;
    execute(&env.dbx,"update attachment_document set extractor_job_id=$3,state='extracting',updated_at=now() at time zone 'utc' where media_id=$1 and generation=$2",
        vec![job.media_id.into(),job.generation.into(),response["id"].as_str().c(h!())?.into()]).await.c(h!())?;
    Ok(false)
}

pub(super) async fn extract_ocr(
    env: &Env,
    job: &Job,
    name: &str,
) -> anyhow::Result<bool> {
    use crate::entities::ocr_job;
    let ocr = ocr_job::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(ocr) = ocr {
        if ocr.state == "completed"
            && matches!(
                ocr.quality_status.as_deref(),
                Some("accepted" | "degraded")
            )
        {
            let html = crate::ocr::load_sanitized_ocr_html(env, job.media_id)
                .await
                .c(h!())?;
            let mut package = html_package(name, &html).c(h!())?;
            if ocr.quality_status.as_deref() == Some("degraded") {
                package.warnings.push("OCR quality is degraded".into());
            }
            publish(env, job, package, html.into_bytes())
                .await
                .c(h!())?;
            return Ok(true);
        }
        anyhow::ensure!(
            ocr.state != "failed"
                && ocr.quality_status.as_deref() != Some("failed"),
            "OCR failed; retry from OCR administration"
        );
    } else if let Some(engine) =
        crate::ocr::main_ocr_engine(&env.dbx).await.c(h!())?
    {
        execute(&env.dbx,"insert into ocr_job(media_id,ai_engine_id,ai_engine_name,model_name,ocr_request_profile) values($1,$2,$3,$4,$5) on conflict do nothing",
            vec![job.media_id.into(),engine.id.into(),engine.name.into(),engine.model_name.into(),engine.ocr_request_profile.into()]).await.c(h!())?;
    }
    Ok(false)
}

pub fn html_package(name: &str, html: &str) -> anyhow::Result<Package> {
    let dom = tl::parse(html, tl::ParserOptions::default()).c(h!())?;
    let mut package = Package {
        complete: true,
        ..Default::default()
    };
    let sections: Vec<_> = dom
        .query_selector("section")
        .into_iter()
        .flatten()
        .collect();
    if sections.is_empty() {
        append_html(&mut package, name, "document", html).c(h!())?;
    } else {
        for (index, handle) in sections.into_iter().enumerate() {
            if let Some(node) = handle.get(dom.parser()) {
                append_html(
                    &mut package,
                    name,
                    &format!("page {}", index + 1),
                    &node.outer_html(dom.parser()),
                )
                .c(h!())?;
            }
        }
    }
    Ok(package)
}

pub(crate) fn append_html(
    package: &mut Package,
    name: &str,
    locator: &str,
    html: &str,
) -> anyhow::Result<()> {
    let markdown =
        crate::media_summary::plain_text_from_sanitized_html(html).c(h!())?;
    let chars: Vec<char> = markdown.chars().collect();
    for offset in (0..chars.len())
        .step_by(ATTACHMENT_CHUNK_CHARS - ATTACHMENT_CHUNK_OVERLAP)
    {
        let text: String = chars
            [offset..(offset + ATTACHMENT_CHUNK_CHARS).min(chars.len())]
            .iter()
            .collect();
        package.sections.push(Section {
            member: name.into(),
            locator: format!("{locator}; character {offset}"),
            html: crate::ocr::package::sanitize_html_without_images(&format!(
                "<p>{}</p>",
                text.replace('&', "&amp;").replace('<', "&lt;")
            )),
            markdown: text.clone(),
            text,
        });
        if offset + ATTACHMENT_CHUNK_CHARS >= chars.len() {
            break;
        }
    }
    Ok(())
}

pub async fn source_bytes(
    env: &Env,
    media: &signal_message_media::Model,
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        media.size_bytes >= 0
            && media.size_bytes as u64 <= OCR_MAX_SOURCE_BYTES,
        "attachment exceeds input limit"
    );
    if media.is_encrypted {
        return crate::messenger::media::fetch_media_bytes(env, media)
            .await
            .c(h!());
    }
    let mut stream = crate::messenger::media::stream_plaintext_media_range(
        env,
        media,
        0..media.size_bytes as u64,
    )
    .await
    .c(h!())?;
    let mut bytes = Vec::new();
    while let Some(part) = stream.try_next().await.c(h!())? {
        anyhow::ensure!(
            bytes.len() + part.len() <= ATTACHMENT_MAX_RESULT_BYTES,
            "attachment exceeds input limit"
        );
        bytes.extend_from_slice(&part);
    }
    Ok(bytes)
}

pub(crate) async fn bounded_response(
    response: reqwest::Response,
) -> anyhow::Result<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(part) = stream.try_next().await.c(h!())? {
        anyhow::ensure!(
            bytes.len() + part.len() <= ATTACHMENT_MAX_RESULT_BYTES,
            "extractor result too large"
        );
        bytes.extend_from_slice(&part);
    }
    Ok(bytes)
}

pub(crate) fn unpack(bytes: &[u8]) -> anyhow::Result<Package> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).c(h!())?;
    let manifest = read_entry(&mut archive, "manifest.json").c(h!())?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest).c(h!())?;
    anyhow::ensure!(
        manifest["format"] == "attachment_document_v1",
        "unknown attachment package format"
    );
    let hashes = manifest["file_hashes"].as_object().c(h!())?;
    anyhow::ensure!(
        archive.len() == hashes.len() + 1,
        "attachment manifest coverage mismatch"
    );
    let mut expanded = 0usize;
    let mut document = None;
    for (name, digest) in hashes {
        anyhow::ensure!(
            !name.starts_with('/') && !name.split('/').any(|part| part == ".."),
            "unsafe package member"
        );
        let data = read_entry(&mut archive, name).c(h!())?;
        expanded += data.len();
        anyhow::ensure!(
            expanded <= ATTACHMENT_MAX_RESULT_BYTES,
            "attachment package expanded limit"
        );
        anyhow::ensure!(
            digest.as_str() == Some(sha256::digest(&data).as_str()),
            "attachment package checksum mismatch"
        );
        if name == "document.json" {
            document = Some(data);
        }
    }
    serde_json::from_slice(&document.c(h!())?).c(h!())
}

fn read_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> anyhow::Result<Vec<u8>> {
    let file = archive.by_name(name).c(h!())?;
    anyhow::ensure!(
        file.size() <= ATTACHMENT_MAX_RESULT_BYTES as u64,
        "oversized package member"
    );
    let mut bytes = Vec::new();
    file.take(ATTACHMENT_MAX_RESULT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .c(h!())?;
    anyhow::ensure!(
        bytes.len() <= ATTACHMENT_MAX_RESULT_BYTES,
        "oversized package member"
    );
    Ok(bytes)
}

pub async fn publish(
    env: &Env,
    job: &Job,
    mut package: Package,
    bytes: Vec<u8>,
) -> anyhow::Result<()> {
    let revision = Uuid::now_v7();
    let key = format!(
        "{}{}/{revision}",
        super::store::artifact_prefix(&env.config),
        job.media_id
    );
    let config = env.config.s3_config.as_ref().c(h!())?;
    crate::storage::upload_encrypted_to_s3_with_operator(
        &env.s3,
        env.s3_config.as_ref().c(h!())?,
        &config.strongbox_key,
        &key,
        bytes.into(),
    )
    .await
    .c(h!())?;
    let result = publish_chunks(env, job, &key, revision, &mut package).await;
    match result {
        Ok(previous) => {
            if let Some(published) = previous {
                if let Some(previous) = published.previous_artifact {
                    super::store::delete_artifact(env, &previous).await;
                }
                crate::media_summary::publish_inbox_change(env, job.media_id)
                    .await
                    .c(h!())?;
            }
            Ok(())
        }
        Err(error) => {
            super::store::delete_artifact(env, &key).await;
            Err(error)
        }
    }
}

struct PublishedRevision {
    previous_artifact: Option<String>,
}

async fn publish_chunks(
    env: &Env,
    job: &Job,
    key: &str,
    revision: Uuid,
    package: &mut Package,
) -> anyhow::Result<Option<PublishedRevision>> {
    if !package.images.is_empty() {
        package.complete = false;
        package.warnings.push(format!(
            "{} embedded image(s) await OCR",
            package.images.len()
        ));
    }
    let tx = env.dbx.begin().await.c(h!())?;
    use sea_orm::QuerySelect;
    let previous = attachment_document::Entity::find_by_id(job.media_id)
        .lock_exclusive()
        .one(&tx)
        .await
        .c(h!())?
        .c(h!())?;
    if previous.generation != job.generation {
        tx.rollback().await.c(h!())?;
        super::store::delete_artifact(env, key).await;
        return Ok(None);
    }
    super::enrich::renew(&tx, job).await.c(h!())?;

    let updated=execute(&tx,"update attachment_document set revision=$3,state='completed',quality=$4,complete=$5,
      artifact_key=$6,chunk_count=$7,warnings=$8,last_error=null,summary=null,summary_state='queued',position_state='queued',
      updated_at=now() at time zone 'utc' where media_id=$1 and generation=$2
      and exists(select 1 from attachment_job where id=$9 and lease=$10 and lease_until>now() at time zone 'utc')",
      vec![job.media_id.into(),job.generation.into(),revision.into(),(if package.warnings.is_empty(){"accepted"}else{"degraded"}).into(),
        package.complete.into(),key.into(),(package.sections.len() as i32).into(),serde_json::json!(package.warnings).into(),job.id.into(),job.lease.into()]).await.c(h!())?;
    anyhow::ensure!(updated == 1, "attachment publication lease lost");
    execute(
        &tx,
        "delete from attachment_chunk where media_id=$1",
        vec![job.media_id.into()],
    )
    .await
    .c(h!())?;
    execute(
        &tx,
        "delete from media_summary where media_id=$1",
        vec![job.media_id.into()],
    )
    .await
    .c(h!())?;
    for (ordinal, section) in std::mem::take(&mut package.sections)
        .into_iter()
        .enumerate()
    {
        anyhow::ensure!(
            section.text.chars().count() <= ATTACHMENT_CHUNK_CHARS,
            "oversized source chunk"
        );
        let coordinates = super::enrich::coordinates(
            &section.text,
            &format!("{} — {}", section.member, section.locator),
        )
        .await
        .c(h!())?;
        execute(&tx,"insert into attachment_chunk(media_id,revision,ordinal,member,locator,text,markdown,html,coordinates) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          vec![job.media_id.into(),revision.into(),(ordinal as i32).into(),section.member.into(),section.locator.into(),section.text.into(),section.markdown.into(),crate::ocr::package::sanitize_html_without_images(&section.html).into(),coordinates.into()]).await.c(h!())?;
    }
    queue(&tx, job.media_id, job.generation, "summary")
        .await
        .c(h!())?;
    queue(&tx, job.media_id, job.generation, "positions")
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(Some(PublishedRevision {
        previous_artifact: previous.artifact_key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::tests::{attachment, fixture};
    use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};

    #[tokio::test]
    #[serial_test::serial]
    async fn attachment_claim_preserves_eligibility_and_newest_first_3780() {
        let (env, _, message) = fixture().await;
        let mut jobs = Vec::new();
        for name in ["old", "new", "future", "leased", "stale", "done"] {
            jobs.push(attachment(&env, message, name).await);
        }
        execute(&env.dbx, "update attachment_job set state='queued',lease=null,lease_until=null,next_attempt_at=now() at time zone 'utc'-interval '1 minute',created_at=(now() at time zone 'utc')+make_interval(secs=>array_position($1::uuid[],id)) where id=any($1::uuid[])", vec![jobs.iter().map(|job| job.id).collect::<Vec<_>>().into()]).await.unwrap();
        execute(&env.dbx, "update attachment_job set next_attempt_at=(now() at time zone 'utc')+interval '1 hour' where id=$1", vec![jobs[2].id.into()]).await.unwrap();
        execute(&env.dbx, "update attachment_job set state='running',lease=gen_random_uuid(),lease_until=(now() at time zone 'utc')+interval '1 hour' where id=$1", vec![jobs[3].id.into()]).await.unwrap();
        execute(&env.dbx, "update attachment_job set generation=gen_random_uuid() where id=$1", vec![jobs[4].id.into()]).await.unwrap();
        execute(
            &env.dbx,
            "update attachment_job set state='completed' where id=$1",
            vec![jobs[5].id.into()],
        )
        .await
        .unwrap();
        assert!(claim_job(&env.dbx, "summary").await.unwrap().is_none());
        let newest = claim_job(&env.dbx, "extract").await.unwrap().unwrap();
        assert_eq!(newest.id, jobs[1].id);
        assert_eq!(
            claim_job(&env.dbx, "extract").await.unwrap().unwrap().id,
            jobs[0].id
        );
        assert!(claim_job(&env.dbx, "extract").await.unwrap().is_none());
        execute(&env.dbx, "update attachment_job set lease_until=(now() at time zone 'utc')-interval '1 second' where id=$1", vec![newest.id.into()]).await.unwrap();
        let reclaimed = claim_job(&env.dbx, "extract").await.unwrap().unwrap();
        assert_eq!(reclaimed.id, newest.id);
        assert_ne!(reclaimed.lease, newest.lease);
        assert_eq!(reclaimed.attempts, newest.attempts + 1);
        execute(
            &env.dbx,
            "update signal_message set deleted=true where id=$1",
            vec![message.into()],
        )
        .await
        .unwrap();
        execute(&env.dbx, "update attachment_job set state='queued',next_attempt_at=now() at time zone 'utc' where id=$1", vec![jobs[0].id.into()]).await.unwrap();
        assert!(claim_job(&env.dbx, "extract").await.unwrap().is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn attachment_claim_skips_locks_and_never_leases_twice_3780() {
        let (env, _, message) = fixture().await;
        let first = attachment(&env, message, "first").await;
        let second = attachment(&env, message, "second").await;
        let third = attachment(&env, message, "third").await;
        let ids = vec![first.id, second.id, third.id];
        execute(&env.dbx, "update attachment_job set state='retry_wait',lease=null,lease_until=null,next_attempt_at=(now() at time zone 'utc')-interval '1 minute',created_at='2026-10-01'::timestamp where id=any($1::uuid[])", vec![ids.clone().into()]).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        txn.query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select id from attachment_job where id=$1 for update",
            [first.id.into()],
        ))
        .await
        .unwrap();
        let (a, b) = tokio::join!(
            claim_job(&env.dbx, "extract"),
            claim_job(&env.dbx, "extract")
        );
        let a = a.unwrap().unwrap();
        let b = b.unwrap().unwrap();
        assert_ne!(a.id, b.id);
        assert_ne!(a.id, first.id);
        assert_ne!(b.id, first.id);
        assert!(claim_job(&env.dbx, "extract").await.unwrap().is_none());
        txn.rollback().await.unwrap();
        assert_eq!(
            claim_job(&env.dbx, "extract").await.unwrap().unwrap().id,
            first.id
        );
    }
    #[tokio::test]
    #[serial_test::serial]
    #[ignore = "250k-row local claim benchmark"]
    async fn attachment_claim_scale_benchmark_3780() {
        let (env, _, _) = fixture().await;
        let txn = env.dbx.begin().await.unwrap();
        txn.execute_unprepared(r#"
            set local statement_timeout='15s';
            set local jit=off;
            create temporary table signal_message (id bigint primary key, deleted boolean) on commit drop;
            create temporary table signal_message_media (id uuid primary key, signal_message_id bigint) on commit drop;
            create temporary table attachment_document (media_id uuid primary key, generation uuid) on commit drop;
            create temporary table attachment_job (
                id uuid primary key, media_id uuid, generation uuid, kind text,
                created_at timestamp, state text, next_attempt_at timestamp,
                lease uuid, lease_until timestamp, attempts integer default 0,
                updated_at timestamp, payload jsonb default '{}'
            ) on commit drop;
            insert into signal_message select id,false from generate_series(1,250000) id;
            insert into signal_message_media select md5(id::text)::uuid,id from signal_message;
            insert into attachment_document select id,md5('generation:'||signal_message_id)::uuid from signal_message_media;
            insert into attachment_job (id,media_id,generation,kind,created_at,state,next_attempt_at)
            select md5('job:'||media.signal_message_id)::uuid,media.id,doc.generation,'extract',
                   '2026-10-01'::timestamp+media.signal_message_id*interval '1 millisecond',
                   case when media.signal_message_id<100000 then 'completed' else 'queued' end,
                   '2020-01-01'::timestamp
            from signal_message_media media join attachment_document doc on doc.media_id=media.id;
            create index attachment_job_due_idx on attachment_job(kind,next_attempt_at,created_at,id)
                where state in ('queued','retry_wait','running');
            analyze signal_message; analyze signal_message_media;
            analyze attachment_document; analyze attachment_job;
        "#).await.unwrap();
        let original = r#"with selected as (
      select job.id from attachment_job job
      join attachment_document doc on doc.media_id=job.media_id and doc.generation=job.generation
      join signal_message_media media on media.id=job.media_id
      join signal_message message on message.id=media.signal_message_id and not message.deleted
      where job.kind=$1 and job.next_attempt_at <= now() at time zone 'utc'
      and (job.state in ('queued','retry_wait') or job.state='running' and job.lease_until < now() at time zone 'utc')
      order by job.created_at desc,job.id limit 1 for update of job skip locked
    ) update attachment_job job set state='running',lease=$2,
       lease_until=(now() at time zone 'utc') + make_interval(secs=>$3),
       attempts=attempts+1,updated_at=now() at time zone 'utc'
      from selected where job.id=selected.id returning job.*"#;
        let mut timings = Vec::new();
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let old = rows::<Job, _>(
                &txn,
                original,
                vec![
                    "extract".into(),
                    Uuid::now_v7().into(),
                    (ATTACHMENT_LEASE_SECS as f64).into(),
                ],
            )
            .await
            .unwrap()
            .pop()
            .unwrap();
            let old_ms = started.elapsed().as_secs_f64() * 1000.0;
            txn.execute_unprepared("create index attachment_job_claim_idx on attachment_job(kind,created_at desc,id) where state in ('queued','retry_wait','running')").await.unwrap();
            execute(&txn,"update attachment_job set state='queued',lease=null,lease_until=null where id=$1",vec![old.id.into()]).await.unwrap();
            let started = std::time::Instant::now();
            let new = claim_job(&txn, "extract").await.unwrap().unwrap();
            let new_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(old.id, new.id);
            execute(&txn,"update attachment_job set state='queued',lease=null,lease_until=null where id=$1",vec![new.id.into()]).await.unwrap();
            timings.push((old_ms, new_ms));
            txn.execute_unprepared("drop index attachment_job_claim_idx")
                .await
                .unwrap();
        }
        println!("250k attachment claims: old/new milliseconds {timings:?}");
        txn.rollback().await.unwrap();
    }
}
