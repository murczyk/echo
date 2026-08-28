use crate::config::*;
use crate::h;
use anyhow::{bail, Context};
use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use itertools::Itertools;
use redis::aio::ConnectionManager;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::io::Cursor;
use tokio::time::{sleep, Duration as TokioDuration, Instant as TokioInstant};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct GroupCount {
    pub signal_group_batch_id: i64,
    pub quantity: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct IdCount {
    pub signal_group_batch_id: i64,
    pub value: i64,
    pub quantity: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct StringCount {
    pub signal_group_batch_id: i64,
    pub value: String,
    pub quantity: i32,
}

const HLL_PRECISION: u32 = 14;
const HLL_REGISTERS: usize = 1 << HLL_PRECISION;
const HLL_SPARSE_MAX: usize = 2_048;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum HllSketch {
    Sparse(Vec<u64>),
    Dense(Vec<u8>),
}

impl Default for HllSketch {
    fn default() -> Self {
        Self::Sparse(Vec::new())
    }
}

impl HllSketch {
    pub fn insert_message_id(&mut self, message_id: i64) {
        self.insert_hash(mix_message_id(message_id as u64));
    }

    pub fn merge(&mut self, other: &Self) {
        match other {
            Self::Sparse(hashes) => {
                for hash in hashes {
                    self.insert_hash(*hash);
                }
            }
            Self::Dense(other_registers) => match self {
                Self::Dense(registers) => {
                    for (register, other_register) in
                        registers.iter_mut().zip(other_registers)
                    {
                        *register = (*register).max(*other_register);
                    }
                }
                Self::Sparse(hashes) => {
                    let hashes = std::mem::take(hashes);
                    let mut registers = other_registers.clone();
                    for hash in hashes {
                        update_hll_register(&mut registers, hash);
                    }
                    *self = Self::Dense(registers);
                }
            },
        }
    }

    pub fn estimate(&self) -> i64 {
        match self {
            Self::Sparse(hashes) => hashes.len() as i64,
            Self::Dense(registers) => {
                let zeros =
                    registers.iter().filter(|register| **register == 0).count();
                if zeros > 0 {
                    let estimate = HLL_REGISTERS as f64
                        * (HLL_REGISTERS as f64 / zeros as f64).ln();
                    return estimate.round() as i64;
                }
                let harmonic_sum = registers
                    .iter()
                    .map(|register| 2f64.powi(-i32::from(*register)))
                    .sum::<f64>();
                let m = HLL_REGISTERS as f64;
                let alpha = 0.7213 / (1.0 + 1.079 / m);
                (alpha * m * m / harmonic_sum).round() as i64
            }
        }
    }

    fn insert_hash(&mut self, hash: u64) {
        match self {
            Self::Sparse(hashes) => match hashes.binary_search(&hash) {
                Ok(_) => {}
                Err(index) => {
                    hashes.insert(index, hash);
                    if hashes.len() > HLL_SPARSE_MAX {
                        let hashes = std::mem::take(hashes);
                        let mut registers = vec![0; HLL_REGISTERS];
                        for hash in hashes {
                            update_hll_register(&mut registers, hash);
                        }
                        *self = Self::Dense(registers);
                    }
                }
            },
            Self::Dense(registers) => update_hll_register(registers, hash),
        }
    }
}

fn mix_message_id(value: u64) -> u64 {
    let mut value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn update_hll_register(registers: &mut [u8], hash: u64) {
    let index = (hash as usize) & (HLL_REGISTERS - 1);
    let rank =
        ((hash >> HLL_PRECISION).leading_zeros() + 1 - HLL_PRECISION) as u8;
    registers[index] = registers[index].max(rank);
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct IdHll {
    pub signal_group_batch_id: i64,
    pub value: i64,
    pub sketch: HllSketch,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct StringHll {
    pub signal_group_batch_id: i64,
    pub value: String,
    pub sketch: HllSketch,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct GroupBucket {
    pub groups: Vec<GroupCount>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct DetailBucket {
    pub aors: Vec<IdCount>,
    pub posts: Vec<IdCount>,
    pub tags: Vec<IdCount>,
    pub senders: Vec<StringCount>,
    pub frequencies: Vec<StringCount>,
    pub callsigns: Vec<StringCount>,
    pub units: Vec<StringCount>,
    pub locations: Vec<StringCount>,
    pub aor_hlls: Vec<IdHll>,
    pub post_hlls: Vec<IdHll>,
    pub tag_hlls: Vec<IdHll>,
    pub sender_hlls: Vec<StringHll>,
    pub frequency_hlls: Vec<StringHll>,
    pub callsign_hlls: Vec<StringHll>,
    pub unit_hlls: Vec<StringHll>,
    pub location_hlls: Vec<StringHll>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct UnitBucket {
    pub units: Vec<IdCount>,
    pub unit_hlls: Vec<IdHll>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct SettlementBucket {
    pub settlements: Vec<IdCount>,
    pub settlement_hlls: Vec<IdHll>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct GeneralDayBucket {
    pub groups: Vec<GroupCount>,
    pub details: DetailBucket,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct FiveMinuteBucket {
    pub groups: GroupBucket,
    pub details: DetailBucket,
    pub units: UnitBucket,
    pub settlements: SettlementBucket,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct NetworkCount {
    pub signal_group_batch_id: i64,
    pub network_id: i64,
    pub quantity: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct NetworkStringCount {
    pub signal_group_batch_id: i64,
    pub network_id: i64,
    pub value: String,
    pub quantity: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct NetworkDayBucket {
    pub networks: Vec<NetworkCount>,
    pub frequencies: Vec<NetworkStringCount>,
    pub callsigns: Vec<NetworkStringCount>,
}

pub(super) async fn build_5min_buckets(
    dbx: &DatabaseConnection,
    rows: &[super::StatsRow],
    network_rows: &[super::NetworkStatsRow],
    network_aors: &HashMap<i64, Vec<i64>>,
    since: NaiveDateTime,
    till: NaiveDateTime,
    batches: &mut HashMap<String, i64>,
) -> anyhow::Result<BTreeMap<NaiveDateTime, FiveMinuteBucket>> {
    let group_counts = count_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            (),
            row.group_master_key.clone(),
        )
    }));
    let frequency_counts = count_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.freq.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let sender_counts = count_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.sender.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let unit_counts = count_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.unit_v2.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let linked_unit_counts = count_group_values(linked_unit_values(rows));
    let settlement_counts = count_group_values(settlement_values(rows));
    let post_counts = count_group_values(rows.iter().filter_map(|row| {
        row.post_id.map(|post_id| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                post_id,
                row.group_master_key.clone(),
            )
        })
    }));
    let tag_counts = count_group_values(rows.iter().flat_map(|row| {
        row.tags
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|tag_id| {
                (
                    bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                    row.id,
                    tag_id,
                    row.group_master_key.clone(),
                )
            })
    }));
    let callsign_counts = count_group_values(rows.iter().flat_map(|row| {
        let callsigns: Vec<String> = row
            .callsigns
            .clone()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        callsigns.into_iter().map(|callsign| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                callsign,
                row.group_master_key.clone(),
            )
        })
    }));
    let location_counts = count_group_values(rows.iter().flat_map(|row| {
        row.location_v2
            .clone()
            .map(|value| {
                value
                    .split('|')
                    .map(|value| value.trim().to_string())
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default()
            .into_iter()
            .map(|location| {
                (
                    bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                    row.id,
                    location,
                    row.group_master_key.clone(),
                )
            })
    }));
    let group_aors = rows.iter().filter_map(|row| {
        row.aor_id.map(|aor_id| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                aor_id,
                row.group_master_key.clone(),
            )
        })
    });
    let network_aor_counts = network_aor_values(network_rows, network_aors);
    let aor_counts = count_group_values(group_aors.chain(network_aor_counts));
    let sender_hlls = hll_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.sender.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let frequency_hlls = hll_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.freq.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let unit_hlls = hll_group_values(rows.iter().map(|row| {
        (
            bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
            row.id,
            row.unit_v2.clone().unwrap_or_default(),
            row.group_master_key.clone(),
        )
    }));
    let linked_unit_hlls = hll_group_values(linked_unit_values(rows));
    let settlement_hlls = hll_group_values(settlement_values(rows));
    let post_hlls = hll_group_values(rows.iter().filter_map(|row| {
        row.post_id.map(|post_id| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                post_id,
                row.group_master_key.clone(),
            )
        })
    }));
    let tag_hlls = hll_group_values(rows.iter().flat_map(|row| {
        row.tags
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|tag_id| {
                (
                    bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                    row.id,
                    tag_id,
                    row.group_master_key.clone(),
                )
            })
    }));
    let callsign_hlls = hll_group_values(rows.iter().flat_map(|row| {
        let callsigns: Vec<String> = row
            .callsigns
            .clone()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        callsigns.into_iter().map(|callsign| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                callsign,
                row.group_master_key.clone(),
            )
        })
    }));
    let location_hlls = hll_group_values(rows.iter().flat_map(|row| {
        row.location_v2
            .clone()
            .map(|value| {
                value
                    .split('|')
                    .map(|value| value.trim().to_string())
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default()
            .into_iter()
            .map(|location| {
                (
                    bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                    row.id,
                    location,
                    row.group_master_key.clone(),
                )
            })
    }));
    let group_aor_hlls = rows.iter().filter_map(|row| {
        row.aor_id.map(|aor_id| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                aor_id,
                row.group_master_key.clone(),
            )
        })
    });
    let network_aor_hlls = network_aor_values(network_rows, network_aors);
    let aor_hlls = hll_group_values(group_aor_hlls.chain(network_aor_hlls));

    let batch_keys = group_counts
        .keys()
        .map(|(_, batch_key, _)| batch_key)
        .chain(frequency_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(sender_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(unit_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(linked_unit_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(settlement_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(post_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(tag_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(callsign_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(location_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(aor_counts.keys().map(|(_, batch_key, _)| batch_key))
        .cloned()
        .collect::<HashSet<_>>();
    ensure_batch_keys(dbx, batches, batch_keys).await?;

    let mut result = empty_5min_buckets(since, till);
    append_group_counts(&mut result, group_counts, batches)?;
    append_string_counts(&mut result, frequency_counts, batches, |details| {
        &mut details.frequencies
    })?;
    append_string_counts(&mut result, sender_counts, batches, |details| {
        &mut details.senders
    })?;
    append_string_counts(&mut result, unit_counts, batches, |details| {
        &mut details.units
    })?;
    append_id_counts(&mut result, linked_unit_counts, batches, |bucket| {
        &mut bucket.units.units
    })
    .context(h!())?;
    append_id_counts(&mut result, settlement_counts, batches, |bucket| {
        &mut bucket.settlements.settlements
    })
    .context(h!())?;
    append_string_counts(&mut result, callsign_counts, batches, |details| {
        &mut details.callsigns
    })?;
    append_string_counts(&mut result, location_counts, batches, |details| {
        &mut details.locations
    })?;
    append_id_counts(&mut result, post_counts, batches, |bucket| {
        &mut bucket.details.posts
    })?;
    append_id_counts(&mut result, tag_counts, batches, |bucket| {
        &mut bucket.details.tags
    })?;
    append_id_counts(&mut result, aor_counts, batches, |bucket| {
        &mut bucket.details.aors
    })?;
    append_string_hlls(&mut result, sender_hlls, batches, |details| {
        &mut details.sender_hlls
    })?;
    append_string_hlls(&mut result, frequency_hlls, batches, |details| {
        &mut details.frequency_hlls
    })?;
    append_string_hlls(&mut result, unit_hlls, batches, |details| {
        &mut details.unit_hlls
    })?;
    append_id_hlls(&mut result, linked_unit_hlls, batches, |bucket| {
        &mut bucket.units.unit_hlls
    })
    .context(h!())?;
    append_id_hlls(&mut result, settlement_hlls, batches, |bucket| {
        &mut bucket.settlements.settlement_hlls
    })
    .context(h!())?;
    append_id_hlls(&mut result, post_hlls, batches, |bucket| {
        &mut bucket.details.post_hlls
    })?;
    append_id_hlls(&mut result, tag_hlls, batches, |bucket| {
        &mut bucket.details.tag_hlls
    })?;
    append_string_hlls(&mut result, callsign_hlls, batches, |details| {
        &mut details.callsign_hlls
    })?;
    append_string_hlls(&mut result, location_hlls, batches, |details| {
        &mut details.location_hlls
    })?;
    append_id_hlls(&mut result, aor_hlls, batches, |bucket| {
        &mut bucket.details.aor_hlls
    })?;
    Ok(result)
}

fn linked_unit_values(
    rows: &[super::StatsRow],
) -> impl Iterator<Item = (NaiveDateTime, i64, i64, String)> + '_ {
    rows.iter().flat_map(|row| {
        row.linked_unit_ids.iter().copied().map(move |unit_id| {
            (
                bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                row.id,
                unit_id,
                row.group_master_key.clone(),
            )
        })
    })
}

fn settlement_values(
    rows: &[super::StatsRow],
) -> impl Iterator<Item = (NaiveDateTime, i64, i64, String)> + '_ {
    rows.iter().flat_map(|row| {
        row.settlement_ids
            .iter()
            .copied()
            .map(move |settlement_id| {
                (
                    bucket_timestamp(row.datetime.unwrap_or(row.created_at)),
                    row.id,
                    settlement_id,
                    row.group_master_key.clone(),
                )
            })
    })
}

fn network_aor_values<'a>(
    network_rows: &'a [super::NetworkStatsRow],
    network_aors: &'a HashMap<i64, Vec<i64>>,
) -> impl Iterator<Item = (NaiveDateTime, i64, i64, String)> + 'a {
    network_rows.iter().flat_map(|row| {
        network_aors
            .get(&row.network_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|aor_id| {
                (
                    bucket_timestamp(
                        row.datetime
                            .or(row.timestamp)
                            .unwrap_or(row.created_at),
                    ),
                    row.id,
                    aor_id,
                    row.group_master_key.clone(),
                )
            })
    })
}

pub(super) fn aggregate_general_day(
    groups: impl IntoIterator<Item = GroupBucket>,
    details: impl IntoIterator<Item = DetailBucket>,
) -> GeneralDayBucket {
    GeneralDayBucket {
        groups: aggregate_group_counts(
            groups.into_iter().flat_map(|bucket| bucket.groups),
        ),
        details: aggregate_detail_buckets(details),
    }
}

pub(super) fn aggregate_unit_day(
    buckets: impl IntoIterator<Item = UnitBucket>,
) -> UnitBucket {
    let buckets = buckets.into_iter().collect::<Vec<_>>();
    UnitBucket {
        units: aggregate_id_counts(
            buckets.iter().flat_map(|bucket| bucket.units.clone()),
        ),
        unit_hlls: aggregate_id_hlls(
            buckets.iter().flat_map(|bucket| bucket.unit_hlls.clone()),
        ),
    }
}

pub(super) fn aggregate_settlement_day(
    buckets: impl IntoIterator<Item = SettlementBucket>,
) -> SettlementBucket {
    let buckets = buckets.into_iter().collect::<Vec<_>>();
    SettlementBucket {
        settlements: aggregate_id_counts(
            buckets.iter().flat_map(|bucket| bucket.settlements.clone()),
        ),
        settlement_hlls: aggregate_id_hlls(
            buckets
                .iter()
                .flat_map(|bucket| bucket.settlement_hlls.clone()),
        ),
    }
}

pub(super) async fn build_network_days(
    dbx: &DatabaseConnection,
    rows: &[super::NetworkStatsRow],
    batches: &mut HashMap<String, i64>,
) -> anyhow::Result<BTreeMap<NaiveDate, NetworkDayBucket>> {
    let message_groups = rows.iter().fold(
        HashMap::<i64, HashSet<String>>::new(),
        |mut result, row| {
            result
                .entry(row.id)
                .or_default()
                .insert(row.group_master_key.clone());
            result
        },
    );
    let message_batch_keys = message_groups
        .into_iter()
        .map(|(id, keys)| (id, super::all_to_batch_key(keys)))
        .collect::<HashMap<_, _>>();
    ensure_batch_keys(
        dbx,
        batches,
        message_batch_keys.values().cloned().collect(),
    )
    .await?;

    let mut network_counts = HashMap::<(NaiveDate, i64, i64), i32>::new();
    let mut frequency_counts =
        HashMap::<(NaiveDate, i64, i64, String), i32>::new();
    let mut callsign_counts =
        HashMap::<(NaiveDate, i64, i64, String), i32>::new();
    let mut processed = HashSet::new();
    for row in rows {
        if !processed.insert((row.id, row.network_id)) {
            continue;
        }
        let timestamp =
            row.datetime.or(row.timestamp).unwrap_or(row.created_at);
        let date = super::get_local_date(timestamp);
        let batch_key = message_batch_keys.get(&row.id).context(
            "missing group batch key for network statistics message",
        )?;
        let batch_id = *batches
            .get(batch_key)
            .context("missing group batch for network statistics message")?;
        *network_counts
            .entry((date, batch_id, row.network_id))
            .or_default() += 1;

        if let Some(frequency) = row
            .freq
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            *frequency_counts
                .entry((date, batch_id, row.network_id, frequency.to_string()))
                .or_default() += 1;
        }
        let callsigns: Vec<String> = row
            .callsigns
            .clone()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        for callsign in callsigns {
            let callsign = callsign.trim();
            if !callsign.is_empty() {
                *callsign_counts
                    .entry((
                        date,
                        batch_id,
                        row.network_id,
                        callsign.to_string(),
                    ))
                    .or_default() += 1;
            }
        }
    }

    let mut result = BTreeMap::<NaiveDate, NetworkDayBucket>::new();
    for ((date, signal_group_batch_id, network_id), quantity) in network_counts
    {
        result.entry(date).or_default().networks.push(NetworkCount {
            signal_group_batch_id,
            network_id,
            quantity,
        });
    }
    for ((date, signal_group_batch_id, network_id, value), quantity) in
        frequency_counts
    {
        result
            .entry(date)
            .or_default()
            .frequencies
            .push(NetworkStringCount {
                signal_group_batch_id,
                network_id,
                value,
                quantity,
            });
    }
    for ((date, signal_group_batch_id, network_id, value), quantity) in
        callsign_counts
    {
        result
            .entry(date)
            .or_default()
            .callsigns
            .push(NetworkStringCount {
                signal_group_batch_id,
                network_id,
                value,
                quantity,
            });
    }
    Ok(result)
}

fn bucket_timestamp(timestamp: NaiveDateTime) -> NaiveDateTime {
    super::round_to_5min(timestamp)
        .expect("valid timestamp must round to a five-minute bucket")
}

fn count_group_values<V>(
    rows: impl IntoIterator<Item = (NaiveDateTime, i64, V, String)>,
) -> HashMap<(NaiveDateTime, String, V), i32>
where
    V: Clone + Eq + Hash,
{
    let grouped = rows.into_iter().fold(
        HashMap::<(NaiveDateTime, i64, V), HashSet<String>>::new(),
        |mut result, (timestamp, id, value, group)| {
            result
                .entry((timestamp, id, value))
                .or_default()
                .insert(group);
            result
        },
    );
    grouped.into_iter().fold(
        HashMap::new(),
        |mut result, ((timestamp, _, value), groups)| {
            *result
                .entry((timestamp, super::all_to_batch_key(groups), value))
                .or_default() += 1;
            result
        },
    )
}

fn hll_group_values<V>(
    rows: impl IntoIterator<Item = (NaiveDateTime, i64, V, String)>,
) -> HashMap<(NaiveDateTime, String, V), HllSketch>
where
    V: Clone + Eq + Hash,
{
    let grouped = rows.into_iter().fold(
        HashMap::<(NaiveDateTime, i64, V), HashSet<String>>::new(),
        |mut result, (timestamp, id, value, group)| {
            result
                .entry((timestamp, id, value))
                .or_default()
                .insert(group);
            result
        },
    );
    grouped.into_iter().fold(
        HashMap::new(),
        |mut result, ((timestamp, id, value), groups)| {
            result
                .entry((timestamp, super::all_to_batch_key(groups), value))
                .or_insert_with(HllSketch::default)
                .insert_message_id(id);
            result
        },
    )
}

async fn ensure_batch_keys(
    dbx: &DatabaseConnection,
    batches: &mut HashMap<String, i64>,
    batch_keys: HashSet<String>,
) -> anyhow::Result<()> {
    let txn = dbx.begin().await?;
    for batch_key in batch_keys {
        super::ensure_batch_key(&txn, batches, &batch_key).await?;
    }
    txn.commit().await?;
    Ok(())
}

fn empty_5min_buckets(
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> BTreeMap<NaiveDateTime, FiveMinuteBucket> {
    let mut result = BTreeMap::new();
    let mut timestamp = since;
    while timestamp < till {
        result.insert(timestamp, Default::default());
        timestamp += Duration::minutes(5);
    }
    result
}

fn append_group_counts(
    result: &mut BTreeMap<NaiveDateTime, FiveMinuteBucket>,
    counts: HashMap<(NaiveDateTime, String, ()), i32>,
    batches: &HashMap<String, i64>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, ()), quantity) in counts {
        result
            .get_mut(&timestamp)
            .context("group count is outside requested bucket range")?
            .groups
            .groups
            .push(GroupCount {
                signal_group_batch_id: *batches
                    .get(&batch_key)
                    .context("missing group batch")?,
                quantity,
            });
    }
    Ok(())
}

fn append_id_counts(
    result: &mut BTreeMap<NaiveDateTime, FiveMinuteBucket>,
    counts: HashMap<(NaiveDateTime, String, i64), i32>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut FiveMinuteBucket) -> &mut Vec<IdCount>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), quantity) in counts {
        select(
            result
                .get_mut(&timestamp)
                .context("ID count is outside requested bucket range")?,
        )
        .push(IdCount {
            signal_group_batch_id: *batches
                .get(&batch_key)
                .context("missing group batch")?,
            value,
            quantity,
        });
    }
    Ok(())
}

fn append_string_counts(
    result: &mut BTreeMap<NaiveDateTime, FiveMinuteBucket>,
    counts: HashMap<(NaiveDateTime, String, String), i32>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut DetailBucket) -> &mut Vec<StringCount>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), quantity) in counts {
        select(
            &mut result
                .get_mut(&timestamp)
                .context("string count is outside requested bucket range")?
                .details,
        )
        .push(StringCount {
            signal_group_batch_id: *batches
                .get(&batch_key)
                .context("missing group batch")?,
            value,
            quantity,
        });
    }
    Ok(())
}

fn append_id_hlls(
    result: &mut BTreeMap<NaiveDateTime, FiveMinuteBucket>,
    hlls: HashMap<(NaiveDateTime, String, i64), HllSketch>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut FiveMinuteBucket) -> &mut Vec<IdHll>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), sketch) in hlls {
        select(
            result.get_mut(&timestamp).context(
                "HLL ID statistic is outside requested bucket range",
            )?,
        )
        .push(IdHll {
            signal_group_batch_id: *batches
                .get(&batch_key)
                .context("missing group batch")?,
            value,
            sketch,
        });
    }
    Ok(())
}

fn append_string_hlls(
    result: &mut BTreeMap<NaiveDateTime, FiveMinuteBucket>,
    hlls: HashMap<(NaiveDateTime, String, String), HllSketch>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut DetailBucket) -> &mut Vec<StringHll>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), sketch) in hlls {
        select(
            &mut result
                .get_mut(&timestamp)
                .context(
                    "HLL string statistic is outside requested bucket range",
                )?
                .details,
        )
        .push(StringHll {
            signal_group_batch_id: *batches
                .get(&batch_key)
                .context("missing group batch")?,
            value,
            sketch,
        });
    }
    Ok(())
}

fn aggregate_group_counts(
    counts: impl IntoIterator<Item = GroupCount>,
) -> Vec<GroupCount> {
    counts
        .into_iter()
        .fold(HashMap::<i64, i32>::new(), |mut result, count| {
            *result.entry(count.signal_group_batch_id).or_default() +=
                count.quantity;
            result
        })
        .into_iter()
        .map(|(signal_group_batch_id, quantity)| GroupCount {
            signal_group_batch_id,
            quantity,
        })
        .collect()
}

fn aggregate_detail_buckets(
    buckets: impl IntoIterator<Item = DetailBucket>,
) -> DetailBucket {
    let buckets = buckets.into_iter().collect::<Vec<_>>();
    DetailBucket {
        aors: aggregate_id_counts(
            buckets.iter().flat_map(|bucket| bucket.aors.clone()),
        ),
        posts: aggregate_id_counts(
            buckets.iter().flat_map(|bucket| bucket.posts.clone()),
        ),
        tags: aggregate_id_counts(
            buckets.iter().flat_map(|bucket| bucket.tags.clone()),
        ),
        senders: aggregate_string_counts(
            buckets.iter().flat_map(|bucket| bucket.senders.clone()),
        ),
        frequencies: aggregate_string_counts(
            buckets.iter().flat_map(|bucket| bucket.frequencies.clone()),
        ),
        callsigns: aggregate_string_counts(
            buckets.iter().flat_map(|bucket| bucket.callsigns.clone()),
        ),
        units: aggregate_string_counts(
            buckets.iter().flat_map(|bucket| bucket.units.clone()),
        ),
        locations: aggregate_string_counts(
            buckets.iter().flat_map(|bucket| bucket.locations.clone()),
        ),
        aor_hlls: aggregate_id_hlls(
            buckets.iter().flat_map(|bucket| bucket.aor_hlls.clone()),
        ),
        post_hlls: aggregate_id_hlls(
            buckets.iter().flat_map(|bucket| bucket.post_hlls.clone()),
        ),
        tag_hlls: aggregate_id_hlls(
            buckets.iter().flat_map(|bucket| bucket.tag_hlls.clone()),
        ),
        sender_hlls: aggregate_string_hlls(
            buckets.iter().flat_map(|bucket| bucket.sender_hlls.clone()),
        ),
        frequency_hlls: aggregate_string_hlls(
            buckets
                .iter()
                .flat_map(|bucket| bucket.frequency_hlls.clone()),
        ),
        callsign_hlls: aggregate_string_hlls(
            buckets
                .iter()
                .flat_map(|bucket| bucket.callsign_hlls.clone()),
        ),
        unit_hlls: aggregate_string_hlls(
            buckets.iter().flat_map(|bucket| bucket.unit_hlls.clone()),
        ),
        location_hlls: aggregate_string_hlls(
            buckets
                .iter()
                .flat_map(|bucket| bucket.location_hlls.clone()),
        ),
    }
}

fn aggregate_id_counts(
    counts: impl IntoIterator<Item = IdCount>,
) -> Vec<IdCount> {
    counts
        .into_iter()
        .fold(HashMap::<(i64, i64), i32>::new(), |mut result, count| {
            *result
                .entry((count.signal_group_batch_id, count.value))
                .or_default() += count.quantity;
            result
        })
        .into_iter()
        .map(|((signal_group_batch_id, value), quantity)| IdCount {
            signal_group_batch_id,
            value,
            quantity,
        })
        .collect()
}

fn aggregate_string_counts(
    counts: impl IntoIterator<Item = StringCount>,
) -> Vec<StringCount> {
    counts
        .into_iter()
        .fold(HashMap::<(i64, String), i32>::new(), |mut result, count| {
            *result
                .entry((count.signal_group_batch_id, count.value))
                .or_default() += count.quantity;
            result
        })
        .into_iter()
        .map(|((signal_group_batch_id, value), quantity)| StringCount {
            signal_group_batch_id,
            value,
            quantity,
        })
        .collect()
}

fn aggregate_id_hlls(hlls: impl IntoIterator<Item = IdHll>) -> Vec<IdHll> {
    hlls.into_iter()
        .fold(
            HashMap::<(i64, i64), HllSketch>::new(),
            |mut result, hll| {
                result
                    .entry((hll.signal_group_batch_id, hll.value))
                    .or_default()
                    .merge(&hll.sketch);
                result
            },
        )
        .into_iter()
        .map(|((signal_group_batch_id, value), sketch)| IdHll {
            signal_group_batch_id,
            value,
            sketch,
        })
        .collect()
}

fn aggregate_string_hlls(
    hlls: impl IntoIterator<Item = StringHll>,
) -> Vec<StringHll> {
    hlls.into_iter()
        .fold(
            HashMap::<(i64, String), HllSketch>::new(),
            |mut result, hll| {
                result
                    .entry((hll.signal_group_batch_id, hll.value))
                    .or_default()
                    .merge(&hll.sketch);
                result
            },
        )
        .into_iter()
        .map(|((signal_group_batch_id, value), sketch)| StringHll {
            signal_group_batch_id,
            value,
            sketch,
        })
        .collect()
}

#[derive(Clone)]
pub struct GroupStatsRedis {
    redis: ConnectionManager,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RepairBucket {
    FiveMinute(NaiveDateTime),
    GeneralDay(NaiveDate),
    NetworkDay(NaiveDate),
}

pub(super) struct RepairLock {
    redis: ConnectionManager,
    key: String,
    token: String,
}

impl GroupStatsRedis {
    pub fn new(redis: ConnectionManager) -> Self {
        Self { redis }
    }

    pub async fn write_5min(
        &self,
        timestamp: NaiveDateTime,
        groups: &GroupBucket,
        details: &DetailBucket,
    ) -> anyhow::Result<()> {
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            group_5min_key(timestamp),
            groups,
            timestamp + Duration::days(GROUP_STATS_REDIS_GROUP_5MIN_TTL_DAYS),
        )
        .await?;
        write_expiring(
            &mut redis,
            detail_5min_key(timestamp),
            details,
            timestamp + Duration::days(GROUP_STATS_REDIS_DETAIL_5MIN_TTL_DAYS),
        )
        .await
    }

    pub async fn write_unit_5min(
        &self,
        timestamp: NaiveDateTime,
        units: &UnitBucket,
    ) -> anyhow::Result<()> {
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            unit_5min_key(timestamp),
            units,
            timestamp + Duration::days(GROUP_STATS_REDIS_DETAIL_5MIN_TTL_DAYS),
        )
        .await
    }

    pub async fn write_settlement_5min(
        &self,
        timestamp: NaiveDateTime,
        settlements: &SettlementBucket,
    ) -> anyhow::Result<()> {
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            settlement_5min_key(timestamp),
            settlements,
            timestamp + Duration::days(GROUP_STATS_REDIS_DETAIL_5MIN_TTL_DAYS),
        )
        .await
        .context(h!())
    }

    pub async fn write_general_day(
        &self,
        date: NaiveDate,
        bucket: &GeneralDayBucket,
    ) -> anyhow::Result<()> {
        let timestamp = super::start_of_day(date)?;
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            general_day_key(date),
            bucket,
            timestamp + Duration::days(GROUP_STATS_REDIS_DAY_TTL_DAYS),
        )
        .await
    }

    pub async fn write_unit_day(
        &self,
        date: NaiveDate,
        units: &UnitBucket,
    ) -> anyhow::Result<()> {
        let timestamp = super::start_of_day(date).context(h!())?;
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            unit_day_key(date),
            units,
            timestamp + Duration::days(GROUP_STATS_REDIS_DAY_TTL_DAYS),
        )
        .await
    }

    pub async fn write_settlement_day(
        &self,
        date: NaiveDate,
        settlements: &SettlementBucket,
    ) -> anyhow::Result<()> {
        let timestamp = super::start_of_day(date).context(h!())?;
        let mut redis = self.redis.clone();
        write_expiring(
            &mut redis,
            settlement_day_key(date),
            settlements,
            timestamp + Duration::days(GROUP_STATS_REDIS_DAY_TTL_DAYS),
        )
        .await
        .context(h!())
    }

    pub async fn replace_network_day(
        &self,
        date: NaiveDate,
        bucket: &NetworkDayBucket,
    ) -> anyhow::Result<()> {
        let mut redis = self.redis.clone();
        replace_expiring_network_hash(
            &mut redis,
            network_day_key(date),
            bucket,
            network_day_expiry(date)?,
        )
        .await
    }

    pub async fn update_network_day(
        &self,
        date: NaiveDate,
        network_ids: &HashSet<i64>,
        bucket: &NetworkDayBucket,
    ) -> anyhow::Result<()> {
        let mut redis = self.redis.clone();
        update_expiring_network_hash(
            &mut redis,
            network_day_key(date),
            network_ids,
            bucket,
            network_day_expiry(date)?,
        )
        .await
    }

    pub async fn read_group_5min(
        &self,
        timestamps: &[NaiveDateTime],
    ) -> anyhow::Result<Vec<GroupBucket>> {
        self.read_required(
            timestamps.iter().copied().map(group_5min_key).collect(),
        )
        .await
    }

    pub async fn read_detail_5min(
        &self,
        timestamps: &[NaiveDateTime],
    ) -> anyhow::Result<Vec<DetailBucket>> {
        self.read_required(
            timestamps.iter().copied().map(detail_5min_key).collect(),
        )
        .await
    }

    pub async fn read_unit_5min(
        &self,
        timestamps: &[NaiveDateTime],
    ) -> anyhow::Result<Vec<UnitBucket>> {
        self.read_required(
            timestamps.iter().copied().map(unit_5min_key).collect(),
        )
        .await
    }

    pub async fn read_settlement_5min(
        &self,
        timestamps: &[NaiveDateTime],
    ) -> anyhow::Result<Vec<SettlementBucket>> {
        self.read_required(
            timestamps
                .iter()
                .copied()
                .map(settlement_5min_key)
                .collect(),
        )
        .await
        .context(h!())
    }

    pub async fn read_general_days(
        &self,
        dates: &[NaiveDate],
    ) -> anyhow::Result<Vec<GeneralDayBucket>> {
        self.read_required(dates.iter().copied().map(general_day_key).collect())
            .await
    }

    pub async fn read_unit_days(
        &self,
        dates: &[NaiveDate],
    ) -> anyhow::Result<Vec<UnitBucket>> {
        self.read_required(dates.iter().copied().map(unit_day_key).collect())
            .await
    }

    pub async fn read_network_days(
        &self,
        dates: &[NaiveDate],
        network_ids: &HashSet<i64>,
    ) -> anyhow::Result<Vec<NetworkDayBucket>> {
        if dates.is_empty() {
            return Ok(Vec::new());
        }
        let network_ids = network_ids.iter().copied().sorted().collect_vec();
        let values = self.read_network_day_values(dates, &network_ids).await?;
        dates
            .iter()
            .zip(values)
            .map(|(date, values)| {
                decode_network_day(*date, &network_ids, values)
            })
            .collect()
    }

    async fn read_network_day_values(
        &self,
        dates: &[NaiveDate],
        network_ids: &[i64],
    ) -> anyhow::Result<Vec<Vec<Option<Vec<u8>>>>> {
        let mut pipe = redis::pipe();
        for date in dates {
            pipe.cmd("HMGET")
                .arg(network_day_key(*date))
                .arg(GROUP_STATS_REDIS_NETWORK_COMPLETE_FIELD)
                .arg(network_ids);
        }
        let mut redis = self.redis.clone();
        pipe.query_async::<Vec<Vec<Option<Vec<u8>>>>>(&mut redis)
            .await
            .context("read Redis network statistics")
    }

    pub async fn is_network_day_complete(
        &self,
        date: NaiveDate,
    ) -> anyhow::Result<bool> {
        let key = network_day_key(date);
        let mut redis = self.redis.clone();
        redis::cmd("HEXISTS")
            .arg(&key)
            .arg(GROUP_STATS_REDIS_NETWORK_COMPLETE_FIELD)
            .query_async::<bool>(&mut redis)
            .await
            .with_context(|| format!("check Redis network stats key {key}"))
    }

    pub(super) async fn missing_five_minute_buckets(
        &self,
        timestamps: &[NaiveDateTime],
    ) -> anyhow::Result<Vec<NaiveDateTime>> {
        let timestamps = timestamps.iter().copied().unique().collect_vec();
        let keys = timestamps
            .iter()
            .flat_map(|timestamp| {
                [
                    group_5min_key(*timestamp),
                    detail_5min_key(*timestamp),
                    unit_5min_key(*timestamp),
                    settlement_5min_key(*timestamp),
                ]
            })
            .collect_vec();
        let values = self.read_optional(keys).await.context(h!())?;
        Ok(timestamps
            .into_iter()
            .zip(values.chunks_exact(4))
            .filter_map(|(timestamp, values)| {
                let valid = matches!(
                    values,
                    [Some(groups), Some(details), Some(units), Some(settlements)]
                        if decode::<GroupBucket>(groups).is_ok()
                            && decode::<DetailBucket>(details).is_ok()
                            && decode::<UnitBucket>(units).is_ok()
                            && decode::<SettlementBucket>(settlements).is_ok()
                );
                (!valid).then_some(timestamp)
            })
            .collect())
    }

    pub(super) async fn missing_general_days(
        &self,
        dates: &[NaiveDate],
    ) -> anyhow::Result<Vec<NaiveDate>> {
        let dates = dates.iter().copied().unique().collect_vec();
        let keys = dates
            .iter()
            .flat_map(|date| {
                [
                    general_day_key(*date),
                    unit_day_key(*date),
                    settlement_day_key(*date),
                ]
            })
            .collect_vec();
        let values = self.read_optional(keys).await.context(h!())?;
        Ok(dates
            .into_iter()
            .zip(values.chunks_exact(3))
            .filter_map(|(date, values)| {
                let valid = matches!(
                    values,
                    [Some(general), Some(units), Some(settlements)]
                        if decode::<GeneralDayBucket>(general).is_ok()
                            && decode::<UnitBucket>(units).is_ok()
                            && decode::<SettlementBucket>(settlements).is_ok()
                );
                (!valid).then_some(date)
            })
            .collect())
    }

    pub(super) async fn missing_network_days(
        &self,
        dates: &[NaiveDate],
        network_ids: &HashSet<i64>,
    ) -> anyhow::Result<Vec<NaiveDate>> {
        let dates = dates.iter().copied().unique().collect_vec();
        let network_ids = network_ids.iter().copied().sorted().collect_vec();
        let values = self.read_network_day_values(&dates, &network_ids).await?;
        Ok(dates
            .into_iter()
            .zip(values)
            .filter_map(|(date, values)| {
                decode_network_day(date, &network_ids, values)
                    .is_err()
                    .then_some(date)
            })
            .collect())
    }

    pub(super) async fn try_acquire_repair_lock(
        &self,
        bucket: RepairBucket,
    ) -> anyhow::Result<Option<RepairLock>> {
        let key = repair_lock_key(bucket);
        let token = Uuid::new_v4().to_string();
        let mut redis = self.redis.clone();
        let acquired = redis::cmd("SET")
            .arg(&key)
            .arg(&token)
            .arg("NX")
            .arg("EX")
            .arg(GROUP_STATS_REDIS_REPAIR_LOCK_TTL_SECS)
            .query_async::<Option<String>>(&mut redis)
            .await
            .with_context(|| format!("acquire Redis stats repair lock {key}"))?
            .is_some();
        Ok(acquired.then_some(RepairLock {
            redis: self.redis.clone(),
            key,
            token,
        }))
    }

    pub(super) async fn repair_is_complete(
        &self,
        bucket: RepairBucket,
    ) -> anyhow::Result<bool> {
        match bucket {
            RepairBucket::FiveMinute(timestamp) => Ok(self
                .missing_five_minute_buckets(&[timestamp])
                .await?
                .is_empty()),
            RepairBucket::GeneralDay(date) => {
                Ok(self.missing_general_days(&[date]).await?.is_empty())
            }
            RepairBucket::NetworkDay(date) => {
                self.is_network_day_complete(date).await
            }
        }
    }

    pub(super) async fn wait_for_repair(
        &self,
        bucket: RepairBucket,
    ) -> anyhow::Result<()> {
        let deadline = TokioInstant::now()
            + TokioDuration::from_secs(
                GROUP_STATS_REDIS_REPAIR_WAIT_TIMEOUT_SECS,
            );
        loop {
            if self.repair_is_complete(bucket).await? {
                return Ok(());
            }
            if TokioInstant::now() >= deadline {
                bail!("timed out waiting for Redis stats repair {bucket:?}");
            }
            sleep(TokioDuration::from_millis(
                GROUP_STATS_REDIS_REPAIR_WAIT_INTERVAL_MS,
            ))
            .await;
        }
    }

    pub(super) async fn network_day_is_readable(
        &self,
        date: NaiveDate,
        network_ids: &HashSet<i64>,
    ) -> anyhow::Result<bool> {
        let network_ids = network_ids.iter().copied().sorted().collect_vec();
        let mut values =
            self.read_network_day_values(&[date], &network_ids).await?;
        Ok(decode_network_day(date, &network_ids, values.remove(0)).is_ok())
    }

    pub(super) async fn wait_for_network_repair(
        &self,
        date: NaiveDate,
        network_ids: &HashSet<i64>,
    ) -> anyhow::Result<()> {
        let deadline = TokioInstant::now()
            + TokioDuration::from_secs(
                GROUP_STATS_REDIS_REPAIR_WAIT_TIMEOUT_SECS,
            );
        loop {
            if self.network_day_is_readable(date, network_ids).await? {
                return Ok(());
            }
            if TokioInstant::now() >= deadline {
                bail!(
                    "timed out waiting for Redis network stats repair {date}"
                );
            }
            sleep(TokioDuration::from_millis(
                GROUP_STATS_REDIS_REPAIR_WAIT_INTERVAL_MS,
            ))
            .await;
        }
    }

    async fn read_optional(
        &self,
        keys: Vec<String>,
    ) -> anyhow::Result<Vec<Option<Vec<u8>>>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut redis = self.redis.clone();
        redis::cmd("MGET")
            .arg(keys)
            .query_async(&mut redis)
            .await
            .context("read optional Redis group stats buckets")
    }

    async fn read_required<T>(
        &self,
        keys: Vec<String>,
    ) -> anyhow::Result<Vec<T>>
    where
        T: DeserializeOwned,
    {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut redis = self.redis.clone();
        let values = redis::cmd("MGET")
            .arg(&keys)
            .query_async::<Vec<Option<Vec<u8>>>>(&mut redis)
            .await
            .context("read Redis group stats buckets")?;
        let mut result = Vec::with_capacity(values.len());
        for (key, value) in keys.into_iter().zip(values) {
            let Some(value) = value else {
                bail!("missing Redis group stats bucket {key}");
            };
            result
                .push(decode(&value).with_context(|| format!("decode {key}"))?);
        }
        Ok(result)
    }
}

impl RepairLock {
    pub(super) async fn release(mut self) -> anyhow::Result<()> {
        redis::cmd("EVAL")
            .arg(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then \
                 return redis.call('DEL', KEYS[1]) else return 0 end",
            )
            .arg(1)
            .arg(&self.key)
            .arg(&self.token)
            .query_async::<i64>(&mut self.redis)
            .await
            .with_context(|| {
                format!("release Redis stats repair lock {}", self.key)
            })?;
        Ok(())
    }
}

fn decode_network_day(
    date: NaiveDate,
    network_ids: &[i64],
    mut values: Vec<Option<Vec<u8>>>,
) -> anyhow::Result<NetworkDayBucket> {
    if values.first().and_then(Option::as_ref).is_none() {
        bail!("missing Redis network stats bucket for {date}");
    }
    values.remove(0);
    let mut bucket = NetworkDayBucket::default();
    for (network_id, value) in network_ids.iter().copied().zip(values) {
        let Some(value) = value else {
            continue;
        };
        let value: NetworkDayBucket = decode(&value).with_context(|| {
            format!(
                "decode Redis network stats for {date}, network {network_id}"
            )
        })?;
        bucket.networks.extend(value.networks);
        bucket.frequencies.extend(value.frequencies);
        bucket.callsigns.extend(value.callsigns);
    }
    Ok(bucket)
}

async fn replace_expiring_network_hash(
    redis: &mut ConnectionManager,
    key: String,
    bucket: &NetworkDayBucket,
    expires_at: NaiveDateTime,
) -> anyhow::Result<()> {
    let expires_at = expires_at.and_utc().timestamp();
    if expires_at <= Utc::now().timestamp() {
        redis::cmd("DEL")
            .arg(key)
            .query_async::<()>(redis)
            .await
            .context("delete expired Redis network stats")?;
        return Ok(());
    }
    let buckets = split_network_bucket(bucket);
    let mut pipe = redis::pipe();
    pipe.atomic()
        .cmd("DEL")
        .arg(&key)
        .ignore()
        .cmd("HSET")
        .arg(&key)
        .arg(GROUP_STATS_REDIS_NETWORK_COMPLETE_FIELD)
        .arg(1)
        .ignore();
    append_network_hash_values(&mut pipe, &key, buckets)?;
    pipe.cmd("EXPIREAT")
        .arg(&key)
        .arg(expires_at)
        .ignore()
        .query_async::<()>(redis)
        .await
        .with_context(|| format!("replace Redis network stats key {key}"))
}

async fn update_expiring_network_hash(
    redis: &mut ConnectionManager,
    key: String,
    network_ids: &HashSet<i64>,
    bucket: &NetworkDayBucket,
    expires_at: NaiveDateTime,
) -> anyhow::Result<()> {
    if network_ids.is_empty() {
        return Ok(());
    }
    let expires_at = expires_at.and_utc().timestamp();
    if expires_at <= Utc::now().timestamp() {
        return Ok(());
    }
    let buckets = split_network_bucket(bucket);
    let mut pipe = redis::pipe();
    pipe.atomic()
        .cmd("HDEL")
        .arg(&key)
        .arg(network_ids.iter().copied().collect_vec())
        .ignore();
    append_network_hash_values(&mut pipe, &key, buckets)?;
    pipe.cmd("EXPIREAT")
        .arg(&key)
        .arg(expires_at)
        .ignore()
        .query_async::<()>(redis)
        .await
        .with_context(|| format!("update Redis network stats key {key}"))
}

fn append_network_hash_values(
    pipe: &mut redis::Pipeline,
    key: &str,
    buckets: HashMap<i64, NetworkDayBucket>,
) -> anyhow::Result<()> {
    for (network_id, bucket) in buckets {
        pipe.cmd("HSET")
            .arg(key)
            .arg(network_id)
            .arg(encode(&bucket)?)
            .ignore();
    }
    Ok(())
}

fn split_network_bucket(
    bucket: &NetworkDayBucket,
) -> HashMap<i64, NetworkDayBucket> {
    let mut result = HashMap::<i64, NetworkDayBucket>::new();
    for row in &bucket.networks {
        result
            .entry(row.network_id)
            .or_default()
            .networks
            .push(row.clone());
    }
    for row in &bucket.frequencies {
        result
            .entry(row.network_id)
            .or_default()
            .frequencies
            .push(row.clone());
    }
    for row in &bucket.callsigns {
        result
            .entry(row.network_id)
            .or_default()
            .callsigns
            .push(row.clone());
    }
    result
}

fn network_day_expiry(date: NaiveDate) -> anyhow::Result<NaiveDateTime> {
    Ok(super::start_of_day(date)?
        + Duration::days(GROUP_STATS_REDIS_DAY_TTL_DAYS))
}

async fn write_expiring<T>(
    redis: &mut ConnectionManager,
    key: String,
    value: &T,
    expires_at: NaiveDateTime,
) -> anyhow::Result<()>
where
    T: Serialize,
{
    let expires_at = expires_at.and_utc().timestamp();
    if expires_at <= Utc::now().timestamp() {
        redis::cmd("DEL")
            .arg(key)
            .query_async::<()>(redis)
            .await
            .context("delete expired Redis group stats bucket")?;
        return Ok(());
    }

    let value = encode(value)?;
    redis::pipe()
        .atomic()
        .cmd("SET")
        .arg(&key)
        .arg(value)
        .ignore()
        .cmd("EXPIREAT")
        .arg(&key)
        .arg(expires_at)
        .ignore()
        .query_async::<()>(redis)
        .await
        .with_context(|| format!("write Redis group stats key {key}"))?;
    Ok(())
}

fn encode<T: Serialize>(value: &T) -> anyhow::Result<Vec<u8>> {
    let value = postcard::to_stdvec(value).context("serialize stats bucket")?;
    zstd::stream::encode_all(Cursor::new(value), GROUP_STATS_REDIS_ZSTD_LEVEL)
        .context("compress stats bucket")
}

fn decode<T: DeserializeOwned>(value: &[u8]) -> anyhow::Result<T> {
    let value = zstd::stream::decode_all(Cursor::new(value))
        .context("decompress stats bucket")?;
    postcard::from_bytes(&value).context("deserialize stats bucket")
}

fn group_5min_key(timestamp: NaiveDateTime) -> String {
    format!(
        "{GROUP_STATS_REDIS_KEY_PREFIX}:5m:group:{}",
        timestamp.and_utc().timestamp()
    )
}

fn detail_5min_key(timestamp: NaiveDateTime) -> String {
    format!(
        "{GROUP_STATS_REDIS_KEY_PREFIX}:5m:detail:{}",
        timestamp.and_utc().timestamp()
    )
}

fn unit_5min_key(timestamp: NaiveDateTime) -> String {
    format!(
        "{GROUP_STATS_REDIS_KEY_PREFIX}:5m:unit-id:{}",
        timestamp.and_utc().timestamp()
    )
}

fn settlement_5min_key(timestamp: NaiveDateTime) -> String {
    format!(
        "{GROUP_STATS_REDIS_KEY_PREFIX}:5m:settlement-id:{}",
        timestamp.and_utc().timestamp()
    )
}

fn general_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:general:{date}")
}

fn unit_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:unit-id:{date}")
}

fn settlement_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:settlement-id:{date}")
}

fn network_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:network:{date}")
}

fn repair_lock_key(bucket: RepairBucket) -> String {
    match bucket {
        RepairBucket::FiveMinute(timestamp) => format!(
            "{GROUP_STATS_REDIS_KEY_PREFIX}:repair-lock:5m:{}",
            timestamp.and_utc().timestamp()
        ),
        RepairBucket::GeneralDay(date) => {
            format!("{GROUP_STATS_REDIS_KEY_PREFIX}:repair-lock:day:{date}")
        }
        RepairBucket::NetworkDay(date) => format!(
            "{GROUP_STATS_REDIS_KEY_PREFIX}:repair-lock:network-day:{date}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn timestamp() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 29)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap()
    }

    #[test]
    fn bucket_codec_round_trip() {
        let bucket = GeneralDayBucket {
            groups: vec![GroupCount {
                signal_group_batch_id: 42,
                quantity: 7,
            }],
            details: DetailBucket {
                frequencies: vec![StringCount {
                    signal_group_batch_id: 42,
                    value: "123.450".to_string(),
                    quantity: 3,
                }],
                ..Default::default()
            },
        };

        let encoded = encode(&bucket).unwrap();
        let decoded: GeneralDayBucket = decode(&encoded).unwrap();

        assert_eq!(decoded, bucket);

        let units = UnitBucket {
            units: vec![IdCount {
                signal_group_batch_id: 42,
                value: 7,
                quantity: 3,
            }],
            ..Default::default()
        };
        let encoded = encode(&units).unwrap();
        let decoded: UnitBucket = decode(&encoded).unwrap();

        assert_eq!(decoded, units);

        let settlements = SettlementBucket {
            settlements: vec![IdCount {
                signal_group_batch_id: 42,
                value: 8,
                quantity: 2,
            }],
            ..Default::default()
        };
        let encoded = encode(&settlements).unwrap();
        let decoded: SettlementBucket = decode(&encoded).unwrap();

        assert_eq!(decoded, settlements);
    }

    #[test]
    fn message_groups_are_unioned_before_counting() {
        let timestamp = timestamp();
        let counts = count_group_values([
            (timestamp, 1, "freq".to_string(), "b".to_string()),
            (timestamp, 1, "freq".to_string(), "a".to_string()),
            (timestamp, 1, "freq".to_string(), "a".to_string()),
            (timestamp, 2, "freq".to_string(), "a".to_string()),
        ]);

        assert_eq!(
            counts.get(&(timestamp, "|a|b|".to_string(), "freq".to_string())),
            Some(&1)
        );
        assert_eq!(
            counts.get(&(timestamp, "|a|".to_string(), "freq".to_string())),
            Some(&1)
        );
    }

    #[test]
    fn hll_unions_a_message_across_groups_and_buckets_once() {
        let timestamp = timestamp();
        let first = hll_group_values([
            (timestamp, 1, "unit".to_string(), "a".to_string()),
            (timestamp, 1, "unit".to_string(), "b".to_string()),
            (timestamp, 2, "unit".to_string(), "a".to_string()),
        ]);
        let second = hll_group_values([(
            timestamp + Duration::minutes(5),
            1,
            "unit".to_string(),
            "a".to_string(),
        )]);

        let mut sketch = first
            .get(&(timestamp, "|a|b|".to_string(), "unit".to_string()))
            .cloned()
            .unwrap();
        sketch.merge(
            first
                .get(&(timestamp, "|a|".to_string(), "unit".to_string()))
                .unwrap(),
        );
        sketch.merge(
            second
                .get(&(
                    timestamp + Duration::minutes(5),
                    "|a|".to_string(),
                    "unit".to_string(),
                ))
                .unwrap(),
        );

        assert_eq!(sketch.estimate(), 2);
    }

    #[test]
    fn hll_sparse_counts_are_exact() {
        let mut sketch = HllSketch::default();
        for message_id in 1..=87 {
            sketch.insert_message_id(message_id);
        }
        sketch.insert_message_id(1);

        assert_eq!(sketch.estimate(), 87);
    }

    #[test]
    fn network_aors_are_included_in_hll_stats() {
        let timestamp = timestamp();
        let network_rows = vec![super::super::NetworkStatsRow {
            id: 7,
            created_at: timestamp,
            timestamp: None,
            datetime: Some(timestamp),
            group_master_key: "group".to_string(),
            network_id: 42,
            freq: None,
            callsigns: None,
        }];
        let network_aors = HashMap::from([(42, vec![10, 11])]);
        let hlls =
            hll_group_values(network_aor_values(&network_rows, &network_aors));

        for aor_id in [10, 11] {
            assert_eq!(
                hlls.get(&(timestamp, "|group|".to_string(), aor_id))
                    .unwrap()
                    .estimate(),
                1
            );
        }
    }

    #[test]
    fn hll_dense_count_stays_within_expected_error() {
        let mut sketch = HllSketch::default();
        for message_id in 1..=100_000 {
            sketch.insert_message_id(message_id);
        }

        assert!(matches!(sketch, HllSketch::Dense(_)));
        assert!((sketch.estimate() - 100_000).abs() < 2_000);
    }

    #[test]
    fn network_bucket_is_partitioned_by_network() {
        let bucket = NetworkDayBucket {
            networks: vec![
                NetworkCount {
                    signal_group_batch_id: 1,
                    network_id: 10,
                    quantity: 2,
                },
                NetworkCount {
                    signal_group_batch_id: 1,
                    network_id: 20,
                    quantity: 3,
                },
            ],
            frequencies: vec![NetworkStringCount {
                signal_group_batch_id: 1,
                network_id: 10,
                value: "100".to_string(),
                quantity: 2,
            }],
            callsigns: Vec::new(),
        };

        let buckets = split_network_bucket(&bucket);

        assert_eq!(buckets[&10].networks.len(), 1);
        assert_eq!(buckets[&10].frequencies.len(), 1);
        assert_eq!(buckets[&20].networks.len(), 1);
        assert!(buckets[&20].frequencies.is_empty());
    }

    #[test]
    fn repair_locks_are_scoped_to_their_bucket() {
        let timestamp = timestamp();
        let date = timestamp.date();

        assert_ne!(
            repair_lock_key(RepairBucket::FiveMinute(timestamp)),
            repair_lock_key(RepairBucket::GeneralDay(date))
        );
        assert_ne!(
            repair_lock_key(RepairBucket::GeneralDay(date)),
            repair_lock_key(RepairBucket::NetworkDay(date))
        );
    }

    #[tokio::test]
    #[ignore = "requires local Redis database 15"]
    async fn redis_repair_lock_is_single_flight() {
        let client = redis::Client::open("redis://127.0.0.1/15").unwrap();
        let redis = client.get_connection_manager().await.unwrap();
        let stats_redis = GroupStatsRedis::new(redis.clone());
        let bucket = RepairBucket::FiveMinute(timestamp());
        let key = repair_lock_key(bucket);
        let mut cleanup_redis = redis.clone();
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<()>(&mut cleanup_redis)
            .await
            .unwrap();

        let repair_lock = stats_redis
            .try_acquire_repair_lock(bucket)
            .await
            .unwrap()
            .unwrap();
        assert!(stats_redis
            .try_acquire_repair_lock(bucket)
            .await
            .unwrap()
            .is_none());
        repair_lock.release().await.unwrap();
        let repair_lock = stats_redis
            .try_acquire_repair_lock(bucket)
            .await
            .unwrap()
            .unwrap();
        repair_lock.release().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires local Redis database 15"]
    async fn redis_storage_round_trip() {
        let client = redis::Client::open("redis://127.0.0.1/15").unwrap();
        let redis = client.get_connection_manager().await.unwrap();
        let stats_redis = GroupStatsRedis::new(redis.clone());
        let timestamp =
            super::super::round_to_5min(Utc::now().naive_utc()).unwrap();
        let date = super::super::get_local_date(timestamp);
        let groups = GroupBucket {
            groups: vec![GroupCount {
                signal_group_batch_id: 1,
                quantity: 2,
            }],
        };
        let details = DetailBucket {
            frequencies: vec![StringCount {
                signal_group_batch_id: 1,
                value: "100".to_string(),
                quantity: 2,
            }],
            ..Default::default()
        };
        let units = UnitBucket {
            units: vec![IdCount {
                signal_group_batch_id: 1,
                value: 42,
                quantity: 1,
            }],
            unit_hlls: Vec::new(),
        };
        let settlements = SettlementBucket {
            settlements: vec![IdCount {
                signal_group_batch_id: 1,
                value: 43,
                quantity: 1,
            }],
            settlement_hlls: Vec::new(),
        };
        stats_redis
            .write_5min(timestamp, &groups, &details)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .missing_five_minute_buckets(&[timestamp])
                .await
                .unwrap(),
            vec![timestamp]
        );
        stats_redis
            .write_unit_5min(timestamp, &units)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .missing_five_minute_buckets(&[timestamp])
                .await
                .unwrap(),
            vec![timestamp]
        );
        stats_redis
            .write_settlement_5min(timestamp, &settlements)
            .await
            .unwrap();
        assert_eq!(
            stats_redis.read_group_5min(&[timestamp]).await.unwrap(),
            vec![groups.clone()]
        );
        assert_eq!(
            stats_redis.read_detail_5min(&[timestamp]).await.unwrap(),
            vec![details.clone()]
        );
        assert_eq!(
            stats_redis.read_unit_5min(&[timestamp]).await.unwrap(),
            vec![units.clone()]
        );
        assert_eq!(
            stats_redis
                .read_settlement_5min(&[timestamp])
                .await
                .unwrap(),
            vec![settlements.clone()]
        );
        assert!(stats_redis
            .missing_five_minute_buckets(&[timestamp])
            .await
            .unwrap()
            .is_empty());
        let mut redis = redis.clone();
        redis::cmd("SET")
            .arg(detail_5min_key(timestamp))
            .arg("invalid")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .missing_five_minute_buckets(&[timestamp])
                .await
                .unwrap(),
            vec![timestamp]
        );
        stats_redis
            .write_5min(timestamp, &groups, &details)
            .await
            .unwrap();
        redis::cmd("SET")
            .arg(settlement_5min_key(timestamp))
            .arg("invalid")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .missing_five_minute_buckets(&[timestamp])
                .await
                .unwrap(),
            vec![timestamp]
        );
        stats_redis
            .write_settlement_5min(timestamp, &settlements)
            .await
            .unwrap();

        let general = GeneralDayBucket {
            groups: groups.groups.clone(),
            details: details.clone(),
        };
        stats_redis.write_general_day(date, &general).await.unwrap();
        assert_eq!(
            stats_redis.missing_general_days(&[date]).await.unwrap(),
            vec![date]
        );
        stats_redis.write_unit_day(date, &units).await.unwrap();
        assert_eq!(
            stats_redis.missing_general_days(&[date]).await.unwrap(),
            vec![date]
        );
        stats_redis
            .write_settlement_day(date, &settlements)
            .await
            .unwrap();
        assert!(stats_redis
            .missing_general_days(&[date])
            .await
            .unwrap()
            .is_empty());
        redis::cmd("SET")
            .arg(unit_day_key(date))
            .arg("invalid")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stats_redis.missing_general_days(&[date]).await.unwrap(),
            vec![date]
        );
        stats_redis.write_unit_day(date, &units).await.unwrap();
        stats_redis
            .write_settlement_day(date, &settlements)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .read_required::<SettlementBucket>(vec![settlement_day_key(
                    date
                ),])
                .await
                .unwrap(),
            vec![settlements.clone()]
        );
        redis::cmd("SET")
            .arg(settlement_day_key(date))
            .arg("invalid")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stats_redis.missing_general_days(&[date]).await.unwrap(),
            vec![date]
        );
        stats_redis
            .write_settlement_day(date, &settlements)
            .await
            .unwrap();

        let network_bucket = NetworkDayBucket {
            networks: vec![
                NetworkCount {
                    signal_group_batch_id: 1,
                    network_id: 10,
                    quantity: 2,
                },
                NetworkCount {
                    signal_group_batch_id: 1,
                    network_id: 20,
                    quantity: 3,
                },
            ],
            ..Default::default()
        };
        stats_redis
            .replace_network_day(date, &network_bucket)
            .await
            .unwrap();
        let selected = stats_redis
            .read_network_days(&[date], &HashSet::from([10]))
            .await
            .unwrap();
        assert_eq!(
            selected[0].networks,
            vec![network_bucket.networks[0].clone()]
        );
        redis::cmd("HSET")
            .arg(network_day_key(date))
            .arg(10)
            .arg("invalid")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stats_redis
                .missing_network_days(&[date], &HashSet::from([10]))
                .await
                .unwrap(),
            vec![date]
        );
        stats_redis
            .replace_network_day(date, &network_bucket)
            .await
            .unwrap();

        stats_redis
            .update_network_day(date, &HashSet::from([10]), &Default::default())
            .await
            .unwrap();
        let selected = stats_redis
            .read_network_days(&[date], &HashSet::from([10, 20]))
            .await
            .unwrap();
        assert_eq!(
            selected[0].networks,
            vec![network_bucket.networks[1].clone()]
        );

        redis::cmd("DEL")
            .arg(&[
                group_5min_key(timestamp),
                detail_5min_key(timestamp),
                unit_5min_key(timestamp),
                settlement_5min_key(timestamp),
                general_day_key(date),
                unit_day_key(date),
                settlement_day_key(date),
                network_day_key(date),
            ])
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
    }
}
