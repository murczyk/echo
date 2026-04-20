use crate::config::RER_DUTY_TEST_WINDOW_MINUTES;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::messenger::id::update_message_with_uid;
use crate::system_settings::get_active_system_settings;
use crate::types::{Mode, ShortContext};
use crate::utils::worker_watch;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use rand::Rng;
use redis::aio::ConnectionManager;
use sea_orm::*;
use std::collections::HashMap;

const WORKER_DISABLED_SLEEP_SEC: u64 = 5;
const WORKER_ERROR_SLEEP_SEC: u64 = 15;

struct ReplaySource {
    message: signal_message::Model,
    inbox_item: sigint_inbox_item::Model,
    groups: Vec<signal_message_group::Model>,
    metadata: Vec<sigint_inbox_item_metadata::Model>,
    networks: Vec<sigint_inbox_item_network::Model>,
    tags: Vec<sigint_inbox_item_tag::Model>,
    point_tokens: Vec<sigint_inbox_item_point_token::Model>,
}

pub async fn run_rer_duty_historical_interceptions_worker_nofail(mode: Mode) {
    let (config, _settlements, _rq, mut redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    let mut source_offset = 0_u64;
    let mut source_since_ms = None;
    loop {
        let _loop_guard = worker_watch::loop_guard(
            "rer_duty_historical_interceptions_worker",
        );
        match run_rer_duty_historical_interceptions_worker_once(
            &config,
            &dbx,
            &mut redis,
            &mut source_offset,
            &mut source_since_ms,
        )
        .await
        {
            Ok(sleep_sec) => {
                tokio::time::sleep(tokio::time::Duration::from_secs(sleep_sec))
                    .await;
            }
            Err(e) => {
                error!(
                    "rer_duty_historical_interceptions_worker failed: {e:#?}"
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(
                    WORKER_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

async fn run_rer_duty_historical_interceptions_worker_once(
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    source_offset: &mut u64,
    source_since_ms: &mut Option<i64>,
) -> Result<u64, AppError> {
    let Some(settings) = get_active_system_settings(dbx).await.c(h!())? else {
        *source_offset = 0;
        *source_since_ms = None;
        return Ok(WORKER_DISABLED_SLEEP_SEC);
    };
    if !settings.rer_duty_insert_historical_interceptions {
        *source_offset = 0;
        *source_since_ms = None;
        return Ok(WORKER_DISABLED_SLEEP_SEC);
    }

    let since_ms = settings.rer_duty_test_since_ms.max(0);
    if *source_since_ms != Some(since_ms) {
        *source_offset = 0;
        *source_since_ms = Some(since_ms);
    }
    let since = crate::utils::dt_from_millis(since_ms).c(h!())?;
    let till = since + Duration::minutes(RER_DUTY_TEST_WINDOW_MINUTES);
    let limit = settings.rer_duty_test_limit.max(1) as u64;

    let mut sources =
        load_replay_sources(dbx, since, till, limit, *source_offset)
            .await
            .c(h!())?;
    if sources.is_empty() && *source_offset > 0 {
        *source_offset = 0;
        sources = load_replay_sources(dbx, since, till, limit, *source_offset)
            .await
            .c(h!())?;
    }
    if sources.is_empty() {
        warn!(
            "rer_duty_historical_interceptions_worker: no source inbox items found in configured window since={since} till={till}"
        );
        return Ok(settings.rer_duty_poll_interval_sec.max(1) as u64);
    }

    for source in &sources {
        replay_source_message(config, dbx, redis, source)
            .await
            .c(h!())?;
    }

    *source_offset += sources.len() as u64;
    if sources.len() < limit as usize {
        *source_offset = 0;
    }

    info!(
        "rer_duty_historical_interceptions_worker replayed {} historical messages",
        sources.len()
    );
    Ok(settings.rer_duty_poll_interval_sec.max(1) as u64)
}

async fn load_replay_sources(
    dbx: &DatabaseConnection,
    since: NaiveDateTime,
    till: NaiveDateTime,
    limit: u64,
    offset: u64,
) -> Result<Vec<ReplaySource>, AppError> {
    let source_ids = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(sigint_inbox_item::Column::Datetime.lt(till))
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id)
        .limit(limit)
        .offset(offset)
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    if source_ids.is_empty() {
        return Ok(vec![]);
    }

    let mut messages_by_id = signal_message::Entity::find()
        .filter(signal_message::Column::Id.eq_any(source_ids.clone()))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|message| (message.id, message))
        .collect::<HashMap<_, _>>();
    let mut inbox_items_by_id = sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Id.eq_any(source_ids.clone()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let groups_by_id = load_grouped_by_inbox_id(
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq_any(source_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?,
        |row| row.signal_message_id,
    );
    let metadata_by_id = load_grouped_by_inbox_id(
        sigint_inbox_item_metadata::Entity::find()
            .filter(
                sigint_inbox_item_metadata::Column::SigintInboxItemId
                    .eq_any(source_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?,
        |row| row.sigint_inbox_item_id,
    );
    let networks_by_id = load_grouped_by_inbox_id(
        sigint_inbox_item_network::Entity::find()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq_any(source_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?,
        |row| row.sigint_inbox_item_id,
    );
    let tags_by_id = load_grouped_by_inbox_id(
        sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq_any(source_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?,
        |row| row.sigint_inbox_item_id,
    );
    let point_tokens_by_id = load_grouped_by_inbox_id(
        sigint_inbox_item_point_token::Entity::find()
            .filter(
                sigint_inbox_item_point_token::Column::SigintInboxItemId
                    .eq_any(source_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?,
        |row| row.sigint_inbox_item_id,
    );

    let mut result = vec![];
    for source_id in source_ids {
        let Some(message) = messages_by_id.remove(&source_id) else {
            continue;
        };
        let Some(inbox_item) = inbox_items_by_id.remove(&source_id) else {
            continue;
        };
        result.push(ReplaySource {
            message,
            inbox_item,
            groups: groups_by_id.get(&source_id).cloned().unwrap_or_default(),
            metadata: metadata_by_id
                .get(&source_id)
                .cloned()
                .unwrap_or_default(),
            networks: networks_by_id
                .get(&source_id)
                .cloned()
                .unwrap_or_default(),
            tags: tags_by_id.get(&source_id).cloned().unwrap_or_default(),
            point_tokens: point_tokens_by_id
                .get(&source_id)
                .cloned()
                .unwrap_or_default(),
        });
    }
    Ok(result)
}

fn load_grouped_by_inbox_id<T, F>(
    items: Vec<T>,
    id_fn: F,
) -> HashMap<i64, Vec<T>>
where
    F: Fn(&T) -> i64,
{
    let mut grouped = HashMap::<i64, Vec<T>>::new();
    for item in items {
        grouped.entry(id_fn(&item)).or_default().push(item);
    }
    grouped
}

async fn replay_source_message(
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    source: &ReplaySource,
) -> Result<(), AppError> {
    let replay_ts = random_replay_timestamp();
    let (date, time) = format_date_time_fields(replay_ts);
    let txn = dbx.begin().await.c(h!())?;

    let inserted = signal_message::ActiveModel {
        id: NotSet,
        body: Set(source.message.body.clone()),
        created_at: NotSet,
        timestamp: Set(Some(replay_ts)),
        sender: Set(source.message.sender.clone()),
        format: Set(source.message.format),
        deleted: Set(false),
        external_id: Set(None),
        message_uid: Set(None),
        datasource_group_id: Set(source.message.datasource_group_id),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    let inserted = update_message_with_uid(&txn, config, inserted)
        .await
        .c(h!())?;

    for group in &source.groups {
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(inserted.id),
            group_master_key: Set(group.group_master_key.clone()),
            sender: Set(group.sender.clone()),
            message_uid: Set(inserted.message_uid.clone()),
            datasource_group_id: Set(group
                .datasource_group_id
                .or(inserted.datasource_group_id)),
            created_at: Set(inserted.created_at),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    sigint_inbox_item::ActiveModel {
        id: Set(inserted.id),
        date: Set(Some(date)),
        time: Set(Some(time)),
        freq: Set(source.inbox_item.freq.clone()),
        coords: Set(source.inbox_item.coords.clone()),
        callsigns: Set(source.inbox_item.callsigns.clone()),
        checked: Set(source.inbox_item.checked),
        reviewed: Set(source.inbox_item.reviewed),
        unit: Set(source.inbox_item.unit.clone()),
        callsign_tokens: Set(source.inbox_item.callsign_tokens.clone()),
        keyword_tokens: Set(source.inbox_item.keyword_tokens.clone()),
        lat: Set(source.inbox_item.lat),
        lng: Set(source.inbox_item.lng),
        nominatimres_id: Set(source.inbox_item.nominatimres_id),
        location: Set(source.inbox_item.location.clone()),
        tags: Set(source.inbox_item.tags.clone()),
        callsigns_alg2: Set(source.inbox_item.callsigns_alg2.clone()),
        callsigns_alg1: Set(source.inbox_item.callsigns_alg1.clone()),
        datetime: Set(Some(replay_ts)),
        signal_tokens: Set(source.inbox_item.signal_tokens.clone()),
        body_noheader: Set(source.inbox_item.body_noheader.clone()),
        location_v2: Set(source.inbox_item.location_v2.clone()),
        unit_v2: Set(source.inbox_item.unit_v2.clone()),
        parsed_unit_v2: Set(source.inbox_item.parsed_unit_v2),
        post_id: Set(source.inbox_item.post_id),
    }
    .insert(&txn)
    .await
    .c(h!())?;

    for metadata in &source.metadata {
        sigint_inbox_item_metadata::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inserted.id),
            color_code: Set(metadata.color_code.clone()),
            call_group_id: Set(metadata.call_group_id.clone()),
            call_group_name: Set(metadata.call_group_name.clone()),
            sender_id: Set(metadata.sender_id.clone()),
            sender_name: Set(metadata.sender_name.clone()),
            hash_id: Set(metadata.hash_id.clone()),
            created_at: Set(inserted.created_at),
            color_code_start_index: Set(metadata.color_code_start_index),
            color_code_end_index: Set(metadata.color_code_end_index),
            call_group_id_start_index: Set(metadata.call_group_id_start_index),
            call_group_id_end_index: Set(metadata.call_group_id_end_index),
            call_group_name_start_index: Set(
                metadata.call_group_name_start_index
            ),
            call_group_name_end_index: Set(metadata.call_group_name_end_index),
            sender_id_start_index: Set(metadata.sender_id_start_index),
            sender_id_end_index: Set(metadata.sender_id_end_index),
            sender_name_start_index: Set(metadata.sender_name_start_index),
            sender_name_end_index: Set(metadata.sender_name_end_index),
            hash_id_start_index: Set(metadata.hash_id_start_index),
            hash_id_end_index: Set(metadata.hash_id_end_index),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for network in &source.networks {
        sigint_inbox_item_network::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inserted.id),
            sigint_network_id: Set(network.sigint_network_id),
            created_at: Set(inserted.created_at),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for tag in &source.tags {
        sigint_inbox_item_tag::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inserted.id),
            tag_id: Set(tag.tag_id),
            confidence: Set(tag.confidence),
            login: Set(tag.login.clone()),
            model: Set(tag.model.clone()),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for point_token in &source.point_tokens {
        sigint_inbox_item_point_token::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inserted.id),
            palitra_id: Set(point_token.palitra_id),
            point_tokens: Set(point_token.point_tokens.clone()),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    crate::sigint::worker::incoming_message_after_insert(&txn, inserted.id)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;

    fanout(redis, EventMsg::new(EventType::ETInboxChanged(inserted.id)))
        .await
        .c(h!())?;
    Ok(())
}

fn random_replay_timestamp() -> NaiveDateTime {
    let now = Utc::now().naive_utc();
    let max_offset_sec = (RER_DUTY_TEST_WINDOW_MINUTES * 60).max(1);
    let offset_sec = rand::rng().random_range(0..=max_offset_sec);
    now - Duration::seconds(offset_sec)
}

fn format_date_time_fields(dt_utc: NaiveDateTime) -> (String, String) {
    let dt_kyiv = DateTime::<Utc>::from_naive_utc_and_offset(dt_utc, Utc)
        .with_timezone(&chrono_tz::Europe::Kyiv);
    let date = dt_kyiv.format("%Y-%m-%d").to_string();
    let time = dt_kyiv.format("%H:%M:%S").to_string();
    (date, time)
}
