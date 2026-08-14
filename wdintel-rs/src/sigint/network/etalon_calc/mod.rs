use crate::entities::*;
use crate::sigint::network::etalon_calc::consistency::InboxItem;
use crate::types::*;
use crate::{config, h};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::*;

mod consistency;
pub mod oneoff;
pub mod tui;
pub mod worker;

pub(super) const ETALON_CALC_QUERY_PARAM_CHUNK_SIZE: usize = 20_000;
const ETALON_CALC_NETWORK_INSERT_CHUNK_SIZE: usize = 5_000;

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
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(since_ts),
        till_ts: Set(Utc::now().naive_utc()),
        group_master_key: Set(Some(group.master_key.clone())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: NotSet,
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

async fn load_group_first_inbox_item_datetime<'a, 'async_trait, C>(
    db: &'a C,
    master_key: &str,
) -> anyhow::Result<Option<NaiveDateTime>>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(signal_message_group::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .column(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Datetime)
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

pub async fn invalidate_network_inbox_for_aor(
    db: &DatabaseConnection,
    aor: &area_of_responsibility::Model,
    context_msg: String,
) -> anyhow::Result<()> {
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(aor.created_at),
        till_ts: Set(Utc::now().naive_utc()),
        group_master_key: NotSet,
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: Set(Some(aor.id)),
        sigint_network_id: NotSet,
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn invalidate_network_inbox_for_freq(
    freq: &str,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    db: &DatabaseConnection,
    context_msg: String,
) -> anyhow::Result<()> {
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: Set(Some(freq.to_string())),
        since_ts: Set(since_ts.unwrap_or(
            Utc::now().naive_utc()
                - Duration::days(config::GROUP_STATS_DAY_TTL_DAYS),
        )),
        till_ts: Set(till_ts.unwrap_or(Utc::now().naive_utc())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: NotSet,
        tag: NotSet,
        group_master_key: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn invalidate_network_inbox(
    network: sigint_network::Model,
    frequencies: Vec<String>,
    db: &DatabaseConnection,
    context_msg: String,
) -> anyhow::Result<()> {
    let frequencies_desc = if frequencies.is_empty() {
        "all".to_string()
    } else {
        frequencies.join(" ,")
    };
    info!(
        "network invalidation task created for network #{}, frequencies: {frequencies_desc}; reason: {context_msg}",
        network.id
    );
    let backfill_task = network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(network
            .active_from
            .unwrap_or(Utc::now().naive_utc() - Duration::days(365))),
        till_ts: Set(network.active_to.unwrap_or(Utc::now().naive_utc())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: Set(Some(network.id)),
        group_master_key: NotSet,
        tag: NotSet,
    };
    backfill_task.clone().insert(db).await.c(h!())?;
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
        let mut backfill_task = backfill_task.clone();
        backfill_task.since_ts = Set(freq.active_from);
        backfill_task.till_ts =
            Set(freq.active_to.unwrap_or(Utc::now().naive_utc()));
        backfill_task.frequency = Set(Some(freq.freq));
        backfill_task.insert(db).await.c(h!())?;
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
                sigint_network_id: Set(network_id),
                created_at: NotSet,
            };
            networks_to_insert.push(active_model);
            result.entry(item_id).or_default().push(network_id);
        }
    }
    for networks_to_insert in
        networks_to_insert.chunks(ETALON_CALC_NETWORK_INSERT_CHUNK_SIZE)
    {
        sigint_inbox_item_network::Entity::insert_many(
            networks_to_insert.to_vec(),
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
    for item_id in &non_rer_item_ids {
        crate::sigint::unit_tag::enqueue_unit_tag_recalculation_for_inbox_item(
            dbx, *item_id,
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
}
