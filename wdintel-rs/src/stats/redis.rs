use crate::config::*;
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
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct GeneralDayBucket {
    pub groups: Vec<GroupCount>,
    pub details: DetailBucket,
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
) -> anyhow::Result<BTreeMap<NaiveDateTime, (GroupBucket, DetailBucket)>> {
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
    let network_aors = network_rows.iter().flat_map(|row| {
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
    });
    let aor_counts = count_group_values(group_aors.chain(network_aors));

    let batch_keys = group_counts
        .keys()
        .map(|(_, batch_key, _)| batch_key)
        .chain(frequency_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(sender_counts.keys().map(|(_, batch_key, _)| batch_key))
        .chain(unit_counts.keys().map(|(_, batch_key, _)| batch_key))
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
    append_string_counts(&mut result, callsign_counts, batches, |details| {
        &mut details.callsigns
    })?;
    append_string_counts(&mut result, location_counts, batches, |details| {
        &mut details.locations
    })?;
    append_id_counts(&mut result, post_counts, batches, |details| {
        &mut details.posts
    })?;
    append_id_counts(&mut result, tag_counts, batches, |details| {
        &mut details.tags
    })?;
    append_id_counts(&mut result, aor_counts, batches, |details| {
        &mut details.aors
    })?;
    Ok(result)
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
) -> BTreeMap<NaiveDateTime, (GroupBucket, DetailBucket)> {
    let mut result = BTreeMap::new();
    let mut timestamp = since;
    while timestamp < till {
        result.insert(timestamp, Default::default());
        timestamp += Duration::minutes(5);
    }
    result
}

fn append_group_counts(
    result: &mut BTreeMap<NaiveDateTime, (GroupBucket, DetailBucket)>,
    counts: HashMap<(NaiveDateTime, String, ()), i32>,
    batches: &HashMap<String, i64>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, ()), quantity) in counts {
        result
            .get_mut(&timestamp)
            .context("group count is outside requested bucket range")?
            .0
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
    result: &mut BTreeMap<NaiveDateTime, (GroupBucket, DetailBucket)>,
    counts: HashMap<(NaiveDateTime, String, i64), i32>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut DetailBucket) -> &mut Vec<IdCount>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), quantity) in counts {
        select(
            &mut result
                .get_mut(&timestamp)
                .context("ID count is outside requested bucket range")?
                .1,
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
    result: &mut BTreeMap<NaiveDateTime, (GroupBucket, DetailBucket)>,
    counts: HashMap<(NaiveDateTime, String, String), i32>,
    batches: &HashMap<String, i64>,
    select: impl Fn(&mut DetailBucket) -> &mut Vec<StringCount>,
) -> anyhow::Result<()> {
    for ((timestamp, batch_key, value), quantity) in counts {
        select(
            &mut result
                .get_mut(&timestamp)
                .context("string count is outside requested bucket range")?
                .1,
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

#[derive(Clone)]
pub struct GroupStatsRedis {
    redis: ConnectionManager,
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

    pub async fn read_general_days(
        &self,
        dates: &[NaiveDate],
    ) -> anyhow::Result<Vec<GeneralDayBucket>> {
        self.read_required(dates.iter().copied().map(general_day_key).collect())
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
        let mut pipe = redis::pipe();
        for date in dates {
            pipe.cmd("HMGET")
                .arg(network_day_key(*date))
                .arg(GROUP_STATS_REDIS_NETWORK_COMPLETE_FIELD)
                .arg(&network_ids);
        }
        let mut redis = self.redis.clone();
        let values = pipe
            .query_async::<Vec<Vec<Option<Vec<u8>>>>>(&mut redis)
            .await
            .context("read Redis network statistics")?;
        let mut result = Vec::with_capacity(dates.len());
        for (date, mut values) in dates.iter().zip(values) {
            if values.first().and_then(Option::as_ref).is_none() {
                bail!("missing Redis network stats bucket for {date}");
            }
            values.remove(0);
            let mut bucket = NetworkDayBucket::default();
            for (network_id, value) in network_ids.iter().copied().zip(values) {
                let Some(value) = value else {
                    continue;
                };
                let value: NetworkDayBucket = decode(&value).with_context(
                    || {
                        format!(
                            "decode Redis network stats for {date}, network {network_id}"
                        )
                    },
                )?;
                bucket.networks.extend(value.networks);
                bucket.frequencies.extend(value.frequencies);
                bucket.callsigns.extend(value.callsigns);
            }
            result.push(bucket);
        }
        Ok(result)
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

fn general_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:general:{date}")
}

fn network_day_key(date: NaiveDate) -> String {
    format!("{GROUP_STATS_REDIS_KEY_PREFIX}:day:network:{date}")
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
        stats_redis
            .write_5min(timestamp, &groups, &details)
            .await
            .unwrap();
        assert_eq!(
            stats_redis.read_group_5min(&[timestamp]).await.unwrap(),
            vec![groups]
        );
        assert_eq!(
            stats_redis.read_detail_5min(&[timestamp]).await.unwrap(),
            vec![details]
        );

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

        let mut redis = redis.clone();
        redis::cmd("DEL")
            .arg(&[
                group_5min_key(timestamp),
                detail_5min_key(timestamp),
                network_day_key(date),
            ])
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
    }
}
