use crate::devices::config::{
    DEVICE_STATS_LIST_ACTIVITY_DAYS, DEVICE_STATS_TIMEZONE,
};
use crate::devices::devices::types::DeviceAudioDayStat;
use crate::h;
use anyhow::{Context, Result};
use chrono::NaiveDate;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
};
use std::collections::HashMap;
use uuid::Uuid;

const READ_RECENT_AUDIO_DAYS_SQL: &str = r#"
select d.device_id, (a.created_at at time zone $2)::date as day,
       count(*)::bigint as content_count,
       sum(a.source_size_bytes)::bigint as content_bytes
from unnest($1::uuid[]) d(device_id)
cross join lateral (
    select created_at from device_audio
    where device_id = d.device_id
    order by created_at desc limit 1
) latest
join device_audio a on a.device_id = d.device_id
    and a.created_at >= least(
        (latest.created_at at time zone $2)::date::timestamp at time zone $2,
        ((now() at time zone $2)::date - ($3::integer - 1))::timestamp at time zone $2
    )
group by 1, 2
order by 1, 2
"#;

pub(in crate::devices) async fn read_recent_or_none(
    db: &DatabaseConnection,
    device_ids: &[Uuid],
) -> Option<HashMap<Uuid, Vec<DeviceAudioDayStat>>> {
    match read_recent(db, device_ids).await {
        Ok(days) => Some(days),
        Err(error) => {
            crate::types::warn!("Device audio activity unavailable: {error:#}");
            None
        }
    }
}

async fn read_recent(
    db: &DatabaseConnection,
    device_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<DeviceAudioDayStat>>> {
    let mut days: HashMap<_, Vec<_>> =
        device_ids.iter().map(|id| (*id, Vec::new())).collect();
    if device_ids.is_empty() {
        return Ok(days);
    }
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            READ_RECENT_AUDIO_DAYS_SQL,
            [
                device_ids.to_vec().into(),
                DEVICE_STATS_TIMEZONE.into(),
                DEVICE_STATS_LIST_ACTIVITY_DAYS.into(),
            ],
        ))
        .await
        .context(h!())?;
    for row in rows {
        let device_id = row.try_get::<Uuid>("", "device_id").context(h!())?;
        days.get_mut(&device_id)
            .context(h!())?
            .push(DeviceAudioDayStat {
                day: row
                    .try_get::<NaiveDate>("", "day")
                    .context(h!())?
                    .to_string(),
                content_count: u64::try_from(
                    row.try_get::<i64>("", "content_count").context(h!())?,
                )
                .context(h!())?,
                content_bytes: u64::try_from(
                    row.try_get::<i64>("", "content_bytes").context(h!())?,
                )
                .context(h!())?,
            });
    }
    Ok(days)
}
