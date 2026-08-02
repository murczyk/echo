use crate::config::{
    RER_DUTY_TEST_REPLAY_ADVISORY_LOCK_KEY,
    RER_DUTY_TEST_REPLAY_CLEANUP_BATCH_SIZE, RER_DUTY_TEST_REPLAY_COMMENT,
    RER_DUTY_TEST_REPLAY_DISABLED_SLEEP_SEC,
    RER_DUTY_TEST_REPLAY_ERROR_SLEEP_SEC, RER_DUTY_TEST_REPLAY_IDLE_SLEEP_SEC,
    RER_DUTY_TEST_REPLAY_INTERVAL_SEC_MAX, RER_DUTY_TEST_REPLAY_SOURCE_MAX,
};
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::messenger::id::update_message_with_uid;
use crate::system_settings::get_active_system_settings;
use crate::system_settings::types::RerDutyTestReplayStatusRsp;
use crate::types::{error, info};
use crate::types::{Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::utils::worker_watch;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use lazy_static::lazy_static;
use redis::aio::ConnectionManager;
use regex::Regex;
use sea_orm::*;
use sea_query::{Expr, Query};
use std::collections::HashMap;

struct ReplayIteration {
    sleep_sec: u64,
    changed_message_ids: Vec<i64>,
}

struct ReplayProgress {
    generated_count: i64,
    latest_created_at: Option<NaiveDateTime>,
}

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
    loop {
        let _loop_guard = worker_watch::loop_guard(
            "rer_duty_historical_interceptions_worker",
        );
        match run_rer_duty_historical_interceptions_worker_once(&config, &dbx)
            .await
        {
            Ok(iteration) => {
                if let Err(e) = publish_replay_events(
                    &mut redis,
                    iteration.changed_message_ids,
                )
                .await
                {
                    error!(
                        "rer_duty_historical_interceptions_worker event failed: {:#?}",
                        e
                    );
                    tokio::time::sleep(tokio::time::Duration::from_secs(
                        RER_DUTY_TEST_REPLAY_ERROR_SLEEP_SEC,
                    ))
                    .await;
                    continue;
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(
                    iteration.sleep_sec,
                ))
                .await;
            }
            Err(e) => {
                error!(
                    "rer_duty_historical_interceptions_worker failed: {:#?}",
                    e
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(
                    RER_DUTY_TEST_REPLAY_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

async fn run_rer_duty_historical_interceptions_worker_once(
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
) -> Result<ReplayIteration, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    if !acquire_replay_lock(&txn).await? {
        txn.rollback().await.c(h!())?;
        return Ok(ReplayIteration {
            sleep_sec: RER_DUTY_TEST_REPLAY_IDLE_SLEEP_SEC,
            changed_message_ids: vec![],
        });
    }

    run_locked_replay_iteration(config, txn).await
}

async fn run_locked_replay_iteration(
    config: &crate::config::Config,
    txn: DatabaseTransaction,
) -> Result<ReplayIteration, AppError> {
    let settings = get_active_system_settings(&txn).await.c(h!())?;
    let Some(settings) =
        settings.filter(|settings| settings.rer_duty_test_enabled)
    else {
        return cleanup_replayed_messages(txn).await;
    };
    let source_ids = load_replay_source_ids(
        &txn,
        settings.rer_duty_test_since_ms,
        settings.rer_duty_test_limit,
    )
    .await?;
    if source_ids.is_empty() {
        txn.commit().await.c(h!())?;
        return Ok(ReplayIteration {
            sleep_sec: responsive_sleep(replay_interval_sec(
                settings.rer_duty_test_replay_interval_sec,
            ) as u64),
            changed_message_ids: vec![],
        });
    }
    let progress = load_replay_progress(&txn).await?;
    let now = Utc::now().naive_utc();
    let next_emit_at = progress.latest_created_at.map(|created_at| {
        created_at
            + Duration::seconds(replay_interval_sec(
                settings.rer_duty_test_replay_interval_sec,
            ))
    });
    if let Some(next_emit_at) =
        next_emit_at.filter(|next_emit_at| *next_emit_at > now)
    {
        let sleep_sec = responsive_sleep(sleep_until(next_emit_at, now));
        txn.commit().await.c(h!())?;
        return Ok(ReplayIteration {
            sleep_sec,
            changed_message_ids: vec![],
        });
    }
    let source_index = next_source_index(&source_ids, progress.generated_count);
    let source_id = source_ids[source_index];
    let Some(source) = load_replay_source(&txn, source_id).await? else {
        txn.commit().await.c(h!())?;
        return Ok(ReplayIteration {
            sleep_sec: 0,
            changed_message_ids: vec![],
        });
    };
    let replayed_message_id =
        replay_source_message(config, &txn, &source, now).await?;
    sigint_comment::ActiveModel {
        id: NotSet,
        login_id: Set(crate::users::system_login_id(&txn).await.c(h!())?),
        signal_message_id: Set(replayed_message_id),
        comment: Set(RER_DUTY_TEST_REPLAY_COMMENT.to_string()),
        created_at: Set(now),
        sigint_post_id: Set(None),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    info!(
        "rer_duty_historical_interceptions_worker replayed source {source_id} as {replayed_message_id}"
    );
    Ok(ReplayIteration {
        sleep_sec: responsive_sleep(replay_interval_sec(
            settings.rer_duty_test_replay_interval_sec,
        ) as u64),
        changed_message_ids: vec![replayed_message_id],
    })
}

async fn acquire_replay_lock<C>(dbx: &C) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let row = dbx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select pg_try_advisory_xact_lock($1) as acquired",
            [RER_DUTY_TEST_REPLAY_ADVISORY_LOCK_KEY.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    Ok(row.try_get("", "acquired").c(h!())?)
}

fn sleep_until(next_emit_at: NaiveDateTime, now: NaiveDateTime) -> u64 {
    let milliseconds = (next_emit_at - now).num_milliseconds().max(1);
    ((milliseconds + 999) / 1_000) as u64
}

fn responsive_sleep(sleep_sec: u64) -> u64 {
    sleep_sec.min(RER_DUTY_TEST_REPLAY_DISABLED_SLEEP_SEC)
}

fn replay_interval_sec(interval_sec: i64) -> i64 {
    interval_sec.clamp(1, RER_DUTY_TEST_REPLAY_INTERVAL_SEC_MAX)
}

async fn load_replay_source_ids<C>(
    dbx: &C,
    since_ms: i64,
    limit: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    let since = crate::utils::dt_from_millis(since_ms.max(0)).c(h!())?;
    let limit = limit.clamp(1, RER_DUTY_TEST_REPLAY_SOURCE_MAX) as u64;
    let replay_comment = Query::select()
        .expr(Expr::value(1))
        .from(sigint_comment::Entity)
        .and_where(
            Expr::col((
                sigint_comment::Entity,
                sigint_comment::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .and_where(
            sigint_comment::Column::Comment.eq(RER_DUTY_TEST_REPLAY_COMMENT),
        )
        .to_owned();
    Ok(sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(Expr::exists(replay_comment).not())
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id)
        .limit(limit)
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

fn next_source_index(source_ids: &[i64], generated_count: i64) -> usize {
    generated_count.max(0) as usize % source_ids.len()
}

async fn cleanup_replayed_messages(
    txn: DatabaseTransaction,
) -> Result<ReplayIteration, AppError> {
    let system_login_id = crate::users::system_login_id(&txn).await.c(h!())?;
    let replayed_message_ids = marked_replay_comments(system_login_id)
        .order_by_asc(sigint_comment::Column::SignalMessageId)
        .limit(RER_DUTY_TEST_REPLAY_CLEANUP_BATCH_SIZE)
        .select_only()
        .column(sigint_comment::Column::SignalMessageId)
        .into_tuple::<i64>()
        .all(&txn)
        .await
        .c(h!())?;
    if replayed_message_ids.is_empty() {
        txn.commit().await.c(h!())?;
        return Ok(ReplayIteration {
            sleep_sec: RER_DUTY_TEST_REPLAY_DISABLED_SLEEP_SEC,
            changed_message_ids: vec![],
        });
    }
    signal_message::Entity::update_many()
        .col_expr(signal_message::Column::Deleted, Expr::value(true))
        .filter(signal_message::Column::Id.is_in(replayed_message_ids.clone()))
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(ReplayIteration {
        sleep_sec: 0,
        changed_message_ids: replayed_message_ids,
    })
}

async fn publish_replay_events(
    redis: &mut ConnectionManager,
    message_ids: Vec<i64>,
) -> Result<(), AppError> {
    if message_ids.is_empty() {
        return Ok(());
    }
    fanout_mult(
        redis,
        message_ids
            .iter()
            .map(|message_id| {
                EventMsg::new(EventType::ETInboxChanged(*message_id))
            })
            .collect(),
    )
    .await
    .c(h!())?;
    Ok(())
}

fn marked_replay_comments(
    system_login_id: uuid::Uuid,
) -> Select<sigint_comment::Entity> {
    sigint_comment::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_comment::Relation::SignalMessage.def(),
        )
        .filter(sigint_comment::Column::LoginId.eq(system_login_id))
        .filter(
            sigint_comment::Column::Comment.eq(RER_DUTY_TEST_REPLAY_COMMENT),
        )
        .filter(signal_message::Column::Deleted.eq(false))
}

async fn load_replay_progress<C>(dbx: &C) -> Result<ReplayProgress, AppError>
where
    C: ConnectionTrait,
{
    let system_login_id = crate::users::system_login_id(dbx).await.c(h!())?;
    let generated_count = marked_replay_comments(system_login_id)
        .count(dbx)
        .await
        .c(h!())? as i64;
    let latest = marked_replay_comments(system_login_id)
        .order_by_desc(sigint_comment::Column::CreatedAt)
        .order_by_desc(sigint_comment::Column::SignalMessageId)
        .one(dbx)
        .await
        .c(h!())?;
    Ok(ReplayProgress {
        generated_count,
        latest_created_at: latest.map(|comment| comment.created_at),
    })
}

pub async fn rer_duty_test_replay_status(
    dbx: &DatabaseConnection,
) -> Result<RerDutyTestReplayStatusRsp, AppError> {
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    let enabled = settings
        .as_ref()
        .is_some_and(|settings| settings.rer_duty_test_enabled);
    let progress = load_replay_progress(dbx).await?;
    if !enabled {
        return Ok(RerDutyTestReplayStatusRsp {
            status: if progress.generated_count > 0 {
                "cleaning"
            } else {
                "disabled"
            }
            .to_string(),
            source_count: 0,
            next_source_position: None,
            generated_count: progress.generated_count,
            next_emit_at_ms: None,
        });
    }
    let settings = settings.expect("enabled settings must exist");
    let source_ids = load_replay_source_ids(
        dbx,
        settings.rer_duty_test_since_ms,
        settings.rer_duty_test_limit,
    )
    .await?;
    let source_count = source_ids.len() as i64;
    let next_source_position = (!source_ids.is_empty()).then(|| {
        next_source_index(&source_ids, progress.generated_count) as i64 + 1
    });
    let next_emit_at_ms = progress
        .latest_created_at
        .map(|created_at| {
            created_at
                + Duration::seconds(replay_interval_sec(
                    settings.rer_duty_test_replay_interval_sec,
                ))
        })
        .map(|next_emit_at| next_emit_at.and_utc().timestamp_millis())
        .or_else(|| Some(Utc::now().timestamp_millis()));
    Ok(RerDutyTestReplayStatusRsp {
        status: if source_ids.is_empty() {
            "empty".to_string()
        } else {
            "running".to_string()
        },
        source_count,
        next_source_position,
        generated_count: progress.generated_count,
        next_emit_at_ms,
    })
}

async fn load_replay_source<C>(
    dbx: &C,
    source_id: i64,
) -> Result<Option<ReplaySource>, AppError>
where
    C: ConnectionTrait,
{
    Ok(load_replay_sources(dbx, vec![source_id])
        .await?
        .into_iter()
        .next())
}

async fn load_replay_sources<C>(
    dbx: &C,
    source_ids: Vec<i64>,
) -> Result<Vec<ReplaySource>, AppError>
where
    C: ConnectionTrait,
{
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

async fn replay_source_message<C>(
    config: &crate::config::Config,
    dbx: &C,
    source: &ReplaySource,
    replay_ts: NaiveDateTime,
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    let body = build_replay_body(source.message.body.as_deref(), replay_ts);
    let (date, time) = format_date_time_fields(replay_ts);

    let inserted = signal_message::ActiveModel {
        id: NotSet,
        body: Set(body),
        created_at: NotSet,
        timestamp: Set(Some(replay_ts)),
        sender: Set(source.message.sender.clone()),
        format: Set(source.message.format),
        deleted: Set(false),
        external_id: Set(None),
        echo_inbox_message_id: Set(None),
        message_uid: Set(None),
        datasource_group_id: Set(source.message.datasource_group_id),
        operator_tags: Set(source.message.operator_tags.clone()),
        attachments_hash: Set(source.message.attachments_hash.clone()),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    let inserted = update_message_with_uid(dbx, config, inserted)
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
        .insert(dbx)
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
        device_name_id: Set(source.inbox_item.device_name_id),
        network: Set(source.inbox_item.network.clone()),
    }
    .insert(dbx)
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
        .insert(dbx)
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
        .insert(dbx)
        .await
        .c(h!())?;
    }

    for tag in &source.tags {
        sigint_inbox_item_tag::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inserted.id),
            tag_id: Set(tag.tag_id),
            confidence: Set(tag.confidence),
            login_id: Set(tag.login_id),
            model: Set(tag.model.clone()),
        }
        .insert(dbx)
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
        .insert(dbx)
        .await
        .c(h!())?;
    }

    crate::sigint::worker::incoming_message_after_insert(dbx, inserted.id)
        .await
        .c(h!())?;
    Ok(inserted.id)
}

fn build_replay_body(
    body: Option<&str>,
    replay_ts: NaiveDateTime,
) -> Option<String> {
    let body = body?;
    rewrite_buran_datetime(body, replay_ts)
        .or_else(|| rewrite_single_datetime_token(body, replay_ts))
        .or_else(|| Some(body.to_string()))
}

fn rewrite_buran_datetime(
    body: &str,
    replay_ts: NaiveDateTime,
) -> Option<String> {
    lazy_static! {
        static ref DATE_RE: Regex =
            Regex::new(r"Дата: \d{4}-\d{2}-\d{2}").unwrap();
        static ref TIME_RE: Regex = Regex::new(r"Час: \d{2}:\d{2}").unwrap();
    }
    DATE_RE.find(body)?;
    TIME_RE.find(body)?;

    let replay_ts = replay_ts_kyiv(replay_ts);
    let body = replace_first_match(
        body,
        &DATE_RE,
        &replay_ts.format("Дата: %Y-%m-%d").to_string(),
    )?;
    replace_first_match(
        &body,
        &TIME_RE,
        &replay_ts.format("Час: %H:%M").to_string(),
    )
}

fn rewrite_single_datetime_token(
    body: &str,
    replay_ts: NaiveDateTime,
) -> Option<String> {
    lazy_static! {
        static ref PATTERNS: Vec<(Regex, &'static str)> = vec![
            (
                Regex::new(r"\d{2}\.\d{2}\.\d{4}_\d{2}:\d{2}:\d{2}").unwrap(),
                "%d.%m.%Y_%H:%M:%S",
            ),
            (
                Regex::new(r"\d{2}\.\d{2}\.\d{4}_\d{2}:\d{2}").unwrap(),
                "%d.%m.%Y_%H:%M",
            ),
            (
                Regex::new(r"\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}").unwrap(),
                "%d.%m.%Y, %H:%M:%S",
            ),
            (
                Regex::new(r"\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}").unwrap(),
                "%Y-%m-%d_%H:%M:%S",
            ),
            (
                Regex::new(r"\d{4}-\d{2}-\d{2}_\d{2}:\d{2}").unwrap(),
                "%Y-%m-%d_%H:%M",
            ),
            (
                Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}").unwrap(),
                "%Y-%m-%dT%H:%M:%S",
            ),
            (
                Regex::new(r"\d{4}_\d{2}_\d{2} \d{2}-\d{2}-\d{2}").unwrap(),
                "%Y_%m_%d %H-%M-%S",
            ),
            (
                Regex::new(r"\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}").unwrap(),
                "%d.%m, %H:%M:%S",
            ),
            (
                Regex::new(r"Час: \d{2}:\d{2}:\d{2}").unwrap(),
                "Час: %H:%M:%S",
            ),
            (
                Regex::new(r"\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}").unwrap(),
                "%d.%m.%Y %H:%M:%S",
            ),
            (
                Regex::new(r"\d{2}:\d{2} \d{2}\.\d{2}\.\d{4}").unwrap(),
                "%H:%M %d.%m.%Y",
            ),
            (
                Regex::new(r"\d{2}-\d{2} \d{2}:\d{2}:\d{2}").unwrap(),
                "%d-%m %H:%M:%S",
            ),
        ];
    }

    let replay_ts = replay_ts_kyiv(replay_ts);
    PATTERNS.iter().find_map(|(regex, fmt)| {
        replace_first_match(body, regex, &replay_ts.format(fmt).to_string())
    })
}

fn replace_first_match(
    body: &str,
    regex: &Regex,
    replacement: &str,
) -> Option<String> {
    let found = regex.find(body)?;
    let mut result = String::with_capacity(
        body.len() - found.as_str().len() + replacement.len(),
    );
    result.push_str(&body[..found.start()]);
    result.push_str(replacement);
    result.push_str(&body[found.end()..]);
    Some(result)
}

fn replay_ts_kyiv(replay_ts: NaiveDateTime) -> DateTime<chrono_tz::Tz> {
    DateTime::<Utc>::from_naive_utc_and_offset(replay_ts, Utc)
        .with_timezone(&chrono_tz::Europe::Kyiv)
}

fn format_date_time_fields(dt_utc: NaiveDateTime) -> (String, String) {
    let dt_kyiv = DateTime::<Utc>::from_naive_utc_and_offset(dt_utc, Utc)
        .with_timezone(&chrono_tz::Europe::Kyiv);
    let date = dt_kyiv.format("%Y-%m-%d").to_string();
    let time = dt_kyiv.format("%H:%M:%S").to_string();
    (date, time)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone};

    fn replay_ts() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 4, 22)
            .unwrap()
            .and_hms_opt(9, 18, 31)
            .unwrap()
    }

    fn parsed_body_datetime(body: &str) -> NaiveDateTime {
        let lnow = chrono_tz::Europe::Kyiv
            .from_utc_datetime(&replay_ts())
            .with_timezone(&chrono_tz::Europe::Kyiv);
        crate::rer_importer::datetime::extract_datetime(lnow, body)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn build_replay_body_rewrites_mouse_datetime() {
        let body = r#"29.02.2024_15:50 F=446.1125(МГц) П54
УКХ р/м 70 мсп 42 мсд 58 А
ЛАВИНА
СЕРБ"#;

        let edited = build_replay_body(Some(body), replay_ts()).unwrap();

        assert!(edited.starts_with("22.04.2026_12:18"));
        assert_eq!(
            parsed_body_datetime(&edited),
            NaiveDate::from_ymd_opt(2026, 4, 22)
                .unwrap()
                .and_hms_opt(12, 18, 0)
                .unwrap()
        );
    }

    #[test]
    fn build_replay_body_rewrites_buran_datetime_pair() {
        let body = r#"Дата: 2024-02-21;
Час: 17:28;
Частота: 446.1125
ЛАВИНА СЕРБ"#;

        let edited = build_replay_body(Some(body), replay_ts()).unwrap();

        assert!(edited.contains("Дата: 2026-04-22;"));
        assert!(edited.contains("Час: 12:18;"));
        assert_eq!(
            parsed_body_datetime(&edited),
            NaiveDate::from_ymd_opt(2026, 4, 22)
                .unwrap()
                .and_hms_opt(12, 18, 0)
                .unwrap()
        );
    }

    #[test]
    fn build_replay_body_preserves_body_without_editable_datetime() {
        assert_eq!(
            build_replay_body(Some("ЛАВИНА СЕРБ без дати"), replay_ts()),
            Some("ЛАВИНА СЕРБ без дати".to_string())
        );
        assert_eq!(build_replay_body(None, replay_ts()), None);
    }

    #[test]
    fn replay_interval_is_bounded() {
        assert_eq!(replay_interval_sec(0), 1);
        assert_eq!(replay_interval_sec(10), 10);
        assert_eq!(
            replay_interval_sec(i64::MAX),
            RER_DUTY_TEST_REPLAY_INTERVAL_SEC_MAX
        );
    }

    #[test]
    fn replay_position_loops_over_source_messages() {
        let source_ids = [10, 20, 30];
        assert_eq!(next_source_index(&source_ids, 0), 0);
        assert_eq!(next_source_index(&source_ids, 2), 2);
        assert_eq!(next_source_index(&source_ids, 3), 0);
    }
}
