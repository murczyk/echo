//! The model input: one message and its candidate networks.

use super::{candidate_set, sql};
use crate::config::{
    AI_NETWORK_MATCH_MAX_CALLSIGNS_PER_NETWORK,
    AI_NETWORK_MATCH_MAX_LIST_ITEMS_PER_NETWORK,
    AI_NETWORK_MATCH_MESSAGE_MAX_CHARS,
};
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_network, sigint_network,
    sigint_network_freq, sigint_post, signal_message,
};
use crate::h;
use crate::types::ShortContext;
use md5::{Digest, Md5};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

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
    let input = MatchInput {
        message: message_input(dbx, &body, item).await.c(h!())?,
        candidates: candidate_inputs(dbx, &network_ids).await.c(h!())?,
    };
    let input_json = serde_json::to_string(&input).c(h!())?;
    Ok(Some(MatchContext {
        input_md5: format!("{:x}", Md5::digest(input_json.as_bytes())),
        input_json,
        network_ids,
    }))
}

async fn message_input<C: ConnectionTrait>(
    dbx: &C,
    body: &str,
    item: sigint_inbox_item::Model,
) -> anyhow::Result<MessageInput> {
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
        dmr: dmr_input(body),
    })
}

fn dmr_input(body: &str) -> Option<DmrInput> {
    let mut color_codes = BTreeSet::new();
    let mut call_groups = BTreeSet::new();
    let mut subscribers = BTreeSet::new();
    for entry in crate::rer_importer::inbox::metadata::parse_metadata(body) {
        color_codes.extend(entry.cc);
        call_groups.extend(labelled(entry.cg, entry.cg_name));
        subscribers.extend(labelled(entry.id, entry.id_name));
        subscribers.extend(entry.hash_id);
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
) -> anyhow::Result<Vec<CandidateInput>> {
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids.to_vec()))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|network| (network.id, network))
        .collect::<HashMap<_, _>>();
    let mut frequencies = load_frequencies(dbx, network_ids).await.c(h!())?;
    let mut units = load_texts(dbx, UNITS_SQL, network_ids).await.c(h!())?;
    let mut posts = load_texts(dbx, POSTS_SQL, network_ids).await.c(h!())?;
    let mut callsigns = load_callsigns(dbx, network_ids).await.c(h!())?;
    Ok(network_ids
        .iter()
        .enumerate()
        .filter_map(|(index, network_id)| {
            let network = networks.get(network_id)?;
            Some(CandidateInput {
                key: index + 1,
                name: network.name.clone(),
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

const POSTS_SQL: &str = "select link.network_id, post.name as value from sigint_network_post link join sigint_post post on post.id = link.post_id where link.network_id = any($1) and not link.deleted and not post.deleted order by link.network_id, post.name";

async fn load_texts<C: ConnectionTrait>(
    dbx: &C,
    query: &str,
    network_ids: &[i64],
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let rows = NetworkText::find_by_statement(sql(
        query,
        vec![network_ids.to_vec().into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
    Ok(group_capped(
        rows.into_iter().map(|row| (row.network_id, row.value)),
        AI_NETWORK_MATCH_MAX_LIST_ITEMS_PER_NETWORK,
    ))
}

async fn load_frequencies<C: ConnectionTrait>(
    dbx: &C,
    network_ids: &[i64],
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let freqs = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_freq::Column::Freq)
        .all(dbx)
        .await
        .c(h!())?;
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

/// Main stations and command callsigns first, as they say the most.
async fn load_callsigns<C: ConnectionTrait>(
    dbx: &C,
    network_ids: &[i64],
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let rows = NetworkText::find_by_statement(sql(
        "select sigint_network_id as network_id, sigint_callsign as value from sigint_network_callsign where sigint_network_id = any($1) and not deleted order by sigint_network_id, main_radio_station desc, command_control desc, id",
        vec![network_ids.to_vec().into()],
    ))
    .all(dbx)
    .await
    .c(h!())?;
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
