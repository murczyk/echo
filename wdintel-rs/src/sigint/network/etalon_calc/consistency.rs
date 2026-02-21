use crate::entities::*;
use crate::h;
use crate::types::ShortContext;
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use itertools::Itertools;
use log::*;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, FromQueryResult)]
pub struct InboxItem {
    pub id: i64,
    pub timestamp: Option<NaiveDateTime>,
    pub freq: Option<String>,
    pub unit: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct NetworkFreqResult {
    pub network_id: i64,
    pub unit: Option<String>,
    pub freq: String,
    pub freq_active_from: Option<NaiveDateTime>,
    pub freq_active_to: Option<NaiveDateTime>,
    pub network_active_from: Option<NaiveDateTime>,
    pub network_active_to: Option<NaiveDateTime>,
}

pub async fn run_inbox_network_daily_consistency_worker_once<
    'a,
    'async_trait,
    C,
>(
    db: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let (day_start, day_end) = current_day_bounds_utc();
    let messages =
        load_today_inbox_messages_for_network_check(db, day_start, day_end)
            .await
            .c(h!())?;
    if messages.is_empty() {
        return Ok(());
    }
    let expected_map =
        load_networks_for_inbox_items(db, &messages).await.c(h!())?;
    let message_ids = messages.iter().map(|msg| msg.id).collect::<Vec<_>>();
    let actual_map = load_actual_networks_for_messages(&message_ids, db)
        .await
        .c(h!())?;
    log_network_mismatches(&messages, &expected_map, &actual_map);
    Ok(())
}

pub async fn load_networks_for_inbox_items<'a, 'async_trait, C>(
    db: &'a C,
    messages: &Vec<InboxItem>,
) -> anyhow::Result<HashMap<i64, Vec<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    let message_ids = messages.iter().map(|msg| msg.id).collect::<Vec<_>>();
    let groups_map =
        load_message_group_entries(&message_ids, db).await.c(h!())?;
    let expected_map =
        load_expected_networks_for_messages(messages, &groups_map, db)
            .await
            .c(h!())?;
    Ok(expected_map)
}

fn current_day_bounds_utc() -> (NaiveDateTime, NaiveDateTime) {
    let today = Utc::now().date_naive();
    let start = today.and_hms_opt(0, 0, 0).unwrap();
    let end = start + chrono::Duration::days(1);
    (start, end)
}

async fn load_today_inbox_messages_for_network_check<'a, 'async_trait, C>(
    db: &'a C,
    day_start: NaiveDateTime,
    day_end: NaiveDateTime,
) -> anyhow::Result<Vec<InboxItem>>
where
    C: ConnectionTrait + 'async_trait,
{
    let messages = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::UnitV2, "unit")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(day_start))
        .filter(sigint_inbox_item::Column::Datetime.lt(day_end))
        .into_model::<InboxItem>()
        .all(db)
        .await
        .c(h!())?;
    Ok(messages)
}

async fn load_message_group_entries<'a, 'async_trait, C>(
    message_ids: &[i64],
    db: &'a C,
) -> anyhow::Result<HashMap<i64, Vec<signal_message_group::Model>>>
where
    C: ConnectionTrait + 'async_trait,
{
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let group_rows = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(message_ids.to_vec()),
        )
        .all(db)
        .await
        .c(h!())?;
    let mut groups_map: HashMap<i64, Vec<signal_message_group::Model>> =
        HashMap::new();
    for entry in group_rows {
        groups_map
            .entry(entry.signal_message_id)
            .or_default()
            .push(entry);
    }
    Ok(groups_map)
}

async fn load_expected_networks_for_messages<'a, 'async_trait, C>(
    messages: &Vec<InboxItem>,
    groups_map: &HashMap<i64, Vec<signal_message_group::Model>>,
    db: &'a C,
) -> anyhow::Result<HashMap<i64, Vec<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    // Step 1: Collect group_ids and freqs from messages
    let mut group_master_keys = HashSet::new();
    let mut freqs = HashSet::new();
    for msg in messages {
        if let Some(freq) = &msg.freq {
            freqs.insert(freq.clone());
        }
        if let Some(entries) = groups_map.get(&msg.id) {
            for entry in entries {
                if let Some(group_master_key) = entry.group_master_key.clone() {
                    group_master_keys.insert(group_master_key);
                }
            }
        }
    }

    // Step 2. Load groups bounds
    let groups_with_aors = signal_group_aor::Entity::find()
        .find_with_related(area_of_responsibility::Entity)
        .filter(
            signal_group_aor::Column::MasterKey
                .is_in(group_master_keys.into_iter().collect_vec()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(db)
        .await
        .context(h!())?;

    let mut group_bounds_map: HashMap<String, Vec<(f64, f64)>> = HashMap::new();
    for (group_aor, aors) in groups_with_aors {
        for aor in aors {
            group_bounds_map
                .entry(group_aor.master_key.clone())
                .or_default()
                .push((aor.left_bound, aor.right_bound));
        }
    }

    // Step 3: Load network_freq + networks, collect network_ids
    let networks_freqs = sigint_network_freq::Entity::find()
        .inner_join(sigint_network::Entity)
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .column(sigint_network_freq::Column::NetworkId)
        .column(sigint_network_freq::Column::Freq)
        .column_as(sigint_unit::Column::Name, "unit")
        .column_as(sigint_network_freq::Column::ActiveFrom, "freq_active_from")
        .column_as(sigint_network_freq::Column::ActiveTo, "freq_active_to")
        .column_as(sigint_network::Column::ActiveFrom, "network_active_from")
        .column_as(sigint_network::Column::ActiveTo, "network_active_to")
        .filter(
            sigint_network_freq::Column::Freq
                .is_in(freqs.into_iter().collect_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .into_model::<NetworkFreqResult>()
        .all(db)
        .await
        .context(h!())?;

    let mut network_ids = HashSet::new();
    for nf in &networks_freqs {
        network_ids.insert(nf.network_id);
    }

    // Step 5: Load AORs for networks
    let network_aors = sigint_network_aor::Entity::find()
        .find_with_related(area_of_responsibility::Entity)
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(
            sigint_network_aor::Column::NetworkId
                .is_in(network_ids.into_iter().collect_vec()),
        )
        .all(db)
        .await
        .context(h!())?;

    let mut network_bounds_map: HashMap<i64, Vec<(f64, f64)>> = HashMap::new();
    for (na, aors) in network_aors {
        for aor in aors {
            network_bounds_map
                .entry(na.network_id)
                .or_default()
                .push((aor.left_bound, aor.right_bound));
        }
    }

    // Step 6: Match messages to networks
    let res = match_network_ids_for_messages(
        messages,
        groups_map,
        &group_bounds_map,
        &network_bounds_map,
        networks_freqs,
    )
    .context(h!())?;

    Ok(res)
}

fn match_network_ids_for_messages(
    messages: &Vec<InboxItem>,
    groups_map: &HashMap<i64, Vec<signal_message_group::Model>>,
    group_bounds_map: &HashMap<String, Vec<(f64, f64)>>,
    network_bounds_map: &HashMap<i64, Vec<(f64, f64)>>,
    networks_freqs: Vec<NetworkFreqResult>,
) -> anyhow::Result<HashMap<i64, Vec<i64>>> {
    let mut freq_networks_map: HashMap<String, Vec<NetworkFreqResult>> =
        HashMap::new();
    let mut network_units: HashMap<i64, HashSet<String>> = HashMap::new();
    for nf in networks_freqs {
        if let Some(unit) = &nf.unit {
            network_units
                .entry(nf.network_id)
                .or_default()
                .insert(unit.clone());
        }
        freq_networks_map
            .entry(nf.freq.clone())
            .or_default()
            .push(nf);
    }

    let mut result = HashMap::new();

    fn is_active_at(
        dt: NaiveDateTime,
        active_from: Option<NaiveDateTime>,
        active_to: Option<NaiveDateTime>,
    ) -> bool {
        let from_ok = active_from.map(|from| from <= dt).unwrap_or(true);
        let to_ok = active_to.map(|to| to >= dt).unwrap_or(true);
        from_ok && to_ok
    }

    for msg in messages {
        let Some(entries) = groups_map.get(&msg.id) else {
            continue;
        };
        let Some(group_master_key) = entries
            .iter()
            .min_by_key(|entry| entry.id)
            .and_then(|entry| entry.group_master_key.clone())
        else {
            continue;
        };
        let Some(freq) = &msg.freq else { continue };

        let Some(group_bounds) = group_bounds_map.get(&group_master_key) else {
            continue;
        };

        let Some(candidate_networks) = freq_networks_map.get(freq) else {
            continue;
        };

        let msg_dt = msg.timestamp.unwrap_or_else(|| Utc::now().naive_utc());
        let mut matched = HashSet::new();

        for candidate in candidate_networks {
            let network_id = candidate.network_id;
            if !is_active_at(
                msg_dt,
                candidate.network_active_from,
                candidate.network_active_to,
            ) {
                continue;
            }
            if !is_active_at(
                msg_dt,
                candidate.freq_active_from,
                candidate.freq_active_to,
            ) {
                continue;
            }
            if let Some(net_bounds) = network_bounds_map.get(&network_id) {
                for (gl, gr) in group_bounds {
                    for (nl, nr) in net_bounds {
                        // 1. Group starts inside network
                        // Network: |----[nl=======nr]-------|
                        // Group:   |----------[gl=====gr]---|

                        // 2. Group ends inside network
                        // Network: |------[nl========nr]----|
                        // Group:   |--[gl======gr]----------|

                        // 3. Group covers network
                        // Network: |-------[nl==nr]---------|
                        // Group:   |---[gl===========gr]----|

                        if (gl >= nl && gl <= nr)
                            || (gr >= nl && gr <= nr)
                            || (gl <= nl && gr >= nr)
                        {
                            matched.insert(network_id);
                            break;
                        }
                    }
                }
            }
        }
        matched = try_discard_by_unit(&msg.unit, matched, &network_units);

        result.insert(msg.id, matched.into_iter().collect::<Vec<_>>());
    }

    Ok(result)
}

fn try_discard_by_unit(
    message_unit_name: &Option<String>,
    matched_networks: HashSet<i64>,
    network_units: &HashMap<i64, HashSet<String>>,
) -> HashSet<i64> {
    let Some(message_unit_name) = message_unit_name else {
        return matched_networks;
    };
    let mut result = HashSet::new();
    for network_id in &matched_networks {
        let Some(units) = network_units.get(network_id) else {
            continue;
        };
        for network_unit_name in units {
            if is_parent_of(network_unit_name, message_unit_name)
                || is_parent_of(message_unit_name, network_unit_name)
            {
                result.insert(*network_id);
                break;
            }
        }
    }
    // if we managed to narrow down matches by unit - return narrowed result, otherwise return the original
    if result.is_empty() {
        matched_networks
    } else {
        result
    }
}

fn is_parent_of(
    network_unit_name: &String,
    message_unit_name: &String,
) -> bool {
    message_unit_name.ends_with(&format!(" {network_unit_name}"))
}

async fn load_actual_networks_for_messages<'a, 'async_trait, C>(
    message_ids: &[i64],
    db: &'a C,
) -> anyhow::Result<HashMap<i64, BTreeSet<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let existing = sigint_inbox_item_network::Entity::find()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(message_ids.to_vec()),
        )
        .all(db)
        .await
        .c(h!())?;
    let mut actual_map: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for entry in existing {
        actual_map
            .entry(entry.sigint_inbox_item_id)
            .or_default()
            .insert(entry.sigint_network_id);
    }
    Ok(actual_map)
}

fn log_network_mismatches(
    messages: &[InboxItem],
    expected_map: &HashMap<i64, Vec<i64>>,
    actual_map: &HashMap<i64, BTreeSet<i64>>,
) {
    let mut mismatches = Vec::new();
    for msg in messages {
        let expected = expected_map
            .get(&msg.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let actual = actual_map.get(&msg.id).cloned().unwrap_or_default();
        if expected != actual {
            mismatches.push((msg, expected, actual));
        }
    }
    if mismatches.is_empty() {
        info!("sigint inbox networks mismatches: total=0");
        return;
    }
    error!(
        "sigint inbox networks mismatches: total={}",
        mismatches.len()
    );
    let head = mismatches.len().min(10);
    for (msg, expected, actual) in mismatches.iter().take(head) {
        error!(
            "sigint inbox networks mismatch for message {}: expected={:?} actual={:?} freq={:?} timestamp={:?}",
            msg.id, expected, actual, msg.freq, msg.timestamp
        );
    }
    if mismatches.len() > head {
        error!("...{} more", mismatches.len() - head);
    }
}
