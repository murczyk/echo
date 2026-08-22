use crate::entities::{datasource_group, sigint_network, sigint_network_freq};
use crate::error::AppError;
use crate::sigint::etalonka::query::CallsignActivityInfo;
use crate::types::*;
use chrono::NaiveDateTime;
use sea_orm::*;
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};

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

pub(crate) async fn load_network_callsign_activity(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_id: i64,
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
    let datasource_group_ids =
        load_datasource_group_ids(source_db, groups).await?;
    if datasource_group_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let Some((min_item_id, max_item_id)) =
        load_network_message_id_bounds(source_db, network_id).await?
    else {
        return Ok(HashMap::new());
    };
    let rows = load_network_callsign_activity_rows(
        analytics_db,
        network_id,
        min_item_id,
        max_item_id,
        &datasource_group_ids,
    )
    .await?;
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
    let bounds = sqlx::query_as::<_, NetworkMessageIdBounds>(
        r#"
        SELECT
            min(sigint_inbox_item_id) AS min_id,
            max(sigint_inbox_item_id) AS max_id
        FROM sigint_inbox_item_network
        WHERE sigint_network_id = $1
        "#,
    )
    .bind(network_id)
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
) -> Result<Vec<NetworkCallsignActivityRow>, AppError> {
    Ok(sqlx::query_as::<_, NetworkCallsignActivityRow>(
        NETWORK_CALLSIGN_ACTIVITY_SQL,
    )
    .bind(network_id)
    .bind(min_item_id)
    .bind(max_item_id)
    .bind(datasource_group_ids)
    .fetch_all(db.get_postgres_connection_pool())
    .await
    .c(h!())?)
}

pub(crate) async fn load_network_freq_callsigns(
    source_db: &DatabaseConnection,
    analytics_db: &DatabaseConnection,
    groups: &[String],
    network_freq_ids: &[i64],
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

    let datasource_group_ids =
        load_datasource_group_ids(source_db, groups).await?;
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
            load_network_message_id_bounds(source_db, network_id).await?
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
        )
        .await?;
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
) -> Result<Vec<NetworkFreqCallsignRow>, AppError> {
    Ok(
        sqlx::query_as::<_, NetworkFreqCallsignRow>(NETWORK_FREQ_CALLSIGNS_SQL)
            .bind(network_id)
            .bind(min_item_id)
            .bind(max_item_id)
            .bind(datasource_group_ids)
            .bind(network_freq_ids)
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
