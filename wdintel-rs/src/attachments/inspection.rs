use super::{
    store::*,
    types::*,
    worker::{self, Job, Package},
};
use crate::{
    entities::{attachment_document, signal_message_media},
    h,
    types::{Env, ShortContext},
};
use sea_orm::EntityTrait;

pub async fn process(env: &Env, job: &Job) -> anyhow::Result<bool> {
    let req: AttachmentInspectionReq =
        serde_json::from_value(job.payload.clone()).c(h!())?;
    let media = signal_message_media::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let Some(package) =
        extract_original(env, job, &req, &media).await.c(h!())?
    else {
        return Ok(false);
    };
    let document = attachment_document::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    anyhow::ensure!(
        document.generation == job.generation,
        "original changed during inspection"
    );
    let mut result = super::api::read_document(
        env,
        &AttachmentReadReq {
            media_id: req.media_id.clone(),
            limit: Some(1),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    result.sections.clear();
    result.coordinates.clear();
    result.next_after = None;
    result.warnings = package.warnings;
    for (ordinal, section) in package.sections.into_iter().enumerate() {
        let member = match section.member.split_once("!/") {
            Some((_, path)) => format!(
                "{}!/{path}",
                media.file_name.as_deref().unwrap_or("attachment")
            ),
            None => media.file_name.clone().unwrap_or(section.member),
        };
        if req
            .member
            .as_ref()
            .is_some_and(|expected| expected != &member)
            || req.locator.as_ref().is_some_and(|locator| {
                !section
                    .locator
                    .to_lowercase()
                    .contains(&locator.to_lowercase())
            })
        {
            continue;
        }
        if result.sections.len() == 8 {
            result.warnings.push("More original sections are available; inspect a specific member or locator".into());
            break;
        }
        let coordinates =
            super::enrich::coordinates(&section.text, &section.locator)
                .await
                .c(h!())?;
        result.coordinates.extend(
            serde_json::from_value::<
                Vec<crate::media_summary::types::MediaSummaryCoordinate>,
            >(coordinates)
            .c(h!())?,
        );
        result.sections.push(AttachmentSection {
            id: format!("{}:{ordinal}", job.id),
            ordinal: ordinal as i32,
            member,
            locator: section.locator,
            text: section.text,
            markdown: section.markdown,
            html: crate::ocr::package::sanitize_html_without_images(
                &section.html,
            ),
            summary: None,
        });
    }
    super::enrich::renew(&env.dbx, job).await.c(h!())?;
    execute(
        &env.dbx,
        "update attachment_job set result=$3 where id=$1 and lease=$2",
        vec![
            job.id.into(),
            job.lease.into(),
            serde_json::to_value(result).c(h!())?.into(),
        ],
    )
    .await
    .c(h!())?;
    Ok(true)
}

async fn extract_original(
    env: &Env,
    job: &Job,
    req: &AttachmentInspectionReq,
    media: &signal_message_media::Model,
) -> anyhow::Result<Option<Package>> {
    let config = super::store::extractor_config(env).c(h!())?;
    if let Some(id) = job.payload["extractorJobId"].as_str() {
        let response = env
            .rq
            .get(format!("{}/v1/jobs/{id}", config.base_url))
            .bearer_auth(&config.token)
            .send()
            .await
            .c(h!())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            forget_extractor_job(env, job).await.c(h!())?;
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
                return Ok(Some(
                    worker::unpack(
                        &worker::bounded_response(response).await.c(h!())?,
                    )
                    .c(h!())?,
                ));
            }
            Some("failed" | "cancelled") => anyhow::bail!(
                "original inspection failed: {}",
                status["error_summary"]
            ),
            _ => return Ok(None),
        }
    }
    let bytes = worker::source_bytes(env, media).await.c(h!())?;
    let extension = media.file_ext.as_deref().unwrap_or("bin");
    anyhow::ensure!(
        extension.chars().all(|c| c.is_ascii_alphanumeric()),
        "invalid original format"
    );
    let name = format!("attachment.{extension}");
    let manifest = serde_json::json!({"schema_version":1,"inputs":[name],"metadata":{"attachment_native":true,"inspection_operation":req.operation,"inspection_locator":req.locator}});
    let response = env
        .rq
        .post(format!("{}/v1/jobs", config.base_url))
        .bearer_auth(&config.token)
        .header(
            "Idempotency-Key",
            format!("inspection-{}-{}", config.instance_id, job.id),
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
    ) {
        return Ok(None);
    }
    let response = response.error_for_status().c(h!())?;
    let response: serde_json::Value = response.json().await.c(h!())?;
    execute(&env.dbx,"update attachment_job set payload=payload || jsonb_build_object('extractorJobId',$3::text) where id=$1 and lease=$2",vec![job.id.into(),job.lease.into(),response["id"].as_str().c(h!())?.into()]).await.c(h!())?;
    Ok(None)
}

/// The extractor no longer knows the job, for example after switching
/// extractors, so the next run submits the original again.
async fn forget_extractor_job(env: &Env, job: &Job) -> anyhow::Result<()> {
    execute(&env.dbx,"update attachment_job set payload=payload - 'extractorJobId' where id=$1 and lease=$2",vec![job.id.into(),job.lease.into()]).await.c(h!())?;
    Ok(())
}
