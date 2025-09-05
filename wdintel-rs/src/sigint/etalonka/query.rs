use crate::entities::*;
use crate::error::AppError;
use crate::sigint::network::types::ListNetworksSortBy;
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use actix_web::web::Json;
use chrono::prelude::*;
use futures::stream::TryStreamExt;
use log::*;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::{
    Alias, CommonTableExpression, Expr, Iden, Query, SelectStatement,
    SimpleExpr, WithClause,
};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashSet;
use tempfile::Builder;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use std::collections::HashMap;

use crate::sigint::etalonka::types::*;

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
    active_freqs_only: bool,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    trace!("> load freqs for network: {network_id:?}");

    let mut q: SelectStatement = Query::select();
    q.expr_as(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
        Alias::new("network_freq_id"),
    )
    .expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
        Alias::new("datetime"),
    )
    .expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Callsigns)),
        Alias::new("callsigns"),
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
        SigintNetworkFreq::Table,
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq))
            .equals((SigintInboxItem::Table, SigintInboxItem::Freq)),
    )
    .join(
        JoinType::InnerJoin,
        SigintNetwork::Table,
        Expr::col((SigintNetwork::Table, SigintNetwork::Id))
            .equals((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId)),
    )
    .and_where(
        Expr::col((DatasourceGroup::Table, DatasourceGroup::GroupMasterKey))
            .is_in(groups),
    )
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintNetwork::Table, SigintUnit::Id)).eq(network_id),
    )
    .and_where(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)).gte(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ActiveFrom,
            )),
        ),
    )
    .and_where(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)).lt(
            Expr::cust("COALESCE(sigint_network_freq.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
        ),
    );

    if active_freqs_only {
        q.and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo))
                .is_null(),
        );
    }

    let network_messages_cte = CommonTableExpression::new()
        .query(q)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    let mut q_agg: SelectStatement = Query::select();
    q_agg
        .expr_as(Expr::cust("network_freq_id"), Alias::new("network_freq_id"))
        .expr_as(Expr::cust("COUNT(*)"), Alias::new("message_count"))
        .expr_as(Expr::cust("MAX(datetime)"), Alias::new("last_datetime"))
        .expr_as(Expr::cust("jsonb_agg(callsigns)"), Alias::new("callsigns"))
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
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Kind))
                .cast_as(Alias::new("text")),
            Alias::new("kind"),
        )
        .expr_as(
            Expr::col((Alias::new("agg"), Alias::new("message_count"))),
            Alias::new("message_count"),
        )
        .expr_as(
            Expr::col((Alias::new("agg"), Alias::new("last_datetime"))),
            Alias::new("last_datetime"),
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
            Expr::col((SigintNetwork::Table, SigintUnit::Id)).eq(network_id),
        )
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

    let network_active_freqs: Result<Vec<NetworkFreqsRes>, AppError> = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?
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

            Ok(NetworkFreqsRes {
                network_freq_id: row
                    .try_get("", "network_freq_id")
                    .unwrap_or_default(),
                freq: row.try_get("", "freq").unwrap_or_default(),
                modulation_id: row.try_get("", "modulation_id").ok(),
                modulation: row.try_get("", "modulation_name").ok(),
                message_count: row.try_get("", "message_count").unwrap_or(0),
                callsigns: row_callsigns,
                last_datetime: row
                    .try_get("", "last_datetime")
                    .ok()
                    .map(|dt: NaiveDateTime| dt.and_utc().timestamp_millis()),

                created_at: created_at.and_utc().timestamp_millis(),
                is_active: active_to.is_none(),
                active_from,
                active_to,
                kind: row.try_get("", "kind").ok(),
            })
        })
        .collect();

    network_active_freqs
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

pub async fn find_all_known_callsigns(
    db: &DatabaseConnection,
) -> Result<BTreeMap<String, Vec<KnownCallsignRes>>, AppError> {
    let q = sigint_callsign::Entity::find()
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
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_callsign::Column::Callsign.ne(""))
        .order_by_asc(sigint_callsign::Column::Callsign);

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

#[derive(Debug, Clone)]
pub struct CallsignCommunicationInfo {
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
    pub network_names: Option<Vec<String>>,
}

pub async fn load_callsigns(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
    known_callsigns: &BTreeMap<String, Vec<KnownCallsignRes>>,
) -> Result<Vec<CallsignRes>, AppError> {
    let start = std::time::Instant::now();

    trace!("> load_callsigns for network: {network_id:?}");

    let (base_with, callsigns_select) =
        build_callsigns_queries(groups, network_id).context(h!())?;

    // Step 1. Get all active callsigns for the given network
    let active_callsigns = get_active_callsigns(
        db,
        base_with.clone(),
        callsigns_select.clone(),
        network_id,
    )
    .await
    .context(h!())?;

    let mut res: Vec<CallsignRes> = active_callsigns
        .iter()
        .map(|row| {
            let callsign = row.callsign.clone();

            let short_known_callsigns =
                crate::sigint::callsign::match_known_callsigns(
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

    // Step 2. Get communication info for callsigns with known_callsigns
    let res_known_callsigns: Vec<String> = res
        .iter()
        .filter(|c| c.known_callsigns.is_some())
        .map(|c| c.callsign.clone())
        .collect();

    let known_callsigns_comm_info = get_communication_info_for_callsigns(
        db,
        base_with.clone(),
        callsigns_select.clone(),
        &res_known_callsigns,
    )
    .await
    .context(h!())?;

    // Step 3. Update res vector with communication info for callsigns with known_callsigns
    for c in &mut res {
        if let Some(comm_info) = known_callsigns_comm_info.get(&c.callsign) {
            c.message_count = comm_info.message_count;
            c.last_datetime = comm_info.last_datetime;
            c.freqs = comm_info.freqs.clone();
            c.network_names = comm_info.network_names.clone();
        }
    }

    res.sort_by(|a, b| match (&a.known_callsigns, &b.known_callsigns) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => a.callsign.cmp(&b.callsign),
    });

    let duration = start.elapsed();
    trace!(
        "[load_callsigns] Execution time: {duration:.2?} (network: {network_id:?})"        
    );

    Ok(res)
}

pub fn build_callsigns_queries(
    groups: &Vec<String>,
    network_id: i64,
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
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).eq(network_id),
        )
        .to_owned();

    let network_freqs_cte = CommonTableExpression::new()
        .query(network_freqs_select)
        .table_name(Alias::new("network_freqs"))
        .to_owned();

    let network_messages_select = Query::select()
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
            Expr::col((Alias::new("network_freqs"), Alias::new("network_id"))),
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
            Alias::new("network_freqs"),
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
                .equals((Alias::new("network_freqs"), Alias::new("freq")))
                .and(Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                    .gte(Expr::col((Alias::new("network_freqs"), Alias::new("active_from"))))
                    .and(Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                        .lt(Expr::cust("COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")))),
        )
    .and_where(
        Expr::col((DatasourceGroup::Table, DatasourceGroup::GroupMasterKey))
            .is_in(groups),
    )
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
    )
    .to_owned();

    let network_messages_cte = CommonTableExpression::new()
        .query(network_messages_select)
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

pub async fn get_communication_info_for_callsigns<'a, 'async_trait, C>(
    txn: &'a C,
    base_with: WithClause,
    callsigns_select: SelectStatement,
    callsigns: &[String],
) -> Result<HashMap<String, CallsignCommunicationInfo>, AppError>
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
            CallsignCommunicationInfo {
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
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
) -> Result<Option<Vec<u8>>, AppError> {
    let date_since = filter.since_date_inclusive_ms;
    let date_till = filter.till_date_noninclusive_ms;

    let mut query = signal_message::Entity::find()
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
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .distinct()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column_as(
            SimpleExpr::Custom(
                "to_char(sigint_peleng.lat,'FM90.000000')".to_string(),
            ),
            "lat",
        )
        .column_as(
            SimpleExpr::Custom(
                "to_char(sigint_peleng.lng,'FM90.000000')".to_string(),
            ),
            "lng",
        )
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups))
        .filter(sigint_inbox_item::Column::Coords.is_not_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_peleng::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.eq(filter.network_id));

    if let Some(date_since) = date_since {
        query = query.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(date_since)?),
        )
    }

    if let Some(date_till) = date_till {
        query = query.filter(
            sigint_inbox_item::Column::Datetime.gte(dt_from_millis(date_till)?),
        )
    }

    // debug!(
    //     "> pelengs per unir sql: {}\n",
    //     query.build(DbBackend::Postgres).to_string()
    // );

    let map_points = query
        .into_model::<PelengsQueryRes>()
        .all(db)
        .await
        .context(h!())?;

    if map_points.is_empty() {
        return Ok(None);
    }

    let res = get_map_image(map_points).await?;

    Ok(Some(res))
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
            error!("Failed to start geo-screenshot: {e:#?}");
            e
        })
        .context(h!())?
        .wait_with_output()
        .await
        .map_err(|e| {
            error!("geo-screenshot process failed: {e:#?}");
            e
        })
        .context(h!())?;

    if output.status.success() {
        // debug!("> geo-screenshot call done. Processing output temp file");
        let file = tokio::fs::File::open(temp_file_name)
            .await
            .map_err(|e| {
                error!("Failed to open temp file {temp_file_name}: {e:#?}");
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

pub async fn load_networks(
    db: &DatabaseConnection,
    req: &Json<EtalonkaJimForksReq>,
) -> Result<HashMap<String, Vec<NetworkEtalonkaResult>>, AppError> {
    let mut networks = sigint_network::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            JoinType::InnerJoin,
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
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::ActiveFrom)
        .column(sigint_network::Column::ActiveTo);

    networks = networks.filter(
        sigint_network::Column::Deleted
            .eq(req.req.show_only_deleted.unwrap_or(false)),
    );

    if !req.req.show_inactive.unwrap_or(false) {
        networks = networks.filter(sigint_network::Column::ActiveTo.is_null());
    }

    if let Some(filter_unit) = &req.req.filter_unit {
        networks = networks.filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![format!("%{}%", filter_unit.to_lowercase())],
        ))
    };

    if req.req.show_only_further_inverstigation.unwrap_or(false) {
        networks = networks.filter(sigint_network_unit::Column::Id.is_null());
    }

    // Optional filter by Areas of Responsibility (AOR) IDs
    if let Some(aor_ids) = &req.req.aor_ids {
        if !aor_ids.is_empty() {
            networks = networks
                .join_as(
                    JoinType::InnerJoin,
                    sigint_network::Relation::SigintNetworkAor.def(),
                    Alias::new("sigint_network_aor"),
                )
                .filter(
                    sigint_network_aor::Column::AorId.is_in(aor_ids.clone()),
                );
        }
    }

    if let Some(filter_freq) = &req.req.filter_freq {
        let subquery = sigint_network_freq::Entity::find()
            .select_only()
            .column(sigint_network_freq::Column::Freq)
            .filter(
                sigint_network_freq::Column::NetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            )
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .filter(Expr::cust_with_values(
                "sigint_network_freq.freq ilike $1",
                vec![format!("{filter_freq}%").as_str()],
            ));
        networks = networks.filter(Expr::exists(subquery.into_query()));
    }

    networks = if let Some(sort_by) = &req.req.sort_by {
        sort_by
            .iter()
            .fold(networks, |networks, sort_by| match sort_by {
                ListNetworksSortBy::NameAsc => {
                    networks.order_by_asc(sigint_network::Column::Name)
                }
                ListNetworksSortBy::NameDesc => {
                    networks.order_by_desc(sigint_network::Column::Name)
                }
            })
    } else {
        networks.order_by_asc(sigint_network::Column::Name)
    };

    // debug!(
    //     "> sql networks: {}",
    //     networks.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks
        .clone()
        .into_model::<NetworkEtalonkaResult>()
        .all(db)
        .await
        .context(h!())?;

    let mut res: HashMap<String, Vec<NetworkEtalonkaResult>> = HashMap::new();
    for network in networks {
        let key = network
            .unit_name
            .as_deref()
            .unwrap_or(DEFAULT_EMPTY_UNIT_NAME)
            .to_string();

        res.entry(key).or_default().push(network);
    }

    Ok(res)
}

pub async fn load_networks_by_id(
    db: &DatabaseConnection,
    req: &Json<EtalonkaNetworkBatchReq>,
) -> Result<HashMap<String, Vec<NetworkEtalonkaResult>>, AppError> {
    let mut networks = sigint_network::Entity::find()
        .join_as(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
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
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::ActiveFrom)
        .column(sigint_network::Column::ActiveTo)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.is_in(req.network_ids.clone()));

    networks = if let Some(sort_by) = &req.sort_by {
        sort_by
            .iter()
            .fold(networks, |networks, sort_by| match sort_by {
                ListNetworksSortBy::NameAsc => {
                    networks.order_by_asc(sigint_network::Column::Name)
                }
                ListNetworksSortBy::NameDesc => {
                    networks.order_by_desc(sigint_network::Column::Name)
                }
            })
    } else {
        networks.order_by_asc(sigint_network::Column::Name)
    };

    // debug!(
    //     "> sql networks by id: {}",
    //     networks.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks
        .clone()
        .into_model::<NetworkEtalonkaResult>()
        .all(db)
        .await
        .context(h!())?;

    let mut res: HashMap<String, Vec<NetworkEtalonkaResult>> = HashMap::new();
    for network in networks {
        let key = network
            .unit_name
            .as_deref()
            .unwrap_or(DEFAULT_EMPTY_UNIT_NAME)
            .to_string();

        res.entry(key).or_default().push(network);
    }

    Ok(res)
}
