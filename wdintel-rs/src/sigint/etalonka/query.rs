use crate::config::{
    ENCRYPTION_KEY_PLACEHOLDER, ETALONKA_GEO_SCREENSHOT_CONCURRENCY,
    RER_ETALONKA_PELENGS_MAP_QUERY_CHUNK_MULTIPLIER, STATS_MIN_DATETIME_DAYS,
};
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::filter_selected_networks;
use crate::rer_importer::report_chunking::ReportPeriodEnd;
use crate::sigint::callsign::bl_network_callsign::{
    get_callsigns_activity_info, get_unassigned_callsigns_activity_info,
};
use crate::sigint::etalonka::types::*;
use crate::sigint::network::filter::{
    apply_network_list_filters_with_text_search_mode, NetworkTextSearchMode,
};
use crate::sigint::network::resolve_network_text_search_mode;
use crate::sigint::network::sort as network_sort;
use crate::sigint::network::types::{
    ListNetworksReq, NetworkFreqCallsignsPeriod,
};
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use chrono::prelude::*;
use futures::stream::TryStreamExt;
use once_cell::sync::Lazy;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::*;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;
use tempfile::Builder;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio_util::io::ReaderStream;

const SCREENSHOT_DELAY_MILLIS: u64 = 2500;
const DEFAULT_EMPTY_UNIT_NAME: &str = "в дорозвідці";
static GEO_SCREENSHOT_SEMAPHORE: Lazy<Semaphore> =
    Lazy::new(|| Semaphore::new(ETALONKA_GEO_SCREENSHOT_CONCURRENCY));

#[derive(Iden)]
pub enum SignalMessage {
    Table,
    Id,
    CreatedAt,
    DatasourceGroupId,
    Deleted,
    Timestamp,
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
pub enum SigintInboxItemCallsign {
    Table,
    Id,
    SigintInboxItemId,
    Callsign,
    Deleted,
    Ordering,
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
    Id,
    Freq,
    ActivityDatetime,
    CreatedAt,
    EncryptionName,
    NetworkFreqId,
    ActiveFrom,
    ActiveTo,
    Callsigns,
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
    EncryptionId,
    Modulation,
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
pub enum Encryption {
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
    user_login: &uuid::Uuid,
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
    user_login: &uuid::Uuid,
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
    user_login: &uuid::Uuid,
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

    let combined_query = build_network_freqs_query(
        groups,
        network_id,
        filter,
        include_callsigns,
        None,
    )?;

    // debug!(
    //     "> freqs query: {}",
    //     combined_query.to_string(PostgresQueryBuilder)
    // );

    let rows = db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    load_network_freq_rows(db, rows, user_login, freq_counts).await
}

pub async fn load_network_freq_row(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    network_freq_id: i64,
    user_login: &uuid::Uuid,
    include_callsigns: bool,
) -> Result<Option<NetworkFreqsRes>, AppError> {
    let combined_query = build_network_freqs_query(
        groups,
        network_id,
        None,
        include_callsigns,
        Some(network_freq_id),
    )?;

    let rows = db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    let mut freqs = load_network_freq_rows(db, rows, user_login, None).await?;
    Ok(freqs.pop())
}

pub(crate) fn build_scoped_network_messages_query(
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
) -> Result<SelectStatement, AppError> {
    let mut query = Query::select();
    query
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)),
            Alias::new("id"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            network_message_source_activity_datetime(),
            Alias::new("activity_datetime"),
        )
        .from(SigintInboxItemNetwork::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            ))
            .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SignalMessage::Table,
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
            SigintNetwork::Table,
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintNetworkId,
            ))
            .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .and_where(
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintNetworkId,
            ))
            .eq(network_id),
        )
        .and_where(
            datasource_group::Column::GroupMasterKey.eq_any(groups.clone()),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
        )
        .and_where_option(
            build_network_message_period_filter(filter).context(h!())?,
        );
    Ok(query)
}

fn network_message_source_activity_datetime() -> SimpleExpr {
    Func::coalesce([
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
        Expr::col((SignalMessage::Table, SignalMessage::Timestamp)),
        Expr::col((SignalMessage::Table, SignalMessage::CreatedAt)),
    ])
    .into()
}

fn network_message_activity_datetime() -> SimpleExpr {
    Expr::col((NetworkMessages::Table, NetworkMessages::ActivityDatetime))
}

fn build_network_message_callsigns_expr(include_callsigns: bool) -> SimpleExpr {
    if include_callsigns {
        Expr::cust(
            "(select coalesce(jsonb_agg(siic.callsign order by siic.ordering, siic.id), '[]'::jsonb) from sigint_inbox_item_callsign siic where siic.sigint_inbox_item_id = sigint_inbox_item.id and not siic.deleted)",
        )
    } else {
        Expr::cust("NULL")
    }
}

fn build_network_message_period_filter(
    filter: Option<&NetworkFreqFilter>,
) -> Result<Option<SimpleExpr>, AppError> {
    let Some(filter) = filter else {
        return Ok(None);
    };
    let mut condition = None;
    if let Some(since_ms) = filter.since_date_inclusive_ms {
        let since_dt = DateTime::from_timestamp_millis(since_ms)
            .context(h!())?
            .naive_utc();
        push_filter_condition(
            &mut condition,
            network_message_source_activity_datetime().gte(since_dt),
        );
    }
    if let Some(till_ms) = filter.till_date_inclusive_ms {
        let till_dt = DateTime::from_timestamp_millis(till_ms)
            .context(h!())?
            .naive_utc();
        push_filter_condition(
            &mut condition,
            if filter.till_date_end == ReportPeriodEnd::Inclusive {
                network_message_source_activity_datetime().lte(till_dt)
            } else {
                network_message_source_activity_datetime().lt(till_dt)
            },
        );
    }
    Ok(condition)
}

fn push_filter_condition(condition: &mut Option<SimpleExpr>, next: SimpleExpr) {
    *condition = Some(match condition.take() {
        Some(condition) => condition.and(next),
        None => next,
    });
}

pub(crate) fn build_network_message_freq_join_condition(
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
        Expr::col((Alias::new("network_freqs"), SigintNetworkFreq::ActiveFrom))
    };

    let till_bound = till_ms
        .map(|till_ms| {
            DateTime::from_timestamp_millis(till_ms)
                .context(h!())
                .map(|till_dt| Expr::value(till_dt.naive_utc()))
        })
        .transpose()?;
    let period_till_inclusive = till_inclusive
        && filter.is_none_or(|filter| {
            filter.till_date_end == ReportPeriodEnd::Inclusive
        });
    let active_to_bound = Expr::cust(
        "COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
    );
    let mut join_condition =
        Expr::col((NetworkMessages::Table, NetworkMessages::Freq))
            .equals((Alias::new("network_freqs"), SigintNetworkFreq::Freq))
            .and(network_message_activity_datetime().gte(lower_bound))
            .and(if till_inclusive {
                network_message_activity_datetime().lte(active_to_bound)
            } else {
                network_message_activity_datetime().lt(active_to_bound)
            });
    if let Some(till_bound) = till_bound {
        join_condition = join_condition.and(if period_till_inclusive {
            network_message_activity_datetime().lte(till_bound)
        } else {
            network_message_activity_datetime().lt(till_bound)
        });
    }

    Ok(join_condition)
}

pub(crate) fn should_materialize_scoped_network_messages(
    filter: Option<&NetworkFreqFilter>,
) -> bool {
    filter.is_some_and(|filter| {
        filter.since_date_inclusive_ms.is_some()
            || filter.till_date_inclusive_ms.is_some()
    })
}

fn build_network_freqs_query(
    groups: &Vec<String>,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    include_callsigns: bool,
    network_freq_id: Option<i64>,
) -> Result<WithQuery, AppError> {
    let nf = Alias::new("network_freqs");
    let network_messages =
        build_scoped_network_messages_query(groups, network_id, filter)
            .context(h!())?
            .expr_as(
                build_network_message_callsigns_expr(include_callsigns),
                Alias::new("callsigns"),
            )
            .to_owned();

    let mut q_agg: SelectStatement = Query::select();
    q_agg
        .expr_as(
            Expr::col((nf.clone(), SigintNetworkFreq::Id)),
            Alias::new("network_freq_id"),
        )
        .expr_as(Expr::cust("COUNT(*)"), Alias::new("message_count"))
        .expr_as(
            if include_callsigns {
                Expr::cust("jsonb_agg(callsigns)")
            } else {
                Expr::cust("NULL")
            },
            Alias::new("callsigns"),
        )
        .from(NetworkMessages::Table)
        .join_as(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            nf.clone(),
            build_network_message_freq_join_condition(filter, true)
                .context(h!())?,
        )
        .and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::NetworkId))
                .eq(network_id),
        )
        .and_where_option(filter.as_ref().filter(|f| f.active_freqs_only).map(
            |_| Expr::col((nf.clone(), SigintNetworkFreq::ActiveTo)).is_null(),
        ));
    if let Some(network_freq_id) = network_freq_id {
        q_agg.and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::Id)).eq(network_freq_id),
        );
    }

    let mut network_messages_cte = CommonTableExpression::new();
    network_messages_cte
        .query(network_messages)
        .table_name(Alias::new("network_messages"));
    if network_freq_id.is_none()
        && should_materialize_scoped_network_messages(filter)
    {
        network_messages_cte.materialized(true);
    }
    let network_messages_cte = network_messages_cte.to_owned();

    q_agg.add_group_by([Expr::col((nf.clone(), SigintNetworkFreq::Id))]);

    let aggregated_cte = CommonTableExpression::new()
        .query(q_agg)
        .table_name(Alias::new("agg"))
        .to_owned();

    let mut main_query = SelectStatement::new();
    main_query
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
                SigintNetworkFreq::EncryptionId,
            )),
            Alias::new("encryption_id"),
        )
        .expr_as(
            Expr::col((Encryption::Table, Encryption::Name)),
            Alias::new("encryption_name"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::LastSeenDt,
            )),
            Alias::new("last_datetime"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::Modulation,
            )),
            Alias::new("modulation"),
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
            Encryption::Table,
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::EncryptionId,
            ))
            .equals((Encryption::Table, Encryption::Id)),
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
        ));
    if let Some(network_freq_id) = network_freq_id {
        main_query.and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id))
                .eq(network_freq_id),
        );
    }
    let main_query = main_query
        .order_by_expr(Expr::cust("freq"), Order::Asc)
        .to_owned();

    Ok(Query::with()
        .cte(network_messages_cte)
        .clone()
        .cte(aggregated_cte)
        .clone()
        .query(main_query))
}

async fn load_freqs_with_cached_activity(
    db: &DatabaseConnection,
    network_id: i64,
    filter: Option<&NetworkFreqFilter>,
    user_login: &uuid::Uuid,
    freq_counts: HashMap<i64, i64>,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    let main_query = build_network_freqs_base_query(network_id, filter)
        .expr_as(Expr::cust("NULL"), Alias::new("callsigns"))
        .to_owned();

    let rows = db
        .query_all_raw(Statement::from_string(
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
                SigintNetworkFreq::EncryptionId,
            )),
            Alias::new("encryption_id"),
        )
        .expr_as(
            Expr::col((Encryption::Table, Encryption::Name)),
            Alias::new("encryption_name"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::LastSeenDt,
            )),
            Alias::new("last_datetime"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::Modulation,
            )),
            Alias::new("modulation"),
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
            Encryption::Table,
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::EncryptionId,
            ))
            .equals((Encryption::Table, Encryption::Id)),
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
    user_login: &uuid::Uuid,
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
                encryption_id: row.try_get("", "encryption_id").ok(),
                encryption: row.try_get("", "encryption_name").ok(),
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
                modulation: row.try_get("", "modulation").ok(),
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
    env: &actix_web::web::Data<Env>,
    groups: &Vec<String>,
    network_id: i64,
) -> Result<HashMap<i64, i64>, AppError> {
    let dbx = &env.dbx;
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

    let rows = {
        let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
        let till_date = crate::stats::get_local_date(Utc::now().naive_utc());
        let since_date =
            till_date - chrono::Duration::days(STATS_MIN_DATETIME_DAYS);
        let network_ids = HashSet::from([network_id]);
        crate::stats::read_redis_network_days(
            env,
            since_date,
            till_date,
            &network_ids,
        )
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|(dt, bucket)| {
            let batch_ids = &batch_ids;
            bucket
                .frequencies
                .into_iter()
                .filter(move |row| {
                    row.network_id == network_id
                        && batch_ids.contains(&row.signal_group_batch_id)
                })
                .map(move |row| NetworkFreqStatsDayRow {
                    frequency: row.value,
                    dt,
                    quantity: row.quantity as i64,
                })
        })
        .fold(
            HashMap::<(NaiveDate, String), i64>::new(),
            |mut result, row| {
                *result.entry((row.dt, row.frequency)).or_default() +=
                    row.quantity;
                result
            },
        )
        .into_iter()
        .map(|((dt, frequency), quantity)| NetworkFreqStatsDayRow {
            frequency,
            dt,
            quantity,
        })
        .collect::<Vec<NetworkFreqStatsDayRow>>()
    };

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
        .column(sigint_callsign::Column::FullName)
        .column(sigint_callsign::Column::UnitId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_unit::Column::ArmyRegion)
        .column(sigint_unit::Column::MilitaryDistrict)
        .column(sigint_unit::Column::Army)
        .column(sigint_unit::Column::Corps)
        .column(sigint_unit::Column::Division)
        .column(sigint_unit::Column::Brigade)
        .column(sigint_unit::Column::Regiment)
        .column(sigint_unit::Column::Battalion)
        .column(sigint_unit::Column::Company)
        .column(sigint_unit::Column::Platoon)
        .column(sigint_unit::Column::Squad)
        .column(sigint_unit::Column::Section)
        .column(sigint_unit::Column::TeamOrCrew)
        .column(sigint_unit::Column::Other)
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
    section: Option<
        crate::sigint::network::types::SingleNetworkCallsignsSection,
    >,
    filter: Option<&NetworkFreqFilter>,
    exclude_network_callsign_activity: bool,
) -> Result<Vec<CallsignRes>, AppError> {
    let start = std::time::Instant::now();

    trace!("> load_callsigns for network: {:?}", network_id);

    // Step 1. Get all active callsigns for the given network
    let active_callsigns = get_active_callsigns(db, groups, filter, network_id)
        .await
        .context(h!())?;
    let mut res = render_active_callsigns(
        db,
        &active_callsigns,
        known_callsigns,
        section,
    )
    .await?;

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

    let known_callsigns_activity_info = if exclude_network_callsign_activity {
        get_unassigned_callsigns_activity_info(
            db,
            groups.clone(),
            network_id,
            &callsigns,
            filter.context(h!())?,
        )
        .await
        .context(h!())?
    } else {
        get_callsigns_activity_info(
            db,
            groups.clone(),
            network_id,
            &callsigns,
            filter,
        )
        .await
        .context(h!())?
    };

    apply_activity_info(&mut res, &known_callsigns_activity_info);
    if exclude_network_callsign_activity {
        res.retain(|callsign| {
            known_callsigns_activity_info.contains_key(&callsign.callsign)
        });
    }

    let duration = start.elapsed();
    trace!(
        "[load_callsigns] Execution time: {:.2?} (network: {:?})",
        duration,
        network_id
    );

    Ok(res)
}

pub(crate) async fn load_callsigns_from_activity_info(
    db: &DatabaseConnection,
    network_id: i64,
    known_callsigns: Option<&BTreeMap<String, Vec<KnownCallsignRes>>>,
    include_activity_info: bool,
    section: Option<
        crate::sigint::network::types::SingleNetworkCallsignsSection,
    >,
    activity_info: &HashMap<String, CallsignActivityInfo>,
) -> Result<Vec<CallsignRes>, AppError> {
    let mut callsigns = activity_info.keys().cloned().collect::<Vec<_>>();
    callsigns.sort();
    let active_callsigns =
        build_callsign_query_results(db, network_id, callsigns, true).await?;
    let mut res = render_active_callsigns(
        db,
        &active_callsigns,
        known_callsigns,
        section,
    )
    .await?;
    if include_activity_info {
        apply_activity_info(&mut res, activity_info);
    }
    Ok(res)
}

async fn render_active_callsigns(
    db: &DatabaseConnection,
    active_callsigns: &[CallsignQueryResult],
    known_callsigns: Option<&BTreeMap<String, Vec<KnownCallsignRes>>>,
    section: Option<
        crate::sigint::network::types::SingleNetworkCallsignsSection,
    >,
) -> Result<Vec<CallsignRes>, AppError> {
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

    let mut res = active_callsigns
        .iter()
        .map(|row| {
            let callsign = row.callsign.clone();
            let known_callsigns =
                crate::sigint::callsign::bl::match_known_callsigns(
                    known_callsigns.get(&callsign),
                    &callsign,
                    row,
                );
            CallsignRes {
                callsign,
                known_callsigns,
                message_count: 0,
                last_datetime: None,
                freqs: None,
                network_names: None,
                is_old: false,
            }
        })
        .collect();
    res = filter_callsigns(res);
    res = filter_callsigns_for_section(res, section);
    sort_callsigns(&mut res);
    Ok(res)
}

pub(super) fn sort_callsigns(callsigns: &mut [CallsignRes]) {
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

/// Helper to build join condition for sigint_inbox_item_network and sigint_network_freqs based on the filter.
/// `till_inclusive` selects the upper-bound operator so callers can keep their own window semantics.
///
/// sigint_inbox_item.id = sigint_inbox_item_network.sigint_inbox_item_id
/// AND sigint_inbox_item_network.sigint_network_id = network_freqs.network_id
/// AND sigint_inbox_item.freq = network_freqs.freq
/// AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) >= GREATEST(since_date_inclusive, network_freqs.active_from)
/// AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) {<,<=} COALESCE(network_freqs.active_to, now())
/// AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) {<,<=} till_date
pub fn build_network_freq_join_condition(
    filter: Option<&NetworkFreqFilter>,
    till_inclusive: bool,
) -> Result<SimpleExpr, AppError> {
    build_network_freq_join_condition_with_missing_active_to(
        filter,
        till_inclusive,
        MissingActiveToBound::CurrentTime,
    )
}

/// Builds the network frequency join while treating a missing `active_to` as unbounded.
pub fn build_open_ended_network_freq_join_condition(
    filter: Option<&NetworkFreqFilter>,
    till_inclusive: bool,
) -> Result<SimpleExpr, AppError> {
    build_network_freq_join_condition_with_missing_active_to(
        filter,
        till_inclusive,
        MissingActiveToBound::Unbounded,
    )
}

enum MissingActiveToBound {
    CurrentTime,
    Unbounded,
}

fn build_network_freq_join_condition_with_missing_active_to(
    filter: Option<&NetworkFreqFilter>,
    till_inclusive: bool,
    missing_active_to_bound: MissingActiveToBound,
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
    };

    let till_bound = till_ms
        .map(|till_ms| {
            DateTime::from_timestamp_millis(till_ms)
                .context(h!())
                .map(|till_dt| Expr::value(till_dt.naive_utc()))
        })
        .transpose()?;
    let period_till_inclusive = till_inclusive
        && filter.is_none_or(|filter| {
            filter.till_date_end == ReportPeriodEnd::Inclusive
        });
    let activity_datetime = || {
        Expr::cust(
            "COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at)",
        )
    };
    let mut join_condition =
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Id))
            .equals((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            ))
            .and(
                Expr::col((
                    SigintInboxItemNetwork::Table,
                    SigintInboxItemNetwork::SigintNetworkId,
                ))
                .equals((
                    Alias::new("network_freqs"),
                    Alias::new("network_id"),
                )),
            )
            .and(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
                    .equals((Alias::new("network_freqs"), Alias::new("freq"))),
            )
            .and(activity_datetime().gte(lower_bound))
            .and(match missing_active_to_bound {
                MissingActiveToBound::CurrentTime => {
                    let active_to_bound = Expr::cust(
                        "COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
                    );
                    if till_inclusive {
                        activity_datetime().lte(active_to_bound)
                    } else {
                        activity_datetime().lt(active_to_bound)
                    }
                }
                MissingActiveToBound::Unbounded => {
                    let active_to = || {
                        Expr::col((
                            Alias::new("network_freqs"),
                            Alias::new("active_to"),
                        ))
                    };
                    active_to().is_null().or(if till_inclusive {
                        activity_datetime().lte(active_to())
                    } else {
                        activity_datetime().lt(active_to())
                    })
                }
            });
    if let Some(till_bound) = till_bound {
        join_condition = join_condition.and(if period_till_inclusive {
            activity_datetime().lte(till_bound)
        } else {
            activity_datetime().lt(till_bound)
        });
    }

    Ok(join_condition)
}

pub fn build_datetime_filter(
    filter: Option<&NetworkFreqFilter>,
) -> Result<SimpleExpr, AppError> {
    let mut expr_active_only = None;
    let mut expr_active_from =
        sigint_network_freq::Column::ActiveFrom.into_simple_expr();

    let expr_active_to = Func::coalesce([
        sigint_network_freq::Column::ActiveTo.into_simple_expr(),
        Expr::cust("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'"),
    ]);
    let mut expr_till = None;

    if let Some(network_freq_filter) = filter {
        if network_freq_filter.active_freqs_only {
            expr_active_only =
                Some(sigint_network_freq::Column::ActiveTo.is_null());
        }

        if let Some(since_ms) = network_freq_filter.since_date_inclusive_ms {
            let since_dt = DateTime::from_timestamp_millis(since_ms)
                .context(h!())?
                .naive_utc();
            expr_active_from = Func::greatest([
                Expr::value(since_dt),
                sigint_network_freq::Column::ActiveFrom.into_simple_expr(),
            ])
            .into();
        }

        if let Some(till_ms) = network_freq_filter.till_date_inclusive_ms {
            let till_dt = DateTime::from_timestamp_millis(till_ms)
                .context(h!())?
                .naive_utc();
            expr_till = Some(Expr::value(till_dt));
        }
    }

    let expr_datetime = Func::coalesce([
        sigint_inbox_item::Column::Datetime.into_simple_expr(),
        signal_message::Column::Timestamp.into_simple_expr(),
        signal_message::Column::CreatedAt.into_simple_expr(),
    ]);

    let mut cond_is_network_freq_active = expr_datetime
        .clone()
        .gte(expr_active_from)
        .and(expr_datetime.clone().lte(expr_active_to));
    if let Some(expr_till) = expr_till {
        let cond_till = if filter.is_none_or(|filter| {
            filter.till_date_end == ReportPeriodEnd::Inclusive
        }) {
            expr_datetime.lte(expr_till)
        } else {
            expr_datetime.lt(expr_till)
        };
        cond_is_network_freq_active =
            cond_is_network_freq_active.and(cond_till);
    }

    if let Some(active_filter) = expr_active_only {
        Ok(cond_is_network_freq_active.and(active_filter))
    } else {
        Ok(cond_is_network_freq_active)
    }
}

/// Активні позивні на частотах мережі.
/// Поточні прив'язки виключаються лише без історичного фільтра; звіт за період
/// звіряє позивні з інтервалами прив'язки після завантаження активності.
pub async fn get_active_callsigns(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: Option<&NetworkFreqFilter>,
    network_id: i64,
) -> Result<Vec<CallsignQueryResult>, AppError> {
    let nf = Alias::new("network_freqs");
    let callsigns = Alias::new("callsigns");
    let network_messages =
        build_scoped_network_messages_query(groups, network_id, filter)
            .context(h!())?;
    let mut network_messages_cte = CommonTableExpression::new();
    network_messages_cte
        .query(network_messages)
        .table_name(Alias::new("network_messages"));
    if should_materialize_scoped_network_messages(filter) {
        network_messages_cte.materialized(true);
    }
    let network_messages_cte = network_messages_cte.to_owned();

    let mut query = Query::select();
    query
        .distinct()
        .expr_as(
            Expr::col((callsigns.clone(), SigintInboxItemCallsign::Callsign)),
            Alias::new("callsign"),
        )
        .from(NetworkMessages::Table)
        .join_as(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            nf.clone(),
            build_network_message_freq_join_condition(filter, true)
                .context(h!())?,
        )
        .join_as(
            JoinType::InnerJoin,
            SigintInboxItemCallsign::Table,
            callsigns.clone(),
            Expr::col((
                callsigns.clone(),
                SigintInboxItemCallsign::SigintInboxItemId,
            ))
            .equals((NetworkMessages::Table, NetworkMessages::Id))
            .and(
                Expr::col((
                    callsigns.clone(),
                    SigintInboxItemCallsign::Deleted,
                ))
                .eq(false),
            ),
        )
        .and_where(
            Expr::col((nf.clone(), SigintNetworkFreq::NetworkId))
                .eq(network_id),
        )
        .and_where(
            Condition::any()
                .add(
                    Expr::col((nf.clone(), SigintNetworkFreq::Deleted))
                        .eq(false),
                )
                .add(
                    Expr::col((nf.clone(), SigintNetworkFreq::ActiveTo))
                        .is_not_null(),
                )
                .into(),
        )
        .and_where_option(filter.as_ref().filter(|f| f.active_freqs_only).map(
            |_| Expr::col((nf.clone(), SigintNetworkFreq::ActiveTo)).is_null(),
        ));
    let query = Query::with()
        .cte(network_messages_cte)
        .clone()
        .query(query)
        .to_owned();
    let rows = db
        .query_all_raw(db.get_database_backend().build(&query))
        .await
        .context(h!())?;
    let mut distinct_callsigns = Vec::with_capacity(rows.len());
    for row in rows {
        distinct_callsigns.push(row.try_get("", "callsign").context(h!())?);
    }
    build_callsign_query_results(
        db,
        network_id,
        distinct_callsigns,
        filter.is_none(),
    )
    .await
}

async fn build_callsign_query_results(
    db: &DatabaseConnection,
    network_id: i64,
    mut callsigns: Vec<String>,
    exclude_network_callsigns: bool,
) -> Result<Vec<CallsignQueryResult>, AppError> {
    if exclude_network_callsigns {
        let network_callsigns = sigint_network_callsign::Entity::find()
            .select_only()
            .distinct()
            .column(sigint_network_callsign::Column::SigintCallsign)
            .filter(
                sigint_network_callsign::Column::SigintNetworkId.eq(network_id),
            )
            .filter(sigint_network_callsign::Column::Deleted.eq(false))
            .into_tuple::<String>()
            .all(db)
            .await
            .context(h!())?
            .into_iter()
            .collect::<HashSet<_>>();
        callsigns.retain(|callsign| !network_callsigns.contains(callsign));
    }
    callsigns.sort();

    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .all(db)
        .await
        .context(h!())?;
    let mut records = Vec::new();
    for callsign in callsigns {
        if units.is_empty() {
            let item = CallsignQueryResult {
                callsign,
                ..Default::default()
            };
            records.push(item);
        } else {
            for unit in &units {
                let item = CallsignQueryResult {
                    callsign: callsign.clone(),
                    unit_id: Some(unit.id),
                    unit_name: Some(unit.name.clone()),
                    army_region: Some(unit.army_region.clone()),
                    military_district: Some(unit.military_district.clone()),
                    army: Some(unit.army.clone()),
                    corps: Some(unit.corps.clone()),
                    division: Some(unit.division.clone()),
                    brigade: Some(unit.brigade.clone()),
                    regiment: Some(unit.regiment.clone()),
                    battalion: Some(unit.battalion.clone()),
                    company: Some(unit.company.clone()),
                    platoon: Some(unit.platoon.clone()),
                    squad: Some(unit.squad.clone()),
                    section: Some(unit.section.clone()),
                    team_or_crew: Some(unit.team_or_crew.clone()),
                    other: Some(unit.other.clone()),
                };
                records.push(item);
            }
        };
    }

    Ok(records)
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
    get_callsigns_for_network_freq_with_period(
        db,
        groups,
        network_freq_id,
        None,
    )
    .await
}

pub async fn get_callsigns_for_network_freq_with_period(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_freq_id: i64,
    period: Option<&NetworkFreqCallsignsPeriod>,
) -> Result<Vec<String>, AppError> {
    Ok(get_callsigns_for_network_freq_batch_with_period(
        db,
        groups,
        &[network_freq_id],
        period,
    )
    .await
    .context(h!())?
    .remove(&network_freq_id)
    .unwrap_or_default())
}

pub async fn get_callsigns_for_network_freq_batch(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_freq_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    get_callsigns_for_network_freq_batch_with_period(
        db,
        groups,
        network_freq_ids,
        None,
    )
    .await
}

pub async fn get_callsigns_for_network_freq_batch_with_period(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_freq_ids: &[i64],
    period: Option<&NetworkFreqCallsignsPeriod>,
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    if network_freq_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let nf = Alias::new("network_freqs");
    let join_condition =
        build_network_freq_join_condition(None, true).c(h!())?;

    let mut query = Query::select()
        .distinct()
        .expr_as(
            Expr::col((nf.clone(), SigintNetworkFreq::Id)),
            Alias::new("network_freq_id"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)),
            Alias::new("inbox_item_id"),
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
        .join_as(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            nf.clone(),
            join_condition,
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
            Expr::col((nf.clone(), SigintNetworkFreq::Id))
                .is_in(network_freq_ids.to_vec()),
        )
        .and_where(Expr::cust(crate::inbox::callsigns::sql_exists_condition(
            "sigint_inbox_item",
        )))
        .order_by_expr(
            Expr::col((nf.clone(), SigintNetworkFreq::Id)),
            Order::Asc,
        )
        .to_owned();
    if let Some(lookback_days) =
        period.and_then(NetworkFreqCallsignsPeriod::lookback_days)
    {
        query.and_where(Expr::cust(format!(
            "COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) >= COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '{lookback_days} days'"
        )));
    }

    let rows = db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;

    let mut inbox_item_ids_by_network_freq_id = HashMap::new();
    let mut inbox_item_ids = HashSet::new();
    for row in rows {
        let network_freq_id: i64 =
            row.try_get("", "network_freq_id").context(h!())?;
        let inbox_item_id: i64 =
            row.try_get("", "inbox_item_id").context(h!())?;
        inbox_item_ids_by_network_freq_id
            .entry(network_freq_id)
            .or_insert_with(Vec::new)
            .push(inbox_item_id);
        inbox_item_ids.insert(inbox_item_id);
    }
    let inbox_item_ids = inbox_item_ids.into_iter().collect::<Vec<_>>();
    let callsigns =
        crate::inbox::callsigns::load_by_item_ids(db, &inbox_item_ids).await?;
    let mut callsigns_by_network_freq_id = network_freq_ids
        .iter()
        .copied()
        .map(|network_freq_id| (network_freq_id, HashSet::new()))
        .collect::<HashMap<_, _>>();
    for (network_freq_id, inbox_item_ids) in inbox_item_ids_by_network_freq_id {
        let network_freq_callsigns = callsigns_by_network_freq_id
            .entry(network_freq_id)
            .or_default();
        for inbox_item_id in inbox_item_ids {
            let Some(inbox_item_callsigns) = callsigns.get(&inbox_item_id)
            else {
                continue;
            };
            network_freq_callsigns.extend(
                inbox_item_callsigns
                    .effective()
                    .into_iter()
                    .filter(|callsign| !callsign.trim().is_empty()),
            );
        }
    }
    Ok(callsigns_by_network_freq_id
        .into_iter()
        .map(|(network_freq_id, callsigns)| {
            let mut callsigns = callsigns.into_iter().collect::<Vec<_>>();
            callsigns.sort();
            (network_freq_id, callsigns)
        })
        .collect())
}

fn filter_callsigns(callsigns: Vec<CallsignRes>) -> Vec<CallsignRes> {
    let mut callsign_indexes: HashMap<String, usize> = HashMap::new();
    let mut result: Vec<CallsignRes> = Vec::new();

    for mut callsign in callsigns {
        if let Some(index) = callsign_indexes.get(&callsign.callsign).copied() {
            merge_known_callsigns(
                &mut result[index].known_callsigns,
                callsign.known_callsigns,
            );
            continue;
        }

        deduplicate_known_callsigns(&mut callsign.known_callsigns);
        callsign_indexes.insert(callsign.callsign.clone(), result.len());
        result.push(callsign);
    }

    result
}

fn deduplicate_known_callsigns(
    known_callsigns: &mut Option<Vec<KnownCallsignShortRes>>,
) {
    let Some(known_callsigns) = known_callsigns else {
        return;
    };
    let mut known_callsign_ids = HashSet::new();
    known_callsigns
        .retain(|known_callsign| known_callsign_ids.insert(known_callsign.id));
    known_callsigns.sort_by_key(|known_callsign| known_callsign.id);
}

fn merge_known_callsigns(
    target: &mut Option<Vec<KnownCallsignShortRes>>,
    source: Option<Vec<KnownCallsignShortRes>>,
) {
    let Some(source) = source else {
        return;
    };
    let target = target.get_or_insert_with(Vec::new);
    let mut known_callsign_ids = target
        .iter()
        .map(|known_callsign| known_callsign.id)
        .collect::<HashSet<_>>();
    target.extend(
        source.into_iter().filter(|known_callsign| {
            known_callsign_ids.insert(known_callsign.id)
        }),
    );
    target.sort_by_key(|known_callsign| known_callsign.id);
}

fn filter_callsigns_for_section(
    callsigns: Vec<CallsignRes>,
    section: Option<
        crate::sigint::network::types::SingleNetworkCallsignsSection,
    >,
) -> Vec<CallsignRes> {
    match section.unwrap_or(crate::sigint::network::types::SingleNetworkCallsignsSection::Everything) {
        crate::sigint::network::types::SingleNetworkCallsignsSection::Everything => callsigns,
        crate::sigint::network::types::SingleNetworkCallsignsSection::Catalog => {
            callsigns.into_iter().filter(|callsign| callsign.known_callsigns.is_some()).collect()
        }
        crate::sigint::network::types::SingleNetworkCallsignsSection::Intercepted => {
            callsigns.into_iter().filter(|callsign| callsign.known_callsigns.is_none()).collect()
        }
    }
}

pub async fn load_pelengs_map(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    filters: &[NetworkFreqFilter],
) -> Result<Option<Vec<u8>>, AppError> {
    let mut map_points = Vec::new();
    for filter in build_pelengs_map_filters(filters) {
        map_points.extend(
            bl_get_network_points(dbx, groups, network_id, Some(&filter))
                .await
                .c(h!())?
                .into_iter()
                .map(|p| PelengsQueryRes {
                    freq: p.freq,
                    lat: format!("{:02.6}", p.lat),
                    lng: format!("{:02.6}", p.lng),
                }),
        );
    }
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

fn build_pelengs_map_filters(
    filters: &[NetworkFreqFilter],
) -> Vec<NetworkFreqFilter> {
    let Some(max_span_ms) = pelengs_map_query_max_span_ms(filters) else {
        return build_pelengs_map_filter(filters).into_iter().collect();
    };
    let mut batches = Vec::new();
    let mut batch = Vec::new();

    for filter in filters {
        if !batch.is_empty()
            && !can_add_to_pelengs_map_filter_batch(&batch, filter, max_span_ms)
        {
            if let Some(filter) = build_pelengs_map_filter(&batch) {
                batches.push(filter);
            }
            batch.clear();
        }
        batch.push(*filter);
    }
    if let Some(filter) = build_pelengs_map_filter(&batch) {
        batches.push(filter);
    }

    batches
}

fn pelengs_map_query_max_span_ms(filters: &[NetworkFreqFilter]) -> Option<i64> {
    filters
        .iter()
        .filter_map(|filter| {
            let since_ms = filter.since_date_inclusive_ms?;
            let till_ms = filter.till_date_inclusive_ms?;
            till_ms.checked_sub(since_ms).filter(|span_ms| *span_ms > 0)
        })
        .max()
        .map(|chunk_span_ms| {
            chunk_span_ms
                .saturating_mul(RER_ETALONKA_PELENGS_MAP_QUERY_CHUNK_MULTIPLIER)
        })
}

fn can_add_to_pelengs_map_filter_batch(
    batch: &[NetworkFreqFilter],
    filter: &NetworkFreqFilter,
    max_span_ms: i64,
) -> bool {
    let Some(batch_filter) = build_pelengs_map_filter(batch) else {
        return true;
    };
    if batch_filter.active_freqs_only != filter.active_freqs_only {
        return false;
    }
    let (
        Some(batch_since_ms),
        Some(batch_till_ms),
        Some(filter_since_ms),
        Some(filter_till_ms),
    ) = (
        batch_filter.since_date_inclusive_ms,
        batch_filter.till_date_inclusive_ms,
        filter.since_date_inclusive_ms,
        filter.till_date_inclusive_ms,
    )
    else {
        return false;
    };

    filter_since_ms <= batch_till_ms
        && filter_till_ms.saturating_sub(batch_since_ms) <= max_span_ms
}

fn build_pelengs_map_filter(
    filters: &[NetworkFreqFilter],
) -> Option<NetworkFreqFilter> {
    let first = *filters.first()?;
    let since_date_inclusive_ms = if filters
        .iter()
        .any(|filter| filter.since_date_inclusive_ms.is_none())
    {
        None
    } else {
        filters
            .iter()
            .filter_map(|filter| filter.since_date_inclusive_ms)
            .min()
    };
    let till_date_inclusive_ms = if filters
        .iter()
        .any(|filter| filter.till_date_inclusive_ms.is_none())
    {
        None
    } else {
        filters
            .iter()
            .filter_map(|filter| filter.till_date_inclusive_ms)
            .max()
    };
    let till_date_end = match till_date_inclusive_ms {
        Some(till_date_inclusive_ms)
            if filters.iter().any(|filter| {
                filter.till_date_inclusive_ms == Some(till_date_inclusive_ms)
                    && filter.till_date_end == ReportPeriodEnd::Inclusive
            }) =>
        {
            ReportPeriodEnd::Inclusive
        }
        None => first.till_date_end,
        _ => ReportPeriodEnd::NonInclusive,
    };

    Some(NetworkFreqFilter {
        active_freqs_only: first.active_freqs_only,
        since_date_inclusive_ms,
        till_date_inclusive_ms,
        till_date_end,
    })
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
            crate::sigint::freq::util::inbox_item_network_freq_relation()
                .from_alias(nf_alias.clone()),
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

    let _permit = GEO_SCREENSHOT_SEMAPHORE.acquire().await.context(h!())?;
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
    text_search_mode: NetworkTextSearchMode,
    _groups: &[String],
) -> Select<sigint_network::Entity> {
    let filter_unit = req.filter_unit.clone();
    let filter_unit_army_region = req.filter_unit_army_region.clone();
    let filter_unit_military_district =
        req.filter_unit_military_district.clone();
    let filter_unit_army = req.filter_unit_army.clone();
    let filter_unit_corps = req.filter_unit_corps.clone();
    let filter_unit_division = req.filter_unit_division.clone();
    let filter_unit_brigade = req.filter_unit_brigade.clone();
    let filter_unit_regiment = req.filter_unit_regiment.clone();
    let filter_unit_battalion = req.filter_unit_battalion.clone();
    let filter_unit_company = req.filter_unit_company.clone();
    let filter_unit_platoon = req.filter_unit_platoon.clone();
    let filter_unit_squad = req.filter_unit_squad.clone();
    let filter_unit_section = req.filter_unit_section.clone();
    let filter_unit_team_or_crew = req.filter_unit_team_or_crew.clone();
    let filter_unit_other = req.filter_unit_other.clone();
    let mut report_req = req.clone();
    report_req.filter_unit = None;
    report_req.filter_unit_army_region = None;
    report_req.filter_unit_military_district = None;
    report_req.filter_unit_army = None;
    report_req.filter_unit_corps = None;
    report_req.filter_unit_division = None;
    report_req.filter_unit_brigade = None;
    report_req.filter_unit_regiment = None;
    report_req.filter_unit_battalion = None;
    report_req.filter_unit_company = None;
    report_req.filter_unit_platoon = None;
    report_req.filter_unit_squad = None;
    report_req.filter_unit_section = None;
    report_req.filter_unit_team_or_crew = None;
    report_req.filter_unit_other = None;

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
        networks = apply_network_list_filters_with_text_search_mode(
            networks,
            &report_req,
            true,
            text_search_mode,
        );
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

    if let Some(filter_unit_army_region) = filter_unit_army_region.as_deref() {
        networks = networks.filter(
            sigint_unit::Column::ArmyRegion.eq(filter_unit_army_region),
        );
    }
    if let Some(filter_unit_military_district) =
        filter_unit_military_district.as_deref()
    {
        networks = networks.filter(
            sigint_unit::Column::MilitaryDistrict
                .eq(filter_unit_military_district),
        );
    }
    if let Some(filter_unit_army) = filter_unit_army.as_deref() {
        networks =
            networks.filter(sigint_unit::Column::Army.eq(filter_unit_army));
    }
    if let Some(filter_unit_corps) = filter_unit_corps.as_deref() {
        networks =
            networks.filter(sigint_unit::Column::Corps.eq(filter_unit_corps));
    }
    if let Some(filter_unit_division) = filter_unit_division.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Division.eq(filter_unit_division));
    }
    if let Some(filter_unit_brigade) = filter_unit_brigade.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Brigade.eq(filter_unit_brigade));
    }
    if let Some(filter_unit_regiment) = filter_unit_regiment.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Regiment.eq(filter_unit_regiment));
    }
    if let Some(filter_unit_battalion) = filter_unit_battalion.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Battalion.eq(filter_unit_battalion));
    }
    if let Some(filter_unit_company) = filter_unit_company.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Company.eq(filter_unit_company));
    }
    if let Some(filter_unit_platoon) = filter_unit_platoon.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Platoon.eq(filter_unit_platoon));
    }
    if let Some(filter_unit_squad) = filter_unit_squad.as_deref() {
        networks =
            networks.filter(sigint_unit::Column::Squad.eq(filter_unit_squad));
    }
    if let Some(filter_unit_section) = filter_unit_section.as_deref() {
        networks = networks
            .filter(sigint_unit::Column::Section.eq(filter_unit_section));
    }
    if let Some(filter_unit_team_or_crew) = filter_unit_team_or_crew.as_deref()
    {
        networks = networks.filter(
            sigint_unit::Column::TeamOrCrew.eq(filter_unit_team_or_crew),
        );
    }
    if let Some(filter_unit_other) = filter_unit_other.as_deref() {
        networks =
            networks.filter(sigint_unit::Column::Other.eq(filter_unit_other));
    }

    network_sort::apply_network_sorts(networks, req.sort_by.as_ref())
}

pub async fn load_networks(
    db: &DatabaseConnection,
    req: &EtalonkaJimForksReq,
    groups: &[String],
) -> Result<
    BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    AppError,
> {
    let text_search_mode =
        resolve_network_text_search_mode(db, &req.req).await?;
    let networks = build_etalonka_networks_query(
        &req.req,
        JoinType::InnerJoin,
        None,
        None,
        text_search_mode,
        groups,
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
    groups: &[String],
) -> Result<
    BTreeMap<NetworkEtalonkaUnitKey, Vec<NetworkEtalonkaResult>>,
    AppError,
> {
    let sort_req = ListNetworksReq {
        filter_freq: None,
        filter_unit_id: None,
        filter_unit: None,
        filter_unit_army_region: None,
        filter_unit_military_district: None,
        filter_unit_army: None,
        filter_unit_corps: None,
        filter_unit_division: None,
        filter_unit_brigade: None,
        filter_unit_regiment: None,
        filter_unit_battalion: None,
        filter_unit_company: None,
        filter_unit_platoon: None,
        filter_unit_squad: None,
        filter_unit_section: None,
        filter_unit_team_or_crew: None,
        filter_unit_other: None,
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
        NetworkTextSearchMode::Substring,
        groups,
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
    use crate::functest::tests::{
        cleanup, mk_sigint_network, mk_sigint_network_unit, mk_sigint_unit,
    };
    use crate::sigint::network::types::ListNetworksSortBy;
    use serial_test::serial;

    fn empty_list_networks_req() -> ListNetworksReq {
        ListNetworksReq {
            filter_freq: None,
            filter_unit_id: None,
            filter_unit: None,
            filter_unit_army_region: None,
            filter_unit_military_district: None,
            filter_unit_army: None,
            filter_unit_corps: None,
            filter_unit_division: None,
            filter_unit_brigade: None,
            filter_unit_regiment: None,
            filter_unit_battalion: None,
            filter_unit_company: None,
            filter_unit_platoon: None,
            filter_unit_squad: None,
            filter_unit_section: None,
            filter_unit_team_or_crew: None,
            filter_unit_other: None,
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

    fn test_callsign_res(
        callsign: &str,
        known_callsigns: Option<Vec<KnownCallsignShortRes>>,
    ) -> CallsignRes {
        CallsignRes {
            callsign: callsign.to_string(),
            known_callsigns,
            message_count: 0,
            last_datetime: None,
            freqs: None,
            network_names: None,
            is_old: false,
        }
    }

    fn test_known_callsign(id: i64) -> KnownCallsignShortRes {
        KnownCallsignShortRes {
            id,
            callsign: "KNOWN".to_string(),
            position: String::new(),
            comment: String::new(),
            full_name: String::new(),
            unit_id: id,
            unit_name: format!("Unit {id}"),
            source_name: String::new(),
            created_at: id,
        }
    }

    async fn mk_network_with_unit(
        db: &DatabaseConnection,
        network_name: &str,
        unit_name: &str,
    ) -> sigint_network::Model {
        let unit = mk_sigint_unit(
            db,
            sigint_unit::ActiveModel {
                name: Set(unit_name.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(
            db,
            sigint_network::ActiveModel {
                name: Set(network_name.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_unit(
            db,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        network
    }

    #[tokio::test]
    #[serial]
    async fn etalonka_networks_use_resolved_text_search_mode() {
        let env = cleanup().await.unwrap();
        let exact_network =
            mk_network_with_unit(&env.dbx, "точна мережа", "6 омсбр 3 А").await;
        let substring_network = mk_network_with_unit(
            &env.dbx,
            "підрядкова мережа",
            "2 мсб 164 омсбр 25 А",
        )
        .await;
        let mut network_req = empty_list_networks_req();
        network_req.filter_text = Some("6 омсбр".to_string());
        let req = EtalonkaJimForksReq {
            req: network_req,
            etalonka_type: EtalonkaReportType::AccordingToTheForm(
                EtalonkaSettings {
                    active_freqs_only: false,
                    include_callsign_full_names: false,
                    include_sigint_signs: false,
                    include_confirmation: false,
                    include_headings_and_freqs: false,
                },
            ),
        };

        let networks = load_networks(&env.dbx, &req, &[]).await.unwrap();
        let ids = networks
            .values()
            .flatten()
            .map(|network| network.id)
            .collect::<HashSet<_>>();

        assert!(ids.contains(&exact_network.id));
        assert!(!ids.contains(&substring_network.id));
    }

    #[test]
    fn build_pelengs_map_filters_batches_chunks_with_bounded_span() {
        let chunk_span_ms = chrono::Duration::hours(13).num_milliseconds();
        let max_span_ms =
            chunk_span_ms * RER_ETALONKA_PELENGS_MAP_QUERY_CHUNK_MULTIPLIER;
        let filters = (0..15)
            .map(|idx| NetworkFreqFilter {
                active_freqs_only: true,
                since_date_inclusive_ms: Some(idx * chunk_span_ms),
                till_date_inclusive_ms: Some((idx + 1) * chunk_span_ms),
                till_date_end: if idx == 14 {
                    ReportPeriodEnd::Inclusive
                } else {
                    ReportPeriodEnd::NonInclusive
                },
            })
            .collect::<Vec<_>>();

        let filters = build_pelengs_map_filters(&filters);

        assert_eq!(filters.len(), 2);
        assert!(filters[0].active_freqs_only);
        assert_eq!(filters[0].since_date_inclusive_ms, Some(0));
        assert_eq!(filters[0].till_date_inclusive_ms, Some(max_span_ms));
        assert_eq!(filters[0].till_date_end, ReportPeriodEnd::NonInclusive);
        assert_eq!(filters[1].since_date_inclusive_ms, Some(max_span_ms));
        assert_eq!(
            filters[1].till_date_inclusive_ms,
            Some(max_span_ms + chunk_span_ms)
        );
        assert_eq!(filters[1].till_date_end, ReportPeriodEnd::Inclusive);
    }

    #[test]
    fn build_pelengs_map_filters_handles_empty_filters() {
        assert!(build_pelengs_map_filters(&[]).is_empty());
    }

    #[test]
    fn build_network_freq_join_condition_uses_noninclusive_upper_bound() {
        let filter = NetworkFreqFilter {
            active_freqs_only: false,
            since_date_inclusive_ms: Some(1_740_000_000_000),
            till_date_inclusive_ms: Some(1_740_000_600_000),
            till_date_end: ReportPeriodEnd::Inclusive,
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
        let noninclusive_period_sql = Query::select()
            .expr(
                build_network_freq_join_condition(
                    Some(&NetworkFreqFilter {
                        till_date_end: ReportPeriodEnd::NonInclusive,
                        ..filter
                    }),
                    true,
                )
                .expect("join condition"),
            )
            .to_string(PostgresQueryBuilder);

        assert!(exclusive_sql.contains(" < "), "{exclusive_sql}");
        assert!(!exclusive_sql.contains(" <= "), "{exclusive_sql}");
        assert!(inclusive_sql.contains(" <= "), "{inclusive_sql}");
        assert!(
            noninclusive_period_sql.contains(" < "),
            "{noninclusive_period_sql}"
        );
    }

    #[test]
    fn build_network_freqs_query_scopes_messages_before_freq_join() {
        let filter = NetworkFreqFilter {
            active_freqs_only: false,
            since_date_inclusive_ms: Some(1_740_000_000_000),
            till_date_inclusive_ms: Some(1_740_000_600_000),
            till_date_end: ReportPeriodEnd::NonInclusive,
        };
        let sql = build_network_freqs_query(
            &vec!["group-a".to_string()],
            42,
            Some(&filter),
            true,
            None,
        )
        .expect("network freqs query")
        .to_string(PostgresQueryBuilder);

        assert!(sql.contains("WITH \"network_messages\""), "{sql}");
        assert!(sql.contains("MATERIALIZED"), "{sql}");
        assert!(sql.contains("FROM \"sigint_inbox_item_network\""), "{sql}");
        assert!(
            sql.contains(
                "\"sigint_inbox_item_network\".\"sigint_network_id\" = 42"
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                "INNER JOIN \"sigint_network_freq\" AS \"network_freqs\" ON \"network_messages\".\"freq\" = \"network_freqs\".\"freq\""
            ),
            "{sql}"
        );
        assert!(
            sql.contains("\"network_messages\".\"activity_datetime\""),
            "{sql}"
        );
    }

    #[test]
    fn build_network_freqs_query_does_not_materialize_single_freq_lookup() {
        let sql = build_network_freqs_query(
            &vec!["group-a".to_string()],
            42,
            None,
            false,
            Some(7),
        )
        .expect("network freqs query")
        .to_string(PostgresQueryBuilder);

        assert!(!sql.contains("MATERIALIZED"), "{sql}");
        assert!(sql.contains("\"sigint_network_freq\".\"id\" = 7"), "{sql}");
    }

    #[test]
    fn etalonka_network_sorting_uses_requested_sort_variants() {
        let groups = vec!["test-group".to_string()];
        let no_id_sql = build_etalonka_networks_query(
            &empty_list_networks_req(),
            JoinType::InnerJoin,
            None,
            None,
            NetworkTextSearchMode::Substring,
            &groups,
        )
        .build(DbBackend::Postgres)
        .to_string();

        let empty_ids: Vec<i64> = vec![];
        let empty_id_sql = build_etalonka_networks_query(
            &empty_list_networks_req(),
            JoinType::InnerJoin,
            Some(&empty_ids),
            None,
            NetworkTextSearchMode::Substring,
            &groups,
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
            NetworkTextSearchMode::Substring,
            &groups,
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
            NetworkTextSearchMode::Substring,
            &groups,
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
            NetworkTextSearchMode::Substring,
            &groups,
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
            NetworkTextSearchMode::Substring,
            &groups,
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert_primary_sort_before_name(
            &sql,
            "\"sigint_network\".\"last_active_at\" DESC NULLS LAST",
        );
    }

    #[test]
    fn filter_callsigns_deduplicates_catalog_matches_across_network_units() {
        let first_match = test_known_callsign(1);
        let second_match = test_known_callsign(2);
        let callsigns = vec![
            test_callsign_res("KNOWN", Some(vec![first_match.clone()])),
            test_callsign_res(
                "KNOWN",
                Some(vec![second_match.clone(), first_match]),
            ),
            test_callsign_res("KNOWN", None),
        ];

        let mut callsigns = filter_callsigns(callsigns);
        apply_activity_info(
            &mut callsigns,
            &HashMap::from([(
                "KNOWN".to_string(),
                CallsignActivityInfo {
                    message_count: 7,
                    last_datetime: None,
                    freqs: None,
                    network_names: None,
                },
            )]),
        );

        assert_eq!(callsigns.len(), 1);
        assert_eq!(callsigns[0].message_count, 7);
        assert_eq!(
            callsigns[0].known_callsigns,
            Some(vec![test_known_callsign(1), second_match])
        );
    }

    #[test]
    fn filter_callsigns_for_section_respects_requested_section() {
        let known = test_callsign_res(
            "KNOWN",
            Some(vec![KnownCallsignShortRes {
                id: 1,
                callsign: "KNOWN".to_string(),
                position: String::new(),
                comment: String::new(),
                full_name: String::new(),
                unit_id: 1,
                unit_name: "Unit".to_string(),
                source_name: "Source".to_string(),
                created_at: 1,
            }]),
        );
        let unknown = test_callsign_res("UNKNOWN", None);
        let callsigns = vec![known.clone(), unknown.clone()];

        assert_eq!(
            filter_callsigns_for_section(callsigns.clone(), None),
            callsigns
        );
        assert_eq!(
            filter_callsigns_for_section(
                callsigns.clone(),
                Some(
                    crate::sigint::network::types::SingleNetworkCallsignsSection::Everything
                ),
            ),
            callsigns
        );
        assert_eq!(
            filter_callsigns_for_section(
                callsigns.clone(),
                Some(
                    crate::sigint::network::types::SingleNetworkCallsignsSection::Catalog
                ),
            ),
            vec![known]
        );
        assert_eq!(
            filter_callsigns_for_section(
                callsigns,
                Some(
                    crate::sigint::network::types::SingleNetworkCallsignsSection::Intercepted
                ),
            ),
            vec![unknown]
        );
    }
}
