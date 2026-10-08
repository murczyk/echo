use crate::{
    entities::{attachment_document, ocr_job, signal_message_media},
    h,
    types::{Env, Mode, ShortContext},
};
use sea_orm::EntityTrait;
use uuid::Uuid;

pub(crate) async fn preview(
    env: &Env,
    media_id: Uuid,
) -> anyhow::Result<usize> {
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    anyhow::ensure!(
        media.content_type.starts_with("image/")
            || media.content_type == "application/pdf",
        "stored OCR recovery requires an image or PDF"
    );
    attachment_document::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let ocr = ocr_job::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    anyhow::ensure!(
        ocr.state == "completed"
            && matches!(
                ocr.quality_status.as_deref(),
                Some("accepted" | "degraded")
            ),
        "completed, usable stored OCR is required"
    );
    let html = crate::ocr::load_sanitized_ocr_html(env, media_id)
        .await
        .c(h!())?;
    let package = super::worker::html_package(
        media.file_name.as_deref().unwrap_or("document"),
        &html,
    )
    .c(h!())?;
    let mut count = 0;
    for section in package.sections {
        count += super::enrich::coordinates(&section.text, &section.locator)
            .await
            .c(h!())?
            .as_array()
            .c(h!())?
            .len();
    }
    Ok(count)
}

pub(crate) async fn run(
    mode: Mode,
    ps: crate::OneoffReindexStoredOcrPs,
) -> Result<(), crate::error::AppError> {
    let env = crate::server::new_env(mode).await.c(h!())?;
    reindex(&env, &ps).await.c(h!())?;
    Ok(())
}

pub(crate) async fn reindex(
    env: &Env,
    ps: &crate::OneoffReindexStoredOcrPs,
) -> anyhow::Result<()> {
    let count = preview(env, ps.media_id).await.c(h!())?;
    let dry_run = ps.dry_run || !ps.yes;
    println!(
        "media_id={} coordinates={} dry_run={dry_run}",
        ps.media_id, count
    );
    if !dry_run {
        super::api::retry_document(&env.dbx, ps.media_id)
            .await
            .c(h!())?;
        println!(
            "queued stored-OCR attachment extraction; indexing must be enabled"
        );
    }
    Ok(())
}
