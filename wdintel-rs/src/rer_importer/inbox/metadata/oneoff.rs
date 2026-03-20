use crate::entities::sigint_inbox_item;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::metadata::types::InboxMetadataRecalcRow;
use crate::rer_importer::inbox::metadata::*;
use crate::types::*;
use chrono::Utc;
use indicatif::ProgressBar;
use sea_orm::*;

pub async fn oneoff_reprocess_inbox_metadata(
    mode: Mode,
    ps: &crate::OneoffReprocessInboxMetadataPs,
) -> Result<(), AppError> {
    println!("> oneoff_reprocess_inbox_metadata {ps:?}");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut since_ts = parse_optional_ts(ps.since_ts.as_deref()).c(h!())?;
    let mut till_ts = parse_optional_ts(ps.till_ts.as_deref()).c(h!())?;
    if since_ts.is_none() && till_ts.is_none() {
        till_ts = Some(Utc::now().naive_utc());
        since_ts = Some(
            till_ts.c(h!())?
                - chrono::Duration::days(
                    crate::config::ONEOFF_REPROCESS_INBOX_METADATA_DEFAULT_DAYS,
                ),
        );
    }
    let q = build_inbox_metadata_recalc_query(since_ts, till_ts);
    let count = q.clone().count(&dbx).await.c(h!())?;
    let mut rows = q
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_model::<InboxMetadataRecalcRow>()
        .stream(&dbx)
        .await
        .c(h!())?;
    let pb = ProgressBar::new(count);
    let mut processed = 0_u64;
    while let Some(row) = rows.try_next().await.c(h!())? {
        pb.inc(1);
        refresh_metadata(row.id, &dbx).await.c(h!())?;
        processed += 1;
    }
    println!("> done oneoff_reprocess_inbox_metadata: processed={processed}");
    Ok(())
}
