//! The model input: one message and its candidate networks.

use super::callsigns::{matched_callsigns, CallsignMatches};
use super::{candidate_set, sql};
use crate::config::{
    AI_NETWORK_MATCH_MAX_CALLSIGNS_PER_NETWORK,
    AI_NETWORK_MATCH_MAX_LIST_ITEMS_PER_NETWORK,
    AI_NETWORK_MATCH_MESSAGE_MAX_CHARS,
};
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_metadata, sigint_inbox_item_network,
    sigint_network, sigint_network_freq, sigint_post, signal_message,
};
use crate::h;
use crate::rer_importer::callsigns::callsign_match_key;
use crate::types::ShortContext;
use md5::{Digest, Md5};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

pub(super) struct MatchContext {
    /// The model's user message.
    pub input_json: String,
    /// Candidate `key` N is `network_ids[N - 1]`; sorted and unique.
    pub network_ids: Vec<i64>,
    /// Changes with anything the model reads: the message, its metadata, or
    /// a candidate's attributes.
    pub input_md5: String,
}

#[derive(Serialize)]
struct MatchInput {
    message: MessageInput,
    candidates: Vec<CandidateInput>,
}

#[derive(Serialize)]
struct MessageInput {
    text: String,
    frequency: Option<String>,
    datetime: Option<String>,
    post: Option<String>,
    unit: Option<String>,
    /// Recognized in the text by the callsign parser and AI worker.
    callsigns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dmr: Option<DmrInput>,
}

#[derive(Serialize)]
struct DmrInput {
    color_codes: Vec<String>,
    call_groups: Vec<String>,
    subscribers: Vec<String>,
}

#[derive(Serialize)]
struct CandidateInput {
    key: usize,
    name: String,
    /// The message's callsigns this network lists, checked against its whole
    /// callsign list.
    matched_callsigns: Vec<String>,
    location: String,
    purpose: Option<String>,
    operation_mode: Option<String>,
    operation_type: Option<String>,
    radio_station: Option<String>,
    frequencies: Vec<String>,
    units: Vec<String>,
    posts: Vec<String>,
    callsigns: Vec<String>,
    instructions: Option<String>,
}

#[derive(FromQueryResult)]
struct NetworkText {
    network_id: i64,
    value: String,
}

/// The message's current candidate set.
pub(super) async fn current_network_ids<C: ConnectionTrait>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<Vec<i64>> {
    let network_ids = sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintNetworkId)
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(candidate_set(&network_ids))
}

/// `None` when the message is gone.
pub(super) async fn load<C: ConnectionTrait>(
    dbx: &C,
    sigint_inbox_item_id: i64,
    network_ids: Vec<i64>,
) -> anyhow::Result<Option<MatchContext>> {
    let Some(message) =
        signal_message::Entity::find_by_id(sigint_inbox_item_id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let Some(item) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .one(dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let body = message.body.unwrap_or_default();
    let message_callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &[sigint_inbox_item_id])
            .await
            .c(h!())?
            .remove(&sigint_inbox_item_id)
            .unwrap_or_default()
            .effective();
    let matches = matched_callsigns(dbx, &[sigint_inbox_item_id], &network_ids)
        .await
        .c(h!())?;
    let candidates = candidate_inputs(
        dbx,
        &network_ids,
        &MessageValues {
            item_id: sigint_inbox_item_id,
            freq: item.freq.clone(),
            post_id: item.post_id,
            callsign_keys: message_callsigns
                .iter()
                .map(|callsign| callsign_match_key(callsign))
                .collect(),
        },
        &matches,
    )
    .await
    .c(h!())?;
    let input = MatchInput {
        message: message_input(dbx, &body, item, message_callsigns)
            .await
            .c(h!())?,
        candidates,
    };
    let input_json = serde_json::to_string(&input).c(h!())?;
    Ok(Some(MatchContext {
        input_md5: format!("{:x}", Md5::digest(input_json.as_bytes())),
        input_json,
        network_ids,
    }))
}

/// The message's own values, which go first in each candidate's capped lists,
/// so a long list never seems to contradict the message.
struct MessageValues {
    item_id: i64,
    freq: Option<String>,
    post_id: Option<i64>,
    callsign_keys: HashSet<String>,
}

async fn message_input<C: ConnectionTrait>(
    dbx: &C,
    body: &str,
    item: sigint_inbox_item::Model,
    callsigns: Vec<String>,
) -> anyhow::Result<MessageInput> {
    let stored_metadata = stored_metadata(dbx, item.id).await.c(h!())?;
    let post = match item.post_id {
        Some(post_id) => sigint_post::Entity::find_by_id(post_id)
            .one(dbx)
            .await
            .c(h!())?
            .map(|post| post.name),
        None => None,
    };
    Ok(MessageInput {
        text: body
            .chars()
            .take(AI_NETWORK_MATCH_MESSAGE_MAX_CHARS)
            .collect(),
        frequency: item.freq,
        datetime: item
            .datetime
            .map(|datetime| datetime.format("%Y-%m-%d %H:%M").to_string()),
        post,
        unit: item.unit_v2.filter(|unit| !unit.trim().is_empty()),
        callsigns,
        dmr: dmr_input(body, stored_metadata),
    })
}

/// Stored DMR metadata: parsed from the text, and submitted through the API
/// without appearing in the text (`save_submit_dmr_metadata`).
async fn stored_metadata<C: ConnectionTrait>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<Vec<sigint_inbox_item_metadata::Model>> {
    sigint_inbox_item_metadata::Entity::find()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .order_by_asc(sigint_inbox_item_metadata::Column::Id)
        .all(dbx)
        .await
        .c(h!())
}

/// DMR values from the text and the stored metadata, deduplicated and
/// sorted, so the input hash changes only when the values do.
fn dmr_input(
    body: &str,
    stored: Vec<sigint_inbox_item_metadata::Model>,
) -> Option<DmrInput> {
    let mut color_codes = BTreeSet::new();
    let mut call_groups = BTreeSet::new();
    let mut subscribers = BTreeSet::new();
    for entry in crate::rer_importer::inbox::metadata::parse_metadata(body) {
        color_codes.extend(entry.cc);
        call_groups.extend(labelled(entry.cg, entry.cg_name));
        subscribers.extend(labelled(entry.id, entry.id_name));
        subscribers.extend(entry.hash_id);
    }
    for row in stored {
        color_codes.extend(row.color_code);
        call_groups.extend(labelled(row.call_group_id, row.call_group_name));
        subscribers.extend(labelled(row.sender_id, row.sender_name));
        subscribers.extend(row.hash_id);
    }
    if color_codes.is_empty()
        && call_groups.is_empty()
        && subscribers.is_empty()
    {
        return None;
    }
    Some(DmrInput {
        color_codes: color_codes.into_iter().collect(),
        call_groups: call_groups.into_iter().collect(),
        subscribers: subscribers.into_iter().collect(),
    })
}

fn labelled(id: Option<String>, name: Option<String>) -> Option<String> {
    match (id, name) {
        (Some(id), Some(name)) => Some(format!("{id} ({name})")),
        (id, name) => id.or(name),
    }
}

async fn candidate_inputs<C: ConnectionTrait>(
    dbx: &C,
    network_ids: &[i64],
    message: &MessageValues,
    matches: &CallsignMatches,
) -> anyhow::Result<Vec<CandidateInput>> {
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids.to_vec()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|network| (network.id, network))
        .collect::<HashMap<_, _>>();
    let mut frequencies =
        load_frequencies(dbx, network_ids, message.freq.as_deref())
            .await
            .c(h!())?;
    let mut units =
        load_texts(dbx, UNITS_SQL, vec![network_ids.to_vec().into()])
            .await
            .c(h!())?;
    let mut posts = load_texts(
        dbx,
        POSTS_SQL,
        vec![network_ids.to_vec().into(), message.post_id.into()],
    )
    .await
    .c(h!())?;
    let mut callsigns =
        load_callsigns(dbx, network_ids, &message.callsign_keys)
            .await
            .c(h!())?;
    Ok(network_ids
        .iter()
        .enumerate()
        .filter_map(|(index, network_id)| {
            let network = networks.get(network_id)?;
            Some(CandidateInput {
                key: index + 1,
                name: network.name.clone(),
                matched_callsigns: matches
                    .get(&(message.item_id, *network_id))
                    .cloned()
                    .unwrap_or_default(),
                location: network.location.clone(),
                purpose: network.purpose.clone(),
                operation_mode: network.operation_mode.clone(),
                operation_type: network.operation_type.clone(),
                radio_station: network.radio_station.clone(),
                frequencies: frequencies.remove(network_id).unwrap_or_default(),
                units: units.remove(network_id).unwrap_or_default(),
                posts: posts.remove(network_id).unwrap_or_default(),
                callsigns: callsigns.remove(network_id).unwrap_or_default(),
                instructions: network.ai_instructions.clone(),
            })
        })
        .collect())
}

const UNITS_SQL: &str = "select link.network_id, unit.name as value from sigint_network_unit link join sigint_unit unit on unit.id = link.unit_id where link.network_id = any($1) and not unit.deleted order by link.network_id, unit.name";

/// The message's post first.
const POSTS_SQL: &str = "select link.network_id, post.name as value from sigint_network_post link join sigint_post post on post.id = link.post_id where link.network_id = any($1) and not link.deleted and not post.deleted order by link.network_id, coalesce(post.id = $2, false) desc, post.name";

async fn load_texts<C: ConnectionTrait>(
    dbx: &C,
    query: &str,
    values: Vec<sea_orm::Value>,
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let rows = NetworkText::find_by_statement(sql(query, values))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(group_capped(
        rows.into_iter().map(|row| (row.network_id, row.value)),
        AI_NETWORK_MATCH_MAX_LIST_ITEMS_PER_NETWORK,
    ))
}

/// The message's frequency first: every candidate has it, and a list cut
/// before it would tell the model otherwise.
async fn load_frequencies<C: ConnectionTrait>(
    dbx: &C,
    network_ids: &[i64],
    message_freq: Option<&str>,
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let mut freqs = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_freq::Column::Freq)
        .all(dbx)
        .await
        .c(h!())?;
    freqs.sort_by_key(|freq| Some(freq.freq.as_str()) != message_freq);
    Ok(group_capped(
        freqs.into_iter().map(|freq| {
            let label = if freq.modulation.trim().is_empty() {
                freq.freq
            } else {
                format!("{} {}", freq.freq, freq.modulation)
            };
            (freq.network_id, label)
        }),
        AI_NETWORK_MATCH_MAX_LIST_ITEMS_PER_NETWORK,
    ))
}

/// The message's callsigns first, then main stations and command callsigns,
/// as they say the most.
async fn load_callsigns<C: ConnectionTrait>(
    dbx: &C,
    network_ids: &[i64],
    message_callsign_keys: &HashSet<String>,
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let mut rows = NetworkText::find_by_statement(sql(
        "select sigint_network_id as network_id, sigint_callsign as value from sigint_network_callsign where sigint_network_id = any($1) and not deleted order by sigint_network_id, main_radio_station desc, command_control desc, id",
        vec![network_ids.to_vec().into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    rows.sort_by_key(|row| {
        !message_callsign_keys.contains(&callsign_match_key(&row.value))
    });
    Ok(group_capped(
        rows.into_iter().map(|row| (row.network_id, row.value)),
        AI_NETWORK_MATCH_MAX_CALLSIGNS_PER_NETWORK,
    ))
}

/// Groups by network, keeping the first `cap` distinct non-blank values.
fn group_capped(
    rows: impl Iterator<Item = (i64, String)>,
    cap: usize,
) -> HashMap<i64, Vec<String>> {
    let mut grouped: HashMap<i64, Vec<String>> = HashMap::new();
    for (network_id, value) in rows {
        let value = value.trim();
        let values = grouped.entry(network_id).or_default();
        if value.is_empty()
            || values.len() >= cap
            || values.iter().any(|v| v == value)
        {
            continue;
        }
        values.push(value.to_string());
    }
    grouped
}
