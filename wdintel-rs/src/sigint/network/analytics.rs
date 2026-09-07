use crate::entities::{datasource_group, sigint_network, sigint_network_freq};
use crate::error::AppError;
use crate::sigint::etalonka::query::CallsignActivityInfo;
use crate::sigint::etalonka::types::NetworkPointQueryRes;
use crate::sigint::network::types::{
    NetworkCallsignRelationMessage, NetworkCallsignRelationMessagesReq,
    NetworkFreqCallsignsPeriod,
};
use crate::types::*;
use chrono::NaiveDateTime;
use sea_orm::*;
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};

type NetworkGroupActivity =
    HashMap<String, HashMap<String, HashMap<String, i64>>>;

const NETWORK_GROUP_ACTIVITY_SQL: &str = r#"
SELECT
    network_link.sigint_network_id AS network_id,
    (
        EXTRACT(EPOCH FROM DATE_TRUNC(
            'day',
            inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv'
        )) * 1000
    )::BIGINT AS day,
    COALESCE(signal_group.name, datasource_group.group_master_key) AS group_name,
    count(*) AS message_count
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
  AND signal_message.deleted = false
  AND signal_message.datasource_group_id = ANY($4)
  AND signal_group.deleted = false
  AND signal_group.is_archived = false
  AND inbox_item.datetime >= $5
  AND inbox_item.datetime <= $6
  AND (
      network.active_from IS NULL
      OR inbox_item.datetime >= network.active_from
  )
  AND (
      network.active_to IS NULL
      OR inbox_item.datetime <= network.active_to
  )
  AND EXISTS (
      SELECT 1
      FROM sigint_network_freq network_freq
      WHERE network_freq.network_id = network_link.sigint_network_id
        AND network_freq.freq = inbox_item.freq
        AND network_freq.deleted = false
        AND inbox_item.datetime >= network_freq.active_from
        AND (
            network_freq.active_to IS NULL
            OR inbox_item.datetime <= network_freq.active_to
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
          CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      ) - ($6 * INTERVAL '1 day')
  )
  AND COALESCE(
      inbox_item.datetime,
      signal_message.timestamp,
      signal_message.created_at
  ) <= COALESCE(
      network_freq.active_to,
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
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

#[derive(Debug, FromRow)]
struct NetworkGroupActivityRow {
    network_id: i64,
    day: i64,
    group_name: String,
    message_count: i64,
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
) -> Result<NetworkGroupActivity, AppError> {
    if groups.is_empty() || network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let datasource_group_ids = load_datasource_group_ids(source_db, groups)
        .await
        .context(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let (network_bounds, period_bounds) = tokio::try_join!(
        load_networks_message_id_bounds(source_db, network_ids),
        load_message_id_bounds_for_period(analytics_db, since, till),
    )
    .context(h!())?;
    let (
        Some((network_min_id, network_max_id)),
        Some((period_min_id, period_max_id)),
    ) = (network_bounds, period_bounds)
    else {
        return Ok(HashMap::new());
    };
    let min_item_id = std::cmp::max(network_min_id, period_min_id);
    let max_item_id = std::cmp::min(network_max_id, period_max_id);
    if min_item_id > max_item_id {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, NetworkGroupActivityRow>(
        NETWORK_GROUP_ACTIVITY_SQL,
    )
    .bind(network_ids)
    .bind(min_item_id)
    .bind(max_item_id)
    .bind(&datasource_group_ids)
    .bind(since)
    .bind(till)
    .fetch_all(analytics_db.get_postgres_connection_pool())
    .await
    .c(h!())?;

    let mut activity = NetworkGroupActivity::new();
    for row in rows {
        activity
            .entry(row.network_id.to_string())
            .or_default()
            .entry(row.day.to_string())
            .or_default()
            .insert(row.group_name, row.message_count);
    }
    Ok(activity)
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
        SELECT
            min(sigint_inbox_item_id) AS min_id,
            max(sigint_inbox_item_id) AS max_id
        FROM sigint_inbox_item_network
        WHERE sigint_network_id = ANY($1)
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
) -> Result<Option<(i64, i64)>, AppError> {
    let bounds = sqlx::query_as::<_, NetworkMessageIdBounds>(
        r#"
        SELECT min(id) AS min_id, max(id) AS max_id
        FROM sigint_inbox_item
        WHERE datetime >= $1
          AND datetime <= $2
        "#,
    )
    .bind(since)
    .bind(till)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .c(h!())?;
    Ok(bounds.min_id.zip(bounds.max_id))
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
    let network_bounds = load_network_message_id_bounds(source_db, network_id);
    let Some((since, till)) = period_bounds else {
        return Ok(network_bounds.await.context(h!())?);
    };
    let (network_bounds, period_bounds) = tokio::try_join!(
        network_bounds,
        load_activity_message_id_bounds_for_period(analytics_db, since, till,),
    )
    .context(h!())?;
    let (
        Some((network_min_id, network_max_id)),
        Some((period_min_id, period_max_id)),
    ) = (network_bounds, period_bounds)
    else {
        return Ok(None);
    };
    let min_item_id = std::cmp::max(network_min_id, period_min_id);
    let max_item_id = std::cmp::min(network_max_id, period_max_id);
    Ok((min_item_id <= max_item_id).then_some((min_item_id, max_item_id)))
}

async fn load_activity_message_id_bounds_for_period(
    db: &DatabaseConnection,
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> Result<Option<(i64, i64)>, AppError> {
    let bounds = sqlx::query_as::<_, NetworkMessageIdBounds>(
        r#"
        SELECT min(inbox_item.id) AS min_id, max(inbox_item.id) AS max_id
        FROM sigint_inbox_item inbox_item
        JOIN signal_message
            ON signal_message.id = inbox_item.id
        WHERE COALESCE(
            inbox_item.datetime,
            signal_message.timestamp,
            signal_message.created_at
        ) >= $1
          AND COALESCE(
            inbox_item.datetime,
            signal_message.timestamp,
            signal_message.created_at
        ) <= $2
        "#,
    )
    .bind(since)
    .bind(till)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .c(h!())?;
    Ok(bounds.min_id.zip(bounds.max_id))
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
    let mut network_freq_ids_by_network = HashMap::<i64, Vec<i64>>::new();
    for network_freq in network_freqs {
        network_freq_ids_by_network
            .entry(network_freq.network_id)
            .or_default()
            .push(network_freq.id);
    }

    for (network_id, network_freq_ids) in network_freq_ids_by_network {
        let Some((min_item_id, max_item_id)) =
            load_network_message_id_bounds(source_db, network_id)
                .await
                .context(h!())?
        else {
            continue;
        };
        let rows = load_network_freq_callsign_rows(
            analytics_db,
            network_id,
            min_item_id,
            max_item_id,
            &datasource_group_ids,
            &network_freq_ids,
            period,
        )
        .await
        .context(h!())?;
        for row in rows {
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

async fn load_network_freq_callsign_rows(
    db: &DatabaseConnection,
    network_id: i64,
    min_item_id: i64,
    max_item_id: i64,
    datasource_group_ids: &[i64],
    network_freq_ids: &[i64],
    period: Option<&NetworkFreqCallsignsPeriod>,
) -> Result<Vec<NetworkFreqCallsignRow>, AppError> {
    Ok(
        sqlx::query_as::<_, NetworkFreqCallsignRow>(NETWORK_FREQ_CALLSIGNS_SQL)
            .bind(network_id)
            .bind(min_item_id)
            .bind(max_item_id)
            .bind(datasource_group_ids)
            .bind(network_freq_ids)
            .bind(period.and_then(NetworkFreqCallsignsPeriod::lookback_days))
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

    #[test]
    fn analytics_queries_use_bounded_network_membership_semijoin() {
        for sql in [NETWORK_CALLSIGN_ACTIVITY_SQL, NETWORK_FREQ_CALLSIGNS_SQL] {
            assert!(sql.contains("echo_clickhouse_derived.message_callsign"));
            assert!(sql.contains("inbox_item.id BETWEEN $2 AND $3"));
            assert!(sql.contains("inbox_item.id IN ("));
            assert!(sql.contains(
                "FROM echo_clickhouse_derived.message_network_link network_link"
            ));
            assert!(!sql
                .contains("JOIN echo_clickhouse_derived.message_network_link"));
        }
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
