use crate::config::ENCRYPTION_KEY_PLACEHOLDER;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::{
    filter_selected_networks, filter_selected_networks_stmt,
};
use crate::sigint::etalonka::types::*;
use crate::sigint::network::filter::apply_network_list_filters;
use crate::sigint::network::sort as network_sort;
use crate::sigint::network::types::ListNetworksReq;
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use chrono::prelude::*;
use futures::stream::TryStreamExt;
use sea_orm::{sea_query::PostgresQueryBuilder, Value, *};
use sea_query::*;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;
use tempfile::Builder;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

const SCREENSHOT_DELAY_MILLIS: u64 = 2500;
const DEFAULT_EMPTY_UNIT_NAME: &str = "в дорозвідці";

#[derive(Iden)]
pub enum SignalMessage {
    Table,
    Id,
    DatasourceGroupId,
    Deleted,
}

#[derive(Iden)]
pub enum DatasourceGroup {
    Table,
    Id,
    GroupMasterKey,
}

#[derive(Iden)]
pub enum SigintInboxItem {
    Table,
    Id,
    Freq,
    Datetime,
    Callsigns,
}

#[derive(Iden)]
pub enum SigintInboxItemNetwork {
    Table,
    Id,
    SigintInboxItemId,
    SigintNetworkId,
    CreatedAt,
}

#[derive(Iden)]
pub enum SigintNetwork {
    Table,
    Id,
    Deleted,
}

#[derive(Iden)]
pub enum NetworkMessages {
    Table,
    Freq,
    CreatedAt,
    ModulationName,
    NetworkFreqId,
    ActiveFrom,
    ActiveTo,
}

#[derive(Iden)]
pub enum SigintNetworkUnit {
    Table,
    NetworkId,
    UnitId,
}

#[derive(Iden)]
pub enum SigintNetworkFreq {
    Table,
    Id,
    NetworkId,
    Freq,
    CreatedAt,
    LastSeenDt,
    ActiveFrom,
    ActiveTo,
    ModulationId,
    Kind,
    Deleted,
}

#[derive(Iden)]
pub enum SigintNetworkCallsign {
    Table,
    Id,
    SigintNetworkId,
    SigintCallsign,
    Deleted,
}

#[derive(Iden)]
pub enum SigintUnit {
    Table,
    Id,
    Name,
    Regiment,
    Division,
    Army,
    Deleted,
}

#[derive(Iden)]
pub enum Modulation {
    Table,
    Id,
    Name,
}

#[derive(Iden)]
pub enum Callsigns {
    Table,
    Callsign,
}

pub async fn load_freqs(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    user_login: &str,
    include_callsigns: bool,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    load_freqs_impl(
        db,
        groups,
        network_id,
        filter,
        user_login,
        None,
        include_callsigns,
    )
    .await
}

pub async fn load_freqs_with_stats(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    user_login: &str,
    freq_counts: HashMap<i64, i64>,
    include_callsigns: bool,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    load_freqs_impl(
        db,
        groups,
        network_id,
        filter,
        user_login,
        Some(freq_counts),
        include_callsigns,
    )
    .await
}

async fn load_freqs_impl(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    user_login: &str,
    freq_counts: Option<HashMap<i64, i64>>,
    include_callsigns: bool,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    trace!("> load freqs for network: {:?}", network_id);

    if freq_counts.is_some() && !include_callsigns {
        return load_freqs_with_cached_activity(
            db,
            network_id,
            filter,
            user_login,
            freq_counts.c(h!())?,
        )
        .await;
    }

    let nf = Alias::new("network_freqs");
    let join_condition =
        build_network_freq_join_condition(filter, true).c(h!())?;
    let callsigns_expr: SimpleExpr = if include_callsigns {
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Callsigns)).into()
    } else {
        Expr::cust("NULL")
    };

    let mut q: SelectStatement = Query::select();
    q.expr_as(
        Expr::col((nf.clone(), SigintNetworkFreq::Id)),
        Alias::new("network_freq_id"),
    )
    .expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
        Alias::new("datetime"),
    )
    .expr_as(callsigns_expr, Alias::new("callsigns"))
    .from(SignalMessage::Table)
    .join(
        JoinType::InnerJoin,
        SigintInboxItem::Table,
        Expr::col((SignalMessage::Table, SignalMessage::Id))
            .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
    )
    .join(
        JoinType::InnerJoin,
        DatasourceGroup::Table,
        Expr::col((SignalMessage::Table, SignalMessage::DatasourceGroupId))
            .equals((DatasourceGroup::Table, DatasourceGroup::Id)),
    )
    .join(
        JoinType::InnerJoin,
        SigintInboxItemNetwork::Table,
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
            SigintInboxItemNetwork::Table,
            SigintInboxItemNetwork::SigintInboxItemId,
        )),
    )
    .join_as(
        JoinType::InnerJoin,
        SigintNetworkFreq::Table,
        nf.clone(),
        join_condition,
    )
    .join(
        JoinType::InnerJoin,
        SigintNetwork::Table,
        Expr::col((SigintNetwork::Table, SigintNetwork::Id))
            .equals((nf.clone(), SigintNetworkFreq::NetworkId)),
    )
    .and_where(datasource_group::Column::GroupMasterKey.eq_any(groups.clone()))
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
    )
    .and_where(Expr::col((nf.clone(), SigintNetworkFreq::Deleted)).eq(false))
    .and_where(
        Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(network_id),
    )
    .and_where_option(filter.as_ref().filter(|f| f.active_freqs_only).map(
        |_| Expr::col((nf.clone(), SigintNetworkFreq::ActiveTo)).is_null(),
    ));
    q = filter_selected_networks_stmt(q, &Some(vec![network_id]), &None)
        .c(h!())?;

    let network_messages_cte = CommonTableExpression::new()
        .query(q)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    let mut q_agg: SelectStatement = Query::select();
    let message_count_expr = if freq_counts.is_none() {
        Expr::cust("COUNT(*)")
    } else {
        Expr::cust("0")
    };
    let callsigns_expr = if include_callsigns {
        Expr::cust("jsonb_agg(callsigns)")
    } else {
        Expr::cust("NULL")
    };
    q_agg
        .expr_as(Expr::cust("network_freq_id"), Alias::new("network_freq_id"))
        .expr_as(message_count_expr, Alias::new("message_count"))
        .expr_as(callsigns_expr, Alias::new("callsigns"))
        .from(Alias::new("network_messages"))
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::NetworkFreqId,
        ))
        .into()]);

    let aggregated_cte = CommonTableExpression::new()
        .query(q_agg)
        .table_name(Alias::new("agg"))
        .to_owned();

    let main_query = SelectStatement::new()
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
            Alias::new("network_freq_id"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::CreatedAt)),
            Alias::new("created_at"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ActiveFrom,
            )),
            Alias::new("active_from"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo)),
            Alias::new("active_to"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ModulationId,
            )),
            Alias::new("modulation_id"),
        )
        .expr_as(
            Expr::col((Modulation::Table, Modulation::Name)),
            Alias::new("modulation_name"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::LastSeenDt,
            )),
            Alias::new("last_datetime"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Kind))
                .cast_as(Alias::new("text")),
            Alias::new("kind"),
        )
        .expr_as(
            Expr::col((Alias::new("agg"), Alias::new("message_count"))),
            Alias::new("message_count"),
        )
        .expr_as(
            Expr::col((Alias::new("agg"), Alias::new("callsigns"))),
            Alias::new("callsigns"),
        )
        .from(SigintNetwork::Table)
        .join(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::LeftJoin,
            Modulation::Table,
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ModulationId,
            ))
            .equals((Modulation::Table, Modulation::Id)),
        )
        .join(
            JoinType::LeftJoin,
            Alias::new("agg"),
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id))
                .equals((Alias::new("agg"), Alias::new("network_freq_id"))),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(network_id),
        )
        .and_where_option(filter.as_ref().filter(|f| f.active_freqs_only).map(
            |_| {
                Expr::col((
                    SigintNetworkFreq::Table,
                    SigintNetworkFreq::ActiveTo,
                ))
                .is_null()
            },
        ))
        .order_by_expr(Expr::cust("freq"), Order::Asc)
        .to_owned();

    let combined_query = Query::with()
        .cte(network_messages_cte)
        .clone()
        .cte(aggregated_cte)
        .clone()
        .query(main_query);

    // debug!(
    //     "> freqs query: {}",
    //     combined_query.to_string(PostgresQueryBuilder)
    // );

    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    load_network_freq_rows(db, rows, user_login, freq_counts).await
}

async fn load_freqs_with_cached_activity(
    db: &DatabaseConnection,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    user_login: &str,
    freq_counts: HashMap<i64, i64>,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    let main_query = build_network_freqs_base_query(network_id, filter)
        .expr_as(Expr::cust("NULL"), Alias::new("callsigns"))
        .to_owned();

    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            main_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    load_network_freq_rows(db, rows, user_login, Some(freq_counts)).await
}

fn build_network_freqs_base_query(
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
) -> SelectStatement {
    SelectStatement::new()
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
            Alias::new("network_freq_id"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::CreatedAt)),
            Alias::new("created_at"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ActiveFrom,
            )),
            Alias::new("active_from"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo)),
            Alias::new("active_to"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ModulationId,
            )),
            Alias::new("modulation_id"),
        )
        .expr_as(
            Expr::col((Modulation::Table, Modulation::Name)),
            Alias::new("modulation_name"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::LastSeenDt,
            )),
            Alias::new("last_datetime"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Kind))
                .cast_as(Alias::new("text")),
            Alias::new("kind"),
        )
        .expr_as(Expr::cust("0"), Alias::new("message_count"))
        .from(SigintNetwork::Table)
        .join(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::LeftJoin,
            Modulation::Table,
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ModulationId,
            ))
            .equals((Modulation::Table, Modulation::Id)),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(network_id),
        )
        .and_where_option(filter.as_ref().filter(|f| f.active_freqs_only).map(
            |_| {
                Expr::col((
                    SigintNetworkFreq::Table,
                    SigintNetworkFreq::ActiveTo,
                ))
                .is_null()
            },
        ))
        .order_by_expr(Expr::cust("freq"), Order::Asc)
        .to_owned()
}

async fn load_network_freq_rows(
    db: &DatabaseConnection,
    rows: Vec<QueryResult>,
    user_login: &str,
    freq_counts: Option<HashMap<i64, i64>>,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    let mut freq_ids = vec![];
    let network_active_freqs: Result<Vec<NetworkFreqsRes>, AppError> = rows
        .iter()
        .map(|row| -> Result<NetworkFreqsRes, AppError> {
            let row_callsigns: Option<serde_json::Value> =
                row.try_get("", "callsigns").ok();
            let row_callsigns = row_callsigns
                .map(serde_json::from_value::<Vec<Vec<String>>>)
                .transpose()
                .context(h!())?
                .map(flatten_and_dedup);

            let created_at: NaiveDateTime =
                row.try_get("", "created_at").context(h!())?;
            let active_from: NaiveDateTime =
                row.try_get("", "active_from").context(h!())?;
            let active_to: Option<NaiveDateTime> =
                row.try_get("", "active_to").context(h!())?;
            let active_to = active_to.map(|dt| dt.and_utc().timestamp_millis());
            let active_from = active_from.and_utc().timestamp_millis();

            let network_freq_id: i64 =
                row.try_get("", "network_freq_id").unwrap_or_default();
            if network_freq_id > 0 {
                freq_ids.push(network_freq_id);
            }
            let freq: String = row.try_get("", "freq").unwrap_or_default();
            let message_count = if let Some(counts) = freq_counts.as_ref() {
                counts.get(&network_freq_id).copied().unwrap_or(0)
            } else {
                row.try_get("", "message_count").unwrap_or(0)
            };

            Ok(NetworkFreqsRes {
                network_freq_id,
                freq,
                modulation_id: row.try_get("", "modulation_id").ok(),
                modulation: row.try_get("", "modulation_name").ok(),
                encryption_key_ids: vec![],
                encryption_keys: vec![],
                message_count,
                callsigns: row_callsigns,
                last_datetime: row
                    .try_get("", "last_datetime")
                    .ok()
                    .map(|dt: NaiveDateTime| dt.and_utc().timestamp_millis()),
                last_datetime_in_aor: None,

                created_at: created_at.and_utc().timestamp_millis(),
                is_active: active_to.is_none(),
                active_from,
                active_to,
                kind: row.try_get("", "kind").ok(),
            })
        })
        .collect();

    let mut keys_by_freq =
        crate::sigint::key::load_freq_keys(db, user_login, freq_ids)
            .await
            .c(h!())?;
    match network_active_freqs {
        Ok(mut networks) => {
            for network in networks.iter_mut() {
                let keys = keys_by_freq
                    .remove(&network.network_freq_id)
                    .unwrap_or_default();
                network.encryption_key_ids =
                    keys.iter().filter_map(|key| key.id).collect();
                network.encryption_keys = keys
                    .into_iter()
                    .map(|key| {
                        format_encryption_key_display(key.key, key.key_hash)
                    })
                    .collect();
            }
            networks.sort_by(|left, right| {
                left.freq.cmp(&right.freq).then_with(|| {
                    left.network_freq_id.cmp(&right.network_freq_id)
                })
            });
            Ok(networks)
        }
        _err => _err,
    }
}

#[derive(FromQueryResult, Clone)]
struct NetworkFreqStatsRangeRow {
    network_freq_id: i64,
    frequency: String,
    active_from: NaiveDateTime,
    active_to: Option<NaiveDateTime>,
}

#[derive(FromQueryResult)]
struct NetworkFreqStatsDayRow {
    frequency: String,
    dt: NaiveDate,
    quantity: i64,
}

#[derive(Debug)]
struct ExactNetworkFreqCountRequest {
    frequency: String,
    day_since_ts: NaiveDateTime,
    day_till_ts: NaiveDateTime,
    network_freq_ids: Vec<i64>,
}

#[derive(sqlx::FromRow)]
struct ExactNetworkFreqCountRow {
    network_freq_id: i64,
    quantity: i64,
}

fn is_network_freq_active_on_day(
    network_freq: &NetworkFreqStatsRangeRow,
    dt: NaiveDate,
) -> bool {
    let active_from_date =
        crate::stats::get_local_date(network_freq.active_from);
    let active_to_date = network_freq
        .active_to
        .map(crate::stats::get_local_date)
        .unwrap_or(NaiveDate::MAX);
    dt >= active_from_date && dt <= active_to_date
}

fn network_freq_has_intra_day_boundary(
    network_freq: &NetworkFreqStatsRangeRow,
    dt: NaiveDate,
) -> Result<bool, AppError> {
    let day_since_ts = crate::stats::start_of_day(dt).c(h!())?;
    let day_till_ts =
        crate::stats::start_of_day(dt + chrono::Duration::days(1)).c(h!())?;
    let has_partial_start = network_freq.active_from > day_since_ts
        && network_freq.active_from < day_till_ts;
    let has_partial_end = network_freq
        .active_to
        .map(|active_to| active_to >= day_since_ts && active_to < day_till_ts)
        .unwrap_or(false);
    Ok(has_partial_start || has_partial_end)
}

fn should_use_exact_counts_for_day(
    network_freqs_for_day: &[&NetworkFreqStatsRangeRow],
    dt: NaiveDate,
) -> Result<bool, AppError> {
    if network_freqs_for_day.len() > 1 {
        return Ok(true);
    }
    if network_freqs_for_day.is_empty() {
        return Ok(false);
    }
    Ok(
        network_freq_has_intra_day_boundary(network_freqs_for_day[0], dt)
            .c(h!())?,
    )
}

async fn load_exact_network_freq_counts(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    requests: Vec<ExactNetworkFreqCountRequest>,
) -> Result<HashMap<i64, i64>, AppError> {
    if requests.is_empty() {
        return Ok(HashMap::new());
    }

    let mut request_ids = Vec::with_capacity(requests.len());
    let mut frequencies = Vec::with_capacity(requests.len());
    let mut day_since_tss = Vec::with_capacity(requests.len());
    let mut day_till_tss = Vec::with_capacity(requests.len());
    let mut freq_request_ids = vec![];
    let mut network_freq_ids = vec![];

    for (request_index, request) in requests.into_iter().enumerate() {
        let request_id = request_index as i64;
        request_ids.push(request_id);
        frequencies.push(request.frequency);
        day_since_tss.push(request.day_since_ts);
        day_till_tss.push(request.day_till_ts);
        for network_freq_id in request.network_freq_ids {
            freq_request_ids.push(request_id);
            network_freq_ids.push(network_freq_id);
        }
    }
    if network_freq_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, ExactNetworkFreqCountRow>(
        r#"
        WITH exact_requests AS (
            SELECT *
            FROM unnest(
                $1::bigint[],
                $2::text[],
                $3::timestamp[],
                $4::timestamp[]
            ) AS req(request_id, frequency, day_since_ts, day_till_ts)
        ),
        exact_freqs AS (
            SELECT *
            FROM unnest(
                $5::bigint[],
                $6::bigint[]
            ) AS freq(request_id, network_freq_id)
        )
        SELECT
            nf.id AS network_freq_id,
            COUNT(*) AS quantity
        FROM exact_requests req
        JOIN exact_freqs ef
            ON ef.request_id = req.request_id
        JOIN sigint_network_freq nf
            ON nf.id = ef.network_freq_id
           AND nf.network_id = $7
           AND nf.freq = req.frequency
           AND nf.deleted = false
        JOIN sigint_inbox_item_network iin
            ON iin.sigint_network_id = nf.network_id
        JOIN sigint_inbox_item ii
            ON ii.id = iin.sigint_inbox_item_id
           AND ii.freq = nf.freq
        JOIN signal_message sm
            ON sm.id = ii.id
        JOIN datasource_group dg
            ON dg.id = sm.datasource_group_id
        WHERE sm.deleted = false
          AND dg.group_master_key = ANY($8)
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at) >= nf.active_from
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at)
                <= COALESCE(nf.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at) >= req.day_since_ts
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at) < req.day_till_ts
        GROUP BY nf.id
        "#,
    )
        .bind(request_ids)
        .bind(frequencies)
        .bind(day_since_tss)
        .bind(day_till_tss)
        .bind(freq_request_ids)
        .bind(network_freq_ids)
        .bind(network_id)
        .bind(groups)
        .fetch_all(dbx.get_postgres_connection_pool())
        .await
        .c(h!())?;

    Ok(rows
        .into_iter()
        .map(|row| (row.network_freq_id, row.quantity))
        .collect())
}

pub async fn load_network_freqs_counts_from_stats(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
) -> Result<HashMap<i64, i64>, AppError> {
    let batches =
        crate::stats::collect_signal_group_batches(groups.clone(), dbx)
            .await
            .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    if batch_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let network_freqs = sigint_network_freq::Entity::find()
        .select_only()
        .column_as(sigint_network_freq::Column::Id, "network_freq_id")
        .column_as(sigint_network_freq::Column::Freq, "frequency")
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .into_model::<NetworkFreqStatsRangeRow>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut network_freq_ranges: HashMap<
        String,
        Vec<NetworkFreqStatsRangeRow>,
    > = HashMap::new();
    for network_freq in network_freqs {
        network_freq_ranges
            .entry(network_freq.frequency.clone())
            .or_default()
            .push(network_freq);
    }

    let rows = stats_group_network_freq_day::Entity::find()
        .select_only()
        .column(stats_group_network_freq_day::Column::Frequency)
        .column(stats_group_network_freq_day::Column::Dt)
        .expr_as(Expr::cust("SUM(quantity)"), "quantity")
        .filter(
            stats_group_network_freq_day::Column::SignalGroupBatchId
                .eq_any(batch_ids),
        )
        .filter(stats_group_network_freq_day::Column::NetworkId.eq(network_id))
        .group_by(stats_group_network_freq_day::Column::Dt)
        .group_by(stats_group_network_freq_day::Column::Frequency)
        .into_model::<NetworkFreqStatsDayRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut network_freq_counts: HashMap<i64, i64> = HashMap::new();
    let mut exact_count_requests = vec![];
    for row in rows {
        let Some(freq_ranges) = network_freq_ranges.get(&row.frequency) else {
            continue;
        };
        let network_freqs_for_day = freq_ranges
            .iter()
            .filter(|freq| is_network_freq_active_on_day(freq, row.dt))
            .collect::<Vec<_>>();
        if network_freqs_for_day.is_empty() {
            continue;
        }
        let use_exact =
            should_use_exact_counts_for_day(&network_freqs_for_day, row.dt)
                .c(h!())?;
        if !use_exact {
            let network_freq = network_freqs_for_day[0];
            *network_freq_counts
                .entry(network_freq.network_freq_id)
                .or_insert(0) += row.quantity;
            continue;
        }

        exact_count_requests.push(ExactNetworkFreqCountRequest {
            frequency: row.frequency,
            day_since_ts: crate::stats::start_of_day(row.dt).c(h!())?,
            day_till_ts: crate::stats::start_of_day(
                row.dt + chrono::Duration::days(1),
            )
            .c(h!())?,
            network_freq_ids: network_freqs_for_day
                .iter()
                .map(|freq| freq.network_freq_id)
                .collect(),
        });
    }
    let exact_counts = load_exact_network_freq_counts(
        dbx,
        groups,
        network_id,
        exact_count_requests,
    )
    .await
    .c(h!())?;
    for (network_freq_id, quantity) in exact_counts {
        *network_freq_counts.entry(network_freq_id).or_insert(0) += quantity;
    }
    Ok(network_freq_counts)
}

fn flatten_and_dedup(input: Vec<Vec<String>>) -> Vec<String> {
    let mut unique = HashSet::new();

    for inner in input {
        for s in inner {
            if !s.trim().is_empty() {
                unique.insert(s);
            }
        }
    }

    let mut result: Vec<String> = unique.into_iter().collect();
    result.sort();
    result
}

fn format_encryption_key_display(
    key: Option<String>,
    key_hash: Option<String>,
) -> String {
    let key_value = key.unwrap_or_default();
    let hash_value = key_hash.unwrap_or_default();
    let key_trim = key_value.trim();
    let hash_trim = hash_value.trim();

    if key_trim.is_empty() && hash_trim.is_empty() {
        "-".to_string()
    } else if key_trim == ENCRYPTION_KEY_PLACEHOLDER
        && hash_trim == ENCRYPTION_KEY_PLACEHOLDER
    {
        ENCRYPTION_KEY_PLACEHOLDER.to_string()
    } else {
        let display_key = if key_trim.is_empty() { "-" } else { key_trim };
        let display_hash = if hash_trim.is_empty() { "-" } else { hash_trim };
        format!("{}\u{00A0}/\u{00A0}{}", display_key, display_hash)
    }
}

async fn find_known_callsigns(
    db: &DatabaseConnection,
    callsigns: Option<&[String]>,
) -> Result<BTreeMap<String, Vec<KnownCallsignRes>>, AppError> {
    let mut q = sigint_callsign::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_callsign::Relation::Source.def(),
            Alias::new("source"),
        )
        .select_only()
        .column(sigint_callsign::Column::Id)
        .column(sigint_callsign::Column::Callsign)
        .column(sigint_callsign::Column::Comment)
        .column(sigint_callsign::Column::Position)
        .column(sigint_callsign::Column::UnitId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_unit::Column::Regiment)
        .column(sigint_unit::Column::Division)
        .column(sigint_unit::Column::Army)
        .column_as(source::Column::Name, "source_name")
        .column(sigint_callsign::Column::CreatedAt)
        .filter(sigint_callsign::Column::Deleted.eq(false))
        // Full-name-only catalog entries are valid for CRUD/list flows, but
        // etalonka known-callsign matching is driven strictly by callsign.
        .filter(Expr::cust("btrim(sigint_callsign.callsign) <> ''"))
        .filter(sigint_unit::Column::Deleted.eq(false));

    if let Some(callsigns) = callsigns.filter(|callsigns| !callsigns.is_empty())
    {
        q = q.filter(sigint_callsign::Column::Callsign.is_in(callsigns));
    }

    q = q.order_by_asc(sigint_callsign::Column::Callsign);

    // debug!(
    //     "> known callsings sql: {}",
    //     q.build(DbBackend::Postgres).to_string()
    // );

    let results = q
        .into_model::<KnownCallsignRes>()
        .all(db)
        .await
        .context(h!())?;

    // Group results by callsign into a BTreeMap
    let mut grouped_results: BTreeMap<String, Vec<KnownCallsignRes>> =
        BTreeMap::new();

    for result in results {
        grouped_results
            .entry(result.callsign.clone())
            .or_default()
            .push(result);
    }

    Ok(grouped_results)
}

pub async fn find_all_known_callsigns(
    db: &DatabaseConnection,
) -> Result<BTreeMap<String, Vec<KnownCallsignRes>>, AppError> {
    find_known_callsigns(db, None).await
}

#[derive(Debug, Clone)]
pub struct CallsignActivityInfo {
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
    pub network_names: Option<Vec<String>>,
}

pub async fn load_callsigns(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    known_callsigns: Option<&BTreeMap<String, Vec<KnownCallsignRes>>>,
    include_activity_info: bool,
    filter: Option<&NetworkFreqFilter>,
) -> Result<Vec<CallsignRes>, AppError> {
    let start = std::time::Instant::now();

    trace!("> load_callsigns for network: {:?}", network_id);

    let (base_with, callsigns_select) =
        build_callsigns_queries(groups, network_id, None, filter)
            .context(h!())?;

    // Step 1. Get all active callsigns for the given network
    let active_callsigns = get_active_callsigns(
        db,
        base_with.clone(),
        callsigns_select.clone(),
        network_id,
    )
    .await
    .context(h!())?;

    let callsigns = active_callsigns
        .iter()
        .map(|row| row.callsign.clone())
        .collect::<Vec<_>>();
    let known_callsigns_buf;
    let known_callsigns = if let Some(known_callsigns) = known_callsigns {
        known_callsigns
    } else {
        known_callsigns_buf = find_known_callsigns(db, Some(&callsigns))
            .await
            .context(h!())?;
        &known_callsigns_buf
    };

    let mut res: Vec<CallsignRes> = active_callsigns
        .iter()
        .map(|row| {
            let callsign = row.callsign.clone();

            let short_known_callsigns =
                crate::sigint::callsign::bl::match_known_callsigns(
                    known_callsigns.get(&callsign),
                    &callsign,
                    row.unit_id,
                    &row.unit_name.clone(),
                );

            CallsignRes {
                callsign: callsign.clone(),
                known_callsigns: short_known_callsigns,
                message_count: 0,
                last_datetime: None,
                freqs: None,
                network_names: None,
                is_old: false,
            }
        })
        .collect();

    res = filter_callsigns(res);
    sort_callsigns(&mut res);

    if !include_activity_info {
        let duration = start.elapsed();
        trace!(
            "[load_callsigns] Execution time: {:.2?} (network: {:?}, without activity info)",
            duration, network_id
        );
        return Ok(res);
    }

    // Step 2. Get activity info for callsigns with known_callsigns
    let callsigns = res.iter().map(|c| c.callsign.clone()).collect::<Vec<_>>();

    let known_callsigns_activity_info = get_activity_info_for_callsigns(
        db,
        base_with.clone(),
        callsigns_select.clone(),
        &callsigns,
    )
    .await
    .context(h!())?;

    apply_activity_info(&mut res, &known_callsigns_activity_info);

    let duration = start.elapsed();
    trace!(
        "[load_callsigns] Execution time: {:.2?} (network: {:?})",
        duration,
        network_id
    );

    Ok(res)
}

fn sort_callsigns(callsigns: &mut [CallsignRes]) {
    callsigns.sort_by(|a, b| match (&a.known_callsigns, &b.known_callsigns) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => a.callsign.cmp(&b.callsign),
    });
}

fn apply_activity_info(
    callsigns: &mut [CallsignRes],
    activity_info_by_callsign: &HashMap<String, CallsignActivityInfo>,
) {
    for callsign in callsigns {
        if let Some(activity_info) =
            activity_info_by_callsign.get(&callsign.callsign)
        {
            callsign.message_count = activity_info.message_count;
            callsign.last_datetime = activity_info.last_datetime;
            callsign.freqs = activity_info.freqs.clone();
            callsign.network_names = activity_info.network_names.clone();
        }
    }
}

pub fn build_callsigns_queries(
    groups: &Vec<String>,
    network_id: i64,
    callsigns: Option<&Vec<String>>,
    net_freq_filter: Option<&NetworkFreqFilter>,
) -> Result<(WithClause, SelectStatement), AppError> {
    let callsigns_lateral_sub_query = Query::select()
        .expr_as(
            Expr::cust("jsonb_array_elements_text(network_messages.callsigns)"),
            Alias::new("callsign"),
        )
        .to_owned();

    let network_freqs_select = Query::select()
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
            Alias::new("id"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId)),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ActiveFrom,
            )),
            Alias::new("active_from"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo)),
            Alias::new("active_to"),
        )
        .from(SigintNetworkFreq::Table)
        .join(
            JoinType::InnerJoin,
            SigintNetwork::Table,
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted))
                .eq(false),
        )
        .and_where_option(
            net_freq_filter
                .as_ref()
                .filter(|f| f.active_freqs_only)
                .map(|_| {
                    Expr::col((
                        SigintNetworkFreq::Table,
                        SigintNetworkFreq::ActiveTo,
                    ))
                    .is_null()
                }),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(network_id),
        )
        .to_owned();

    let nf = Alias::new("network_freqs");

    let network_freqs_cte = CommonTableExpression::new()
        .query(network_freqs_select)
        .table_name(nf.clone())
        .to_owned();

    let join_condition =
        build_network_freq_join_condition(net_freq_filter, true).c(h!())?;

    let mut network_messages_select = Query::select();
    network_messages_select
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Callsigns)),
            Alias::new("callsigns"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
            Alias::new("datetime"),
        )
        .expr_as(
            Expr::col((nf.clone(), Alias::new("network_id"))),
            Alias::new("network_id"),
        )
        .from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::InnerJoin,
            DatasourceGroup::Table,
            Expr::col((SignalMessage::Table, SignalMessage::DatasourceGroupId))
                .equals((DatasourceGroup::Table, DatasourceGroup::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintInboxItemNetwork::Table,
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            )),
        )
        .join(JoinType::InnerJoin, nf.clone(), join_condition)
        .and_where(
            datasource_group::Column::GroupMasterKey.eq_any(groups.clone()),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        );
    if let Some(callsigns) = callsigns {
        if !callsigns.is_empty() {
            // Create boxed values for the array
            let array_values: Vec<Value> = callsigns
                .iter()
                .map(|s| Value::String(Some(Box::new(s.clone()))))
                .collect();

            // Create properly typed array value
            let callsigns_value = Value::Array(
                sea_query::ArrayType::String,
                Some(Box::new(array_values)),
            );

            let expr = Expr::cust_with_values(
                r#""sigint_inbox_item"."callsigns" ?| $1"#,
                [callsigns_value],
            );

            network_messages_select.and_where(expr);
        }
    }

    network_messages_select = filter_selected_networks_stmt(
        network_messages_select,
        &Some(vec![network_id]),
        &None,
    )
    .c(h!())?;

    let network_messages_cte = CommonTableExpression::new()
        .query(network_messages_select.to_owned())
        .table_name(Alias::new("network_messages"))
        .to_owned();

    let callsigns_select = Query::select()
        .expr_as(
            Expr::cust("c.callsign"),
            Alias::new("callsign"),
        )
        .expr_as(
            Expr::cust(r#"CASE
                WHEN ("sigint_network"."name" IS NOT NULL) AND ("sigint_network"."name" <> '')
                THEN CONCAT('р/м ', "sigint_network"."name")
                ELSE NULL
            END"#.to_string()),
            Alias::new("network_name"),
        )
        .expr_as(
            Expr::col((Alias::new("network_messages"), Alias::new("freq"))),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((Alias::new("network_messages"), Alias::new("datetime"))),
            Alias::new("datetime"),
        )
        .expr_as(
            Expr::col((SigintUnit::Table, SigintUnit::Id)),
            Alias::new("unit_id"),
        )
        .expr_as(
            Expr::col((SigintUnit::Table, SigintUnit::Name)),
            Alias::new("unit_name"),
        )
        .expr_as(
            Expr::col((SigintUnit::Table, SigintUnit::Regiment)),
            Alias::new("regiment"),
        )
        .expr_as(
            Expr::col((SigintUnit::Table, SigintUnit::Division)),
            Alias::new("division"),
        )
        .expr_as(
            Expr::col((SigintUnit::Table, SigintUnit::Army)),
            Alias::new("army"),
        )
        .from(Alias::new("network_messages"))
        .join(
            JoinType::InnerJoin,
            SigintNetwork::Table,
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(Expr::col((Alias::new("network_messages"), Alias::new("network_id")))),
        )
        .join(
            JoinType::LeftJoin,
            SigintNetworkUnit::Table,
            Expr::col((SigintNetworkUnit::Table, SigintNetworkUnit::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::LeftJoin,
            SigintUnit::Table,
            Expr::col((SigintUnit::Table, SigintUnit::Id))
                .equals((SigintNetworkUnit::Table, SigintNetworkUnit::UnitId)),
        )
        .join_lateral(
            JoinType::InnerJoin,
            callsigns_lateral_sub_query,
            Alias::new("c"),
            Expr::cust("true"),
        )
        .and_where(
            Expr::col((SigintUnit::Table, SigintUnit::Deleted))
                .eq(false)
                .or(Expr::col((SigintUnit::Table, SigintUnit::Id)).is_null()),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id))
                .eq(network_id),
        )
        .to_owned();

    let base_with = Query::with()
        .cte(network_freqs_cte)
        .cte(network_messages_cte)
        .clone();

    Ok((base_with, callsigns_select))
}

/// Helper to build join condition for sigint_inbox_item_network and sigint_network_freqs based on the filter.
/// `till_inclusive` selects the upper-bound operator so callers can keep their own window semantics.
///
/// sigint_inbox_item.id = sigint_inbox_item_network.sigint_inbox_item_id
/// AND sigint_inbox_item_network.sigint_network_id = network_freqs.network_id
/// AND sigint_inbox_item.freq = network_freqs.freq
/// AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) >= GREATEST(since_date_inclusive, network_freqs.active_from)
/// AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) {<,<=} LEAST(till_date, COALESCE(network_freqs.active_to, now()))
pub fn build_network_freq_join_condition(
    filter: Option<&NetworkFreqFilter>,
    till_inclusive: bool,
) -> Result<SimpleExpr, AppError> {
    let since_ms = filter.as_ref().and_then(|f| f.since_date_inclusive_ms);
    let till_ms = filter.as_ref().and_then(|f| f.till_date_inclusive_ms);

    let lower_bound = if let Some(since_ms) = since_ms {
        let since_dt = DateTime::from_timestamp_millis(since_ms)
            .context(h!())?
            .naive_utc();

        Expr::cust_with_values(
            "GREATEST($1, network_freqs.active_from)",
            [since_dt],
        )
    } else {
        Expr::col((Alias::new("network_freqs"), Alias::new("active_from")))
            .into()
    };

    let upper_bound = if let Some(till_ms) = till_ms {
        let till_dt = DateTime::from_timestamp_millis(till_ms)
            .context(h!())?
            .naive_utc();

        Expr::cust_with_values(
            "LEAST($1, COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))",
            [till_dt],
        )
    } else {
        Expr::cust("COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
    };

    let join_condition = Expr::col((
        SigintInboxItem::Table,
        SigintInboxItem::Id,
    ))
    .equals((
        SigintInboxItemNetwork::Table,
        SigintInboxItemNetwork::SigintInboxItemId,
    ))
    .and(
        Expr::col((
            SigintInboxItemNetwork::Table,
            SigintInboxItemNetwork::SigintNetworkId,
        ))
        .equals((Alias::new("network_freqs"), Alias::new("network_id"))),
    )
    .and(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
            .equals((Alias::new("network_freqs"), Alias::new("freq"))),
    )
    .and(
        Expr::cust(
            "COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at)",
        )
        .gte(lower_bound),
    )
    .and({
        let datetime_expr = Expr::cust(
            "COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at)",
        );
        if till_inclusive {
            datetime_expr.lte(upper_bound)
        } else {
            datetime_expr.lt(upper_bound)
        }
    });

    Ok(join_condition)
}

/// Активні позивні на частотах мережі, які не входять до вже прив'язаних до мережі позивних
pub async fn get_active_callsigns(
    db: &DatabaseConnection,
    base_with: WithClause,
    callsigns_select: SelectStatement,
    network_id: i64,
) -> Result<Vec<CallsignQueryResult>, AppError> {
    let callsigns_cte = CommonTableExpression::new()
        .query(callsigns_select)
        .table_name(Alias::new("callsigns"))
        .to_owned();

    let network_callsign_alias = Alias::new("nc");
    let callsigns_alias = Alias::new("callsigns");
    let callsign_alias = Alias::new("callsign");
    let network_callsigns_subquery: SelectStatement = Query::select()
        .expr(Expr::value(1)) // SELECT 1
        .from_as(SigintNetworkCallsign::Table, network_callsign_alias.clone()) // FROM network_callsign
        .and_where(
            Expr::col((
                network_callsign_alias.clone(),
                SigintNetworkCallsign::SigintNetworkId,
            ))
            .eq(network_id),
        ) // WHERE network_id = ?
        .and_where(
            Expr::col((
                network_callsign_alias.clone(),
                SigintNetworkCallsign::Deleted,
            ))
            .eq(false),
        ) // WHERE network_id = ?
        .and_where(
            Expr::col((
                network_callsign_alias.clone(),
                SigintNetworkCallsign::SigintCallsign,
            ))
            .eq(Expr::col((callsigns_alias.clone(), callsign_alias.clone()))),
        )
        .to_owned();

    let active_callsigns_select = Query::select()
        .expr_as(Expr::cust("DISTINCT callsign"), callsign_alias)
        .expr_as(Expr::cust("unit_id"), Alias::new("unit_id"))
        .expr_as(Expr::cust("unit_name"), Alias::new("unit_name"))
        .expr_as(Expr::cust("regiment"), Alias::new("regiment"))
        .expr_as(Expr::cust("division"), Alias::new("division"))
        .expr_as(Expr::cust("army"), Alias::new("army"))
        .from(callsigns_alias.clone())
        // виключаємо позивні, які вже прив'язані до мережі
        .and_where(Expr::exists(network_callsigns_subquery).not())
        .order_by_expr(Expr::cust("callsign"), Order::Asc)
        .to_owned();

    let combined_query = base_with
        .clone()
        .cte(callsigns_cte)
        .clone()
        .query(active_callsigns_select);

    // debug!(
    //     "> active callsigns query: {}",
    //     combined_query.to_string(PostgresQueryBuilder)
    // );

    let records: Vec<CallsignQueryResult> = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?
        .into_iter()
        .map(|row| CallsignQueryResult {
            callsign: row.try_get("", "callsign").unwrap_or_default(),
            unit_id: row.try_get("", "unit_id").unwrap_or_default(),
            unit_name: row.try_get("", "unit_name").ok().flatten(),
            regiment: row.try_get("", "regiment").ok().flatten(),
            division: row.try_get("", "division").ok().flatten(),
            army: row.try_get("", "army").ok().flatten(),
        })
        .collect();

    Ok(records)
}

pub async fn get_activity_info_for_callsigns<'a, 'async_trait, C>(
    txn: &'a C,
    base_with: WithClause,
    callsigns_select: SelectStatement,
    callsigns: &[String],
) -> Result<HashMap<String, CallsignActivityInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if callsigns.is_empty() {
        return Ok(HashMap::new());
    }

    // Clone and filter the select statement before wrapping it in the CTE
    let mut filtered_select = callsigns_select.clone();
    filtered_select
        .and_where(Expr::col(Alias::new("callsign")).is_in(callsigns));

    let callsigns_cte = CommonTableExpression::new()
        .query(filtered_select)
        .table_name(Alias::new("callsigns"))
        .to_owned();

    let q = Query::select()
        .expr_as(Expr::cust("callsign"), Alias::new("callsign"))
        .expr_as(Expr::cust("COUNT(*)"), Alias::new("message_count"))
        .expr_as(Expr::cust("MAX(datetime)"), Alias::new("last_datetime"))
        .expr_as(
            Expr::cust("STRING_AGG(DISTINCT freq, ', ')"),
            Alias::new("freqs"),
        )
        .expr_as(
            Expr::cust("STRING_AGG(DISTINCT network_name, ', ')"),
            Alias::new("network_names"),
        )
        .from(Alias::new("callsigns"))
        .add_group_by(vec![Expr::cust("callsign")])
        .to_owned();

    let combined_query = base_with.clone().cte(callsigns_cte).clone().query(q);

    // debug!(
    //     "> activity info query: {}",
    //     combined_query.to_string(PostgresQueryBuilder)
    // );

    let rows = txn
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    let mut res = HashMap::new();
    for row in rows {
        let callsign: String = row.try_get("", "callsign").unwrap_or_default();
        let message_count: i64 = row.try_get("", "message_count").unwrap_or(0);
        let last_datetime: Option<i64> = row
            .try_get::<NaiveDateTime>("", "last_datetime")
            .ok()
            .map(|dt| dt.and_utc().timestamp_millis());
        let freqs: Option<String> = row.try_get("", "freqs").ok();
        let network_names: Option<String> =
            row.try_get("", "network_names").ok();
        res.insert(
            callsign.clone(),
            CallsignActivityInfo {
                message_count,
                last_datetime,
                freqs: freqs
                    .as_ref()
                    .map(|s| s.split(", ").map(|s| s.to_string()).collect()),
                network_names: network_names
                    .as_ref()
                    .map(|s| s.split(", ").map(|s| s.to_string()).collect()),
            },
        );
    }
    Ok(res)
}

pub async fn load_signals_per_unit(
    db: &DatabaseConnection,
    unit: &str,
) -> Result<Vec<SignalRes>, AppError> {
    let q = sigint_signal::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_signal::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column(sigint_signal::Column::Text)
        .column(sigint_signal::Column::Meaning)
        .filter(sigint_signal::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Name.eq(unit));

    // debug!(
    //     "> signals sql: {}",
    //     q.clone().build(DbBackend::Postgres).to_string()
    // );

    Ok(q.clone()
        .into_model::<SignalRes>()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|row| SignalRes {
            text: row.text,
            meaning: row.meaning,
        })
        .collect())
}

pub async fn load_signals_per_network(
    db: &DatabaseConnection,
    network_id: i64,
) -> Result<Vec<NetworkSignalsRes>, AppError> {
    #[derive(Debug, FromQueryResult)]
    pub struct NetworkUnitRes {
        pub unit_id: i64,
        pub unit_name: String,
    }

    let q_network_units = sigint_network_unit::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintNetwork.def(),
            Alias::new("sigint_network"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.eq(network_id))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkUnitRes>()
        .all(db)
        .await
        .context(h!())?;

    let mut res = Vec::new();
    for network_unit in &q_network_units {
        let unit_id = network_unit.unit_id;
        let unit_name = network_unit.unit_name.clone();

        // println!("> network: {}. unit_id: {}, unit_name: {}", network_id, unit_id, unit_name);

        let q = sigint_signal::Entity::find()
            .filter(sigint_signal::Column::Deleted.eq(false))
            .filter(sigint_signal::Column::Unit.eq(unit_id))
            .order_by_asc(sigint_signal::Column::Text)
            .all(db)
            .await
            .context(h!())?;

        let unit_signals = q
            .into_iter()
            .map(|row| Signal {
                id: row.id,
                text: row.text,
                meaning: row.meaning,
                unit: row.unit,
                active: !row.deleted,
                coordinates: row.coordinates,
                created_at: row.created_at.and_utc().timestamp_millis(),
            })
            .collect::<Vec<Signal>>();

        let network_signals = NetworkSignalsRes {
            network_id,
            unit_id,
            unit_name: unit_name.clone(),
            signals: unit_signals,
        };

        res.push(network_signals);
    }

    Ok(res)
}

pub async fn get_callsigns_for_network_freq(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_freq_id: i64,
) -> Result<Vec<String>, AppError> {
    let nf = Alias::new("network_freqs");
    let join_condition =
        build_network_freq_join_condition(None, true).c(h!())?;

    let callsigns_lateral_sub_query = Query::select()
        .expr_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            Alias::new("callsign"),
        )
        .to_owned();

    let query = Query::select()
        .expr_as(Expr::cust("DISTINCT callsign"), Alias::new("callsign"))
        .from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::InnerJoin,
            DatasourceGroup::Table,
            Expr::col((SignalMessage::Table, SignalMessage::DatasourceGroupId))
                .equals((DatasourceGroup::Table, DatasourceGroup::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintInboxItemNetwork::Table,
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            )),
        )
        .join_as(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            nf.clone(),
            join_condition,
        )
        .join_lateral(
            JoinType::InnerJoin,
            callsigns_lateral_sub_query,
            Alias::new("c"),
            Expr::cust("true"),
        )
        .and_where(
            datasource_group::Column::GroupMasterKey.eq_any(groups.clone()),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::Id)).eq(network_freq_id),
        )
        .and_where(Expr::cust("btrim(callsign) <> ''"))
        .order_by_expr(Expr::cust("callsign"), Order::Asc)
        .to_owned();

    let rows = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get("", "callsign").ok())
        .collect())
}

/// Function to filter out duplicate callsigns
/// and keep only the ones with known callsigns
/// or the first occurrence of each callsign
/// in the list of callsigns.
fn filter_callsigns(callsigns: Vec<CallsignRes>) -> Vec<CallsignRes> {
    let mut seen_callsigns = HashSet::new();
    let mut result = Vec::new();

    for c in callsigns {
        if c.known_callsigns.is_some() {
            result.push(c);
        } else {
            // Use the callsign string to deduplicate
            if seen_callsigns.insert(c.callsign.clone()) {
                result.push(c);
            }
        }
    }

    result
}

pub async fn load_pelengs_map(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filter: NetworkFreqFilter,
) -> Result<Option<Vec<u8>>, AppError> {
    let map_points =
        bl_get_network_points(dbx, groups, network_id, Some(&filter))
            .await
            .c(h!())?
            .into_iter()
            .map(|p| PelengsQueryRes {
                freq: p.freq,
                lat: format!("{:02.6}", p.lat),
                lng: format!("{:02.6}", p.lng),
            })
            .collect::<Vec<PelengsQueryRes>>();
    let map_points = uniq_via_btreeset(&map_points);

    if map_points.is_empty() {
        return Ok(None);
    }

    let res = match get_map_image(map_points).await {
        Ok(res) => res,
        Err(err) => {
            error!("failed to generate pelengs map image for network {network_id}: {err:?}");
            return Ok(None);
        }
    };

    Ok(Some(res))
}

pub async fn bl_get_network_points(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
) -> Result<Vec<NetworkPointQueryRes>, AppError> {
    let join_condition =
        build_network_freq_join_condition(filter, false).c(h!())?;

    let nf_alias = Alias::new("network_freqs");

    let mut q = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPeleng.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
            nf_alias.clone(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork
                .def()
                .from_alias(nf_alias.clone()),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_peleng::Column::Lat, "lat")
        .column_as(sigint_peleng::Column::Lng, "lng")
        .column_as(signal_message::Column::Body, "body")
        .filter(datasource_group::Column::GroupMasterKey.eq_any(groups.clone()))
        .filter(
            sigint_inbox_item_network::Column::SigintNetworkId.eq(network_id),
        )
        .filter(sigint_network::Column::Id.eq(network_id))
        .filter(sigint_inbox_item::Column::Coords.is_not_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .filter(join_condition);
    if filter.as_ref().is_some_and(|f| f.active_freqs_only) {
        q = q.filter(
            Expr::col((nf_alias.clone(), SigintNetworkFreq::ActiveTo))
                .is_null(),
        );
    }
    q = filter_selected_networks(q, &Some(vec![network_id]), &None).c(h!())?;

    // debug!(
    //     "> pelengs per unir sql: {}\n",
    //     q.build(DbBackend::Postgres).to_string()
    // );

    let res = q
        .into_model::<NetworkPointQueryRes>()
        .all(dbx)
        .await
        .context(h!())?;
    Ok(res)
}

async fn get_map_image(
    map_points: Vec<PelengsQueryRes>,
) -> Result<Vec<u8>, AppError> {
    #[derive(Debug, Serialize)]
    struct Coords {
        lat: f64,
        lon: f64,
    }
    #[derive(Debug, Serialize)]
    struct MapPoint {
        coords: Coords,
        label: String,
    }

    let map_points: Vec<MapPoint> = map_points
        .into_iter()
        .map(|point| MapPoint {
            coords: Coords {
                lat: point.lat.parse().unwrap_or(0.0),
                lon: point.lng.parse().unwrap_or(0.0),
            },
            label: point.freq,
        })
        .collect();

    let json_string = serde_json::to_string(&map_points)
        .expect("Failed to serialize to JSON");

    // debug!("> --map-points '{}'", json_string);

    let temp_file = Builder::new()
        .prefix("geo-screenshot_")
        .suffix(".png")
        .rand_bytes(5)
        .tempfile()
        .context(h!())?;

    let temp_file_name = temp_file.path().to_str().context(h!())?;
    let mut buffer = Vec::new();

    debug!("> running geo-screenshot...");
    let output = Command::new("xvfb-run")
        .arg("--auto-servernum") // Automatically assign a unique display
        .arg("--server-args=-screen 0 1024x768x24")
        .arg("geo-screenshot")
        .arg("--map-points")
        .arg(&json_string)
        .arg("--delay")
        .arg(format!("{SCREENSHOT_DELAY_MILLIS}"))
        .arg("--force-overview")
        .arg(temp_file_name)
        .spawn()
        .map_err(|e| {
            error!("Failed to start geo-screenshot: {:#?}", e);
            e
        })
        .context(h!())?
        .wait_with_output()
        .await
        .map_err(|e| {
            error!("geo-screenshot process failed: {:#?}", e);
            e
        })
        .context(h!())?;

    if output.status.success() {
        // debug!("> geo-screenshot call done. Processing output temp file");
        let file = tokio::fs::File::open(temp_file_name)
            .await
            .map_err(|e| {
                error!("Failed to open temp file {temp_file_name}: {:#?}", e);
                e
            })
            .context(temp_file_name.to_string())
            .context(h!())?;
        let mut stream = ReaderStream::new(file);

        while let Some(chunk) = stream.try_next().await.context(h!())? {
            buffer.extend_from_slice(&chunk);
        }
    } else {
        let exit_code = output.status.code();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        if exit_code == Some(127) {
            return Err(AppError::BL {
                msg: "geo-screenshot executable not found (exit code 127). Please install geo-screenshot and ensure it is in your PATH.".to_string(),
            });
        }

        return Err(AppError::BL {
            msg: format!(
                "geo-screenshot failed. Exit code: {exit_code:?}. Stdout: {stdout}. Stderr: {stderr}"
            ),
        });
    }
    Ok(buffer)
}

fn build_etalonka_networks_query(
    req: &ListNetworksReq,
    join_type: JoinType,
    id_filter: Option<&Vec<i64>>,
    deleted_only: Option<bool>,
) -> Select<sigint_network::Entity> {
    let filter_unit = req.filter_unit.clone();
    let filter_unit_army = req.filter_unit_army.clone();
    let filter_unit_division = req.filter_unit_division.clone();
    let filter_unit_regiment = req.filter_unit_regiment.clone();
    let filter_unit_battalion = req.filter_unit_battalion.clone();
    let mut report_req = req.clone();
    report_req.filter_unit = None;
    report_req.filter_unit_army = None;
    report_req.filter_unit_division = None;
    report_req.filter_unit_regiment = None;
    report_req.filter_unit_battalion = None;

    let mut networks = sigint_network::Entity::find()
        .join_as(
            join_type,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            join_type,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column(sigint_network::Column::Id)
        .expr_as(
            Expr::cust(r#"CONCAT('р/м ', "sigint_network"."name", ' ', "sigint_unit"."name")"#.to_string()),
            "network_full_name",
        )
        .column(sigint_network::Column::Location)
        .column(sigint_network::Column::Purpose)
        //sklad
        .expr_as(
            Expr::cust(r#"(select string_agg(snf.freq, ', ')
                            from sigint_network_freq snf
                            where snf.network_id = "sigint_network"."id"
                            and snf.active_to is null
                            and snf.deleted = false)"#.to_string()),
            "freqs",
        )
        .column(sigint_network::Column::OperationMode)
        .column(sigint_network::Column::OperationType)
        .column(sigint_network::Column::OperationPeriod)
        .column_as(sigint_unit::Column::Army, "unit_army")
        .column_as(sigint_unit::Column::Division, "unit_division")
        .column_as(sigint_unit::Column::Regiment, "unit_regiment")
        .column_as(sigint_unit::Column::Battalion, "unit_battalion")
        .column_as(sigint_unit::Column::Company, "unit_company")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::ActiveFrom)
        .column(sigint_network::Column::ActiveTo);

    if let Some(deleted_only) = deleted_only {
        networks =
            networks.filter(sigint_network::Column::Deleted.eq(deleted_only));
    } else if id_filter.is_none() {
        networks = apply_network_list_filters(networks, &report_req, true);
    }

    if let Some(id_filter) = id_filter {
        if id_filter.is_empty() {
            // Empty explicit ID filter means "export nothing", not "drop ID filtering".
            networks = networks.filter(Expr::cust("1 = 2"));
        } else {
            networks = networks
                .filter(sigint_network::Column::Id.is_in(id_filter.clone()));
        }
    }

    if let Some(filter_unit) = filter_unit.as_deref() {
        let pattern = format!("%{}%", filter_unit.to_lowercase());
        networks = networks.filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![pattern],
        ));
    }

    if let Some(filter_unit_army) = filter_unit_army.as_deref() {
        networks =
            networks.filter(sigint_unit::Column::Army.eq(filter_unit_army));
    }
    if let Some(filter_unit_division) = filter_unit_division.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Division.eq(filter_unit_division));
    }
    if let Some(filter_unit_regiment) = filter_unit_regiment.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Regiment.eq(filter_unit_regiment));
    }
    if let Some(filter_unit_battalion) = filter_unit_battalion.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Battalion.eq(filter_unit_battalion));
    }

    network_sort::apply_network_sorts(networks, req.sort_by.as_ref())
}

pub async fn load_networks(
    db: &DatabaseConnection,
    req: &EtalonkaJimForksReq,
) -> Result<
    BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    AppError,
> {
    let networks = build_etalonka_networks_query(
        &req.req,
        JoinType::InnerJoin,
        None,
        None,
    );
    let networks = networks
        .clone()
        .into_model::<NetworkEtalonkaResult>()
        .all(db)
        .await
        .context(h!())?;

    let mut res: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>> =
        BTreeMap::new();
    for network in networks.into_iter() {
        let key = NetworkEtalonkaUnitKey {
            unit_army: network.unit_army.clone(),
            unit_division: network.unit_division.clone(),
            unit_regiment: network.unit_regiment.clone(),
            unit_battalion: network.unit_battalion.clone(),
            unit_company: network.unit_company.clone(),
            unit_name: network
                .unit_name
                .as_deref()
                .unwrap_or(DEFAULT_EMPTY_UNIT_NAME)
                .to_string(),
        };

        res.entry(key).or_default().push(network);
    }

    Ok(res)
}

pub async fn load_networks_by_id(
    db: &DatabaseConnection,
    req: &EtalonkaNetworkBatchReq,
) -> Result<
    BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    AppError,
> {
    let sort_req = ListNetworksReq {
        filter_freq: None,
        filter_unit: None,
        filter_unit_army: None,
        filter_unit_division: None,
        filter_unit_regiment: None,
        filter_unit_battalion: None,
        filter_text: None,
        filter_name: None,
        filter_location: None,
        show_only_further_inverstigation: None,
        show_inactive: None,
        show_only_deleted: None,
        status_filter: None,
        aor_ids: None,
        ids: None,
        limit: None,
        offset: None,
        sort_by: req.sort_by.clone(),
    };
    let networks = build_etalonka_networks_query(
        &sort_req,
        JoinType::LeftJoin,
        Some(&req.network_ids),
        None,
    );
    let networks = networks
        .clone()
        .into_model::<NetworkEtalonkaResult>()
        .all(db)
        .await
        .context(h!())?;

    let mut res: BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>> =
        BTreeMap::new();
    for network in networks.into_iter() {
        let key = NetworkEtalonkaUnitKey {
            unit_army: network.unit_army.clone(),
            unit_division: network.unit_division.clone(),
            unit_regiment: network.unit_regiment.clone(),
            unit_battalion: network.unit_battalion.clone(),
            unit_company: network.unit_company.clone(),
            unit_name: network
                .unit_name
                .as_deref()
                .unwrap_or(DEFAULT_EMPTY_UNIT_NAME)
                .to_string(),
        };

        res.entry(key).or_default().push(network);
    }

    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigint::network::types::ListNetworksSortBy;

    fn empty_list_networks_req() -> ListNetworksReq {
        ListNetworksReq {
            filter_freq: None,
            filter_unit: None,
            filter_unit_army: None,
            filter_unit_division: None,
            filter_unit_regiment: None,
            filter_unit_battalion: None,
            filter_text: None,
            filter_name: None,
            filter_location: None,
            show_only_further_inverstigation: None,
            show_inactive: None,
            show_only_deleted: None,
            status_filter: None,
            aor_ids: None,
            ids: None,
            limit: None,
            offset: None,
            sort_by: None,
        }
    }

    fn assert_primary_sort_before_name(sql: &str, primary_fragment: &str) {
        let primary_index = sql.find(primary_fragment).unwrap_or_else(|| {
            panic!("missing primary sort fragment: {primary_fragment}\n{sql}")
        });
        let name_index = sql
            .find("\"sigint_network\".\"name\" ASC")
            .unwrap_or_else(|| panic!("missing name sort fragment\n{sql}"));
        assert!(
            primary_index < name_index,
            "expected primary sort before name sort:\n{sql}"
        );
    }

    #[test]
    fn build_network_freq_join_condition_uses_noninclusive_upper_bound() {
        let filter = NetworkFreqFilter {
            active_freqs_only: false,
            since_date_inclusive_ms: Some(1_740_000_000_000),
            till_date_inclusive_ms: Some(1_740_000_600_000),
        };

        let exclusive_sql = Query::select()
            .expr(
                build_network_freq_join_condition(Some(&filter), false)
                    .expect("join condition"),
            )
            .to_string(PostgresQueryBuilder);
        let inclusive_sql = Query::select()
            .expr(
                build_network_freq_join_condition(Some(&filter), true)
                    .expect("join condition"),
            )
            .to_string(PostgresQueryBuilder);

        assert!(exclusive_sql.contains(" < "), "{exclusive_sql}");
        assert!(!exclusive_sql.contains(" <= "), "{exclusive_sql}");
        assert!(inclusive_sql.contains(" <= "), "{inclusive_sql}");
    }

    #[test]
    fn etalonka_network_sorting_uses_requested_sort_variants() {
        let no_id_sql = build_etalonka_networks_query(
            &empty_list_networks_req(),
            JoinType::InnerJoin,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();

        let empty_ids: Vec<i64> = vec![];
        let empty_id_sql = build_etalonka_networks_query(
            &empty_list_networks_req(),
            JoinType::InnerJoin,
            Some(&empty_ids),
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_ne!(empty_id_sql, no_id_sql);
        // Empty explicit ID filter means "export nothing", not "drop ID filtering".
        assert!(empty_id_sql.contains("1 = 2"), "{empty_id_sql}");

        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![
            ListNetworksSortBy::LocationAsc,
            ListNetworksSortBy::NameDesc,
        ]);
        let sql = build_etalonka_networks_query(
            &req,
            JoinType::InnerJoin,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_primary_sort_before_name(
            &sql,
            "\"sigint_network\".\"location\" ASC",
        );
        assert!(!sql.contains("\"sigint_network\".\"name\" DESC"), "{sql}");
        assert!(sql.contains("\"sigint_network\".\"name\" ASC"), "{sql}");
        assert!(sql.contains("\"sigint_network\".\"id\" ASC"), "{sql}");

        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::NetworkFreqAsc]);
        let sql = build_etalonka_networks_query(
            &req,
            JoinType::InnerJoin,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_primary_sort_before_name(
            &sql,
            network_sort::network_first_freq_sort_sql(),
        );

        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::AorDesc]);
        let sql = build_etalonka_networks_query(
            &req,
            JoinType::InnerJoin,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_primary_sort_before_name(
            &sql,
            network_sort::network_first_aor_sort_sql(),
        );

        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::LastActivityDesc]);
        let sql = build_etalonka_networks_query(
            &req,
            JoinType::InnerJoin,
            None,
            None,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_primary_sort_before_name(
            &sql,
            "\"sigint_network\".\"updated_at\" DESC",
        );
    }
}
