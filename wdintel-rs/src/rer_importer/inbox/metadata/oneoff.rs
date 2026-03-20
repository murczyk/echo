use crate::entities::sigint_inbox_item;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::metadata::*;
use chrono::Utc;
use indicatif::ProgressBar;

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
        .into_tuple::<i64>()
        .stream(&dbx)
        .await
        .c(h!())?;
    let pb = ProgressBar::new(count);
    let mut processed = 0_u64;
    while let Some(id) = rows.try_next().await.c(h!())? {
        pb.inc(1);
        refresh_metadata(id, &dbx).await.c(h!())?;
        processed += 1;
    }
    println!("> done oneoff_reprocess_inbox_metadata: processed={processed}");
    Ok(())
}

fn build_inbox_metadata_recalc_query(
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> Select<sigint_inbox_item::Entity> {
    let mut q = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Body.is_not_null())
        .order_by_asc(sigint_inbox_item::Column::Id);
    if let Some(since_ts) = since_ts {
        q = q.filter(sigint_inbox_item::Column::Datetime.gte(since_ts));
    }
    if let Some(till_ts) = till_ts {
        q = q.filter(sigint_inbox_item::Column::Datetime.lt(till_ts));
    }
    q
}
