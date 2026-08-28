use super::ETALON_CALC_QUERY_PARAM_CHUNK_SIZE;
use crate::entities::*;
use crate::h;
use crate::types::ShortContext;
use crate::types::*;
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, FromQueryResult)]
pub struct InboxItem {
    pub id: i64,
    pub timestamp: Option<NaiveDateTime>,
    pub freq: Option<String>,
    pub unit: Option<String>,
    pub parsed_unit_v2: bool,
    pub post_id: Option<i64>,
}

#[derive(Debug, FromQueryResult)]
struct NetworkFreqResult {
    pub network_id: i64,
    pub unit_id: Option<i64>,
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
    let Some(upper_message_id) =
        load_network_check_upper_message_id(db, day_start, day_end)
            .await
            .c(h!())?
    else {
        return Ok(());
    };

    let mut after_message_id = None;
    let mut checked = 0;
    let mut mismatches = NetworkMismatchSummary::default();
    loop {
        let messages = load_today_inbox_messages_for_network_check(
            db,
            day_start,
            day_end,
            after_message_id,
            upper_message_id,
            crate::config::SIGINT_INBOX_NETWORK_CHECK_BATCH_SIZE,
        )
        .await
        .c(h!())?;
        let Some(last_message_id) = messages.last().map(|message| message.id)
        else {
            break;
        };

        let expected_map =
            load_networks_for_inbox_items(db, &messages).await.c(h!())?;
        let message_ids = messages.iter().map(|msg| msg.id).collect::<Vec<_>>();
        let actual_map = load_actual_networks_for_messages(&message_ids, db)
            .await
            .c(h!())?;
        mismatches.extend(collect_network_mismatches(
            &messages,
            &expected_map,
            &actual_map,
            crate::config::SIGINT_INBOX_NETWORK_CHECK_MISMATCH_LOG_LIMIT
                .saturating_sub(mismatches.examples.len()),
        ));
        checked += messages.len();
        after_message_id = Some(last_message_id);
        debug!(
            "sigint inbox network consistency progress: checked={checked} upper_message_id={upper_message_id} last_message_id={last_message_id}"
        );
    }
    log_network_mismatches(checked, &mismatches);
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
    let disabled_message_ids =
        load_network_assignment_disabled_message_ids(&message_ids, db)
            .await
            .c(h!())?;
    let groups_map =
        load_message_group_entries(&message_ids, db).await.c(h!())?;
    let messages = messages
        .iter()
        .filter(|message| !disabled_message_ids.contains(&message.id))
        .cloned()
        .collect::<Vec<_>>();
    let expected_map =
        load_expected_networks_for_messages(&messages, &groups_map, db)
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

async fn load_network_check_upper_message_id<'a, 'async_trait, C>(
    db: &'a C,
    day_start: NaiveDateTime,
    day_end: NaiveDateTime,
) -> anyhow::Result<Option<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let upper_message_id = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(signal_message::Column::Id.max(), "max_id")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(day_start))
        .filter(sigint_inbox_item::Column::Datetime.lt(day_end))
        .into_tuple::<Option<i64>>()
        .one(db)
        .await
        .c(h!())?
        .flatten();
    Ok(upper_message_id)
}

async fn load_today_inbox_messages_for_network_check<'a, 'async_trait, C>(
    db: &'a C,
    day_start: NaiveDateTime,
    day_end: NaiveDateTime,
    after_message_id: Option<i64>,
    upper_message_id: i64,
    batch_size: u64,
) -> anyhow::Result<Vec<InboxItem>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Timestamp, "timestamp")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::UnitV2, "unit")
        .column_as(sigint_inbox_item::Column::ParsedUnitV2, "parsed_unit_v2")
        .column_as(sigint_inbox_item::Column::PostId, "post_id")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(day_start))
        .filter(sigint_inbox_item::Column::Datetime.lt(day_end))
        .filter(signal_message::Column::Id.lte(upper_message_id))
        .order_by_asc(signal_message::Column::Id)
        .limit(batch_size);
    if let Some(after_message_id) = after_message_id {
        query = query.filter(signal_message::Column::Id.gt(after_message_id));
    }
    let messages = query.into_model::<InboxItem>().all(db).await.c(h!())?;
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
    let mut groups_map: HashMap<i64, Vec<signal_message_group::Model>> =
        HashMap::new();
    for message_ids in message_ids.chunks(ETALON_CALC_QUERY_PARAM_CHUNK_SIZE) {
        let group_rows = signal_message_group::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message_group::Relation::SignalGroup.def(),
            )
            .filter(
                signal_message_group::Column::SignalMessageId
                    .is_in(message_ids.to_vec()),
            )
            .filter(super::network_assignment_enabled_condition())
            .all(db)
            .await
            .c(h!())?;
        for entry in group_rows {
            groups_map
                .entry(entry.signal_message_id)
                .or_default()
                .push(entry);
        }
    }
    Ok(groups_map)
}

async fn load_network_assignment_disabled_message_ids<'a, 'async_trait, C>(
    message_ids: &[i64],
    db: &'a C,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    if message_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let disabled_message_ids =
        load_message_ids_with_network_assignment_enabled(
            message_ids,
            db,
            false,
        )
        .await
        .c(h!())?;
    let enabled_message_ids =
        load_message_ids_with_network_assignment_enabled(message_ids, db, true)
            .await
            .c(h!())?;
    Ok(disabled_message_ids
        .difference(&enabled_message_ids)
        .copied()
        .collect())
}

async fn load_message_ids_with_network_assignment_enabled<'a, 'async_trait, C>(
    message_ids: &[i64],
    db: &'a C,
    enabled: bool,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut ids = HashSet::new();
    for message_ids in message_ids.chunks(ETALON_CALC_QUERY_PARAM_CHUNK_SIZE) {
        ids.extend(
            signal_message_group::Entity::find()
                .join(
                    JoinType::InnerJoin,
                    signal_message_group::Relation::SignalGroup.def(),
                )
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .is_in(message_ids.to_vec()),
                )
                .filter(if enabled {
                    super::network_assignment_enabled_condition()
                } else {
                    super::network_assignment_disabled_condition()
                })
                .select_only()
                .column(signal_message_group::Column::SignalMessageId)
                .distinct()
                .into_tuple::<i64>()
                .all(db)
                .await
                .c(h!())?,
        );
    }
    Ok(ids)
}

async fn load_expected_networks_for_messages<'a, 'async_trait, C>(
    messages: &[InboxItem],
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
        .column_as(sigint_unit::Column::Id, "unit_id")
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

    let network_units = load_network_units_by_network_id(db, &networks_freqs)
        .await
        .c(h!())?;
    let message_units =
        load_message_units_by_name(db, messages).await.c(h!())?;

    let mut network_ids = HashSet::new();
    for nf in &networks_freqs {
        network_ids.insert(nf.network_id);
    }
    let network_posts = load_network_posts_by_network_id(db, &network_ids)
        .await
        .c(h!())?;

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
        &network_units,
        &message_units,
        &network_posts,
    )
    .context(h!())?;

    Ok(res)
}

async fn load_network_units_by_network_id<'a, 'async_trait, C>(
    db: &'a C,
    networks_freqs: &[NetworkFreqResult],
) -> anyhow::Result<HashMap<i64, Vec<sigint_unit::Model>>>
where
    C: ConnectionTrait + 'async_trait,
{
    let unit_ids = networks_freqs
        .iter()
        .filter_map(|nf| nf.unit_id)
        .collect::<HashSet<_>>();
    if unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let units_by_id = sigint_unit::Entity::find()
        .filter(
            sigint_unit::Column::Id.is_in(unit_ids.into_iter().collect_vec()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<HashMap<_, _>>();
    let mut result = HashMap::new();
    for nf in networks_freqs {
        let Some(unit_id) = nf.unit_id else {
            continue;
        };
        let Some(unit) = units_by_id.get(&unit_id) else {
            continue;
        };
        result
            .entry(nf.network_id)
            .or_insert_with(Vec::new)
            .push(unit.clone());
    }
    Ok(result)
}

async fn load_network_posts_by_network_id<'a, 'async_trait, C>(
    db: &'a C,
    network_ids: &HashSet<i64>,
) -> anyhow::Result<HashMap<i64, HashSet<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let network_posts = sigint_network_post::Entity::find()
        .filter(
            sigint_network_post::Column::NetworkId
                .is_in(network_ids.iter().copied().collect_vec()),
        )
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    let mut result: HashMap<i64, HashSet<i64>> = HashMap::new();
    for network_post in network_posts {
        result
            .entry(network_post.network_id)
            .or_default()
            .insert(network_post.post_id);
    }
    Ok(result)
}

async fn load_message_units_by_name<'a, 'async_trait, C>(
    db: &'a C,
    messages: &[InboxItem],
) -> anyhow::Result<HashMap<String, Vec<sigint_unit::Model>>>
where
    C: ConnectionTrait + 'async_trait,
{
    let unit_names = messages
        .iter()
        .filter(|msg| msg.parsed_unit_v2)
        .filter_map(|msg| msg.unit.as_ref())
        .flat_map(|unit| split_unit_names(unit))
        .collect::<HashSet<_>>();
    if unit_names.is_empty() {
        return Ok(HashMap::new());
    }
    let mut result: HashMap<String, Vec<sigint_unit::Model>> = HashMap::new();
    let units = sigint_unit::Entity::find()
        .filter(
            sigint_unit::Column::Name
                .is_in(unit_names.into_iter().collect_vec()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    for unit in units {
        result.entry(unit.name.clone()).or_default().push(unit);
    }
    Ok(result)
}

fn split_unit_names(unit_names: &str) -> Vec<String> {
    unit_names
        .split(',')
        .map(str::trim)
        .filter(|unit_name| !unit_name.is_empty())
        .map(ToString::to_string)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn match_network_ids_for_messages(
    messages: &[InboxItem],
    groups_map: &HashMap<i64, Vec<signal_message_group::Model>>,
    group_bounds_map: &HashMap<String, Vec<(f64, f64)>>,
    network_bounds_map: &HashMap<i64, Vec<(f64, f64)>>,
    networks_freqs: Vec<NetworkFreqResult>,
    network_units: &HashMap<i64, Vec<sigint_unit::Model>>,
    message_units: &HashMap<String, Vec<sigint_unit::Model>>,
    network_posts: &HashMap<i64, HashSet<i64>>,
) -> anyhow::Result<HashMap<i64, Vec<i64>>> {
    let mut freq_networks_map: HashMap<String, Vec<NetworkFreqResult>> =
        HashMap::new();
    let mut network_unit_names: HashMap<i64, HashSet<String>> = HashMap::new();
    for nf in networks_freqs {
        if let Some(unit) = &nf.unit {
            network_unit_names
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
        let Some(freq) = &msg.freq else { continue };

        let group_bounds = group_bounds_for_entries(entries, group_bounds_map);
        if group_bounds.is_empty() {
            continue;
        }

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
                for (gl, gr) in &group_bounds {
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
        matched = try_discard_by_unit(
            msg,
            matched,
            network_units,
            message_units,
            &network_unit_names,
        );
        matched = filter_networks_by_post(msg.post_id, matched, network_posts);

        result.insert(msg.id, matched.into_iter().collect::<Vec<_>>());
    }

    Ok(result)
}

fn group_bounds_for_entries(
    entries: &[signal_message_group::Model],
    group_bounds_map: &HashMap<String, Vec<(f64, f64)>>,
) -> Vec<(f64, f64)> {
    entries
        .iter()
        .filter_map(|entry| entry.group_master_key.as_ref())
        .filter_map(|group_master_key| group_bounds_map.get(group_master_key))
        .flat_map(|bounds| bounds.iter().copied())
        .collect()
}

fn filter_networks_by_post(
    message_post_id: Option<i64>,
    matched_networks: HashSet<i64>,
    network_posts: &HashMap<i64, HashSet<i64>>,
) -> HashSet<i64> {
    matched_networks
        .into_iter()
        .filter(|network_id| match network_posts.get(network_id) {
            Some(post_ids) if !post_ids.is_empty() => message_post_id
                .is_some_and(|post_id| post_ids.contains(&post_id)),
            _ => true,
        })
        .collect()
}

fn try_discard_by_unit(
    message: &InboxItem,
    matched_networks: HashSet<i64>,
    network_units: &HashMap<i64, Vec<sigint_unit::Model>>,
    message_units: &HashMap<String, Vec<sigint_unit::Model>>,
    network_unit_names: &HashMap<i64, HashSet<String>>,
) -> HashSet<i64> {
    if message.parsed_unit_v2 {
        let resolved_message_units =
            resolve_message_units(&message.unit, message_units);
        if !resolved_message_units.is_empty() {
            return filter_networks_by_related_units(
                matched_networks,
                &resolved_message_units,
                network_units,
            );
        }
    }
    try_discard_by_unit_name(
        &message.unit,
        matched_networks,
        network_unit_names,
    )
}

fn resolve_message_units(
    message_unit_name: &Option<String>,
    message_units: &HashMap<String, Vec<sigint_unit::Model>>,
) -> Vec<sigint_unit::Model> {
    let Some(message_unit_name) = message_unit_name else {
        return vec![];
    };
    split_unit_names(message_unit_name)
        .into_iter()
        .flat_map(|unit_name| {
            message_units.get(&unit_name).cloned().unwrap_or_default()
        })
        .collect()
}

fn filter_networks_by_related_units(
    matched_networks: HashSet<i64>,
    message_units: &[sigint_unit::Model],
    network_units: &HashMap<i64, Vec<sigint_unit::Model>>,
) -> HashSet<i64> {
    let mut result = HashSet::new();
    for network_id in &matched_networks {
        let Some(units) = network_units.get(network_id) else {
            continue;
        };
        if message_units.iter().any(|message_unit| {
            units.iter().any(|network_unit| {
                crate::unit::are_units_related(message_unit, network_unit)
            })
        }) {
            result.insert(*network_id);
        }
    }
    if result.is_empty() {
        matched_networks
    } else {
        result
    }
}

fn try_discard_by_unit_name(
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
            if network_unit_name == message_unit_name
                || is_parent_of(network_unit_name, message_unit_name)
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
    let mut actual_map: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for message_ids in message_ids.chunks(ETALON_CALC_QUERY_PARAM_CHUNK_SIZE) {
        let existing = sigint_inbox_item_network::Entity::find()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .is_in(message_ids.to_vec()),
            )
            .all(db)
            .await
            .c(h!())?;
        for entry in existing {
            actual_map
                .entry(entry.sigint_inbox_item_id)
                .or_default()
                .insert(entry.sigint_network_id);
        }
    }
    Ok(actual_map)
}

#[derive(Default)]
struct NetworkMismatchSummary {
    total: usize,
    examples: Vec<NetworkMismatch>,
}

struct NetworkMismatch {
    message_id: i64,
    expected: BTreeSet<i64>,
    actual: BTreeSet<i64>,
    freq: Option<String>,
    timestamp: Option<NaiveDateTime>,
}

impl NetworkMismatchSummary {
    fn extend(&mut self, other: Self) {
        self.total += other.total;
        self.examples.extend(other.examples);
    }
}

fn collect_network_mismatches(
    messages: &[InboxItem],
    expected_map: &HashMap<i64, Vec<i64>>,
    actual_map: &HashMap<i64, BTreeSet<i64>>,
    example_limit: usize,
) -> NetworkMismatchSummary {
    let mut mismatches = NetworkMismatchSummary::default();
    for msg in messages {
        let expected = expected_map
            .get(&msg.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let actual = actual_map.get(&msg.id).cloned().unwrap_or_default();
        if expected != actual {
            mismatches.total += 1;
            if mismatches.examples.len() < example_limit {
                mismatches.examples.push(NetworkMismatch {
                    message_id: msg.id,
                    expected,
                    actual,
                    freq: msg.freq.clone(),
                    timestamp: msg.timestamp,
                });
            }
        }
    }
    mismatches
}

fn log_network_mismatches(checked: usize, mismatches: &NetworkMismatchSummary) {
    if mismatches.total == 0 {
        info!("sigint inbox networks mismatches: total=0 checked={checked}");
        return;
    }
    error!(
        "sigint inbox networks mismatches: total={} checked={checked}",
        mismatches.total
    );
    for mismatch in &mismatches.examples {
        warn!(
            "sigint inbox networks mismatch for message {}: expected={:?} actual={:?} freq={:?} timestamp={:?}",
            mismatch.message_id,
            mismatch.expected,
            mismatch.actual,
            mismatch.freq,
            mismatch.timestamp
        );
    }
    if mismatches.total > mismatches.examples.len() {
        error!("...{} more", mismatches.total - mismatches.examples.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use serial_test::serial;

    #[serial]
    #[tokio::test]
    async fn load_message_group_entries_ignores_disabled_group_links() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let disabled_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                disable_network_assignment: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let enabled_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                disable_network_assignment: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let msg = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();

        mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(msg.id),
                group_master_key: Set(Some(disabled_group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(msg.id),
                group_master_key: Set(Some(disabled_group.master_key)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(msg.id),
                group_master_key: Set(Some(enabled_group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let groups_map =
            load_message_group_entries(&[msg.id], &txn).await.unwrap();
        let entries = groups_map.get(&msg.id).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].group_master_key, Some(enabled_group.master_key));

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn load_network_assignment_disabled_message_ids_requires_all_groups_disabled(
    ) {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();

        let enabled_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                disable_network_assignment: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let disabled_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                disable_network_assignment: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let disabled_only_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                disable_network_assignment: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mixed_msg = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let disabled_msg = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for group in [&enabled_group, &disabled_group] {
            mk_signal_message_group(
                &txn,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(mixed_msg.id),
                    group_master_key: Set(Some(group.master_key.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(disabled_msg.id),
                group_master_key: Set(Some(
                    disabled_only_group.master_key.clone(),
                )),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let ids = load_network_assignment_disabled_message_ids(
            &[mixed_msg.id, disabled_msg.id],
            &txn,
        )
        .await
        .unwrap();

        assert!(!ids.contains(&mixed_msg.id));
        assert!(ids.contains(&disabled_msg.id));

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn network_consistency_pages_stop_at_initial_watermark() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let day_start = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
        let day_end = day_start + chrono::Duration::days(1);
        let mut message_ids = Vec::new();
        for _ in 0..3 {
            let message = mk_sigint_inbox_item(
                &txn,
                sigint_inbox_item::ActiveModel {
                    date: Set(Some(day_start.format("%Y-%m-%d").to_string())),
                    time: Set(Some("12:00:00".to_string())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            message_ids.push(message.id);
        }
        let upper_message_id =
            load_network_check_upper_message_id(&txn, day_start, day_end)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(upper_message_id, message_ids[2]);

        let first_page = load_today_inbox_messages_for_network_check(
            &txn,
            day_start,
            day_end,
            None,
            upper_message_id,
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            first_page.iter().map(|message| message.id).collect_vec(),
            message_ids[..2]
        );

        let later_message = mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                date: Set(Some(day_start.format("%Y-%m-%d").to_string())),
                time: Set(Some("12:00:00".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_page = load_today_inbox_messages_for_network_check(
            &txn,
            day_start,
            day_end,
            Some(first_page.last().unwrap().id),
            upper_message_id,
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            second_page.iter().map(|message| message.id).collect_vec(),
            vec![message_ids[2]]
        );
        assert_ne!(later_message.id, message_ids[2]);

        txn.rollback().await.unwrap();
    }

    #[test]
    fn network_mismatch_summary_caps_examples_across_batches() {
        let messages = (1..=12)
            .map(|id| InboxItem {
                id,
                timestamp: Some(test_dt()),
                freq: Some("148.0000".to_string()),
                unit: None,
                parsed_unit_v2: false,
                post_id: None,
            })
            .collect_vec();
        let expected_map = messages
            .iter()
            .map(|message| (message.id, vec![1]))
            .collect();
        let actual_map = HashMap::new();
        let mut summary = collect_network_mismatches(
            &messages[..7],
            &expected_map,
            &actual_map,
            10,
        );
        summary.extend(collect_network_mismatches(
            &messages[7..],
            &expected_map,
            &actual_map,
            10 - summary.examples.len(),
        ));

        assert_eq!(summary.total, 12);
        assert_eq!(summary.examples.len(), 10);
        assert_eq!(summary.examples[0].message_id, 1);
        assert_eq!(summary.examples[9].message_id, 10);
    }

    #[test]
    fn match_networks_uses_later_group_aor() {
        let item_id = 1;
        let messages = vec![InboxItem {
            id: item_id,
            timestamp: Some(test_dt()),
            freq: Some("158.2510".to_string()),
            unit: None,
            parsed_unit_v2: false,
            post_id: None,
        }];
        let groups_map = HashMap::from([(
            item_id,
            vec![
                mk_group_entry(1, item_id, "without-aor"),
                mk_group_entry(2, item_id, "with-aor"),
            ],
        )]);
        let group_bounds_map =
            HashMap::from([("with-aor".to_string(), vec![(8300.0, 8999.0)])]);
        let network_bounds_map = HashMap::from([(983, vec![(8300.0, 8999.0)])]);
        let networks_freqs = vec![NetworkFreqResult {
            network_id: 983,
            unit_id: None,
            unit: None,
            freq: "158.2510".to_string(),
            freq_active_from: Some(test_dt()),
            freq_active_to: None,
            network_active_from: Some(test_dt()),
            network_active_to: None,
        }];

        let matched = match_network_ids_for_messages(
            &messages,
            &groups_map,
            &group_bounds_map,
            &network_bounds_map,
            networks_freqs,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(
            matched
                .get(&item_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect::<HashSet<_>>(),
            HashSet::from([983])
        );
    }

    fn mk_group_entry(
        id: i64,
        signal_message_id: i64,
        group_master_key: &str,
    ) -> signal_message_group::Model {
        signal_message_group::Model {
            id,
            signal_message_id,
            signal_message_uuid: Some(uuid::Uuid::now_v7()),
            group_master_key: Some(group_master_key.to_string()),
            sender: None,
            login_id: None,
            message_uid: None,
            datasource_group_id: None,
            created_at: test_dt(),
        }
    }

    fn test_dt() -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn mk_unit(id: i64, name: &str, regiment: &str) -> sigint_unit::Model {
        sigint_unit::Model {
            id,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            regiment: regiment.to_string(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            army_region: String::new(),
            military_district: String::new(),
            active: true,
            deleted: false,
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            created_by_login_id: uuid::Uuid::nil(),
            name: name.to_string(),
            comment: String::new(),
            search_tsv: None,
            battalion: String::new(),
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            is_inconsistent: false,
            updated_at: Default::default(),
        }
    }

    #[test]
    fn related_unit_filter_keeps_original_when_no_related_units_match() {
        let matched_networks = HashSet::from([1, 2]);
        let message_units = vec![mk_unit(10, "unit-a", "1")];
        let network_units =
            HashMap::from([(1, vec![mk_unit(20, "unit-b", "2")])]);

        assert_eq!(
            filter_networks_by_related_units(
                matched_networks.clone(),
                &message_units,
                &network_units,
            ),
            matched_networks
        );
    }

    #[test]
    fn related_unit_filter_narrows_when_related_units_match() {
        let matched_networks = HashSet::from([1, 2]);
        let message_units = vec![mk_unit(10, "unit-a", "1")];
        let network_units = HashMap::from([
            (1, vec![mk_unit(20, "unit-b", "2")]),
            (2, vec![mk_unit(30, "unit-c", "1")]),
        ]);

        assert_eq!(
            filter_networks_by_related_units(
                matched_networks,
                &message_units,
                &network_units,
            ),
            HashSet::from([2])
        );
    }

    #[test]
    fn post_filter_keeps_unrestricted_networks() {
        let matched_networks = HashSet::from([1, 2]);
        let network_posts = HashMap::from([(2, HashSet::from([11]))]);

        assert_eq!(
            filter_networks_by_post(Some(11), matched_networks, &network_posts),
            HashSet::from([1, 2])
        );
    }

    #[test]
    fn post_filter_removes_networks_for_other_posts() {
        let matched_networks = HashSet::from([1, 2]);
        let network_posts = HashMap::from([(1, HashSet::from([11]))]);

        assert_eq!(
            filter_networks_by_post(Some(22), matched_networks, &network_posts),
            HashSet::from([2])
        );
    }

    #[test]
    fn post_filter_removes_restricted_networks_without_message_post() {
        let matched_networks = HashSet::from([1, 2]);
        let network_posts = HashMap::from([(1, HashSet::from([11]))]);

        assert_eq!(
            filter_networks_by_post(None, matched_networks, &network_posts),
            HashSet::from([2])
        );
    }
}
