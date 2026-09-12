use crate::entities::*;
use crate::sigint::network::etalon_calc::consistency::InboxItem;
use crate::types::*;
use crate::{config, h};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;

mod consistency;
pub mod oneoff;
pub mod tui;
pub mod worker;

pub(super) const ETALON_CALC_QUERY_PARAM_CHUNK_SIZE: usize = 20_000;
const ETALON_CALC_NETWORK_INSERT_CHUNK_SIZE: usize = 5_000;

#[derive(Default)]
pub(super) struct NetworkInvalidationScope {
    pub(super) frequency: Option<String>,
    pub(super) sigint_network_id: Option<i64>,
    pub(super) aor_id: Option<i64>,
    pub(super) group_master_key: Option<String>,
}

fn normalize_network_invalidation_range(
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let earliest_ts =
        now - Duration::days(config::NETWORK_INBOX_OLD_WORKER_CUTOFF_DAYS);
    let since_ts =
        std::cmp::Ord::max(since_ts.unwrap_or(earliest_ts), earliest_ts);
    let till_ts = std::cmp::Ord::min(till_ts.unwrap_or(now), now);
    (since_ts < till_ts).then_some((since_ts, till_ts))
}

pub(super) async fn enqueue_network_invalidation_task<'a, 'async_trait, C>(
    db: &'a C,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    scope: NetworkInvalidationScope,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let requested_since_ts = since_ts;
    let requested_till_ts = till_ts;
    let Some((since_ts, till_ts)) = normalize_network_invalidation_range(
        since_ts,
        till_ts,
        Utc::now().naive_utc(),
    ) else {
        info!(
            "network invalidation task skipped: requested_since_ts={requested_since_ts:?}, requested_till_ts={requested_till_ts:?}, reason: {context_msg}"
        );
        return Ok(());
    };
    info!(
        "network invalidation task created: since_ts={since_ts}, till_ts={till_ts}, reason: {context_msg}"
    );
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: Set(scope.frequency),
        since_ts: Set(since_ts),
        till_ts: Set(till_ts),
        group_master_key: Set(scope.group_master_key),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: Set(scope.aor_id),
        sigint_network_id: Set(scope.sigint_network_id),
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

fn network_assignment_enabled_condition() -> Condition {
    Condition::all()
        .add(signal_group::Column::DisableNetworkAssignment.eq(false))
}

fn network_assignment_disabled_condition() -> Condition {
    Condition::all()
        .add(signal_group::Column::DisableNetworkAssignment.eq(true))
}

pub async fn invalidate_network_inbox_for_group_with_key<'a, 'async_trait, C>(
    db: &'a C,
    master_key: &str,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let group = signal_group::Entity::find_by_id(master_key.to_string())
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    invalidate_network_inbox_for_group(db, &group, context_msg).await
}

pub async fn invalidate_network_inbox_for_group<'a, 'async_trait, C>(
    db: &'a C,
    group: &signal_group::Model,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    invalidate_network_inbox_for_group_since(
        db,
        group,
        group.created_at,
        context_msg,
    )
    .await
}

pub async fn invalidate_network_inbox_for_group_all_history<
    'a,
    'async_trait,
    C,
>(
    db: &'a C,
    group: &signal_group::Model,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let since_ts = load_group_first_inbox_item_datetime(db, &group.master_key)
        .await
        .c(h!())?
        .unwrap_or(group.created_at);
    invalidate_network_inbox_for_group_since(db, group, since_ts, context_msg)
        .await
}

pub async fn invalidate_network_inbox_for_group_all_history_once<
    'a,
    'async_trait,
    C,
>(
    db: &'a C,
    group: &signal_group::Model,
    context_msg: String,
    invalidation_enqueued: &mut bool,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    if *invalidation_enqueued {
        return Ok(());
    }
    invalidate_network_inbox_for_group_all_history(db, group, context_msg)
        .await
        .c(h!())?;
    *invalidation_enqueued = true;
    Ok(())
}

async fn invalidate_network_inbox_for_group_since<'a, 'async_trait, C>(
    db: &'a C,
    group: &signal_group::Model,
    since_ts: NaiveDateTime,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    enqueue_network_invalidation_task(
        db,
        Some(since_ts),
        None,
        NetworkInvalidationScope {
            group_master_key: Some(group.master_key.clone()),
            ..Default::default()
        },
        context_msg,
    )
    .await
}

async fn load_group_first_inbox_item_datetime<'a, 'async_trait, C>(
    db: &'a C,
    master_key: &str,
) -> anyhow::Result<Option<NaiveDateTime>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(signal_message_group::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .column_as(sigint_inbox_item::Column::Datetime.min(), "first_datetime")
        .into_tuple::<Option<NaiveDateTime>>()
        .one(db)
        .await
        .c(h!())?
        .flatten())
}

pub async fn set_group_disable_network_assignment<'a, 'async_trait, C>(
    db: &'a C,
    master_key: &str,
    disable_network_assignment: bool,
) -> anyhow::Result<(signal_group::Model, bool)>
where
    C: ConnectionTrait + 'async_trait,
{
    let group = signal_group::Entity::find_by_id(master_key.to_string())
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    if group.disable_network_assignment == disable_network_assignment {
        return Ok((group, false));
    }

    let mut group = group.into_active_model();
    group.disable_network_assignment = Set(disable_network_assignment);
    let group = group.update(db).await.c(h!())?;
    Ok((group, true))
}

pub async fn invalidate_network_inbox_for_aor<'a, 'async_trait, C>(
    db: &'a C,
    aor: &area_of_responsibility::Model,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    enqueue_network_invalidation_task(
        db,
        Some(aor.created_at),
        None,
        NetworkInvalidationScope {
            aor_id: Some(aor.id),
            ..Default::default()
        },
        context_msg,
    )
    .await
}

pub async fn invalidate_network_inbox_for_freq<'a, 'async_trait, C>(
    freq: &str,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    db: &'a C,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    enqueue_network_invalidation_task(
        db,
        since_ts,
        till_ts,
        NetworkInvalidationScope {
            frequency: Some(freq.to_string()),
            ..Default::default()
        },
        context_msg,
    )
    .await
}

pub async fn invalidate_network_inbox<'a, 'async_trait, C>(
    network: sigint_network::Model,
    frequencies: Vec<String>,
    db: &'a C,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let frequencies_desc = if frequencies.is_empty() {
        "all".to_string()
    } else {
        frequencies.join(" ,")
    };
    info!(
        "network invalidation task created for network #{}, frequencies: {frequencies_desc}; reason: {context_msg}",
        network.id
    );
    enqueue_network_invalidation_task(
        db,
        network.active_from,
        network.active_to,
        NetworkInvalidationScope {
            sigint_network_id: Some(network.id),
            ..Default::default()
        },
        context_msg.clone(),
    )
    .await
    .c(h!())?;
    let mut sigint_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network.id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    if !frequencies.is_empty() {
        sigint_freqs.retain(|f| frequencies.contains(&f.freq))
    }
    for freq in sigint_freqs {
        enqueue_network_invalidation_task(
            db,
            Some(freq.active_from),
            freq.active_to,
            NetworkInvalidationScope {
                frequency: Some(freq.freq),
                sigint_network_id: Some(network.id),
                ..Default::default()
            },
            context_msg.clone(),
        )
        .await
        .c(h!())?;
    }

    Ok(())
}

pub async fn calculate_sigint_inbox_item_networks<'a, 'async_trait, C>(
    sigint_inbox_items: Vec<sigint_inbox_item::Model>,
    dbx: &'a C,
) -> anyhow::Result<HashMap<i64, Vec<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
    let sigint_inbox_item_ids =
        sigint_inbox_items.iter().map(|i| i.id).collect::<Vec<_>>();
    if sigint_inbox_item_ids.is_empty() {
        return Ok(result);
    }
    crate::rer_importer::inbox::invalidate_messages_network_frequency_last_seen(
        dbx,
        &sigint_inbox_item_ids,
    )
    .await
    .c(h!())?;
    delete_sigint_inbox_item_networks(&sigint_inbox_item_ids, dbx)
        .await
        .c(h!())?;
    let sigint_inbox_items = filter_network_calc_items(sigint_inbox_items, dbx)
        .await
        .c(h!())?;
    if !sigint_inbox_items.is_empty() {
        insert_calculated_sigint_inbox_item_networks(
            sigint_inbox_items,
            dbx,
            &mut result,
        )
        .await
        .c(h!())?;
    }
    crate::inbox::unit_resolution::sync_calculated_network_unit_links(
        dbx,
        &sigint_inbox_item_ids,
        &result,
    )
    .await
    .c(h!())?;
    Ok(result)
}

pub(crate) async fn directly_recalculated_network_unit_item_ids<C>(
    dbx: &C,
    sigint_inbox_item_ids: &[i64],
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    if !crate::system_settings::support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(sigint_inbox_item_ids.to_vec());
    }
    let deferred_item_ids =
        crate::sigint::unit_tag::non_rer_item_ids_from_items(
            dbx,
            sigint_inbox_item_ids.to_vec(),
        )
        .await
        .c(h!())?;
    Ok(sigint_inbox_item_ids
        .iter()
        .filter(|item_id| !deferred_item_ids.contains(item_id))
        .copied()
        .collect())
}

async fn delete_sigint_inbox_item_networks<'a, 'async_trait, C>(
    sigint_inbox_item_ids: &[i64],
    dbx: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    for sigint_inbox_item_ids in
        sigint_inbox_item_ids.chunks(ETALON_CALC_QUERY_PARAM_CHUNK_SIZE)
    {
        sigint_inbox_item_network::Entity::delete_many()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .is_in(sigint_inbox_item_ids.to_vec()),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn insert_calculated_sigint_inbox_item_networks<'a, 'async_trait, C>(
    sigint_inbox_items: Vec<sigint_inbox_item::Model>,
    dbx: &'a C,
    result: &mut HashMap<i64, Vec<i64>>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let item_uuids = sigint_inbox_items
        .iter()
        .map(|item| (item.id, item.id_uuid))
        .collect::<HashMap<_, _>>();
    let items_to_process = sigint_inbox_items
        .into_iter()
        .map(|i| InboxItem {
            id: i.id,
            timestamp: i.datetime,
            freq: i.freq,
            unit: i.unit_v2,
            parsed_unit_v2: i.parsed_unit_v2,
            post_id: i.post_id,
        })
        .collect::<Vec<_>>();
    let network_ids_per_item =
        consistency::load_networks_for_inbox_items(dbx, &items_to_process)
            .await
            .c(h!())?;
    let mut networks_to_insert = Vec::new();
    for (item_id, network_ids) in network_ids_per_item {
        for network_id in network_ids {
            let active_model = sigint_inbox_item_network::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(item_id),
                sigint_inbox_item_uuid: Set(item_uuids
                    .get(&item_id)
                    .copied()
                    .flatten()),
                sigint_network_id: Set(network_id),
                created_at: NotSet,
            };
            networks_to_insert.push(active_model);
            result.entry(item_id).or_default().push(network_id);
        }
    }
    insert_network_links(dbx, networks_to_insert)
        .await
        .c(h!())?;
    Ok(())
}

async fn insert_network_links<C>(
    dbx: &C,
    networks_to_insert: Vec<sigint_inbox_item_network::ActiveModel>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for networks_to_insert in
        networks_to_insert.chunks(ETALON_CALC_NETWORK_INSERT_CHUNK_SIZE)
    {
        sigint_inbox_item_network::Entity::insert_many(
            networks_to_insert.to_vec(),
        )
        .on_conflict(
            OnConflict::columns([
                sigint_inbox_item_network::Column::SigintNetworkId,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn filter_network_calc_items<'a, 'async_trait, C>(
    sigint_inbox_items: Vec<sigint_inbox_item::Model>,
    dbx: &'a C,
) -> anyhow::Result<Vec<sigint_inbox_item::Model>>
where
    C: ConnectionTrait + 'async_trait,
{
    let sigint_inbox_item_ids =
        sigint_inbox_items.iter().map(|i| i.id).collect::<Vec<_>>();
    let mut excluded_item_ids =
        network_assignment_disabled_item_ids_from_items(
            dbx,
            &sigint_inbox_item_ids,
        )
        .await
        .c(h!())?;

    if !crate::system_settings::support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(sigint_inbox_items
            .into_iter()
            .filter(|item| !excluded_item_ids.contains(&item.id))
            .collect());
    }
    let non_rer_item_ids =
        crate::sigint::unit_tag::non_rer_item_ids_from_items(
            dbx,
            sigint_inbox_item_ids.clone(),
        )
        .await
        .c(h!())?;
    for item in sigint_inbox_items
        .iter()
        .filter(|item| non_rer_item_ids.contains(&item.id))
    {
        crate::sigint::unit_tag::enqueue_unit_tag_recalculation_for_inbox_item(
            dbx,
            item.id,
            item.id_uuid,
        )
        .await
        .c(h!())?;
    }
    excluded_item_ids.extend(non_rer_item_ids);
    Ok(sigint_inbox_items
        .into_iter()
        .filter(|item| !excluded_item_ids.contains(&item.id))
        .collect())
}

async fn network_assignment_disabled_item_ids_from_items<'a, 'async_trait, C>(
    db: &'a C,
    sigint_inbox_item_ids: &[i64],
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    if sigint_inbox_item_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let disabled_item_ids = group_item_ids_with_network_assignment_enabled(
        db,
        sigint_inbox_item_ids,
        false,
    )
    .await
    .c(h!())?;
    let enabled_item_ids = group_item_ids_with_network_assignment_enabled(
        db,
        sigint_inbox_item_ids,
        true,
    )
    .await
    .c(h!())?;
    Ok(disabled_item_ids
        .difference(&enabled_item_ids)
        .copied()
        .collect())
}

async fn group_item_ids_with_network_assignment_enabled<'a, 'async_trait, C>(
    db: &'a C,
    sigint_inbox_item_ids: &[i64],
    enabled: bool,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut ids = HashSet::new();
    for sigint_inbox_item_ids in
        sigint_inbox_item_ids.chunks(ETALON_CALC_QUERY_PARAM_CHUNK_SIZE)
    {
        ids.extend(
            signal_message_group::Entity::find()
                .join(
                    JoinType::InnerJoin,
                    signal_message_group::Relation::SignalGroup.def(),
                )
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .is_in(sigint_inbox_item_ids.to_vec()),
                )
                .filter(if enabled {
                    network_assignment_enabled_condition()
                } else {
                    network_assignment_disabled_condition()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use serial_test::serial;

    #[test]
    fn invalidation_range_is_limited_to_supported_history() {
        let now = NaiveDateTime::parse_from_str(
            "2026-08-16 18:00:00",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();
        let malformed_since = NaiveDateTime::parse_from_str(
            "0025-08-16 21:00:00",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();

        let (since_ts, till_ts) = normalize_network_invalidation_range(
            Some(malformed_since),
            None,
            now,
        )
        .unwrap();

        assert_eq!(
            since_ts,
            now - Duration::days(config::NETWORK_INBOX_OLD_WORKER_CUTOFF_DAYS,)
        );
        assert_eq!(till_ts, now);
    }

    #[test]
    fn invalidation_range_skips_expired_or_inverted_ranges() {
        let now = NaiveDateTime::parse_from_str(
            "2026-08-16 18:00:00",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();

        assert!(normalize_network_invalidation_range(
            Some(now - Duration::days(500)),
            Some(now - Duration::days(400)),
            now,
        )
        .is_none());
        assert!(normalize_network_invalidation_range(
            Some(now),
            Some(now - Duration::hours(1)),
            now,
        )
        .is_none());
    }

    #[serial]
    #[tokio::test]
    async fn test_network_assignment_disabled_item_ids_keeps_item_with_enabled_group_link(
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

        let ids = network_assignment_disabled_item_ids_from_items(
            &txn,
            &[mixed_msg.id, disabled_msg.id],
        )
        .await
        .unwrap();

        assert!(!ids.contains(&mixed_msg.id));
        assert!(ids.contains(&disabled_msg.id));

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn calculated_network_links_ignore_concurrent_duplicates() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let link = || sigint_inbox_item_network::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(inbox_item.id),
            sigint_inbox_item_uuid: Set(inbox_item.id_uuid),
            sigint_network_id: Set(network.id),
            created_at: NotSet,
        };

        let (first, second) = tokio::join!(
            insert_network_links(&env.dbx, vec![link()]),
            insert_network_links(&env.dbx, vec![link()]),
        );
        first.unwrap();
        second.unwrap();

        assert_eq!(
            sigint_inbox_item_network::Entity::find()
                .filter(
                    sigint_inbox_item_network::Column::SigintInboxItemId
                        .eq(inbox_item.id),
                )
                .filter(
                    sigint_inbox_item_network::Column::SigintNetworkId
                        .eq(network.id),
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    // Regression for ECHO-3207: recalculation invalidates removed-link activity.
    #[serial]
    #[tokio::test]
    async fn recalculation_invalidates_removed_network_frequency_last_seen() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let timestamp = Utc::now().naive_utc() - Duration::hours(1);
        let freq = "146.4500";
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp)),
                created_at: Set(timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.to_string())),
                datetime: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(freq.to_string()),
                active_from: Set(timestamp - Duration::days(1)),
                last_seen_dt: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        calculate_sigint_inbox_item_networks(
            vec![inbox_item.clone()],
            &env.dbx,
        )
        .await
        .unwrap();

        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let link_count = sigint_inbox_item_network::Entity::find()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(inbox_item.id),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(network_freq.last_seen_dt, None);
        assert_eq!(link_count, 0);
    }
}
