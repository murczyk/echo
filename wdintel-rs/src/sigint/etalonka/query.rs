use crate::entities::*;
use crate::error::AppError;
use crate::location::utils::to_location_list;
use crate::sigint::signal::types::Signal;
use crate::types::*;
use crate::utils::*;
use actix_web::web::Json;
use chrono::prelude::*;
use echo_migration::WithQuery;
use futures::stream::TryStreamExt;
use log::*;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::{
    Alias, CommonTableExpression, Expr, Iden, Query, SelectStatement,
    SimpleExpr,
};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashSet};
use tempfile::Builder;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use std::collections::HashMap;

use crate::sigint::etalonka::types::*;

const SCREENSHOT_DELAY_MILLIS: u64 = 2500;

#[derive(Iden)]
pub enum SignalMessage {
    Table,
    Id,
    GroupMasterKey,
    Deleted,
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

pub async fn load_freqs_per_unit(
    db: &DatabaseConnection,
    groups: Vec<String>,
    req: &Json<EtalonkaReq>,
) -> Result<HashMap<String, Vec<FreqStatsRes>>, AppError> {
    let mut q = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .column_as(sigint_network::Column::Name, "name")
        .column_as(sigint_network::Column::Name, "name_updated")
        .column_as(signal_message::Column::Id.count(), "message_count")
        .column(sigint_network_freq::Column::Kind)
        .column(sigint_network::Column::Comment)
        .column(sigint_network::Column::Location)
        .column(sigint_network::Column::RadioStation)
        .column_as(sigint_unit::Column::Name, "unit")
        .column_as(sigint_inbox_item::Column::Datetime.min(), "first_time")
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(signal_message::Column::GroupMasterKey.is_in(groups))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(signal_message::Column::Deleted.eq(false));

    if !req.full_etalonka_report {
        q = q
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_from_millis(
                req.list_freq_req.since_date_inclusive_ms,
            )?))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_from_millis(
                req.list_freq_req.till_date_noninclusive_ms,
            )?))
            .apply_if(req.list_freq_req.filter_freq.clone(), |q, ff| {
                q.filter(
                    sigint_network_freq::Column::Freq.like(format!("%{}%", ff)),
                )
            })
            .apply_if(req.list_freq_req.filter_unit.clone(), |q, fu| {
                q.filter(Expr::cust_with_exprs(
                    "lower($1 collate \"ru-x-icu\") ilike $2",
                    vec![
                        Expr::col((
                            sigint_unit::Entity,
                            sigint_unit::Column::Name,
                        ))
                        .into(),
                        Expr::val(format!("%{}%", fu.to_lowercase())).into(),
                    ],
                ))
            })
    };

    q = q
        .group_by(sigint_network_freq::Column::Freq)
        .group_by(sigint_network::Column::Id)
        .group_by(sigint_unit::Column::Id)
        .group_by(sigint_network_freq::Column::Kind)
        .order_by_asc(sigint_network_freq::Column::Freq);

    trace!(
        "> sql: {}",
        q.clone().build(DbBackend::Postgres).to_string()
    );

    let freq_stats = q
        .clone()
        .into_model::<FreqStatsRes>()
        .all(db)
        .await
        .context(h!())?;

    let freq_updated = match req.adjacent_freqs_distance {
        Some(djacent_freqs_distance) => {
            let delta = djacent_freqs_distance.as_f64();
            let mut freq_stats_updated = freq_stats;
            update_freq_network_name(&mut freq_stats_updated, delta);
            freq_stats_updated
        }
        None => freq_stats,
    };

    let res = freq_updated
        .into_iter()
        .fold(HashMap::new(), |mut acc, item| {
            // Closure to handle substitution for `kind`
            let substitute_kind = |kind: Option<String>| {
                let kind_value = kind.unwrap_or_default();
                if kind_value == "УКХ" {
                    "NFM".to_string()
                } else {
                    kind_value
                }
            };

            let key = if let Some(unit) = item.unit.clone() {
                unit.to_string()
            } else {
                "Н/В".to_string()
            };

            let key_clone = key.clone();

            acc.entry(key)
                .or_insert_with(Vec::new)
                .iter_mut()
                .find(|freq_stats: &&mut FreqStatsRes| {
                    freq_stats.name == item.name
                })
                .map(|freq_stats| {
                    // Update existing FreqStats
                    freq_stats.freq =
                        format!("{}, {}", freq_stats.freq, item.freq);

                    if let Some(location) = item.location.clone() {
                        let mut locations: HashSet<String> = freq_stats
                            .location
                            .as_deref()
                            .unwrap_or("")
                            .split(", ")
                            .map(|s| s.to_string())
                            .collect();
                        locations.insert(location);
                        freq_stats.location = Some(
                            locations
                                .into_iter()
                                .collect::<Vec<_>>()
                                .join(", "),
                        );
                    }

                    if let Some(comment) =
                        item.comment.clone().filter(|c| !c.trim().is_empty())
                    {
                        freq_stats.comment = match freq_stats.comment.clone() {
                            Some(existing) if !existing.trim().is_empty() => {
                                Some(format!("{}, {}", existing, comment))
                            }
                            _ => Some(comment),
                        };
                    }

                    if let Some(confirmation) = item
                        .confirmation
                        .clone()
                        .filter(|c| !c.trim().is_empty())
                    {
                        freq_stats.confirmation = match freq_stats
                            .confirmation
                            .clone()
                        {
                            Some(existing) if !existing.trim().is_empty() => {
                                Some(format!("{}, {}", existing, confirmation))
                            }
                            _ => Some(confirmation),
                        };
                    }

                    if let Some(radio_station) = item.radio_station.clone() {
                        let mut radio_stations: HashSet<String> = freq_stats
                            .radio_station
                            .as_deref()
                            .unwrap_or("")
                            .split(", ")
                            .map(|s| s.to_string())
                            .collect();
                        radio_stations.insert(radio_station);
                        freq_stats.radio_station = Some(
                            radio_stations
                                .into_iter()
                                .collect::<Vec<_>>()
                                .join(", "),
                        );
                    }

                    freq_stats.message_count += item.message_count;

                    if let Some(first_time) = item.first_time {
                        freq_stats.first_time =
                            Some(match freq_stats.first_time {
                                Some(existing) => existing.min(first_time),
                                None => first_time,
                            });
                    }
                })
                .unwrap_or_else(|| {
                    // Insert new FreqStats
                    acc.get_mut(&key_clone).unwrap().push(FreqStatsRes {
                        name: item.name.clone(),
                        unit: item.unit.clone(),
                        freq: item.freq.clone(),
                        kind: item.kind.clone(),
                        kind_updated: Some(substitute_kind(item.kind.clone())),
                        comment: item.comment.clone(),
                        location: item.location.clone(),
                        radio_station: item.radio_station.clone(),
                        confirmation: item.radio_station.clone(),
                        first_time: item.first_time,
                        message_count: item.message_count,
                    });
                });

            acc
        });

    Ok(res)
}

/// Update empty network `name_updated` field for adjacent frequencies
fn update_freq_network_name(freqs: &mut Vec<FreqStatsRes>, delta: f64) {
    // Sort records by frequency as strings to make sure they are in order
    freqs.sort_by(|a, b| a.freq.cmp(&b.freq));

    let len = freqs.len();
    let mut start = 0; // Window start index

    while start < len {
        let freq_start = freqs[start].freq.parse::<f64>().unwrap_or(0.0);
        let mut end = start;

        // 2. Expand window while the difference is within delta
        while end + 1 < len {
            let freq_next = freqs[end + 1].freq.parse::<f64>().unwrap_or(0.0);
            if (freq_next - freq_start) > delta {
                break;
            }
            end += 1;
        }

        // 3. Find the first non-empty `name_updated` inside this window
        if let Some(valid_name) = (start..=end).find_map(|i| {
            if !freqs[i].name.is_empty() {
                Some(freqs[i].name.clone())
            } else {
                None
            }
        }) {
            // 4. Assign valid `name_updated` to empty fields within the window
            for i in start..=end {
                if freqs[i].name.is_empty() {
                    freqs[i].name = valid_name.clone();
                }
            }
        }

        // 5. Move `start` to the next unprocessed record (end + 1)
        start = end + 1;
    }
}

pub async fn load_freqs(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
    active_freqs_only: bool,
) -> Result<Vec<NetworkFreqsRes>, AppError> {
    trace!(
        "> load freqs for unit: {:?}, network: {:?}",
        filter.filter_unit,
        filter.network_id
    );

    let mut inactive_freqs = Vec::new();
    // Get active frequencies
    let mut network_active_freqs =
        query_active_freqs(db, groups, filter).await.context(h!())?;

    // Get inactive frequencies if needed
    if !active_freqs_only {
        if let Some(network_id) = filter.network_id {
            let active_freqs_short: Vec<String> = network_active_freqs
                .iter()
                .map(|f| f.freq.clone())
                .collect();

            inactive_freqs =
                query_inactive_freqs(db, network_id, &active_freqs_short)
                    .await
                    .context(h!())?;
            network_active_freqs.extend(inactive_freqs.clone());
        }
    }

    let mut network_freqs = network_active_freqs.clone();
    network_freqs.extend(inactive_freqs);

    let mut result = vec![];

    for nf in network_active_freqs.into_iter() {
        result.push(NetworkFreqsRes {
            network_freq_id: nf.network_freq_id,
            freq: nf.freq,
            modulation: nf.modulation,
            message_count: nf.message_count,
            callsigns: nf.callsigns,
            last_datetime: nf.last_datetime,
            created_at: nf.created_at,
            is_active: nf.is_active,
            active_from: nf.active_from,
            active_to: nf.active_to,
        });
    }
    Ok(result)
}

async fn query_active_freqs(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
) -> Result<Vec<NetworkFreqsQueryRes>, AppError> {
    let mut q: SelectStatement = Query::select();
    q.expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)),
        Alias::new("id"),
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
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Callsigns)),
        Alias::new("callsigns"),
    )
    .expr_as(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::CreatedAt)),
        Alias::new("created_at"),
    )
    .expr_as(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveFrom)),
        Alias::new("active_from"),
    )
    .expr_as(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo)),
        Alias::new("active_from"),
    )
    .expr_as(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
        Alias::new("network_freq_id"),
    )
    .expr_as(
        Expr::col((Modulation::Table, Modulation::Name)),
        Alias::new("modulation_name"),
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
    .join(
        JoinType::LeftJoin,
        Modulation::Table,
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ModulationId))
            .equals((Modulation::Table, Modulation::Id)),
    )
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey))
            .is_in(groups),
    )
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo))
            .is_null(),
    )
    .and_where(
        Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
    );

    if let Some(unit) = filter.filter_unit.clone() {
        q.join(
            JoinType::InnerJoin,
            SigintNetworkUnit::Table,
            Expr::col((SigintNetworkUnit::Table, SigintNetworkUnit::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintUnit::Table,
            Expr::col((SigintUnit::Table, SigintUnit::Id))
                .equals((SigintNetworkUnit::Table, SigintNetworkUnit::UnitId)),
        )
        .and_where(
            Expr::col((SigintUnit::Table, SigintUnit::Deleted)).eq(false),
        )
        .and_where(Expr::col((SigintUnit::Table, SigintUnit::Name)).eq(unit));
    }

    if let Some(network_id) = filter.network_id {
        q.and_where(
            Expr::col((SigintNetwork::Table, SigintUnit::Id)).eq(network_id),
        );
    }

    if let Some(date_since) = filter.since_date_inclusive_ms {
        q.and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                .gte(dt_from_millis(date_since)?),
        );
    }
    if let Some(date_till) = filter.till_date_noninclusive_ms {
        q.and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                .lt(dt_from_millis(date_till)?),
        );
    }
    if !filter.full_etalonka_report {
        if let Some(ff) = &filter.filter_freq {
            q.and_where(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
                    .like(format!("%{}%", ff)),
            );
        }
    };

    let network_messages_cte = CommonTableExpression::new()
        .query(q)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    let main_query = SelectStatement::new()
        .expr_as(Expr::cust("network_freq_id"), Alias::new("network_freq_id"))
        .expr_as(Expr::cust("freq"), Alias::new("freq"))
        .expr_as(Expr::cust("created_at"), Alias::new("created_at"))
        .expr_as(Expr::cust("active_from"), Alias::new("active_from"))
        .expr_as(Expr::cust("active_to"), Alias::new("active_to"))
        .expr_as(Expr::cust("modulation_name"), Alias::new("modulation_name"))
        .expr_as(Expr::cust("COUNT(*)"), Alias::new("message_count"))
        .expr_as(Expr::cust("MAX(datetime)"), Alias::new("last_datetime"))
        .expr_as(Expr::cust("jsonb_agg(callsigns)"), Alias::new("callsigns"))
        .from(Alias::new("network_messages"))
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::NetworkFreqId,
        ))
        .into()])
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::Freq,
        ))
        .into()])
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::CreatedAt,
        ))
        .into()])
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::ActiveFrom,
        ))
        .into()])
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::ActiveTo,
        ))
        .into()])
        .add_group_by([Expr::col((
            NetworkMessages::Table,
            NetworkMessages::ModulationName,
        ))
        .into()])
        .order_by_expr(Expr::cust("freq"), Order::Asc)
        .to_owned();

    let combined_query = Query::with()
        .cte(network_messages_cte)
        .clone()
        .query(main_query);

    // debug!(
    //     "> freqs query: {}",
    //     combined_query.to_string(PostgresQueryBuilder)
    // );

    let network_active_freqs: Result<Vec<NetworkFreqsQueryRes>, AppError> = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?
        .iter()
        .map(|row| -> Result<NetworkFreqsQueryRes, AppError> {
            let row_callsigns = row.try_get("", "callsigns").context(h!())?;
            let row_callsigns =
                serde_json::from_value::<Vec<Vec<String>>>(row_callsigns)
                    .context(h!())?;
            let created_at: NaiveDateTime =
                row.try_get("", "created_at").context(h!())?;
            let active_from: NaiveDateTime =
                row.try_get("", "active_from").context(h!())?;
            let active_to: Option<NaiveDateTime> =
                row.try_get("", "active_to").context(h!())?;

            let active_to = active_to.map(|dt| dt.and_utc().timestamp_millis());
            let active_from = active_from.and_utc().timestamp_millis();

            Ok(NetworkFreqsQueryRes {
                network_freq_id: row
                    .try_get("", "network_freq_id")
                    .unwrap_or_default(),
                freq: row.try_get("", "freq").unwrap_or_default(),
                modulation: row.try_get("", "modulation_name").ok(),
                message_count: row.try_get("", "message_count").unwrap_or(0),
                callsigns: (!row_callsigns.is_empty())
                    .then(|| flatten_and_dedup(row_callsigns)),
                last_datetime: row
                    .try_get("", "last_datetime")
                    .map(|dt: NaiveDateTime| dt.and_utc().timestamp_millis())
                    .ok(),
                created_at: created_at.and_utc().timestamp_millis(),
                is_active: true,
                active_from,
                active_to,
            })
        })
        .collect();

    network_active_freqs
}

async fn query_inactive_freqs(
    db: &DatabaseConnection,
    network_id: i64,
    active_freqs_short: &Vec<String>,
) -> Result<Vec<NetworkFreqsQueryRes>, AppError> {
    #[derive(Debug, FromQueryResult)]
    pub struct Res {
        pub active_from: NaiveDateTime,
        pub active_to: Option<NaiveDateTime>,
        pub network_freq_id: i64,
        pub freq: String,
        pub created_at: NaiveDateTime,
        pub modulation_name: Option<String>,
    }

    // println!("> active freqs: {:?}", active_freqs_short);

    let mut inactive_freqs = sigint_network_freq::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::Modulation.def(),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.eq(network_id))
        .select_only()
        .column(sigint_network::Column::ActiveFrom)
        .column(sigint_network::Column::ActiveTo)
        .column_as(sigint_network_freq::Column::Id, "network_freq_id")
        .column_as(sigint_network_freq::Column::Freq, "freq")
        .column_as(sigint_network_freq::Column::CreatedAt, "created_at")
        .column_as(modulation::Column::Name, "modulation_name");

    if !active_freqs_short.is_empty() {
        inactive_freqs = inactive_freqs.filter(
            sigint_network_freq::Column::Freq.is_not_in(active_freqs_short),
        );
    }

    // debug!(
    //     "> inactive_freqs: {}",
    //     inactive_freqs
    //         .clone()
    //         .build(DbBackend::Postgres)
    //         .to_string()
    // );

    let inactive_freqs: Vec<Res> = inactive_freqs
        .into_model::<Res>()
        .all(db)
        .await
        .context(h!())?;

    let network_inactive_freqs: Vec<NetworkFreqsQueryRes> = inactive_freqs
        .into_iter()
        .map(|inactive_freq| {
            let active_to = inactive_freq
                .active_to
                .map(|dt| dt.and_utc().timestamp_millis());
            let active_from =
                inactive_freq.active_from.and_utc().timestamp_millis();

            NetworkFreqsQueryRes {
                network_freq_id: inactive_freq.network_freq_id,
                freq: inactive_freq.freq,
                modulation: inactive_freq.modulation_name,
                message_count: 0,
                callsigns: None,
                last_datetime: None,
                created_at: inactive_freq
                    .created_at
                    .and_utc()
                    .timestamp_millis(),
                is_active: false,
                active_from,
                active_to,
            }
        })
        .collect();

    Ok(network_inactive_freqs)
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
) -> Result<Vec<KnownCallsignRes>, AppError> {
    let q = sigint_callsign::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_callsign::Relation::Source.def(),
            Alias::new("source"),
        )
        .select_only()
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

    trace!(
        "> known callsings sql: {}",
        q.build(DbBackend::Postgres).to_string()
    );

    let res = q
        .into_model::<KnownCallsignRes>()
        .all(db)
        .await
        .context(h!())?;

    Ok(res)
}

pub async fn load_callsigns(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
    known_callsigns: &Vec<KnownCallsignRes>,
    active_callsigns_only: bool,
) -> Result<Vec<CallsignRes>, AppError> {
    trace!(
        "> load_callsigns for unit: {:?}, network: {:?}",
        filter.filter_unit,
        filter.network_id
    );

    let mut date_since = filter.since_date_inclusive_ms;
    let mut date_till = filter.till_date_noninclusive_ms;

    if filter.full_etalonka_report {
        // for full etalonka report take date interval of 20 days from now
        let twenty_days_millis = 20 * 24 * 60 * 60 * 1000;
        date_till = Some(get_unix_timestamp_ms());
        date_since = date_till.map(|till| till - twenty_days_millis);
    };

    let callsigns_lateral_sub_query = Query::select()
        .expr_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            Alias::new("callsign"),
        )
        .to_owned();

    let mut base_subquery_callsigns = Query::select();
    base_subquery_callsigns.expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)),
        Alias::new("freq"),
    )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
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
        );
    base_subquery_callsigns
        .from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
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
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).equals((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::NetworkId,
            )),
        )
        .join(
            JoinType::InnerJoin,
            SigintNetworkUnit::Table,
            Expr::col((SigintNetworkUnit::Table, SigintNetworkUnit::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintUnit::Table,
            Expr::col((SigintUnit::Table, SigintUnit::Id))
                .equals((SigintNetworkUnit::Table, SigintNetworkUnit::UnitId)),
        )
        .join_lateral(
            JoinType::InnerJoin,
            callsigns_lateral_sub_query,
            Alias::new("c"),
            Expr::cust("true"),
        );
    base_subquery_callsigns
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey))
                .is_in(groups),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((SigintUnit::Table, SigintUnit::Deleted)).eq(false),
        );
    if let Some(unit) = filter.filter_unit.clone() {
        base_subquery_callsigns.and_where(
            Expr::col((SigintUnit::Table, SigintUnit::Name)).eq(unit),
        );
    }
    if let Some(network_id) = filter.network_id {
        base_subquery_callsigns.and_where(
            Expr::col((SigintNetwork::Table, SigintUnit::Id)).eq(network_id),
        );
    }

    // debug!(
    //     "> base_subquery_callsigns: {}",
    //     base_subquery_callsigns.to_string(PostgresQueryBuilder)
    // );

    let mut subquery_callsigns = base_subquery_callsigns.clone();
    if let Some(date_since) = date_since {
        subquery_callsigns.and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                .gte(dt_from_millis(date_since)?),
        );
    }
    if let Some(date_till) = date_till {
        subquery_callsigns.and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                .lt(dt_from_millis(date_till)?),
        );
    }
    if !filter.full_etalonka_report {
        if let Some(ff) = filter.filter_freq.clone() {
            subquery_callsigns.and_where(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
                    .like(format!("%{}%", ff)),
            );
        }
    };

    let active_callsigns_query =
        build_callsigns_full_query(subquery_callsigns.clone())
            .await
            .context(h!())?;

    // let q = active_callsigns_query.to_string(PostgresQueryBuilder);
    // debug!("> active callsigns sql: {}", q);

    let mut res: Vec<CallsignRes> = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            active_callsigns_query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?
        .iter()
        .map(|row| {
            let callsign: String =
                row.try_get("", "callsign").unwrap_or_default();
            let unit_id: i64 = row.try_get("", "unit_id").unwrap_or_default();
            let regiment: Option<String> =
                row.try_get("", "regiment").ok().flatten();
            let division: Option<String> =
                row.try_get("", "division").ok().flatten();
            let army: Option<String> = row.try_get("", "army").ok().flatten();
            // Collect all matching known_callsigns based on the same Regiment
            let matched_known_callsigns = known_callsigns
                .iter()
                .filter(|kc| {
                    kc.callsign == callsign
                        && kc.regiment.is_some()
                        && kc.regiment == regiment
                        && kc.division == division
                        && kc.army == army
                })
                .cloned()
                .collect::<Vec<KnownCallsignRes>>();

            // If no match found, fallback to Callsign + UnitId matching when Regiment is empty
            let matched_known_callsigns = if matched_known_callsigns.is_empty()
            {
                known_callsigns
                    .iter()
                    .filter(|kc| {
                        kc.callsign == callsign
                            && kc.regiment.is_none()
                            && kc.unit_id == unit_id
                    })
                    .cloned()
                    .collect()
            } else {
                matched_known_callsigns
            };

            let short_known_callsigns: Vec<KnownCallsignShortRes> =
                matched_known_callsigns
                    .into_iter()
                    .map(|kc| KnownCallsignShortRes {
                        callsign: kc.callsign,
                        position: kc.position,
                        comment: kc.comment,
                        unit_id: kc.unit_id,
                        unit_name: kc.unit_name,
                        source_name: kc.source_name,
                        created_at: kc.created_at.and_utc().timestamp_millis(),
                    })
                    .collect();

            let freqs_list = row
                .try_get::<String>("", "freqs")
                .ok()
                .unwrap_or_default()
                .split(", ")
                .map(|s| s.to_string())
                .collect::<Vec<String>>();

            let network_names_list = row
                .try_get::<String>("", "network_names")
                .ok()
                .unwrap_or_default()
                .split(", ")
                .map(|s| s.to_string())
                .collect::<Vec<String>>();

            CallsignRes {
                callsign: callsign.clone(),
                known_callsigns: (!short_known_callsigns.is_empty())
                    .then(|| short_known_callsigns),
                message_count: row.try_get("", "message_count").unwrap_or(0),
                last_datetime: row
                    .try_get::<NaiveDateTime>("", "last_datetime")
                    .ok()
                    .map(|ndt| ndt.and_utc().timestamp_millis()),
                freqs: (!freqs_list.is_empty()).then(|| freqs_list),
                network_names: (!network_names_list.is_empty())
                    .then(|| network_names_list),
                is_old: false,
            }
        })
        .collect();

    res = filter_callsigns(res);

    // **Step 2: Add missing records from known_callsigns**
    if !active_callsigns_only {
        if let Some(unit) = filter.filter_unit.clone() {
            let existing_callsigns: HashSet<String> =
                res.iter().map(|r| r.callsign.clone()).collect();

            let mut additional_callsigns: Vec<CallsignRes> = known_callsigns
                .iter()
                .filter(|kc| {
                    kc.unit_name == unit
                        && !existing_callsigns.contains(&kc.callsign)
                })
                .map(|kc| CallsignRes {
                    callsign: kc.callsign.clone(),
                    known_callsigns: Some(vec![KnownCallsignShortRes {
                        callsign: kc.callsign.clone(),
                        position: kc.position.clone(),
                        comment: kc.comment.clone(),
                        unit_id: kc.unit_id.clone(),
                        unit_name: kc.unit_name.clone(),
                        source_name: kc.source_name.clone(),
                        created_at: kc.created_at.and_utc().timestamp_millis(),
                    }]),
                    message_count: 0,
                    last_datetime: None,
                    freqs: None,
                    network_names: None,
                    is_old: false,
                })
                .collect();

            // find old (for 60 days) communications for additional callsigns
            let sixty_days_millis = 60 * 24 * 60 * 60 * 1000;

            let old_date_range = date_till.map(|till_date| {
                let since_date = till_date - sixty_days_millis;
                (since_date, till_date)
            });

            let mut subquery_old_additional_callsigns = base_subquery_callsigns;

            if let Some((since_date, till_date)) = old_date_range {
                let from_expr = dt_from_millis(since_date)?;
                let to_expr = dt_from_millis(till_date)?;

                subquery_old_additional_callsigns
                    .and_where(
                        Expr::col((
                            SigintInboxItem::Table,
                            SigintInboxItem::Datetime,
                        ))
                        .gte(from_expr),
                    )
                    .and_where(
                        Expr::col((
                            SigintInboxItem::Table,
                            SigintInboxItem::Datetime,
                        ))
                        .lt(to_expr),
                    );
            }

            subquery_old_additional_callsigns.and_where(
                Expr::expr(SimpleExpr::Custom("c.callsign".to_string())).is_in(
                    additional_callsigns
                        .iter()
                        .map(|c| c.callsign.clone())
                        .collect::<Vec<String>>(),
                ),
            );

            let additional_callsigns_old_communications_query =
                build_callsigns_full_query(
                    subquery_old_additional_callsigns.clone(),
                )
                .await
                .context(h!())?;

            // let q = additional_callsigns_old_communications_query
            //     .to_string(PostgresQueryBuilder);
            // debug!("> old additional callsigns sql: {}", q);

            let additional_callsigns_old_communications: HashMap<
                String,
                (Option<i64>, Option<String>, Option<String>),
            > = db
                .query_all(Statement::from_string(
                    DatabaseBackend::Postgres,
                    additional_callsigns_old_communications_query
                        .to_string(PostgresQueryBuilder),
                ))
                .await
                .context(h!())?
                .into_iter()
                .map(|row| {
                    let callsign: String =
                        row.try_get("", "callsign").unwrap_or_default();
                    let last_datetime: Option<i64> = row
                        .try_get::<NaiveDateTime>("", "last_datetime")
                        .ok()
                        .map(|ndt| ndt.and_utc().timestamp_millis());
                    let freqs: Option<String> = row.try_get("", "freqs").ok();
                    let network_names: Option<String> =
                        row.try_get("", "network_names").ok();

                    (callsign, (last_datetime, freqs, network_names))
                })
                .collect();

            for c1 in &mut additional_callsigns {
                if let Some((last_datetime, freqs, network_names)) =
                    additional_callsigns_old_communications.get(&c1.callsign)
                {
                    let freqs_list = freqs
                        .as_deref()
                        .map(|s| s.split(", ").map(|s| s.to_string()).collect())
                        .unwrap_or_else(Vec::new);

                    let network_names_list = network_names
                        .as_deref()
                        .map(|s| s.split(", ").map(|s| s.to_string()).collect())
                        .unwrap_or_else(Vec::new);

                    c1.last_datetime = last_datetime.clone();
                    c1.freqs = (!freqs_list.is_empty()).then(|| freqs_list);
                    c1.network_names = (!network_names_list.is_empty())
                        .then(|| network_names_list);
                    c1.is_old = true;
                }
            }

            // Append missing known callsigns to result
            res.extend(additional_callsigns);
        }
    }

    res.sort_by(|a, b| match (&a.known_callsigns, &b.known_callsigns) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => a.callsign.cmp(&b.callsign),
    });

    Ok(res)
}

async fn build_callsigns_full_query(
    callsigns_filtered: SelectStatement,
) -> Result<WithQuery, AppError> {
    let callsigns_cte = CommonTableExpression::new()
        .query(callsigns_filtered)
        .table_name(Alias::new("callsigns"))
        .to_owned();

    let unique_callsigns = Query::select()
        .expr_as(Expr::cust("DISTINCT callsign"), Alias::new("callsign"))
        .expr_as(Expr::cust("unit_id"), Alias::new("unit_id"))
        .expr_as(Expr::cust("unit_name"), Alias::new("unit_name"))
        .expr_as(Expr::cust("regiment"), Alias::new("regiment"))
        .expr_as(Expr::cust("division"), Alias::new("division"))
        .expr_as(Expr::cust("army"), Alias::new("army"))
        .from(Alias::new("callsigns"))
        .to_owned();

    let unique_callsigns_cte = CommonTableExpression::new()
        .query(unique_callsigns)
        .table_name(Alias::new("unique_callsigns"))
        .to_owned();

    let main_query: sea_query::SelectStatement = Query::select()
        .expr_as(Expr::cust("callsign"), Alias::new("callsign"))
        .expr_as(Expr::cust("null"), Alias::new("position"))
        .expr_as(Expr::cust("null"), Alias::new("comment"))
        .expr_as(
            Expr::cust(
                "(SELECT datetime FROM callsigns c WHERE c.callsign = unique_callsigns.callsign ORDER BY datetime DESC LIMIT 1)"
            ),
            Alias::new("last_datetime"),
        )
        .expr_as(
            Expr::cust(
                "(SELECT string_agg(t.freq, ', ') FROM (SELECT DISTINCT c.freq FROM callsigns c WHERE c.callsign = unique_callsigns.callsign) t)"
            ),
            Alias::new("freqs"),
        )
        .expr_as(
            Expr::cust(
                "(SELECT string_agg(t.network_name, ', ') FROM (SELECT DISTINCT c.network_name FROM callsigns c WHERE c.callsign = unique_callsigns.callsign) t)"
            ),
            Alias::new("network_names"),
        )
        .expr_as(
            Expr::cust(
                "(SELECT COUNT(*) FROM callsigns c WHERE c.callsign = unique_callsigns.callsign)"
            ),
            Alias::new("message_count"),
        )
        .expr_as(Expr::cust("unit_id"), Alias::new("unit_id"))
        .expr_as(Expr::cust("unit_name"), Alias::new("unit_name"))
        .expr_as(Expr::cust("regiment"), Alias::new("regiment"))
        .expr_as(Expr::cust("division"), Alias::new("division"))
        .expr_as(Expr::cust("army"), Alias::new("army"))
        .from(Alias::new("unique_callsigns"))
        .order_by_expr(Expr::cust("callsign"), Order::Asc)
        .to_owned();

    let combined_query = Query::with()
        .cte(callsigns_cte)
        .cte(unique_callsigns_cte)
        .clone()
        .query(main_query);

    Ok(combined_query)
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
        .filter(sigint_network::Column::Deleted.eq(false))
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
            network_id: network_id,
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

pub async fn load_unregistred_networks(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    req: &Json<EtalonkaReq>,
) -> Result<Vec<UnregistredNetworksRes>, AppError> {
    let sub_query = Query::select()
        .expr_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            Alias::new("callsign"),
        )
        .to_owned();

    let mut q = Query::select();
    q.expr_as(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)),
        Alias::new("freq"),
    )
    .expr_as(
        Expr::cust("COUNT(DISTINCT signal_message.id)"),
        Alias::new("message_count"),
    )
    .expr_as(
        Expr::cust("STRING_AGG(DISTINCT c.callsign, ', ')"),
        Alias::new("callsigns"),
    )
    .expr_as(
        Expr::cust("STRING_AGG(DISTINCT sigint_inbox_item.location_v2, '')"),
        Alias::new("locations"),
    );
    q.from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::LeftJoin,
            SigintNetworkFreq::Table,
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq))
                .equals((SigintInboxItem::Table, SigintInboxItem::Freq)),
        )
        .join(
            JoinType::LeftJoin,
            SigintNetwork::Table,
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)).equals((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::NetworkId,
            )),
        )
        .join_lateral(
            JoinType::InnerJoin,
            sub_query,
            Alias::new("c"),
            Expr::cust("true"),
        );

    let mut date_sinse = req.list_freq_req.since_date_inclusive_ms;
    let mut date_till = req.list_freq_req.till_date_noninclusive_ms;
    if req.full_etalonka_report {
        // for full etalonka report took date interval in 20 days from now
        let twenty_days_millis = 20 * 24 * 60 * 60 * 1000;
        date_till = get_unix_timestamp_ms();
        date_sinse = date_till - twenty_days_millis;
    };

    q.and_where(
        Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey))
            .is_in(groups),
    )
    .and_where(
        Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
    )
    .and_where(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
            .gte(dt_from_millis(date_sinse)?),
    )
    .and_where(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
            .lt(dt_from_millis(date_till)?),
    )
    .and_where(Expr::col((SigintNetwork::Table, SigintNetwork::Id)).is_null())
    .and_where(
        Expr::cust("coalesce(sigint_network.deleted, false) = false"), // Custom filter for deleted column
    )
    .and_where(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
            .is_not_null(),
    )
    .add_group_by([
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into()
    ])
    .order_by_expr(
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into(),
        Order::Asc,
    );

    // debug!(
    //     "> unregistred networks sql: {}",
    //     q.to_string(PostgresQueryBuilder)
    // );

    let res: Vec<UnregistredNetworksRes> = db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            q.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?
        .iter()
        .map(|row| {
            let mut locations = BTreeSet::new();
            if let Some(location_v2) =
                row.try_get("", "locations").unwrap_or(None)
            {
                locations.extend(to_location_list(&location_v2));
            }
            UnregistredNetworksRes {
                freq: row.try_get("", "freq").unwrap_or_default(),
                message_count: row
                    .try_get("", "message_count")
                    .unwrap_or_default(),
                callsigns: row.try_get("", "callsigns").unwrap_or_default(),
                locations: Some(
                    locations.into_iter().collect::<Vec<String>>().join(", "),
                ),
            }
        })
        .collect();

    Ok(res)
}

pub async fn load_pelengs_map(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
) -> Result<Option<Vec<u8>>, AppError> {
    let mut date_since = filter.since_date_inclusive_ms;
    let mut date_till = filter.till_date_noninclusive_ms;
    if filter.full_etalonka_report {
        // for full etalonka report took date interval in 20 days from now
        let twenty_days_millis = 20 * 24 * 60 * 60 * 1000;
        date_till = Some(get_unix_timestamp_ms());
        date_since = date_till.map(|till| till - twenty_days_millis);
    };

    let mut query = signal_message::Entity::find()
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
        .filter(signal_message::Column::GroupMasterKey.is_in(groups))
        .filter(sigint_inbox_item::Column::Coords.is_not_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_peleng::Column::Deleted.eq(false));

    if let Some(unit) = filter.filter_unit.clone() {
        query = query
            .join(
                JoinType::InnerJoin,
                sigint_network::Relation::SigintNetworkUnit.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_network_unit::Relation::SigintUnit.def(),
            )
            .filter(sigint_unit::Column::Deleted.eq(false))
            .filter(sigint_unit::Column::Name.eq(unit));
    }

    if let Some(network_id) = filter.network_id {
        query = query.filter(sigint_network::Column::Id.eq(network_id));
    }

    if !filter.full_etalonka_report {
        if let Some(ff) = filter.filter_freq.clone() {
            query = query.filter(
                sigint_inbox_item::Column::Freq.like(format!("%{}%", ff)),
            );
        }
    };

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
        .arg(format!("{}", json_string))
        .arg("--delay")
        .arg(format!("{}", SCREENSHOT_DELAY_MILLIS))
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
                error!("Failed to open temp file {}: {e:#?}", temp_file_name);
                e
            })
            .context(format!("{}", temp_file_name))
            .context(h!())?;
        let mut stream = ReaderStream::new(file);

        while let Some(chunk) = stream.try_next().await.context(h!())? {
            buffer.extend_from_slice(&chunk);
        }
    } else {
        debug!(
            "geo-screenshot failed. Exit code: {:?}. Stdout: {}. Stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        return Err(AppError::BL {
            msg: format!(
                "Cannot create temp file for a map screenshot. Exit code: {:?}",
                output.status.code()
            ),
        });
    }

    Ok(buffer)
}

pub async fn load_networks(
    db: &DatabaseConnection,
    groups: Vec<String>,
    req: &Json<EtalonkaJimForksReq>,
) -> Result<HashMap<String, Vec<NetworkEtalonkaRes>>, AppError> {
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
                            and snf.deleted = false)"#.to_string()),
            "freqs",
        )
        .column(sigint_network::Column::OperationMode)
        .column(sigint_network::Column::OperationType)
        .column(sigint_network::Column::OperationPeriod)
        .column(sigint_network::Column::Comment)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column(sigint_network::Column::ActiveFrom)
        .column(sigint_network::Column::ActiveTo)
        .filter(sigint_network::Column::Deleted.eq(false));

    if let Some(filter_unit) = &req.filter_unit {
        networks = networks.filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![format!("%{}%", filter_unit.to_lowercase())],
        ))
    };

    if req.filter_freq.is_some()
        || req.since_date_inclusive_ms.is_some()
        || req.till_date_noninclusive_ms.is_some()
    {
        let mut subquery = signal_message::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintNetworkFreq.def(),
            )
            .select_only()
            .column(signal_message::Column::Id)
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(signal_message::Column::GroupMasterKey.is_in(groups))
            .filter(sigint_network_freq::Column::ActiveTo.is_null())
            .filter(
                sigint_network_freq::Column::NetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            );

        if let Some(filter_freq) = &req.filter_freq {
            subquery = subquery
                .filter(sigint_network_freq::Column::Freq.eq(filter_freq));
        }
        if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
            subquery = subquery.filter(
                sigint_inbox_item::Column::Datetime
                    .gte(dt_from_millis(since_date_inclusive_ms)?),
            );
        }
        if let Some(till_date_inclusive_ms) = req.till_date_noninclusive_ms {
            subquery = subquery.filter(
                sigint_inbox_item::Column::Datetime
                    .lte(dt_from_millis(till_date_inclusive_ms)?),
            );
        }
        networks = networks.filter(Expr::exists(subquery.into_query()));
    }

    networks = if let Some(sort_by) = &req.sort_by {
        sort_by
            .iter()
            .fold(networks, |networks, sort_by| match sort_by {
                EtalonkaJimForksSortBy::NetworkNameAsc => {
                    networks.order_by_asc(sigint_network::Column::Name)
                }
                EtalonkaJimForksSortBy::NetworkNameDesc => {
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
        .into_model::<NetworkEtalonkaRes>()
        .all(db)
        .await
        .context(h!())?;

    let mut res: HashMap<String, Vec<NetworkEtalonkaRes>> = HashMap::new();
    for network in networks {
        res.entry(network.unit_name.clone())
            .or_insert_with(Vec::new)
            .push(network);
    }

    Ok(res)
}

pub async fn get_network_active_freqs(
    db: &DatabaseConnection,
    groups: &Vec<String>,
    filter: &EtalonkaFilter,
) -> Result<Vec<String>, AppError> {
    let mut freqs = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .distinct()
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::GroupMasterKey.is_in(groups))
        .filter(sigint_network_freq::Column::ActiveTo.is_null());

    if let Some(network_id) = filter.network_id {
        freqs =
            freqs.filter(sigint_network_freq::Column::NetworkId.eq(network_id));
    }

    if let Some(freq) = &filter.filter_freq {
        freqs = freqs.filter(sigint_network_freq::Column::Freq.eq(freq));
    }
    if let Some(since_date_inclusive_ms) = filter.since_date_inclusive_ms {
        freqs = freqs.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since_date_inclusive_ms)?),
        );
    }
    if let Some(till_date_inclusive_ms) = filter.till_date_noninclusive_ms {
        freqs = freqs.filter(
            sigint_inbox_item::Column::Datetime
                .lte(dt_from_millis(till_date_inclusive_ms)?),
        );
    }

    // debug!(
    //     "> sql active freqs: {}",
    //     freqs.clone().build(DbBackend::Postgres).to_string()
    // );

    let freqs = freqs.into_tuple::<String>().all(db).await.context(h!())?;

    Ok(freqs)
}

fn get_unix_timestamp_ms() -> i64 {
    let now = Utc::now();
    now.timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_freq_network_name_01() {
        let mut freqs = vec![
            FreqStatsRes {
                freq: "456.1203".to_string(),
                name: "УКХ М1".to_string(),
                ..Default::default()
            },
            FreqStatsRes {
                freq: "146.5500".to_string(),
                name: "УКХ М2".to_string(),
                ..Default::default()
            },
            FreqStatsRes {
                freq: "456.1290".to_string(),
                name: "УКХ М12".to_string(),
                ..Default::default()
            },
            FreqStatsRes {
                freq: "140.5500".to_string(),
                name: "УКХ М3".to_string(),
                ..Default::default()
            },
            FreqStatsRes {
                freq: "456.1245".to_string(),
                name: "".to_string(),
                ..Default::default()
            },
        ];

        let delta = 0.005;
        update_freq_network_name(&mut freqs, delta);

        assert_eq!(freqs[0].name, "УКХ М3");
        assert_eq!(freqs[1].name, "УКХ М2");
        assert_eq!(freqs[2].name, "УКХ М1");
        assert_eq!(freqs[3].name, "УКХ М1");
        assert_eq!(freqs[4].name, "УКХ М12");
    }
}
