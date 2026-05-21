use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::entities::*;
use crate::error::AppError;
use crate::sigint::callsign::bl_network_callsign::bl_get_network_callsigns_list;
use crate::sigint::callsign::types::ListNetworkCallsignsReq;
use crate::sigint::network::types::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::{DateTime, NaiveDateTime, Utc};
use sea_orm::sea_query::*;
use sea_orm::*;
use sea_query::Expr;
use sea_query::ExprTrait;

#[derive(Debug, FromQueryResult)]
struct NetworkCallsignRelationMessageRow {
    message_id: i64,
    timestamp: Option<NaiveDateTime>,
    freq: Option<String>,
    text: String,
    callsign: String,
}

#[derive(Debug, FromQueryResult)]
struct CatalogCallsignRow {
    id: i64,
    callsign: String,
    position: Option<String>,
    unit_name: Option<String>,
}

#[derive(Debug, Clone)]
struct RelationMessage {
    id: i64,
    timestamp: Option<i64>,
    freq: Option<String>,
    text: String,
    callsigns: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct NodeEnrichment {
    position: Option<String>,
    unit_name: Option<String>,
    known_callsign_id: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct EdgeAggregation {
    weight: i64,
    by_freq: BTreeMap<String, EdgeFreqAggregation>,
}

#[derive(Debug, Clone, Default)]
struct EdgeFreqAggregation {
    weight: i64,
}

#[post("/api/sigint/network-callsigns/relations")]
pub async fn network_callsigns_relations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignRelationsReq>,
) -> Result<Json<NetworkCallsignRelationsRsp>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "ApiAgent"])
        .await
        .c(h!())?;

    let req = req.into_inner();
    let network_id = req.network_id;
    let since_date_inclusive_ms = req.since_date_inclusive_ms;
    let till_date_noninclusive_ms = req.till_date_noninclusive_ms;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let messages = load_network_relation_messages(
        &env.dbx,
        network_id,
        &groups,
        since_date_inclusive_ms,
        till_date_noninclusive_ms,
    )
    .await
    .context(h!())?;
    let network_callsigns =
        load_network_callsigns(&env.dbx, network_id, &user_id)
            .await
            .context(h!())?;
    let node_ids = messages
        .iter()
        .flat_map(|message| message.callsigns.iter().cloned())
        .collect::<BTreeSet<_>>();
    let catalog_callsigns = load_catalog_callsigns(&env.dbx, &node_ids)
        .await
        .context(h!())?;

    let rsp = aggregate_network_callsign_relations(
        messages,
        &network_callsigns,
        &catalog_callsigns,
    );

    Ok(Json(rsp))
}

async fn load_network_relation_messages(
    dbx: &DatabaseConnection,
    network_id: i64,
    groups: &[String],
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
) -> Result<Vec<RelationMessage>, AppError> {
    let mut query = signal_message::Entity::find()
        .select_only()
        .column_as(signal_message::Column::Id, "message_id")
        .column_as(sigint_inbox_item::Column::Datetime, "timestamp")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(Expr::cust("coalesce(signal_message.body, '')"), "text")
        .column_as(
            Expr::cust(
                "jsonb_array_elements_text(coalesce(sigint_inbox_item.callsigns, '[]'::jsonb))",
            ),
            "callsign",
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Id.eq(network_id))
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups.to_vec()));

    query = query.filter(
        sigint_inbox_item::Column::Datetime
            .gte(dt_from_millis(since_date_inclusive_ms)?),
    );
    query = query.filter(
        sigint_inbox_item::Column::Datetime
            .lt(dt_from_millis(till_date_noninclusive_ms)?),
    );

    let rows = query
        .into_model::<NetworkCallsignRelationMessageRow>()
        .all(dbx)
        .await
        .context(h!())?;

    Ok(aggregate_relation_messages(rows))
}

async fn load_network_callsigns(
    dbx: &DatabaseConnection,
    network_id: i64,
    user_id: &str,
) -> Result<HashMap<String, NodeEnrichment>, AppError> {
    let network_callsigns = bl_get_network_callsigns_list(
        &ListNetworkCallsignsReq {
            network_id,
            sort_by: None,
        },
        user_id,
        dbx,
    )
    .await
    .context(h!())?;

    let mut result = HashMap::new();
    for network_callsign in network_callsigns {
        let callsign = normalize_callsign(&network_callsign.callsign);
        if callsign.is_empty() {
            continue;
        }
        result.insert(
            callsign,
            NodeEnrichment {
                position: network_callsign.position.clone(),
                unit_name: network_callsign.unit_name.clone(),
                known_callsign_id: network_callsign.known_callsign_id,
            },
        );
    }

    Ok(result)
}

async fn load_catalog_callsigns(
    dbx: &DatabaseConnection,
    callsigns: &BTreeSet<String>,
) -> Result<HashMap<String, NodeEnrichment>, AppError> {
    if callsigns.is_empty() {
        return Ok(HashMap::new());
    }

    let lower_callsigns = callsigns
        .iter()
        .map(|callsign| callsign.to_lowercase())
        .collect::<Vec<_>>();
    let rows = sigint_callsign::Entity::find()
        .select_only()
        .column_as(sigint_callsign::Column::Id, "id")
        .column_as(sigint_callsign::Column::Callsign, "callsign")
        .column_as(sigint_callsign::Column::Position, "position")
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Name)),
            "unit_name",
        )
        .join(
            JoinType::LeftJoin,
            sigint_callsign::Relation::SigintUnit.def(),
        )
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .filter(
            Expr::cust("lower(sigint_callsign.callsign)")
                .is_in(lower_callsigns.clone()),
        )
        .into_model::<CatalogCallsignRow>()
        .all(dbx)
        .await
        .context(h!())?;

    let mut result = HashMap::new();
    for row in rows {
        let callsign = normalize_callsign(&row.callsign);
        if callsign.is_empty() {
            continue;
        }
        result.insert(
            callsign,
            NodeEnrichment {
                position: row.position.clone(),
                unit_name: row.unit_name.clone(),
                known_callsign_id: Some(row.id),
            },
        );
    }

    Ok(result)
}

fn aggregate_relation_messages(
    rows: Vec<NetworkCallsignRelationMessageRow>,
) -> Vec<RelationMessage> {
    let mut messages_by_id: HashMap<i64, RelationMessage> = HashMap::new();
    let mut seen_callsigns_by_id: HashMap<i64, HashSet<String>> =
        HashMap::new();

    for row in rows {
        let callsign = normalize_callsign(&row.callsign);
        if callsign.is_empty() {
            continue;
        }

        let message =
            messages_by_id.entry(row.message_id).or_insert_with(|| {
                RelationMessage {
                    id: row.message_id,
                    timestamp: row.timestamp.map(|timestamp| {
                        timestamp.and_utc().timestamp_millis()
                    }),
                    freq: row.freq.clone(),
                    text: row.text.trim().to_string(),
                    callsigns: Vec::new(),
                }
            });

        if message.text.is_empty() {
            message.text = row.text.trim().to_string();
        }
        if message.freq.is_none() {
            message.freq = row.freq.clone();
        }
        if message.timestamp.is_none() {
            message.timestamp = row
                .timestamp
                .map(|timestamp| timestamp.and_utc().timestamp_millis());
        }

        let seen_callsigns =
            seen_callsigns_by_id.entry(row.message_id).or_default();
        if seen_callsigns.insert(callsign.clone()) {
            message.callsigns.push(callsign);
        }
    }

    let mut messages = messages_by_id.into_values().collect::<Vec<_>>();
    for message in &mut messages {
        message.callsigns.sort();
    }
    messages.sort_by(|left, right| {
        right
            .timestamp
            .unwrap_or_default()
            .cmp(&left.timestamp.unwrap_or_default())
            .then_with(|| right.id.cmp(&left.id))
    });
    messages
}

fn aggregate_network_callsign_relations(
    messages: Vec<RelationMessage>,
    network_callsigns: &HashMap<String, NodeEnrichment>,
    catalog_callsigns: &HashMap<String, NodeEnrichment>,
) -> NetworkCallsignRelationsRsp {
    let mut node_stats: HashMap<String, NodeStats> = HashMap::new();
    let mut edge_stats: HashMap<(String, String), EdgeAggregation> =
        HashMap::new();
    let mut freq_weights: HashMap<String, i64> = HashMap::new();

    for message in messages {
        let callsigns = message
            .callsigns
            .iter()
            .map(|callsign| normalize_callsign(callsign))
            .filter(|callsign| !callsign.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if callsigns.is_empty() {
            continue;
        }

        for callsign in &callsigns {
            node_stats
                .entry(callsign.clone())
                .or_default()
                .activity_count += 1;
        }

        if callsigns.len() < 2 {
            continue;
        }

        if let Some(freq) = message
            .freq
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            *freq_weights.entry(freq.clone()).or_insert(0) += 1;

            for left_index in 0..callsigns.len() {
                for right_index in (left_index + 1)..callsigns.len() {
                    let source = callsigns[left_index].clone();
                    let target = callsigns[right_index].clone();
                    let (source, target) = ordered_pair(source, target);
                    let edge = edge_stats
                        .entry((source.clone(), target.clone()))
                        .or_default();
                    edge.weight += 1;
                    let entry = edge.by_freq.entry(freq.clone()).or_default();
                    entry.weight += 1;
                }
            }
        } else {
            for left_index in 0..callsigns.len() {
                for right_index in (left_index + 1)..callsigns.len() {
                    let source = callsigns[left_index].clone();
                    let target = callsigns[right_index].clone();
                    let (source, target) = ordered_pair(source, target);
                    let edge = edge_stats
                        .entry((source.clone(), target.clone()))
                        .or_default();
                    edge.weight += 1;
                }
            }
        }
    }

    let mut nodes = node_stats
        .into_iter()
        .map(|(id, stats)| {
            let enrichment = network_callsigns
                .get(&id)
                .or_else(|| catalog_callsigns.get(&id))
                .cloned()
                .unwrap_or_default();
            NetworkCallsignRelationNode {
                id: id.clone(),
                label: id,
                weight: stats.activity_count,
                relation_count: 0,
                activity_count: stats.activity_count,
                position: enrichment.position,
                unit_name: enrichment.unit_name,
                known_callsign_id: enrichment.known_callsign_id,
            }
        })
        .collect::<Vec<_>>();

    let mut relation_counts: HashMap<String, HashSet<String>> = HashMap::new();
    for (source, target) in edge_stats.keys() {
        relation_counts
            .entry(source.clone())
            .or_default()
            .insert(target.clone());
        relation_counts
            .entry(target.clone())
            .or_default()
            .insert(source.clone());
    }
    for node in &mut nodes {
        node.relation_count = relation_counts
            .get(&node.id)
            .map_or(0, |values| values.len() as i64);
        node.weight = node.activity_count;
    }
    nodes.sort_by(|left, right| {
        right
            .weight
            .cmp(&left.weight)
            .then_with(|| left.label.cmp(&right.label))
    });

    let mut edges = edge_stats
        .into_iter()
        .map(|((source, target), edge)| {
            let mut by_freq = edge
                .by_freq
                .into_iter()
                .map(|(freq, freq_stats)| NetworkCallsignRelationEdgeFreq {
                    freq,
                    weight: freq_stats.weight,
                })
                .collect::<Vec<_>>();
            by_freq.sort_by(|left, right| {
                right
                    .weight
                    .cmp(&left.weight)
                    .then_with(|| left.freq.cmp(&right.freq))
            });
            NetworkCallsignRelationEdge {
                id: edge_id(&source, &target),
                source,
                target,
                weight: edge.weight,
                by_freq,
            }
        })
        .collect::<Vec<_>>();

    edges.sort_by(|left, right| {
        right
            .weight
            .cmp(&left.weight)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut freq_entries = freq_weights.into_iter().collect::<Vec<_>>();
    freq_entries.sort_by(|left, right| {
        right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0))
    });
    let freqs = freq_entries
        .into_iter()
        .map(|(freq, _weight)| NetworkCallsignRelationFreq {
            freq,
            enabled_by_default: true,
        })
        .collect::<Vec<_>>();

    NetworkCallsignRelationsRsp {
        nodes,
        edges,
        freqs,
    }
}

#[derive(Debug, Default)]
struct NodeStats {
    activity_count: i64,
}

fn ordered_pair(left: String, right: String) -> (String, String) {
    if left <= right {
        (left, right)
    } else {
        (right, left)
    }
}

fn edge_id(source: &str, target: &str) -> String {
    format!("{source}__{target}")
}

fn normalize_callsign(value: &str) -> String {
    value.trim().to_uppercase()
}

fn dt_from_millis(millis: i64) -> Result<NaiveDateTime, AppError> {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|datetime| datetime.naive_utc())
        .ok_or_else(|| {
            anyhow::anyhow!("invalid timestamp millis {millis}").into()
        })
}

#[cfg(test)]
fn relation_message_for_test(
    id: i64,
    timestamp: i64,
    freq: Option<&str>,
    text: &str,
    callsigns: &[&str],
) -> RelationMessage {
    RelationMessage {
        id,
        timestamp: Some(timestamp),
        freq: freq.map(|freq| freq.to_string()),
        text: text.to_string(),
        callsigns: callsigns
            .iter()
            .map(|callsign| (*callsign).to_string())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_relations_counts_edges_and_frequencies() {
        let messages = vec![
            relation_message_for_test(
                1,
                1000,
                Some("652.111"),
                "one",
                &["alpha", "beta", "alpha"],
            ),
            relation_message_for_test(
                2,
                2000,
                Some("652.111"),
                "two",
                &["alpha", "gamma"],
            ),
            relation_message_for_test(
                3,
                3000,
                Some("852.111"),
                "three",
                &["beta", "gamma"],
            ),
        ];
        let graph = aggregate_network_callsign_relations(
            messages,
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 3);
        assert_eq!(graph.freqs.len(), 2);

        let alpha = graph.nodes.iter().find(|node| node.id == "ALPHA").unwrap();
        assert_eq!(alpha.activity_count, 2);
        assert_eq!(alpha.relation_count, 2);

        let edge = graph
            .edges
            .iter()
            .find(|edge| edge.id == "ALPHA__BETA")
            .unwrap();
        assert_eq!(edge.weight, 1);
        assert_eq!(edge.by_freq[0].freq, "652.111");
    }

    #[test]
    fn aggregate_relations_prefers_network_enrichment_over_catalog() {
        let messages = vec![relation_message_for_test(
            1,
            1000,
            Some("652.111"),
            "one",
            &["alpha", "beta"],
        )];
        let mut network_callsigns = HashMap::new();
        network_callsigns.insert(
            "ALPHA".to_string(),
            NodeEnrichment {
                position: Some("КР".to_string()),
                unit_name: Some("1 мб".to_string()),
                known_callsign_id: Some(12),
            },
        );
        let mut catalog_callsigns = HashMap::new();
        catalog_callsigns.insert(
            "ALPHA".to_string(),
            NodeEnrichment {
                position: Some("КП".to_string()),
                unit_name: Some("2 мб".to_string()),
                known_callsign_id: Some(99),
            },
        );

        let graph = aggregate_network_callsign_relations(
            messages,
            &network_callsigns,
            &catalog_callsigns,
        );
        let alpha = graph.nodes.iter().find(|node| node.id == "ALPHA").unwrap();
        assert_eq!(alpha.position.as_deref(), Some("КР"));
        assert_eq!(alpha.unit_name.as_deref(), Some("1 мб"));
        assert_eq!(alpha.known_callsign_id, Some(12));
    }
}
