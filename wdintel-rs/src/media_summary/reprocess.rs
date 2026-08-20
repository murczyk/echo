use crate::config::MEDIA_SUMMARY_REPROCESS_MAX_LIMIT;
use crate::entities::{media_summary, ocr_job, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use sea_orm::{
    ColumnTrait, EntityTrait, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait, Select,
};
use uuid::Uuid;

pub(crate) async fn requeue_stored_ocr(
    env: &crate::types::Env,
    media_id: Uuid,
) -> anyhow::Result<media_summary::Model> {
    let summary = media_summary::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    if summary.state != "failed" {
        return Ok(summary);
    }
    let html = crate::ocr::load_sanitized_ocr_html(env, media_id)
        .await
        .c(h!())?;
    let source = super::plain_text_from_sanitized_html(&html).c(h!())?;
    let requeued = super::enqueue_for_reprocessing(
        &env.dbx, media_id, "ocr_text", &source,
    )
    .await
    .c(h!())?;
    if !requeued {
        anyhow::bail!("stored OCR text is empty");
    }
    super::publish_inbox_change(env, media_id).await.c(h!())?;
    media_summary::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())
}

pub(crate) async fn run(
    mode: Mode,
    ps: crate::OneoffReprocessMediaSummariesPs,
) -> Result<(), AppError> {
    if ps.limit == 0 || ps.limit > MEDIA_SUMMARY_REPROCESS_MAX_LIMIT {
        return Err(AppError::BL {
            msg: format!(
                "--limit must be between 1 and {MEDIA_SUMMARY_REPROCESS_MAX_LIMIT}"
            ),
        });
    }
    let env = crate::server::new_env(mode).await.c(h!())?;
    let total = eligible_query(ps.media_id).count(&env.dbx).await.c(h!())?;
    let candidates = eligible_query(ps.media_id)
        .order_by_asc(media_summary::Column::CompletedAt)
        .order_by_asc(media_summary::Column::MediaId)
        .limit(ps.limit)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let dry_run = ps.dry_run || !ps.yes;
    println!(
        "eligible={} selected={} limit={} dry_run={}",
        total,
        candidates.len(),
        ps.limit,
        dry_run
    );
    if dry_run {
        return Ok(());
    }
    let mut requeued = 0_u64;
    for candidate in candidates {
        requeue_stored_ocr(env.as_ref(), candidate.media_id)
            .await
            .c(h!())?;
        requeued += 1;
    }
    println!("requeued={requeued}");
    Ok(())
}

fn eligible_query(media_id: Option<Uuid>) -> Select<media_summary::Entity> {
    let mut query = media_summary::Entity::find()
        .join(
            JoinType::InnerJoin,
            media_summary::Relation::SignalMessageMedia.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_media::Relation::OcrJob.def(),
        )
        .filter(media_summary::Column::State.eq("failed"))
        .filter(ocr_job::Column::State.eq("completed"))
        .filter(ocr_job::Column::QualityStatus.is_in(["accepted", "degraded"]))
        .filter(ocr_job::Column::HtmlS3Key.is_not_null());
    if let Some(media_id) = media_id {
        query = query.filter(media_summary::Column::MediaId.eq(media_id));
    }
    query
}
