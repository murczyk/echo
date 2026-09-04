use crate::types::ShortContext;
use chrono::{NaiveDateTime, Utc};
use sea_orm::{ConnectionTrait, EntityTrait, QuerySelect};
use uuid::{NoContext, Timestamp, Uuid};

pub fn signal_message_uuid(
    timestamp: Option<NaiveDateTime>,
    created_at: NaiveDateTime,
) -> Uuid {
    timestamp
        .or(Some(created_at))
        .and_then(uuid_v7_from_datetime)
        .unwrap_or_else(Uuid::now_v7)
}

pub fn signal_message_uuid_for_insert(
    timestamp: Option<NaiveDateTime>,
) -> Uuid {
    signal_message_uuid(timestamp, Utc::now().naive_utc())
}

pub async fn find_signal_message_uuid<C: ConnectionTrait>(
    db: &C,
    id: i64,
) -> anyhow::Result<Option<Uuid>> {
    Ok(crate::entities::signal_message::Entity::find_by_id(id)
        .select_only()
        .column(crate::entities::signal_message::Column::IdUuid)
        .into_tuple::<Option<Uuid>>()
        .one(db)
        .await
        .c(crate::h!())?
        .flatten())
}

pub async fn find_inbox_item_uuid<C: ConnectionTrait>(
    db: &C,
    id: i64,
) -> anyhow::Result<Option<Uuid>> {
    Ok(crate::entities::sigint_inbox_item::Entity::find_by_id(id)
        .select_only()
        .column(crate::entities::sigint_inbox_item::Column::IdUuid)
        .into_tuple::<Option<Uuid>>()
        .one(db)
        .await
        .c(crate::h!())?
        .flatten())
}

pub fn uuid_v7_from_datetime(datetime: NaiveDateTime) -> Option<Uuid> {
    let datetime = datetime.and_utc();
    let seconds = datetime.timestamp();
    (seconds >= 0).then(|| {
        Uuid::new_v7(Timestamp::from_unix(
            NoContext,
            seconds as u64,
            datetime.timestamp_subsec_nanos(),
        ))
    })
}
