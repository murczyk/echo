use crate::entities::{datasource_group, sigint_network, sigint_network_freq};
use crate::error::AppError;
use crate::sigint::etalonka::query::CallsignActivityInfo;
use crate::sigint::etalonka::types::NetworkPointQueryRes;
use crate::sigint::network::types::{
    NetworkCallsignRelationMessage, NetworkCallsignRelationMessagesReq,
    NetworkFreqCallsignsPeriod, NetworkGroupsActivitySummaryRsp,
};
use crate::types::*;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::*;
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};

const NETWORK_GROUP_ACTIVITY_SQL: &str = r#"
SELECT
    network_link.sigint_network_id AS network_id,
    (
        EXTRACT(EPOCH FROM DATE_TRUNC(
            'day',
            COALESCE(
                inbox_item.datetime,
                signal_message.timestamp,
                signal_message.created_at
            ) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv'
        )) * 1000
    )::BIGINT AS day,
    COALESCE(signal_group.name, datasource_group.group_master_key) AS group_name,
    count(*) AS message_count,
    max(COALESCE(inbox_item.datetime, signal_message.timestamp, signal_message.created_at)) AS last_activity_at
FROM echo_clickhouse_derived.message_network_link network_link
JOIN sigint_inbox_item inbox_item
    ON inbox_item.id = network_link.sigint_inbox_item_id
JOIN sigint_network network
    ON network.id = network_link.sigint_network_id
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN datasource_group
    ON datasource_group.id = signal_message.datasource_group_id
JOIN signal_group
    ON signal_group.master_key = datasource_group.group_master_key
WHERE network_link.sigint_network_id = ANY($1)
  AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  AND inbox_item.id BETWEEN $2 AND $3
  AND signal_message.id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND signal_group.deleted = false
  AND signal_group.is_archived = false
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) >= $5
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) < $6
  AND (
      network.active_from IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) >= network.active_from
  )
  AND (
      network.active_to IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) <= network.active_to
  )
  AND EXISTS (
      SELECT 1
      FROM sigint_network_freq network_freq
      WHERE network_freq.network_id = network_link.sigint_network_id
        AND network_freq.freq = inbox_item.freq
        AND network_freq.deleted = false
        AND COALESCE(
            inbox_item.datetime,
            signal_message.timestamp,
            signal_message.created_at
        ) >= network_freq.active_from
        AND (
            network_freq.active_to IS NULL
            OR COALESCE(
                inbox_item.datetime,
                signal_message.timestamp,
                signal_message.created_at
            ) <= network_freq.active_to
        )
  )
GROUP BY
    network_link.sigint_network_id,
    day,
    group_name
ORDER BY
    network_link.sigint_network_id DESC,
    day DESC,
    group_name DESC
"#;

const NETWORK_POINTS_SQL: &str = r#"
SELECT
    signal_message.id AS id,
    inbox_item.freq AS freq,
    peleng.lat AS lat,
    peleng.lng AS lng,
    signal_message.body AS body
FROM sigint_inbox_item inbox_item
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN sigint_peleng peleng
    ON peleng.source_inbox_item_id = inbox_item.id
JOIN sigint_network_freq network_freq
    ON network_freq.network_id = $1
   AND network_freq.freq = inbox_item.freq
JOIN sigint_network network
    ON network.id = network_freq.network_id
WHERE inbox_item.id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND network.deleted = false
  AND peleng.deleted = false
  AND inbox_item.coords IS NOT NULL
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) >= $5
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) >= network_freq.active_from
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) < COALESCE(
      network_freq.active_to,
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
  )
  AND (
      $6::TIMESTAMP IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) < $6
  )
  AND inbox_item.id IN (
      SELECT network_link.sigint_inbox_item_id
      FROM echo_clickhouse_derived.message_network_link network_link
      WHERE network_link.sigint_network_id = $1
        AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  )
"#;

const NETWORK_RELATION_MESSAGES_SQL: &str = r#"
SELECT
    inbox_item.id AS message_id,
    inbox_item.datetime AS timestamp,
    inbox_item.freq AS freq,
    COALESCE(signal_message.body, '') AS text,
    array_agg(
        DISTINCT upper(btrim(message_callsign.callsign))
    ) AS callsigns
FROM echo_clickhouse_derived.message_network_link network_link
JOIN sigint_inbox_item inbox_item
    ON inbox_item.id = network_link.sigint_inbox_item_id
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN sigint_network network
    ON network.id = network_link.sigint_network_id
JOIN echo_clickhouse_derived.message_callsign message_callsign
    ON message_callsign.sigint_inbox_item_id = inbox_item.id
WHERE network_link.sigint_network_id = $1
  AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND network.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND inbox_item.datetime >= $5
  AND inbox_item.datetime < $6
  AND btrim(message_callsign.callsign) <> ''
GROUP BY
    inbox_item.id,
    inbox_item.datetime,
    inbox_item.freq,
    signal_message.body
ORDER BY inbox_item.datetime DESC, inbox_item.id DESC
"#;

const NETWORK_RELATION_SELECTED_MESSAGES_SQL: &str = r#"
SELECT
    inbox_item.id AS message_id,
    inbox_item.datetime AS timestamp,
    inbox_item.freq AS freq,
    COALESCE(signal_message.body, '') AS text,
    array_agg(
        DISTINCT upper(btrim(message_callsign.callsign))
    ) AS callsigns
FROM echo_clickhouse_derived.message_network_link network_link
JOIN sigint_inbox_item inbox_item
    ON inbox_item.id = network_link.sigint_inbox_item_id
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN sigint_network network
    ON network.id = network_link.sigint_network_id
JOIN echo_clickhouse_derived.message_callsign message_callsign
    ON message_callsign.sigint_inbox_item_id = inbox_item.id
WHERE network_link.sigint_network_id = $1
  AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND network.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND inbox_item.datetime >= $5
  AND inbox_item.datetime < $6
  AND btrim(message_callsign.callsign) <> ''
  AND (
      ($9 AND inbox_item.freq IS NULL)
      OR (
          NOT $9
          AND (
              inbox_item.freq IS NULL
              OR inbox_item.freq = ANY($10)
          )
      )
  )
GROUP BY
    inbox_item.id,
    inbox_item.datetime,
    inbox_item.freq,
    signal_message.body
HAVING count(
    DISTINCT CASE
        WHEN upper(btrim(message_callsign.callsign)) = ANY($7)
        THEN upper(btrim(message_callsign.callsign))
    END
) >= $8
ORDER BY inbox_item.datetime DESC, inbox_item.id DESC
LIMIT $11
"#;

const NETWORK_CALLSIGN_ACTIVITY_SQL: &str = r#"
SELECT
    message_callsign.callsign,
    count(DISTINCT inbox_item.id) AS message_count,
    max(COALESCE(
        inbox_item.datetime,
        signal_message.timestamp,
        signal_message.created_at
    )) AS last_datetime,
    array_agg(DISTINCT inbox_item.freq) AS freqs
FROM sigint_inbox_item inbox_item
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN sigint_network_freq network_freq
    ON network_freq.network_id = $1
   AND network_freq.freq = inbox_item.freq
JOIN echo_clickhouse_derived.message_callsign message_callsign
    ON message_callsign.sigint_inbox_item_id = inbox_item.id
WHERE inbox_item.id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND signal_message.id BETWEEN $2 AND $3
  AND message_callsign.sigint_inbox_item_id BETWEEN $2 AND $3
  AND (
      network_freq.deleted = false
      OR network_freq.active_to IS NOT NULL
  )
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) >= network_freq.active_from
  AND (
      $5::TIMESTAMP IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) >= $5
  )
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) <= COALESCE(
      network_freq.active_to,
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
  )
  AND (
      $6::TIMESTAMP IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) <= $6
  )
  AND inbox_item.id IN (
      SELECT network_link.sigint_inbox_item_id
      FROM echo_clickhouse_derived.message_network_link network_link
      WHERE network_link.sigint_network_id = $1
        AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  )
  AND btrim(message_callsign.callsign) <> ''
GROUP BY message_callsign.callsign
"#;

const NETWORK_FREQ_CALLSIGNS_SQL: &str = r#"
SELECT DISTINCT
    network_freq.id AS network_freq_id,
    message_callsign.callsign
FROM sigint_inbox_item inbox_item
JOIN signal_message
    ON signal_message.id = inbox_item.id
JOIN sigint_network_freq network_freq
    ON network_freq.network_id = $1
   AND network_freq.freq = inbox_item.freq
JOIN echo_clickhouse_derived.message_callsign message_callsign
    ON message_callsign.sigint_inbox_item_id = inbox_item.id
WHERE inbox_item.id BETWEEN $2 AND $3
  AND signal_message.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND signal_message.id BETWEEN $2 AND $3
  AND message_callsign.sigint_inbox_item_id BETWEEN $2 AND $3
  AND network_freq.deleted = false
  AND network_freq.id = ANY($5)
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) >= network_freq.active_from
  AND (
      $6::BIGINT IS NULL
      OR COALESCE(
          inbox_item.datetime,
          signal_message.timestamp,
          signal_message.created_at
      ) >= COALESCE(
          network_freq.active_to,
          $7::TIMESTAMP
      ) - ($6 * INTERVAL '1 day')
  )
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) <= COALESCE(
      network_freq.active_to,
      $7::TIMESTAMP
  )
  AND inbox_item.id IN (
      SELECT network_link.sigint_inbox_item_id
      FROM echo_clickhouse_derived.message_network_link network_link
      WHERE network_link.sigint_network_id = $1
        AND network_link.sigint_inbox_item_id BETWEEN $2 AND $3
  )
  AND btrim(message_callsign.callsign) <> ''
"#;

#[derive(Debug, FromRow)]
struct NetworkMessageIdBounds {
    min_id: Option<i64>,
    max_id: Option<i64>,
}

#[derive(Debug, FromRow)]
struct NetworkCallsignActivityRow {
    callsign: String,
    message_count: i64,
    last_datetime: Option<NaiveDateTime>,
    freqs: Vec<String>,
}

#[derive(Debug, FromRow)]
struct NetworkFreqCallsignRow {
    network_freq_id: i64,
    callsign: String,
}

#[derive(Debug, PartialEq, Eq)]
struct NetworkFreqCallsignQueryGroup {
    network_freq_ids: Vec<i64>,
    period_bounds: Option<(NaiveDateTime, NaiveDateTime)>,
    period_end_is_live: bool,
}

#[derive(Debug, FromRow)]
struct NetworkGroupActivityRow {
    network_id: i64,
    day: i64,
    group_name: String,
    message_count: i64,
    last_activity_at: NaiveDateTime,
}

#[derive(Debug, FromRow)]
struct NetworkRelationMessageRow {
    message_id: i64,
    timestamp: Option<NaiveDateTime>,
    freq: Option<String>,
    text: String,
    callsigns: Vec<String>,
}

#[derive(Debug, FromRow)]
struct NetworkPointRow {
    id: i64,
    freq: String,
    lat: f64,
    lng: f64,
    body: String,
}

pub(crate) async fn load_network_group_activity(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_ids: &[i64],
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> Result<NetworkGroupsActivitySummaryRsp, AppError> {
    if groups.is_empty() || network_ids.is_empty() {
        return Ok(NetworkGroupsActivitySummaryRsp::default());
    }

    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(NetworkGroupsActivitySummaryRsp::default());
    }
    let network_bounds =
        load_networks_message_id_bounds(source_db, network_ids)
            .await
            .context(h!())?;
    let Some(network_bounds) = network_bounds else {
        return Ok(NetworkGroupsActivitySummaryRsp::default());
    };
    let period_bounds = load_message_id_bounds_for_period(
        analytics_db,
        since,
        till,
        network_bounds,
    )
    .await
    .context(h!())?;
    let network_bounds = Some(network_bounds);
    let (
        Some((network_min_id, network_max_id)),
        Some((period_min_id, period_max_id)),
    ) = (network_bounds, period_bounds)
    else {
        return Ok(NetworkGroupsActivitySummaryRsp::default());
    };
    let min_item_id = std::cmp::max(network_min_id, period_min_id);
    let max_item_id = std::cmp::min(network_max_id, period_max_id);
    if min_item_id > max_item_id {
        return Ok(NetworkGroupsActivitySummaryRsp::default());
    }

    let mut response = NetworkGroupsActivitySummaryRsp::default();
    let mut start = min_item_id;
    while start <= max_item_id {
        let end = std::cmp::min(
            start.saturating_add(
                crate::config::ANALYTICS_NETWORK_ACTIVITY_MESSAGE_ID_CHUNK_SIZE
                    - 1,
            ),
            max_item_id,
        );
        let rows = sqlx::query_as::<_, NetworkGroupActivityRow>(
            NETWORK_GROUP_ACTIVITY_SQL,
        )
        .bind(network_ids)
        .bind(start)
        .bind(end)
        .bind(&datasource_group_ids)
        .bind(since)
        .bind(till)
        .fetch_all(analytics_db.get_postgres_connection_pool())
        .await
        .c(h!())?;
        for row in rows {
            merge_network_group_activity_row(&mut response, row).c(h!())?;
        }
        if end == max_item_id {
            break;
        }
        start = end + 1;
    }
    Ok(response)
}

fn merge_network_group_activity_row(
    response: &mut NetworkGroupsActivitySummaryRsp,
    row: NetworkGroupActivityRow,
) -> anyhow::Result<()> {
    let network_id = row.network_id.to_string();
    let last_activity_at = row.last_activity_at.and_utc().timestamp_millis();
    response
        .last_activity_at
        .entry(network_id.clone())
        .and_modify(|current| {
            *current = std::cmp::max(*current, last_activity_at)
        })
        .or_insert(last_activity_at);
    let count = response
        .activity
        .entry(network_id)
        .or_default()
        .entry(row.day.to_string())
        .or_default()
        .entry(row.group_name)
        .or_default();
    *count = count.checked_add(row.message_count).c(h!())?;
    Ok(())
}

pub(crate) async fn load_network_points(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_id: i64,
    since: NaiveDateTime,
    till: Option<NaiveDateTime>,
) -> Result<Vec<NetworkPointQueryRes>, AppError> {
    if groups.is_empty() {
        return Ok(Vec::new());
    }

    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(Vec::new());
    }
    let Some((min_item_id, max_item_id)) =
        load_network_message_id_bounds(source_db, network_id)
            .await
            .context(h!())?
    else {
        return Ok(Vec::new());
    };

    let rows = sqlx::query_as::<_, NetworkPointRow>(NETWORK_POINTS_SQL)
        .bind(network_id)
        .bind(min_item_id)
        .bind(max_item_id)
        .bind(&datasource_group_ids)
        .bind(since)
        .bind(till)
        .fetch_all(analytics_db.get_postgres_connection_pool())
        .await
        .c(h!())?;

    Ok(rows
        .into_iter()
        .map(|row| NetworkPointQueryRes {
            id: row.id,
            freq: row.freq,
            lat: row.lat,
            lng: row.lng,
            body: row.body,
        })
        .collect())
}

pub(crate) async fn load_network_relation_messages_for_graph(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_id: i64,
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> Result<Vec<NetworkCallsignRelationMessage>, AppError> {
    let Some(query_args) =
        load_network_relation_query_args(source_db, groups, network_id)
            .await
            .context(h!())?
    else {
        return Ok(Vec::new());
    };

    let rows = sqlx::query_as::<_, NetworkRelationMessageRow>(
        NETWORK_RELATION_MESSAGES_SQL,
    )
    .bind(network_id)
    .bind(query_args.min_item_id)
    .bind(query_args.max_item_id)
    .bind(&query_args.datasource_group_ids)
    .bind(since)
    .bind(till)
    .fetch_all(analytics_db.get_postgres_connection_pool())
    .await
    .c(h!())?;

    Ok(map_network_relation_messages(rows))
}

pub(crate) async fn load_selected_network_relation_messages(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    req: &NetworkCallsignRelationMessagesReq,
) -> Result<Vec<NetworkCallsignRelationMessage>, AppError> {
    let limit = req
        .limit
        .clamp(0, crate::config::SIGINT_NETWORK_RELATION_MESSAGES_LIMIT_MAX);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some(query_args) =
        load_network_relation_query_args(source_db, groups, req.network_id)
            .await
            .context(h!())?
    else {
        return Ok(Vec::new());
    };
    let required_callsigns = selected_relation_callsigns(req);
    if required_callsigns.is_empty() {
        return Ok(Vec::new());
    }

    let since = crate::utils::dt_from_millis(req.since_date_inclusive_ms)
        .context(h!())?;
    let till = crate::utils::dt_from_millis(req.till_date_noninclusive_ms)
        .context(h!())?;
    let empty_freq_selection = req.freqs.is_empty();
    let freqs = req
        .freqs
        .iter()
        .map(|freq| freq.trim().to_string())
        .filter(|freq| !freq.is_empty())
        .collect::<Vec<_>>();
    let required_callsign_count = required_callsigns.len() as i64;

    let rows = sqlx::query_as::<_, NetworkRelationMessageRow>(
        NETWORK_RELATION_SELECTED_MESSAGES_SQL,
    )
    .bind(req.network_id)
    .bind(query_args.min_item_id)
    .bind(query_args.max_item_id)
    .bind(&query_args.datasource_group_ids)
    .bind(since)
    .bind(till)
    .bind(&required_callsigns)
    .bind(required_callsign_count)
    .bind(empty_freq_selection)
    .bind(&freqs)
    .bind(limit)
    .fetch_all(analytics_db.get_postgres_connection_pool())
    .await
    .c(h!())?;

    Ok(map_network_relation_messages(rows))
}

struct NetworkRelationQueryArgs {
    min_item_id: i64,
    max_item_id: i64,
    datasource_group_ids: Vec<i64>,
}

async fn load_network_relation_query_args(
    source_db: &DatabaseConnection,
    groups: &[String],
    network_id: i64,
) -> Result<Option<NetworkRelationQueryArgs>, AppError> {
    if groups.is_empty() {
        return Ok(None);
    }
    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(None);
    }
    let Some((min_item_id, max_item_id)) =
        load_network_message_id_bounds(source_db, network_id)
            .await
            .context(h!())?
    else {
        return Ok(None);
    };
    Ok(Some(NetworkRelationQueryArgs {
        min_item_id,
        max_item_id,
        datasource_group_ids,
    }))
}

fn selected_relation_callsigns(
    req: &NetworkCallsignRelationMessagesReq,
) -> Vec<String> {
    let mut callsigns = req
        .callsign
        .iter()
        .map(|callsign| callsign.trim().to_uppercase())
        .filter(|callsign| !callsign.is_empty())
        .collect::<Vec<_>>();
    if callsigns.is_empty() {
        callsigns.extend(
            req.source
                .iter()
                .chain(&req.target)
                .map(|callsign| callsign.trim().to_uppercase())
                .filter(|callsign| !callsign.is_empty()),
        );
    }
    callsigns.sort();
    callsigns.dedup();
    callsigns
}

fn map_network_relation_messages(
    rows: Vec<NetworkRelationMessageRow>,
) -> Vec<NetworkCallsignRelationMessage> {
    rows.into_iter()
        .map(|row| {
            let mut callsigns = row.callsigns;
            callsigns.sort();
            callsigns.dedup();
            NetworkCallsignRelationMessage {
                id: row.message_id,
                timestamp: row
                    .timestamp
                    .map(|timestamp| timestamp.and_utc().timestamp_millis()),
                freq: row.freq,
                text: row.text.trim().to_string(),
                callsigns,
            }
        })
        .collect()
}

pub(crate) async fn load_network_callsign_activity(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_id: i64,
    period: &NetworkFreqCallsignsPeriod,
) -> Result<HashMap<String, CallsignActivityInfo>, AppError> {
    if groups.is_empty() {
        return Ok(HashMap::new());
    }

    let Some(network) = sigint_network::Entity::find_by_id(network_id)
        .filter(sigint_network::Column::Deleted.eq(false))
        .one(source_db)
        .await
        .c(h!())?
    else {
        return Ok(HashMap::new());
    };
    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let period_bounds = super::network_callsign_period_bounds(&network, period);
    let Some((min_item_id, max_item_id)) =
        load_network_callsign_message_id_bounds(
            source_db,
            analytics_db,
            network_id,
            period_bounds,
        )
        .await
        .context(h!())?
    else {
        return Ok(HashMap::new());
    };
    let rows = load_network_callsign_activity_rows(
        analytics_db,
        network_id,
        min_item_id,
        max_item_id,
        &datasource_group_ids,
        period_bounds,
    )
    .await
    .context(h!())?;
    let network_names = if network.name.is_empty() {
        Vec::new()
    } else {
        vec![format!("р/м {}", network.name)]
    };

    Ok(rows
        .into_iter()
        .map(|row| {
            let last_datetime = row
                .last_datetime
                .map(|datetime| datetime.and_utc().timestamp_millis());
            (
                row.callsign,
                CallsignActivityInfo {
                    message_count: row.message_count,
                    last_datetime,
                    freqs: Some(row.freqs),
                    network_names: Some(network_names.clone()),
                },
            )
        })
        .collect())
}

async fn load_datasource_group_ids(
    db: &DatabaseConnection,
    groups: &[String],
) -> Result<Vec<i64>, AppError> {
    Ok(datasource_group::Entity::find()
        .select_only()
        .column(datasource_group::Column::Id)
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups.iter()))
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?)
}

async fn load_network_message_id_bounds(
    db: &DatabaseConnection,
    network_id: i64,
) -> Result<Option<(i64, i64)>, AppError> {
    Ok(load_networks_message_id_bounds(db, &[network_id])
        .await
        .context(h!())?)
}

async fn load_networks_message_id_bounds(
    db: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<Option<(i64, i64)>, AppError> {
    if network_ids.is_empty() {
        return Ok(None);
    }
    let bounds = sqlx::query_as::<_, NetworkMessageIdBounds>(
        r#"
        SELECT min(first_message.id) AS min_id, max(last_message.id) AS max_id
        FROM (SELECT DISTINCT unnest($1::bigint[]) AS id) networks
        LEFT JOIN LATERAL (
            SELECT sigint_inbox_item_id AS id
            FROM sigint_inbox_item_network
            WHERE sigint_network_id = networks.id
            ORDER BY sigint_inbox_item_id
            LIMIT 1
        ) first_message ON TRUE
        LEFT JOIN LATERAL (
            SELECT sigint_inbox_item_id AS id
            FROM sigint_inbox_item_network
            WHERE sigint_network_id = networks.id
            ORDER BY sigint_inbox_item_id DESC
            LIMIT 1
        ) last_message ON TRUE
        "#,
    )
    .bind(network_ids)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .c(h!())?;
    Ok(bounds.min_id.zip(bounds.max_id))
}

async fn load_message_id_bounds_for_period(
    db: &DatabaseConnection,
    since: NaiveDateTime,
    till: NaiveDateTime,
    network_bounds: (i64, i64),
) -> Result<Option<(i64, i64)>, AppError> {
    let mut min_id: Option<i64> = None;
    let mut max_id: Option<i64> = None;
    let mut start = network_bounds.0;
    while start <= network_bounds.1 {
        let end = std::cmp::min(
            start.saturating_add(
                crate::config::ANALYTICS_NETWORK_BOUNDS_MESSAGE_ID_CHUNK_SIZE
                    - 1,
            ),
            network_bounds.1,
        );
        let bounds = sqlx::query_as::<_, NetworkMessageIdBounds>(
            r#"
            SELECT min(inbox_item.id) AS min_id, max(inbox_item.id) AS max_id
            FROM sigint_inbox_item inbox_item
            JOIN signal_message ON signal_message.id = inbox_item.id
            WHERE inbox_item.id BETWEEN $3 AND $4
              AND signal_message.id BETWEEN $3 AND $4
              AND COALESCE(inbox_item.datetime, signal_message.timestamp,
                           signal_message.created_at) >= $1
              AND COALESCE(inbox_item.datetime, signal_message.timestamp,
                           signal_message.created_at) < $2
            "#,
        )
        .bind(since)
        .bind(till)
        .bind(start)
        .bind(end)
        .fetch_one(db.get_postgres_connection_pool())
        .await
        .c(h!())?;
        if let Some(id) = bounds.min_id {
            min_id =
                Some(min_id.map_or(id, |previous| std::cmp::min(previous, id)));
        }
        if let Some(id) = bounds.max_id {
            max_id =
                Some(max_id.map_or(id, |previous| std::cmp::max(previous, id)));
        }
        if end == network_bounds.1 {
            break;
        }
        start = end + 1;
    }
    Ok(min_id.zip(max_id))
}

async fn load_network_callsign_activity_rows(
    db: &DatabaseConnection,
    network_id: i64,
    min_item_id: i64,
    max_item_id: i64,
    datasource_group_ids: &[i64],
    period_bounds: Option<(NaiveDateTime, NaiveDateTime)>,
) -> Result<Vec<NetworkCallsignActivityRow>, AppError> {
    let (since, till) = period_bounds.unzip();
    Ok(sqlx::query_as::<_, NetworkCallsignActivityRow>(
        NETWORK_CALLSIGN_ACTIVITY_SQL,
    )
    .bind(network_id)
    .bind(min_item_id)
    .bind(max_item_id)
    .bind(datasource_group_ids)
    .bind(since)
    .bind(till)
    .fetch_all(db.get_postgres_connection_pool())
    .await
    .c(h!())?)
}

async fn load_network_callsign_message_id_bounds(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    network_id: i64,
    period_bounds: Option<(NaiveDateTime, NaiveDateTime)>,
) -> Result<Option<(i64, i64)>, AppError> {
    let Some(network_bounds) =
        load_network_message_id_bounds(source_db, network_id)
            .await
            .context(h!())?
    else {
        return Ok(None);
    };
    let Some((since, till)) = period_bounds else {
        return Ok(Some(network_bounds));
    };
    let till = till
        .checked_add_signed(Duration::microseconds(1))
        .context(h!())?;
    Ok(load_message_id_bounds_for_period(
        analytics_db,
        since,
        till,
        network_bounds,
    )
    .await
    .context(h!())?)
}

pub(crate) async fn load_network_freq_callsigns(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_freq_ids: &[i64],
    period: Option<&NetworkFreqCallsignsPeriod>,
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    let mut callsigns_by_network_freq_id = network_freq_ids
        .iter()
        .copied()
        .map(|network_freq_id| (network_freq_id, HashSet::new()))
        .collect::<HashMap<_, _>>();
    if groups.is_empty() || network_freq_ids.is_empty() {
        return Ok(finalize_network_freq_callsigns(
            callsigns_by_network_freq_id,
        ));
    }

    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(finalize_network_freq_callsigns(
            callsigns_by_network_freq_id,
        ));
    }
    let network_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::Id.is_in(network_freq_ids.iter()))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .all(source_db)
        .await
        .c(h!())?;
    let mut network_freqs_by_network =
        HashMap::<i64, Vec<sigint_network_freq::Model>>::new();
    for network_freq in network_freqs {
        network_freqs_by_network
            .entry(network_freq.network_id)
            .or_default()
            .push(network_freq);
    }

    let current_time = Utc::now().naive_utc();
    for (network_id, network_freqs) in network_freqs_by_network {
        let Some(network_bounds) =
            load_network_message_id_bounds(source_db, network_id)
                .await
                .context(h!())?
        else {
            continue;
        };
        let query_groups = build_network_freq_callsign_query_groups(
            &network_freqs,
            period,
            current_time,
        );
        let rows = futures::future::try_join_all(query_groups.iter().map(
            |query_group| {
                load_network_freq_callsign_group_rows(
                    analytics_db,
                    network_id,
                    network_bounds,
                    &datasource_group_ids,
                    query_group,
                    period,
                    current_time,
                )
            },
        ))
        .await
        .context(h!())?;
        for row in rows.into_iter().flatten() {
            if !row.callsign.trim().is_empty() {
                callsigns_by_network_freq_id
                    .entry(row.network_freq_id)
                    .or_default()
                    .insert(row.callsign);
            }
        }
    }

    Ok(finalize_network_freq_callsigns(
        callsigns_by_network_freq_id,
    ))
}

fn build_network_freq_callsign_query_groups(
    network_freqs: &[sigint_network_freq::Model],
    period: Option<&NetworkFreqCallsignsPeriod>,
    current_time: NaiveDateTime,
) -> Vec<NetworkFreqCallsignQueryGroup> {
    let Some(lookback_days) =
        period.and_then(NetworkFreqCallsignsPeriod::lookback_days)
    else {
        let mut network_freq_ids =
            network_freqs.iter().map(|freq| freq.id).collect::<Vec<_>>();
        network_freq_ids.sort_unstable();
        return vec![NetworkFreqCallsignQueryGroup {
            network_freq_ids,
            period_bounds: None,
            period_end_is_live: false,
        }];
    };

    let mut groups = network_freqs
        .iter()
        .filter_map(|network_freq| {
            let till = network_freq.active_to.unwrap_or(current_time);
            let lookback_since = till
                .checked_sub_signed(Duration::days(lookback_days))
                .unwrap_or(NaiveDateTime::MIN);
            let since = std::cmp::max(network_freq.active_from, lookback_since);
            (since <= till).then_some(NetworkFreqCallsignQueryGroup {
                network_freq_ids: vec![network_freq.id],
                period_bounds: Some((since, till)),
                period_end_is_live: network_freq.active_to.is_none(),
            })
        })
        .collect::<Vec<_>>();
    groups.sort_unstable_by_key(|group| group.period_bounds);
    groups = merge_overlapping_network_freq_callsign_query_groups(groups);
    merge_nearest_network_freq_callsign_query_groups(&mut groups);
    for group in &mut groups {
        group.network_freq_ids.sort_unstable();
    }
    groups
}

fn merge_overlapping_network_freq_callsign_query_groups(
    groups: Vec<NetworkFreqCallsignQueryGroup>,
) -> Vec<NetworkFreqCallsignQueryGroup> {
    let mut merged = Vec::<NetworkFreqCallsignQueryGroup>::new();
    for mut group in groups {
        let Some(previous) = merged.last_mut() else {
            merged.push(group);
            continue;
        };
        let Some((group_since, group_till)) = group.period_bounds else {
            merged.push(group);
            continue;
        };
        let Some((previous_since, previous_till)) = previous.period_bounds
        else {
            merged.push(group);
            continue;
        };
        if group_since > previous_till {
            merged.push(group);
            continue;
        }
        previous
            .network_freq_ids
            .append(&mut group.network_freq_ids);
        previous.period_bounds = Some((
            std::cmp::min(previous_since, group_since),
            std::cmp::max(previous_till, group_till),
        ));
        previous.period_end_is_live |= group.period_end_is_live;
    }
    merged
}

fn merge_nearest_network_freq_callsign_query_groups(
    groups: &mut Vec<NetworkFreqCallsignQueryGroup>,
) {
    while groups.len()
        > crate::config::SIGINT_NETWORK_FREQ_CALLSIGN_QUERY_MAX_PERIOD_GROUPS
    {
        let merge_index = (0..groups.len() - 1)
            .min_by_key(|index| {
                let (_, left_till) = groups[*index]
                    .period_bounds
                    .expect("limited query group has period bounds");
                let (right_since, _) = groups[*index + 1]
                    .period_bounds
                    .expect("limited query group has period bounds");
                right_since - left_till
            })
            .expect("more than one query group has adjacent groups");
        let mut right = groups.remove(merge_index + 1);
        let left = &mut groups[merge_index];
        let (left_since, _) = left
            .period_bounds
            .expect("limited query group has period bounds");
        let (_, right_till) = right
            .period_bounds
            .expect("limited query group has period bounds");
        left.network_freq_ids.append(&mut right.network_freq_ids);
        left.period_bounds = Some((left_since, right_till));
        left.period_end_is_live |= right.period_end_is_live;
    }
}

async fn load_network_freq_callsign_group_rows(
    db: &DatabaseConnection,
    network_id: i64,
    network_bounds: (i64, i64),
    datasource_group_ids: &[i64],
    query_group: &NetworkFreqCallsignQueryGroup,
    period: Option<&NetworkFreqCallsignsPeriod>,
    current_time: NaiveDateTime,
) -> Result<Vec<NetworkFreqCallsignRow>, AppError> {
    let Some((min_item_id, max_item_id)) =
        load_network_freq_callsign_group_message_id_bounds(
            db,
            network_bounds,
            query_group.period_bounds,
            query_group.period_end_is_live,
        )
        .await
        .context(h!())?
    else {
        return Ok(Vec::new());
    };
    Ok(load_network_freq_callsign_rows(
        db,
        network_id,
        min_item_id,
        max_item_id,
        datasource_group_ids,
        &query_group.network_freq_ids,
        period,
        current_time,
    )
    .await
    .context(h!())?)
}

async fn load_network_freq_callsign_group_message_id_bounds(
    db: &DatabaseConnection,
    network_bounds: (i64, i64),
    period_bounds: Option<(NaiveDateTime, NaiveDateTime)>,
    period_end_is_live: bool,
) -> Result<Option<(i64, i64)>, AppError> {
    let Some((since, till)) = period_bounds else {
        return Ok(Some(network_bounds));
    };
    let till = till
        .checked_add_signed(Duration::microseconds(1))
        .context(h!())?;
    let period_bounds =
        load_message_id_bounds_for_period(db, since, till, network_bounds)
            .await
            .context(h!())?;
    Ok(intersect_message_id_bounds(
        network_bounds,
        period_bounds,
        period_end_is_live,
    ))
}

fn intersect_message_id_bounds(
    network_bounds: (i64, i64),
    period_bounds: Option<(i64, i64)>,
    period_end_is_live: bool,
) -> Option<(i64, i64)> {
    let (period_min_id, period_max_id) = period_bounds?;
    let min_item_id = std::cmp::max(network_bounds.0, period_min_id);
    let max_item_id = if period_end_is_live {
        i64::MAX
    } else {
        std::cmp::min(network_bounds.1, period_max_id)
    };
    (min_item_id <= max_item_id).then_some((min_item_id, max_item_id))
}

async fn load_network_freq_callsign_rows(
    db: &DatabaseConnection,
    network_id: i64,
    min_item_id: i64,
    max_item_id: i64,
    datasource_group_ids: &[i64],
    network_freq_ids: &[i64],
    period: Option<&NetworkFreqCallsignsPeriod>,
    current_time: NaiveDateTime,
) -> Result<Vec<NetworkFreqCallsignRow>, AppError> {
    Ok(
        sqlx::query_as::<_, NetworkFreqCallsignRow>(NETWORK_FREQ_CALLSIGNS_SQL)
            .bind(network_id)
            .bind(min_item_id)
            .bind(max_item_id)
            .bind(datasource_group_ids)
            .bind(network_freq_ids)
            .bind(period.and_then(NetworkFreqCallsignsPeriod::lookback_days))
            .bind(current_time)
            .fetch_all(db.get_postgres_connection_pool())
            .await
            .c(h!())?,
    )
}

fn finalize_network_freq_callsigns(
    callsigns_by_network_freq_id: HashMap<i64, HashSet<String>>,
) -> HashMap<i64, Vec<String>> {
    callsigns_by_network_freq_id
        .into_iter()
        .map(|(network_freq_id, callsigns)| {
            let mut callsigns = callsigns.into_iter().collect::<Vec<_>>();
            callsigns.sort();
            (network_freq_id, callsigns)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::SigintNetworkKind;

    #[tokio::test]
    #[serial_test::serial]
    async fn network_activity_ranges_sum_shared_groups_and_keep_latest_time_3780(
    ) {
        use crate::entities::{
            sigint_inbox_item, sigint_inbox_item_network, signal_message,
        };
        use crate::functest::tests::*;
        let env = cleanup().await.unwrap();
        env.dbx.execute_unprepared(r#"
            CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived;
            CREATE OR REPLACE VIEW echo_clickhouse_derived.message_network_link AS
            SELECT sigint_inbox_item_id, sigint_network_id FROM sigint_inbox_item_network;
        "#).await.unwrap();
        let group = find_test_signal_group(&env.dbx).await.unwrap();
        let datasource = find_test_datasource_group(&env.dbx).await.unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("3780.1".into()),
                active_from: Set(dt(3, 1)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let base = signal_message::Entity::find()
            .select_only()
            .column_as(signal_message::Column::Id.max(), "id")
            .into_tuple::<Option<i64>>()
            .one(&env.dbx)
            .await
            .unwrap()
            .flatten()
            .unwrap_or(0)
            + 1;
        let width =
            crate::config::ANALYTICS_NETWORK_ACTIVITY_MESSAGE_ID_CHUNK_SIZE;
        let latest = dt(3, 2) + Duration::seconds(2);
        for (offset, seconds, deleted) in [
            (0, 0, false),
            (width - 1, 1, false),
            (width, 2, false),
            (width + 1, 3, true),
        ] {
            let id = base + offset;
            let timestamp = dt(3, 2) + Duration::seconds(seconds);
            mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    id: Set(id),
                    datasource_group_id: Set(Some(datasource.id)),
                    timestamp: Set(Some(timestamp)),
                    created_at: Set(timestamp),
                    deleted: Set(deleted),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(id),
                    freq: Set(Some("3780.1".into())),
                    datetime: Set(None),
                    date: Set(None),
                    time: Set(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item_network(
                &env.dbx,
                sigint_inbox_item_network::ActiveModel {
                    sigint_network_id: Set(network.id),
                    sigint_inbox_item_id: Set(id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let response = load_network_group_activity(
            &env.dbx,
            &env.dbx,
            &[group.master_key],
            &[network.id],
            dt(3, 1),
            dt(3, 3),
        )
        .await
        .unwrap();
        assert_eq!(
            response.last_activity_at[&network.id.to_string()],
            latest.and_utc().timestamp_millis()
        );
        assert_eq!(
            response.activity[&network.id.to_string()]
                .values()
                .flat_map(HashMap::values)
                .sum::<i64>(),
            3
        );
        assert_eq!(response.activity[&network.id.to_string()].len(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_bounds_seek_empty_and_mixed_networks_3780() {
        use crate::entities::sigint_inbox_item_network;
        use crate::functest::tests::{
            cleanup, mk_sigint_inbox_item, mk_sigint_inbox_item_network,
            mk_sigint_network,
        };
        let env = cleanup().await.unwrap();
        let empty = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let populated = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let mut ids = Vec::new();
        for _ in 0..3 {
            let item = mk_sigint_inbox_item(&env.dbx, Default::default())
                .await
                .unwrap();
            mk_sigint_inbox_item_network(
                &env.dbx,
                sigint_inbox_item_network::ActiveModel {
                    sigint_network_id: Set(populated.id),
                    sigint_inbox_item_id: Set(item.id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            ids.push(item.id);
        }
        for keys in [vec![], vec![empty.id], vec![i64::MAX]] {
            assert_eq!(
                load_networks_message_id_bounds(&env.dbx, &keys)
                    .await
                    .unwrap(),
                None
            );
        }
        for keys in [
            vec![populated.id],
            vec![empty.id, populated.id, populated.id, i64::MAX],
        ] {
            assert_eq!(
                load_networks_message_id_bounds(&env.dbx, &keys)
                    .await
                    .unwrap(),
                Some((ids[0], ids[2]))
            );
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_period_bounds_3780_preserve_fallbacks_and_chunk_boundaries(
    ) {
        use crate::entities::{sigint_inbox_item, signal_message};
        use crate::functest::tests::{
            cleanup, mk_sigint_inbox_item, mk_signal_message,
        };
        let env = cleanup().await.unwrap();
        let base = signal_message::Entity::find()
            .select_only()
            .column_as(signal_message::Column::Id.max(), "id")
            .into_tuple::<Option<i64>>()
            .one(&env.dbx)
            .await
            .unwrap()
            .flatten()
            .unwrap_or(0)
            + 1;
        let width =
            crate::config::ANALYTICS_NETWORK_BOUNDS_MESSAGE_ID_CHUNK_SIZE;
        let since = dt(3, 2);
        let till = dt(3, 3);
        let old = dt(3, 1);
        for (offset, datetime, timestamp, created_at) in [
            (0, None, Some(old), since),
            (1, Some(since), Some(old), old),
            (width, None, Some(since), old),
            (width + 1, None, None, till),
            (width * 2, Some(old), Some(since), since),
        ] {
            let message = mk_signal_message(
                &env.dbx,
                signal_message::ActiveModel {
                    id: Set(base + offset),
                    timestamp: Set(timestamp),
                    created_at: Set(created_at),
                    datasource_group_id: Set(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    id: Set(message.id),
                    date: Set(None),
                    time: Set(None),
                    datetime: Set(datetime),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let bounds = (base, base + width * 2);
        assert_eq!(
            load_message_id_bounds_for_period(&env.dbx, since, till, bounds)
                .await
                .unwrap(),
            Some((base + 1, base + width))
        );
        assert_eq!(
            load_message_id_bounds_for_period(&env.dbx, till, dt(3, 4), bounds)
                .await
                .unwrap(),
            Some((base + width + 1, base + width + 1))
        );
        assert_eq!(
            load_message_id_bounds_for_period(
                &env.dbx,
                dt(4, 1),
                dt(4, 2),
                bounds
            )
            .await
            .unwrap(),
            None
        );
        assert_eq!(
            load_message_id_bounds_for_period(
                &env.dbx,
                since,
                till,
                (base, base)
            )
            .await
            .unwrap(),
            None
        );
    }

    fn dt(month: u32, day: u32) -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, month, day)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn network_freq(
        id: i64,
        active_from: NaiveDateTime,
        active_to: Option<NaiveDateTime>,
    ) -> sigint_network_freq::Model {
        sigint_network_freq::Model {
            id,
            network_id: 755,
            freq: id.to_string(),
            created_at: active_from,
            kind: SigintNetworkKind::Vhf,
            modulation_id: None,
            active_from,
            active_to,
            sigint_origin_id: None,
            deleted: false,
            original_id: None,
            last_seen_dt: None,
            modulation: String::new(),
            encryption_id: None,
        }
    }

    #[test]
    fn analytics_queries_use_bounded_network_membership_semijoin() {
        for sql in [NETWORK_CALLSIGN_ACTIVITY_SQL, NETWORK_FREQ_CALLSIGNS_SQL] {
            assert!(sql.contains("echo_clickhouse_derived.message_callsign"));
            assert!(sql.contains("inbox_item.id BETWEEN $2 AND $3"));
            assert!(sql.contains("signal_message.id BETWEEN $2 AND $3"));
            assert!(sql.contains(
                "message_callsign.sigint_inbox_item_id BETWEEN $2 AND $3"
            ));
            assert!(sql.contains("inbox_item.id IN ("));
            assert!(sql.contains(
                "FROM echo_clickhouse_derived.message_network_link network_link"
            ));
            assert!(!sql
                .contains("JOIN echo_clickhouse_derived.message_network_link"));
        }
        assert!(NETWORK_FREQ_CALLSIGNS_SQL.contains("$7::TIMESTAMP"));
    }

    #[test]
    fn frequency_callsign_query_groups_preserve_historical_windows() {
        let current_time = dt(10, 3);
        let network_freqs = vec![
            network_freq(1, dt(2, 20), Some(dt(2, 28))),
            network_freq(2, dt(3, 8), Some(dt(9, 11))),
            network_freq(3, dt(1, 1), None),
            network_freq(4, dt(1, 1), Some(dt(9, 27))),
        ];

        let groups = build_network_freq_callsign_query_groups(
            &network_freqs,
            Some(&NetworkFreqCallsignsPeriod::Last21Days),
            current_time,
        );

        assert_eq!(
            groups,
            vec![
                NetworkFreqCallsignQueryGroup {
                    network_freq_ids: vec![1],
                    period_bounds: Some((dt(2, 20), dt(2, 28))),
                    period_end_is_live: false,
                },
                NetworkFreqCallsignQueryGroup {
                    network_freq_ids: vec![2, 3, 4],
                    period_bounds: Some((dt(8, 21), current_time)),
                    period_end_is_live: true,
                },
            ]
        );
    }

    #[test]
    fn unlimited_frequency_callsigns_keep_one_network_query() {
        let network_freqs = vec![
            network_freq(2, dt(3, 8), Some(dt(9, 11))),
            network_freq(1, dt(2, 20), Some(dt(2, 28))),
        ];

        assert_eq!(
            build_network_freq_callsign_query_groups(
                &network_freqs,
                Some(&NetworkFreqCallsignsPeriod::Unlimited),
                dt(10, 3),
            ),
            vec![NetworkFreqCallsignQueryGroup {
                network_freq_ids: vec![1, 2],
                period_bounds: None,
                period_end_is_live: false,
            }]
        );
    }

    #[test]
    fn frequency_callsign_query_groups_merge_the_nearest_excess_windows() {
        let mut groups = [1_u32, 10, 12, 20, 30]
            .into_iter()
            .enumerate()
            .map(|(index, day)| NetworkFreqCallsignQueryGroup {
                network_freq_ids: vec![index as i64],
                period_bounds: Some((dt(1, day), dt(1, day))),
                period_end_is_live: false,
            })
            .collect::<Vec<_>>();

        merge_nearest_network_freq_callsign_query_groups(&mut groups);

        assert_eq!(groups.len(), 4);
        assert_eq!(groups[1].network_freq_ids, vec![1, 2]);
        assert_eq!(groups[1].period_bounds, Some((dt(1, 10), dt(1, 12))));
    }

    #[test]
    fn frequency_callsign_message_bounds_are_intersected() {
        assert_eq!(
            intersect_message_id_bounds((10, 50), Some((20, 60)), false),
            Some((20, 50))
        );
        assert_eq!(
            intersect_message_id_bounds((10, 20), Some((21, 30)), false),
            None
        );
        assert_eq!(intersect_message_id_bounds((10, 20), None, false), None);
    }

    #[test]
    fn live_frequency_callsign_message_bounds_keep_the_upper_bound_open() {
        assert_eq!(
            intersect_message_id_bounds((10, 50), Some((20, 40)), true),
            Some((20, i64::MAX))
        );
    }

    #[test]
    fn frequency_callsigns_are_sorted_and_empty_ids_are_retained() {
        let callsigns = finalize_network_freq_callsigns(HashMap::from([
            (7, HashSet::from(["BRAVO".to_string(), "ALPHA".to_string()])),
            (9, HashSet::new()),
        ]));

        assert_eq!(
            callsigns.get(&7),
            Some(&vec!["ALPHA".into(), "BRAVO".into()])
        );
        assert!(callsigns.get(&9).is_some_and(Vec::is_empty));
    }
}
