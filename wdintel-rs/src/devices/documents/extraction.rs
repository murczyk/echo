use super::queue::{self, Job};
use crate::{
    attachments::{
        store::{execute, rows},
        worker::Package,
    },
    config::*,
    devices::config::{
        DEVICE_DOCUMENT_PARSER_VERSION,
        DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
        DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS,
    },
    h,
    types::{Env, ShortContext},
};
use futures_util::TryStreamExt;
use sea_orm::{FromQueryResult, TransactionTrait};
use std::time::Duration;
use uuid::Uuid;

#[derive(FromQueryResult)]
pub(super) struct Source {
    pub name: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub object_key: String,
    pub source_size_bytes: i64,
    pub is_encrypted: bool,
}

pub(super) async fn source(env: &Env, job: &Job) -> anyhow::Result<Source> {
    rows(env.file_registry_db().c(h!())?.connection(),"select r.name,r.extension,r.mime_type,c.object_key,c.source_size_bytes,c.is_encrypted from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.id=$1 and r.revision=$2",vec![job.file_id.into(),job.revision.into()]).await.c(h!())?.pop().c(h!())
}

async fn source_bytes(env: &Env, source: &Source) -> anyhow::Result<Vec<u8>> {
    let size = u64::try_from(source.source_size_bytes).c(h!())?;
    anyhow::ensure!(
        size <= OCR_MAX_SOURCE_BYTES,
        "file exceeds extraction input limit"
    );
    if let Some(bytes) =
        crate::devices::files::content::local_cache::read_bytes(
            env,
            &source.object_key,
            size,
            source.is_encrypted,
        )
        .await
    {
        return Ok(bytes);
    }
    let mut config = env.s3_config.clone().c(h!())?;
    config.prefix.clear();
    let bytes = if source.is_encrypted {
        let key = &env.config.s3_config.as_ref().c(h!())?.strongbox_key;
        crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
            &env.s3,&Some(config),key,&source.object_key,Duration::from_secs(DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS),DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
        ).await.c(h!())?
    } else {
        let mut stream = crate::storage::stream_s3_object_range_with_operator(
            &env.s3,
            &Some(config),
            &source.object_key,
            0..size,
        )
        .await
        .c(h!())?;
        let mut bytes = Vec::new();
        while let Some(part) = stream.try_next().await.c(h!())? {
            anyhow::ensure!(
                bytes.len().saturating_add(part.len()) as u64 <= size,
                "file size mismatch"
            );
            bytes.extend_from_slice(&part);
        }
        bytes
    };
    anyhow::ensure!(bytes.len() as u64 == size, "file size mismatch");
    Ok(bytes)
}

pub(super) async fn extract(env: &Env, job: &Job) -> anyhow::Result<bool> {
    if published(env, job, job.generation).await.c(h!())?
        || reuse(env, job).await.c(h!())?
    {
        return Ok(true);
    }
    let source = source(env, job).await.c(h!())?;
    let extension = extension(&source);
    if !supported(&extension) {
        execute(env.file_registry_db().c(h!())?.connection(),"update file_document set state='unsupported' where file_id=$1 and revision=$2 and generation=$3",vec![job.file_id.into(),job.revision.into(),job.generation.into()]).await.c(h!())?;
        return Ok(true);
    }
    let Some(package) = package(env, job, &source).await.c(h!())? else {
        return Ok(false);
    };
    publish(env, job, package).await.c(h!())?;
    Ok(true)
}

fn extension(source: &Source) -> String {
    source
        .extension
        .as_deref()
        .or_else(|| {
            std::path::Path::new(&source.name)
                .extension()
                .and_then(|s| s.to_str())
        })
        .unwrap_or("")
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn supported(extension: &str) -> bool {
    SIGINT_MEDIA_KMZ_CONVERSION_EXTENSIONS.contains(&extension)
        || matches!(
            extension,
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
                | "pdf"
                | "png"
                | "jpg"
                | "jpeg"
        )
}

pub(super) async fn package(
    env: &Env,
    job: &Job,
    source: &Source,
) -> anyhow::Result<Option<Package>> {
    let extension = extension(source);
    anyhow::ensure!(supported(&extension), "unsupported file format");
    if SIGINT_MEDIA_KMZ_CONVERSION_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(Some(map_package(env, source, &extension).await.c(h!())?));
    }
    let config = crate::attachments::store::extractor_config(env).c(h!())?;
    if let Some(id) = job.payload["extractorJobId"].as_str() {
        return poll_extractor(env, job, &config, id).await.c(h!());
    }
    submit_extractor(env, job, source, &config, &extension)
        .await
        .c(h!())
}

pub(super) async fn submit_extractor(
    env: &Env,
    job: &Job,
    source: &Source,
    config: &crate::ocr::OcrRuntimeConfig,
    extension: &str,
) -> anyhow::Result<Option<Package>> {
    let bytes = tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS),
        source_bytes(env, source),
    )
    .await
    .c(h!())?
    .c(h!())?;
    let name = format!("document.{extension}");
    let manifest = serde_json::json!({"schema_version":1,"inputs":[name],"metadata":{"attachment_native":true,"inspection_operation":job.payload["operation"],"inspection_locator":job.payload["locator"]}});
    let response = env
        .rq
        .post(format!("{}/v1/jobs", config.base_url))
        .bearer_auth(&config.token)
        .header(
            "Idempotency-Key",
            format!("device-{}-{}", config.instance_id, job.id),
        )
        .multipart(
            reqwest::multipart::Form::new()
                .part(
                    "files",
                    reqwest::multipart::Part::bytes(bytes).file_name(name),
                )
                .text("manifest", manifest.to_string()),
        )
        .send()
        .await
        .c(h!())?;
    if matches!(
        response.status(),
        reqwest::StatusCode::TOO_MANY_REQUESTS
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::INSUFFICIENT_STORAGE
    ) {
        return Ok(None);
    }
    let result: serde_json::Value =
        response.error_for_status().c(h!())?.json().await.c(h!())?;
    execute(env.file_registry_db().c(h!())?.connection(),"update file_document_job set payload=payload||jsonb_build_object('extractorJobId',$3::text) where id=$1 and lease=$2",vec![job.id.into(),job.lease.into(),result["id"].as_str().c(h!())?.into()]).await.c(h!())?;
    Ok(None)
}

async fn poll_extractor(
    env: &Env,
    job: &Job,
    config: &crate::ocr::OcrRuntimeConfig,
    id: &str,
) -> anyhow::Result<Option<Package>> {
    let response = env
        .rq
        .get(format!("{}/v1/jobs/{id}", config.base_url))
        .bearer_auth(&config.token)
        .send()
        .await
        .c(h!())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        execute(env.file_registry_db().c(h!())?.connection(),"update file_document_job set payload=payload-'extractorJobId' where id=$1 and lease=$2",vec![job.id.into(),job.lease.into()]).await.c(h!())?;
        return Ok(None);
    }
    let status: serde_json::Value =
        response.error_for_status().c(h!())?.json().await.c(h!())?;
    match status["state"].as_str() {
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
            let bytes = crate::attachments::worker::bounded_response(response)
                .await
                .c(h!())?;
            Ok(Some(crate::attachments::worker::unpack(&bytes).c(h!())?))
        }
        Some("failed" | "cancelled") => anyhow::bail!(
            "document extractor failed: {}",
            status["error_summary"]
        ),
        _ => Ok(None),
    }
}

async fn map_package(
    env: &Env,
    source: &Source,
    extension: &str,
) -> anyhow::Result<Package> {
    let bytes = tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS),
        source_bytes(env, source),
    )
    .await
    .c(h!())?
    .c(h!())?;
    let bytes = if matches!(extension, "kmz" | "kml") {
        bytes
    } else {
        tokio::time::timeout(
            Duration::from_secs(SIGINT_MEDIA_CONVERSION_JOB_TIMEOUT_SEC),
            crate::alpine::convert_bytes_to_kmz(
                env,
                bytes,
                Some(source.name.clone()),
                source.mime_type.clone(),
            ),
        )
        .await
        .c(h!())?
        .c(h!())?
        .body
        .to_vec()
    };
    let name = if extension == "kml" {
        "document.kml"
    } else {
        "document.kmz"
    };
    super::map_extraction::parse(name, &bytes).await.c(h!())
}

async fn reuse(env: &Env, job: &Job) -> anyhow::Result<bool> {
    if job.payload["force"] == true {
        return Ok(false);
    }
    #[derive(FromQueryResult)]
    struct Reuse {
        published_generation: Uuid,
    }
    let db = env.file_registry_db().c(h!())?.connection();
    let found=rows::<Reuse,_>(db,"select d.published_generation from file_content c join file_content prior on prior.file_id=c.file_id and prior.upload_id=c.upload_id and prior.revision<>c.revision join file_revision r on r.id=c.file_id and r.revision=c.revision join file_revision p on p.id=prior.file_id and p.revision=prior.revision join file_document d on d.file_id=prior.file_id and d.revision=prior.revision join file_document_generation g on g.id=d.published_generation where c.file_id=$1 and c.revision=$2 and lower(coalesce(r.extension,substring(r.name from '[^.]+$'))) = lower(coalesce(p.extension,substring(p.name from '[^.]+$'))) and g.parser_version=$3 and g.complete and g.summary_state='completed' and g.position_state='completed' order by d.revision desc limit 1",vec![job.file_id.into(),job.revision.into(),DEVICE_DOCUMENT_PARSER_VERSION.into()]).await.c(h!())?.pop();
    let Some(found) = found else {
        return Ok(false);
    };
    let tx = db.begin().await.c(h!())?;
    queue::renew(&tx, job).await.c(h!())?;
    execute(&tx,"update file_document set published_generation=$4,state='completed' where file_id=$1 and revision=$2 and generation=$3",vec![job.file_id.into(),job.revision.into(),job.generation.into(),found.published_generation.into()]).await.c(h!())?;
    bind_generation(&tx, job, found.published_generation)
        .await
        .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}

pub(super) async fn publish(
    env: &Env,
    job: &Job,
    package: Package,
) -> anyhow::Result<()> {
    let db = env.file_registry_db().c(h!())?.connection();
    let generation = if job.kind == "inspect" {
        job.id
    } else {
        job.generation
    };
    let mut chunks = vec![];
    for (ordinal, section) in package.sections.into_iter().enumerate() {
        anyhow::ensure!(
            section.text.chars().count() <= ATTACHMENT_CHUNK_CHARS,
            "oversized document section"
        );
        let coordinates = crate::attachments::enrich::coordinates(
            &section.text,
            &section.locator,
        )
        .await
        .c(h!())?;
        chunks.push((ordinal, section, coordinates));
    }
    let tx = db.begin().await.c(h!())?;
    queue::renew(&tx, job).await.c(h!())?;
    execute(&tx,"insert into file_document_generation(id,file_id,revision,complete,warnings,parser_version) values($1,$2,$3,$4,$5,$6)",vec![generation.into(),job.file_id.into(),job.revision.into(),package.complete.into(),serde_json::to_value(package.warnings).c(h!())?.into(),DEVICE_DOCUMENT_PARSER_VERSION.into()]).await.c(h!())?;
    for (ordinal, section, coordinates) in chunks {
        execute(&tx,"insert into file_document_chunk(id,generation,ordinal,member,locator,text,markdown,html,coordinates) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",vec![Uuid::now_v7().into(),generation.into(),(ordinal as i32).into(),section.member.into(),section.locator.into(),section.text.into(),section.markdown.into(),crate::ocr::package::sanitize_html_without_images(&section.html).into(),coordinates.into()]).await.c(h!())?;
    }
    bind_generation(&tx, job, generation).await.c(h!())?;
    if job.kind == "inspect" {
        execute(&tx,"update file_document_generation set summary_state='skipped',position_state='skipped' where id=$1",vec![generation.into()]).await.c(h!())?;
    } else {
        let changed=execute(&tx,"update file_document set published_generation=$3,state='completed',last_error=null where file_id=$1 and revision=$2 and generation=$3",vec![job.file_id.into(),job.revision.into(),generation.into()]).await.c(h!())?;
        anyhow::ensure!(changed == 1, "document generation changed");
        for kind in ["summary", "positions"] {
            queue::enqueue(&tx, job.file_id, job.revision, generation, kind)
                .await
                .c(h!())?;
        }
    }
    tx.commit().await.c(h!())?;
    Ok(())
}

async fn bind_generation(
    db: &impl sea_orm::ConnectionTrait,
    job: &Job,
    generation: Uuid,
) -> anyhow::Result<()> {
    execute(db,"insert into file_document_revision_generation(file_id,revision,generation) values($1,$2,$3) on conflict do nothing",vec![job.file_id.into(),job.revision.into(),generation.into()]).await.c(h!())?;
    Ok(())
}

pub(super) async fn published(
    env: &Env,
    job: &Job,
    generation: Uuid,
) -> anyhow::Result<bool> {
    #[derive(FromQueryResult)]
    struct Published {
        published: bool,
    }
    Ok(rows::<Published,_>(env.file_registry_db().c(h!())?.connection(),"select exists(select 1 from file_document_revision_generation where file_id=$1 and revision=$2 and generation=$3) as published",vec![job.file_id.into(),job.revision.into(),generation.into()]).await.c(h!())?.pop().c(h!())?.published)
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[actix_web::test]
    #[serial_test::serial]
    async fn extraction_reads_retained_original_without_s3() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let mut env = env.as_ref().clone();
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"document retained after upload";
        crate::devices::files::content::local_cache::test_support::retain_without_storage(
            &mut env, directory.path(), "devices/extraction-source", bytes, true,
        ).await;
        let source = Source {
            name: "report.txt".to_owned(),
            extension: Some("txt".to_owned()),
            mime_type: Some("text/plain".to_owned()),
            object_key: "devices/extraction-source".to_owned(),
            source_size_bytes: bytes.len() as i64,
            is_encrypted: true,
        };
        assert_eq!(source_bytes(&env, &source).await.unwrap(), bytes);
    }
}
