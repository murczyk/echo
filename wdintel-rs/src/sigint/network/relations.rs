use crate::users::{has_any_role, login_id_from_identity};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::entities::*;
use crate::error::AppError;
use crate::sigint::callsign::bl_network_callsign::bl_get_network_callsigns_list;
use crate::sigint::callsign::types::ListNetworkCallsignsReq;
use crate::sigint::network::types::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
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
    unit_id: i64,
    unit_name: Option<String>,
    army: String,
    division: String,
    regiment: String,
    battalion: String,
    company: String,
}

#[derive(Debug, Clone, Default)]
struct NodeEnrichment {
    position: Option<String>,
    unit_name: Option<String>,
    known_callsign_id: Option<i64>,
    main_radio_station: bool,
    command_control: bool,
    source: NetworkCallsignRelationEnrichmentSource,
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

#[derive(Debug, Clone)]
struct UnitScope {
    unit_id: Option<i64>,
    unit_name: String,
    army: String,
    division: String,
    regiment: String,
    battalion: String,
    company: String,
}

impl UnitScope {
    fn from_unit(unit: &sigint_unit::Model) -> Self {
        Self {
            unit_id: Some(unit.id),
            unit_name: normalize_unit_part(&unit.name),
            army: normalize_unit_part(&unit.army),
            division: normalize_unit_part(&unit.division),
            regiment: normalize_unit_part(&unit.regiment),
            battalion: normalize_unit_part(&unit.battalion),
            company: normalize_unit_part(&unit.company),
        }
    }

    fn from_catalog_row(row: &CatalogCallsignRow) -> Self {
        Self {
            unit_id: Some(row.unit_id),
            unit_name: row
                .unit_name
                .as_deref()
                .map(normalize_unit_part)
                .unwrap_or_default(),
            army: normalize_unit_part(&row.army),
            division: normalize_unit_part(&row.division),
            regiment: normalize_unit_part(&row.regiment),
            battalion: normalize_unit_part(&row.battalion),
            company: normalize_unit_part(&row.company),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CatalogMatchRank {
    distance: usize,
    specificity: usize,
    unit_id: i64,
}

#[post("/api/sigint/network-callsigns/relations")]
pub async fn network_callsigns_relations(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignRelationsReq>,
) -> Result<Json<NetworkCallsignRelationsRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let user_id = login_id_from_identity(&user)?;

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

    let messages = load_network_relation_messages_for_graph(
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
    let catalog_callsigns =
        load_catalog_callsigns(&env.dbx, network_id, &node_ids)
            .await
            .context(h!())?;

    let rsp = aggregate_network_callsign_relations(
        messages,
        &network_callsigns,
        &catalog_callsigns,
    );

    Ok(Json(rsp))
}

#[post("/api/sigint/network-callsigns/relations/messages")]
pub async fn network_callsigns_relation_messages(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignRelationMessagesReq>,
) -> Result<Json<NetworkCallsignRelationMessagesRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;

    let req = req.into_inner();
    validate_network_relation_message_selection(&req)?;
    let messages =
        load_network_relation_messages(&env.dbx, &user, &env.config, &req)
            .await
            .context(h!())?;

    Ok(Json(NetworkCallsignRelationMessagesRsp { messages }))
}

fn validate_network_relation_message_selection(
    req: &NetworkCallsignRelationMessagesReq,
) -> Result<(), AppError> {
    let has_callsign = req
        .callsign
        .as_deref()
        .map(normalize_callsign)
        .is_some_and(|value| !value.is_empty());
    let has_source = req
        .source
        .as_deref()
        .map(normalize_callsign)
        .is_some_and(|value| !value.is_empty());
    let has_target = req
        .target
        .as_deref()
        .map(normalize_callsign)
        .is_some_and(|value| !value.is_empty());

    let has_node_selection = has_callsign;
    let has_edge_selection = has_source && has_target;

    match (has_node_selection, has_edge_selection) {
        (true, false) | (false, true) => Ok(()),
        _ => Err(AppError::BL {
            msg: "Either callsign or source + target must be provided"
                .to_string(),
        }),
    }
}

async fn load_network_relation_messages(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
    config: &crate::Config,
    req: &NetworkCallsignRelationMessagesReq,
) -> Result<Vec<NetworkCallsignRelationMessage>, AppError> {
    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        dbx, user, config,
    )
    .await
    .context(h!())?;

    let message_ids =
        load_network_relation_message_ids(dbx, req.network_id, &groups, req)
            .await
            .context(h!())?;
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }

    let rows = load_network_relation_message_rows(dbx, &message_ids)
        .await
        .context(h!())?;

    Ok(aggregate_relation_messages(rows))
}

async fn load_network_relation_message_rows(
    dbx: &DatabaseConnection,
    message_ids: &[i64],
) -> Result<Vec<NetworkCallsignRelationMessageRow>, AppError> {
    let query = signal_message::Entity::find()
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
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Id.eq_any(message_ids.to_vec()));

    let rows = query
        .into_model::<NetworkCallsignRelationMessageRow>()
        .all(dbx)
        .await
        .context(h!())?;

    Ok(rows)
}

async fn load_network_relation_messages_for_graph(
    dbx: &DatabaseConnection,
    network_id: i64,
    groups: &[String],
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
) -> Result<Vec<NetworkCallsignRelationMessage>, AppError> {
    let rows = load_network_relation_message_rows_for_graph(
        dbx,
        network_id,
        groups,
        since_date_inclusive_ms,
        till_date_noninclusive_ms,
    )
    .await
    .context(h!())?;

    Ok(aggregate_relation_messages(rows))
}

async fn load_network_relation_message_rows_for_graph(
    dbx: &DatabaseConnection,
    network_id: i64,
    groups: &[String],
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
) -> Result<Vec<NetworkCallsignRelationMessageRow>, AppError> {
    let query = signal_message::Entity::find()
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
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups.to_vec()))
        .filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since_date_inclusive_ms)?),
        )
        .filter(
            sigint_inbox_item::Column::Datetime
                .lt(dt_from_millis(till_date_noninclusive_ms)?),
        );

    let rows = query
        .into_model::<NetworkCallsignRelationMessageRow>()
        .all(dbx)
        .await
        .context(h!())?;

    Ok(rows)
}

async fn load_network_relation_message_ids(
    dbx: &DatabaseConnection,
    network_id: i64,
    groups: &[String],
    req: &NetworkCallsignRelationMessagesReq,
) -> Result<Vec<i64>, AppError> {
    let mut query = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
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
        .filter(datasource_group::Column::GroupMasterKey.is_in(groups.to_vec()))
        .filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(req.since_date_inclusive_ms)?),
        )
        .filter(
            sigint_inbox_item::Column::Datetime
                .lt(dt_from_millis(req.till_date_noninclusive_ms)?),
        );

    if let Some(selection) =
        build_network_relation_message_selection_condition(req)
    {
        query = query.filter(selection);
    }

    if let Some(freq_condition) =
        build_network_relation_message_freq_condition(req)
    {
        query = query.filter(freq_condition);
    }

    let limit = clamp_network_relation_messages_limit(req.limit);
    if limit <= 0 {
        return Ok(Vec::new());
    }

    let ids = query
        .order_by_desc(sigint_inbox_item::Column::Datetime)
        .order_by_desc(signal_message::Column::Id)
        .limit(limit as u64)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .context(h!())?;

    Ok(ids)
}

fn clamp_network_relation_messages_limit(limit: i64) -> i64 {
    limit.clamp(0, crate::config::SIGINT_NETWORK_RELATION_MESSAGES_LIMIT_MAX)
}

async fn load_network_callsigns(
    dbx: &DatabaseConnection,
    network_id: i64,
    user_id: &uuid::Uuid,
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
                main_radio_station: network_callsign.main_radio_station,
                command_control: network_callsign.command_control,
                source: NetworkCallsignRelationEnrichmentSource::RelationEnrichmentNetwork,
            },
        );
    }

    Ok(result)
}

async fn load_catalog_callsigns(
    dbx: &DatabaseConnection,
    network_id: i64,
    callsigns: &BTreeSet<String>,
) -> Result<HashMap<String, NodeEnrichment>, AppError> {
    if callsigns.is_empty() {
        return Ok(HashMap::new());
    }

    let network_unit_scopes = load_network_unit_scopes(dbx, network_id)
        .await
        .context(h!())?;
    if network_unit_scopes.is_empty() {
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
        .column_as(sigint_callsign::Column::UnitId, "unit_id")
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Name)),
            "unit_name",
        )
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Army)),
            "army",
        )
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Division)),
            "division",
        )
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Regiment)),
            "regiment",
        )
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Battalion)),
            "battalion",
        )
        .column_as(
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Company)),
            "company",
        )
        .join(
            JoinType::InnerJoin,
            sigint_callsign::Relation::SigintUnit.def(),
        )
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(
            Expr::cust("lower(sigint_callsign.callsign)")
                .is_in(lower_callsigns.clone()),
        )
        .into_model::<CatalogCallsignRow>()
        .all(dbx)
        .await
        .context(h!())?;

    let mut ranked_result: HashMap<String, (CatalogMatchRank, NodeEnrichment)> =
        HashMap::new();
    for row in rows {
        let callsign = normalize_callsign(&row.callsign);
        if callsign.is_empty() {
            continue;
        }
        let catalog_unit_scope = UnitScope::from_catalog_row(&row);
        let Some(distance) = closest_unit_scope_distance(
            &network_unit_scopes,
            &catalog_unit_scope,
        ) else {
            continue;
        };
        let Some(specificity) =
            catalog_unit_rank_specificity(&catalog_unit_scope)
        else {
            continue;
        };
        let rank = CatalogMatchRank {
            distance,
            specificity,
            unit_id: row.unit_id,
        };
        let enrichment = NodeEnrichment {
            position: row.position.clone(),
            unit_name: row.unit_name.clone(),
            known_callsign_id: Some(row.id),
            main_radio_station: false,
            command_control: false,
            source:
                NetworkCallsignRelationEnrichmentSource::RelationEnrichmentCatalog,
        };

        match ranked_result.get(&callsign) {
            Some((current_rank, _))
                if !is_better_catalog_rank(rank, *current_rank) => {}
            _ => {
                ranked_result.insert(callsign, (rank, enrichment));
            }
        }
    }

    Ok(ranked_result
        .into_iter()
        .map(|(callsign, (_rank, enrichment))| (callsign, enrichment))
        .collect())
}

async fn load_network_unit_scopes(
    dbx: &DatabaseConnection,
    network_id: i64,
) -> Result<Vec<UnitScope>, AppError> {
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .all(dbx)
        .await
        .context(h!())?;

    Ok(units.iter().map(UnitScope::from_unit).collect())
}

fn normalize_unit_part(value: &str) -> String {
    value.trim().to_lowercase()
}

fn unit_values(unit: &UnitScope) -> [&str; 5] {
    [
        &unit.army,
        &unit.division,
        &unit.regiment,
        &unit.battalion,
        &unit.company,
    ]
}

fn unit_hierarchy_specificity(unit: &UnitScope) -> Option<usize> {
    unit_values(unit)
        .iter()
        .enumerate()
        .rev()
        .find(|(_level, value)| !value.is_empty())
        .map(|(level, _value)| level)
}

fn unit_has_identity(unit: &UnitScope) -> bool {
    unit.unit_id.is_some() || !unit.unit_name.is_empty()
}

fn catalog_unit_rank_specificity(unit: &UnitScope) -> Option<usize> {
    unit_hierarchy_specificity(unit)
        .or_else(|| unit_has_identity(unit).then_some(0))
}

fn unit_identity_matches(left: &UnitScope, right: &UnitScope) -> bool {
    if left.unit_id.is_some() && left.unit_id == right.unit_id {
        return true;
    }

    !left.unit_name.is_empty() && left.unit_name == right.unit_name
}

fn unit_is_same_or_child(parent: &UnitScope, child: &UnitScope) -> bool {
    let Some(parent_specificity) = unit_hierarchy_specificity(parent) else {
        return false;
    };

    unit_values(parent)
        .into_iter()
        .zip(unit_values(child))
        .enumerate()
        .all(|(level, (parent_value, child_value))| {
            if !parent_value.is_empty() {
                return parent_value == child_value;
            }

            level > parent_specificity || child_value.is_empty()
        })
}

fn unit_parent_boundary_level(unit: &UnitScope) -> Option<usize> {
    if !unit.regiment.is_empty() {
        Some(2)
    } else if !unit.division.is_empty() || !unit.army.is_empty() {
        Some(0)
    } else {
        unit_hierarchy_specificity(unit)
    }
}

fn unit_is_allowed_parent(child: &UnitScope, parent: &UnitScope) -> bool {
    let Some(parent_specificity) = unit_hierarchy_specificity(parent) else {
        return false;
    };
    let Some(boundary_level) = unit_parent_boundary_level(child) else {
        return false;
    };

    parent_specificity >= boundary_level && unit_is_same_or_child(parent, child)
}

fn unit_hierarchy_distance(
    left: &UnitScope,
    right: &UnitScope,
) -> Option<usize> {
    let left_specificity = unit_hierarchy_specificity(left)?;
    let right_specificity = unit_hierarchy_specificity(right)?;
    if left_specificity == right_specificity {
        return Some(0);
    }

    let (parent_specificity, child) = if left_specificity < right_specificity {
        (left_specificity, right)
    } else {
        (right_specificity, left)
    };

    Some(
        unit_values(child)
            .into_iter()
            .enumerate()
            .filter(|(level, value)| {
                *level > parent_specificity && !value.is_empty()
            })
            .count(),
    )
}

fn unit_scope_distance(
    network_unit: &UnitScope,
    catalog_unit: &UnitScope,
) -> Option<usize> {
    if unit_identity_matches(network_unit, catalog_unit) {
        return Some(0);
    }

    if !unit_is_same_or_child(network_unit, catalog_unit)
        && !unit_is_allowed_parent(network_unit, catalog_unit)
    {
        return None;
    }

    unit_hierarchy_distance(network_unit, catalog_unit)
}

fn closest_unit_scope_distance(
    network_units: &[UnitScope],
    catalog_unit: &UnitScope,
) -> Option<usize> {
    network_units
        .iter()
        .filter_map(|network_unit| {
            unit_scope_distance(network_unit, catalog_unit)
        })
        .min()
}

fn is_better_catalog_rank(
    next: CatalogMatchRank,
    current: CatalogMatchRank,
) -> bool {
    next.distance < current.distance
        || (next.distance == current.distance
            && (next.specificity > current.specificity
                || (next.specificity == current.specificity
                    && next.unit_id < current.unit_id)))
}

fn aggregate_relation_messages(
    rows: Vec<NetworkCallsignRelationMessageRow>,
) -> Vec<NetworkCallsignRelationMessage> {
    let mut messages_by_id: HashMap<i64, NetworkCallsignRelationMessage> =
        HashMap::new();
    let mut seen_callsigns_by_id: HashMap<i64, HashSet<String>> =
        HashMap::new();

    for row in rows {
        let callsign = normalize_callsign(&row.callsign);
        if callsign.is_empty() {
            continue;
        }

        let message =
            messages_by_id.entry(row.message_id).or_insert_with(|| {
                NetworkCallsignRelationMessage {
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

fn build_network_relation_message_selection_condition(
    req: &NetworkCallsignRelationMessagesReq,
) -> Option<Condition> {
    if let Some(callsign) = req
        .callsign
        .as_deref()
        .map(normalize_callsign)
        .filter(|value| !value.is_empty())
    {
        return Some(Condition::all().add(Expr::cust_with_values(
            "exists (select 1 from jsonb_array_elements_text(coalesce(sigint_inbox_item.callsigns, '[]'::jsonb)) as callsign where upper(callsign) = $1)",
            vec![callsign],
        )));
    }

    let source = req
        .source
        .as_deref()
        .map(normalize_callsign)
        .filter(|value| !value.is_empty());
    let target = req
        .target
        .as_deref()
        .map(normalize_callsign)
        .filter(|value| !value.is_empty());

    match (source, target) {
        (Some(source), Some(target)) => Some(
            Condition::all()
                .add(Expr::cust_with_values(
                    "exists (select 1 from jsonb_array_elements_text(coalesce(sigint_inbox_item.callsigns, '[]'::jsonb)) as callsign where upper(callsign) = $1)",
                    vec![source],
                ))
                .add(Expr::cust_with_values(
                    "exists (select 1 from jsonb_array_elements_text(coalesce(sigint_inbox_item.callsigns, '[]'::jsonb)) as callsign where upper(callsign) = $1)",
                    vec![target],
                )),
        ),
        _ => None,
    }
}

fn build_network_relation_message_freq_condition(
    req: &NetworkCallsignRelationMessagesReq,
) -> Option<Condition> {
    let freqs = req
        .freqs
        .iter()
        .map(|freq| freq.trim().to_string())
        .filter(|freq| !freq.is_empty())
        .collect::<Vec<_>>();

    if freqs.is_empty() {
        return Some(
            Condition::all().add(sigint_inbox_item::Column::Freq.is_null()),
        );
    }

    // Keep frequencyless messages visible: the graph has no frequency toggle
    // for them, so they must remain part of any selected node/edge messages.
    Some(
        Condition::any()
            .add(sigint_inbox_item::Column::Freq.is_null())
            .add(sigint_inbox_item::Column::Freq.is_in(freqs)),
    )
}

fn aggregate_network_callsign_relations(
    messages: Vec<NetworkCallsignRelationMessage>,
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
                main_radio_station: enrichment.main_radio_station,
                command_control: enrichment.command_control,
                position: enrichment.position,
                unit_name: enrichment.unit_name,
                known_callsign_id: enrichment.known_callsign_id,
                enrichment_source: enrichment.source,
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

pub(crate) fn aggregate_unenriched_callsign_relations(
    messages: Vec<NetworkCallsignRelationMessage>,
) -> NetworkCallsignRelationsRsp {
    aggregate_network_callsign_relations(
        messages,
        &HashMap::new(),
        &HashMap::new(),
    )
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
) -> NetworkCallsignRelationMessage {
    NetworkCallsignRelationMessage {
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
                main_radio_station: true,
                command_control: false,
                source: NetworkCallsignRelationEnrichmentSource::RelationEnrichmentNetwork,
            },
        );
        let mut catalog_callsigns = HashMap::new();
        catalog_callsigns.insert(
            "ALPHA".to_string(),
            NodeEnrichment {
                position: Some("КП".to_string()),
                unit_name: Some("2 мб".to_string()),
                known_callsign_id: Some(99),
                main_radio_station: false,
                command_control: true,
                source: NetworkCallsignRelationEnrichmentSource::RelationEnrichmentCatalog,
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
        assert_eq!(
            alpha.enrichment_source,
            NetworkCallsignRelationEnrichmentSource::RelationEnrichmentNetwork
        );
        assert!(alpha.main_radio_station);
        assert!(!alpha.command_control);
    }

    #[test]
    fn aggregate_relations_marks_catalog_enrichment() {
        let messages = vec![relation_message_for_test(
            1,
            1000,
            Some("652.111"),
            "one",
            &["alpha", "beta"],
        )];
        let mut catalog_callsigns = HashMap::new();
        catalog_callsigns.insert(
            "ALPHA".to_string(),
            NodeEnrichment {
                position: Some("КП".to_string()),
                unit_name: Some("2 мб".to_string()),
                known_callsign_id: Some(99),
                main_radio_station: false,
                command_control: false,
                source: NetworkCallsignRelationEnrichmentSource::RelationEnrichmentCatalog,
            },
        );

        let graph = aggregate_network_callsign_relations(
            messages,
            &HashMap::new(),
            &catalog_callsigns,
        );
        let alpha = graph.nodes.iter().find(|node| node.id == "ALPHA").unwrap();
        let beta = graph.nodes.iter().find(|node| node.id == "BETA").unwrap();
        assert_eq!(alpha.position.as_deref(), Some("КП"));
        assert_eq!(
            alpha.enrichment_source,
            NetworkCallsignRelationEnrichmentSource::RelationEnrichmentCatalog
        );
        assert_eq!(
            beta.enrichment_source,
            NetworkCallsignRelationEnrichmentSource::RelationEnrichmentNone
        );
    }

    fn unit_scope(
        army: &str,
        division: &str,
        regiment: &str,
        battalion: &str,
        company: &str,
    ) -> UnitScope {
        UnitScope {
            unit_id: None,
            unit_name: String::new(),
            army: normalize_unit_part(army),
            division: normalize_unit_part(division),
            regiment: normalize_unit_part(regiment),
            battalion: normalize_unit_part(battalion),
            company: normalize_unit_part(company),
        }
    }

    fn unit_scope_with_identity(unit_id: i64, unit_name: &str) -> UnitScope {
        UnitScope {
            unit_id: Some(unit_id),
            unit_name: normalize_unit_part(unit_name),
            ..unit_scope("", "", "", "", "")
        }
    }

    #[test]
    fn unit_scope_includes_same_parents_and_children() {
        let network_unit = unit_scope("", "", "283 мсп", "1 мсб", "3 мср");
        let same = unit_scope("", "", "283 мсп", "1 мсб", "3 мср");
        let parent_battalion = unit_scope("", "", "283 мсп", "1 мсб", "");
        let parent_regiment = unit_scope("", "", "283 мсп", "", "");
        let sibling = unit_scope("", "", "283 мсп", "1 мсб", "2 мср");
        let other_regiment = unit_scope("", "", "423 мсп", "", "");
        let parent_division = unit_scope("", "42 мсд", "", "", "");

        assert_eq!(unit_scope_distance(&network_unit, &same), Some(0));
        assert_eq!(
            unit_scope_distance(&network_unit, &parent_battalion),
            Some(1)
        );
        assert_eq!(
            unit_scope_distance(&network_unit, &parent_regiment),
            Some(2)
        );
        assert_eq!(unit_scope_distance(&network_unit, &sibling), None);
        assert_eq!(unit_scope_distance(&network_unit, &other_regiment), None);
        assert_eq!(unit_scope_distance(&network_unit, &parent_division), None);
    }

    #[test]
    fn unit_scope_does_not_treat_missing_ancestors_as_wildcards() {
        let network_unit = unit_scope("", "", "", "1 мсб", "");
        let catalog_unit = unit_scope("", "", "283 мсп", "1 мсб", "");

        assert_eq!(unit_scope_distance(&network_unit, &catalog_unit), None);
    }

    #[test]
    fn unit_scope_matches_same_unit_id_without_hierarchy() {
        let network_unit = unit_scope_with_identity(1, "network unit");
        let catalog_unit = unit_scope_with_identity(1, "catalog unit");

        assert_eq!(unit_scope_distance(&network_unit, &catalog_unit), Some(0));
        assert_eq!(catalog_unit_rank_specificity(&catalog_unit), Some(0));
    }

    #[test]
    fn unit_scope_matches_same_unit_name_without_hierarchy() {
        let network_unit = unit_scope_with_identity(1, "Imported Unit");
        let catalog_unit = unit_scope_with_identity(2, " imported unit ");

        assert_eq!(unit_scope_distance(&network_unit, &catalog_unit), Some(0));
        assert_eq!(catalog_unit_rank_specificity(&catalog_unit), Some(0));
    }

    #[test]
    fn unit_scope_rejects_different_units_without_hierarchy() {
        let network_unit = unit_scope_with_identity(1, "network unit");
        let catalog_unit = unit_scope_with_identity(2, "catalog unit");

        assert_eq!(unit_scope_distance(&network_unit, &catalog_unit), None);
    }

    #[test]
    fn unit_scope_uses_division_or_army_as_parent_boundary_without_regiment() {
        let division_network_unit =
            unit_scope("1 армія", "42 мсд", "", "1 мсб", "");
        let division_parent = unit_scope("1 армія", "42 мсд", "", "", "");
        let army_parent = unit_scope("1 армія", "", "", "", "");
        let other_division_parent = unit_scope("1 армія", "43 мсд", "", "", "");

        assert_eq!(
            unit_scope_distance(&division_network_unit, &division_parent),
            Some(1)
        );
        assert_eq!(
            unit_scope_distance(&division_network_unit, &army_parent),
            Some(2)
        );
        assert_eq!(
            unit_scope_distance(&division_network_unit, &other_division_parent),
            None
        );
    }

    #[test]
    fn catalog_rank_prefers_closest_then_more_specific_then_lower_unit_id() {
        let current = CatalogMatchRank {
            distance: 2,
            specificity: 2,
            unit_id: 10,
        };
        assert!(is_better_catalog_rank(
            CatalogMatchRank {
                distance: 1,
                specificity: 1,
                unit_id: 20,
            },
            current
        ));
        assert!(is_better_catalog_rank(
            CatalogMatchRank {
                distance: 2,
                specificity: 3,
                unit_id: 20,
            },
            current
        ));
        assert!(is_better_catalog_rank(
            CatalogMatchRank {
                distance: 2,
                specificity: 2,
                unit_id: 9,
            },
            current
        ));
    }

    #[test]
    fn relation_message_selection_conditions_cover_node_and_edge_filters() {
        assert!(build_network_relation_message_selection_condition(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: Some("alpha".to_string()),
                source: None,
                target: None,
                freqs: vec![],
                limit: 10,
            }
        )
        .is_some());

        assert!(build_network_relation_message_selection_condition(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: None,
                source: Some("alpha".to_string()),
                target: Some("beta".to_string()),
                freqs: vec![],
                limit: 10,
            }
        )
        .is_some());
    }

    #[test]
    fn relation_message_freq_condition_keeps_frequencyless_messages() {
        let condition = build_network_relation_message_freq_condition(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: None,
                source: None,
                target: None,
                freqs: vec![],
                limit: 10,
            },
        );
        assert!(condition.is_some());
    }

    #[test]
    fn relation_message_limit_is_clamped() {
        assert_eq!(clamp_network_relation_messages_limit(-1), 0);
        assert_eq!(clamp_network_relation_messages_limit(10), 10);
        assert_eq!(
            clamp_network_relation_messages_limit(999),
            crate::config::SIGINT_NETWORK_RELATION_MESSAGES_LIMIT_MAX,
        );
    }

    #[test]
    fn relation_message_selection_validation_requires_exactly_one_mode() {
        assert!(validate_network_relation_message_selection(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: Some("alpha".to_string()),
                source: None,
                target: None,
                freqs: vec![],
                limit: 10,
            }
        )
        .is_ok());

        assert!(validate_network_relation_message_selection(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: None,
                source: Some("alpha".to_string()),
                target: Some("beta".to_string()),
                freqs: vec![],
                limit: 10,
            }
        )
        .is_ok());

        assert!(validate_network_relation_message_selection(
            &NetworkCallsignRelationMessagesReq {
                network_id: 1,
                since_date_inclusive_ms: 0,
                till_date_noninclusive_ms: 10,
                callsign: None,
                source: None,
                target: None,
                freqs: vec![],
                limit: 10,
            }
        )
        .is_err());
    }
}
