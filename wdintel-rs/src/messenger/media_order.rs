use crate::entities::signal_message_media;
use crate::types::*;
use sea_orm::*;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct MediaOrder {
    id: Uuid,
    order_f64: Option<f64>,
}

pub(crate) fn sort(media: &mut [signal_message_media::Model]) {
    media.sort_by(|a, b| {
        a.signal_message_id
            .cmp(&b.signal_message_id)
            .then_with(|| match (a.order_f64, b.order_f64) {
                (Some(a), Some(b)) => {
                    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
                }
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub(crate) async fn next(
    db: &impl ConnectionTrait,
    message: i64,
    additional: usize,
) -> anyhow::Result<f64> {
    db.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id from signal_message where id=$1 for update",
        [message.into()],
    ))
    .await
    .c(h!())?
    .c(h!())?;
    let media = MediaOrder::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id, order_f64 from signal_message_media where signal_message_id=$1 union all select id, order_f64 from signal_message_audio_ref where signal_message_id=$1 order by order_f64 nulls last, id",
        [message.into()],
    ))
    .all(db)
    .await
    .c(h!())?;
    let mut next = media
        .iter()
        .filter_map(|media| media.order_f64)
        .filter(|order| order.is_finite())
        .reduce(f64::max)
        .unwrap_or(0.0)
        + 1.0;
    let end = next + (media.len() + additional) as f64;
    if !end.is_finite()
        || end + 1.0 == end
        || media.iter().any(|media| {
            media.order_f64.is_some_and(|order| !order.is_finite())
        })
    {
        for (index, media) in media.iter().enumerate() {
            set(db, message, media.id, (index + 1) as f64)
                .await
                .c(h!())?;
        }
        return Ok((media.len() + 1) as f64);
    }
    for media in media.iter().filter(|media| media.order_f64.is_none()) {
        set(db, message, media.id, next).await.c(h!())?;
        next += 1.0;
    }
    anyhow::ensure!(next.is_finite(), "Attachment order overflow");
    Ok(next)
}

pub(crate) async fn set(
    db: &impl ConnectionTrait,
    message: i64,
    id: Uuid,
    order: f64,
) -> anyhow::Result<()> {
    anyhow::ensure!(order.is_finite(), "Invalid attachment order");
    for table in ["signal_message_media", "signal_message_audio_ref"] {
        let updated = db
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("update {table} set order_f64=$3 where signal_message_id=$1 and id=$2 and order_f64 is distinct from $3"),
                [message.into(), id.into(), order.into()],
            ))
            .await
            .c(h!())?;
        if updated.rows_affected() > 0 {
            break;
        }
    }
    Ok(())
}
