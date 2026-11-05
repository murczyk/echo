use crate::config::{
    UNIT_TAG_QUEUE_WORKER_BATCH_SIZE, UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
    UNIT_TAG_RECALC_HISTORY_DAYS,
};
use crate::entities::sea_orm_active_enums::InterseptionKind;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{error, ShortContext};
use crate::utils::worker_watch;
use chrono::{Duration, Utc};
use sea_orm::*;
use std::collections::HashSet;

pub(crate) async fn enqueue_unit_tag_recalculation_for_inbox_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
    sigint_inbox_item_uuid: Option<uuid::Uuid>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_unit_tag_queue::Entity::insert(
        sigint_inbox_item_unit_tag_queue::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            sigint_inbox_item_uuid: Set(sigint_inbox_item_uuid),
            created_at: NotSet,
        },
    )
    .on_conflict_do_nothing_on([
        sigint_inbox_item_unit_tag_queue::Column::SigintInboxItemId,
    ])
    .exec(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn enqueue_recent_non_rer_unit_tag_recalculation<C>(
    db: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since =
        Utc::now().naive_utc() - Duration::days(UNIT_TAG_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::IdUuid,
        ])
        .into_tuple::<(i64, Option<uuid::Uuid>)>()
        .all(db)
        .await
        .c(h!())?;
    for (item_id, item_uuid) in item_ids {
        enqueue_unit_tag_recalculation_for_inbox_item(db, item_id, item_uuid)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn enqueue_recent_unit_tag_recalculation_for_group<C>(
    db: &C,
    master_key: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let since =
        Utc::now().naive_utc() - Duration::days(UNIT_TAG_RECALC_HISTORY_DAYS);
    let item_ids = sigint_inbox_item::Entity::find()
        .distinct()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(since))
        .filter(signal_message_group::Column::GroupMasterKey.eq(master_key))
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::IdUuid,
        ])
        .into_tuple::<(i64, Option<uuid::Uuid>)>()
        .all(db)
        .await
        .c(h!())?;
    for (item_id, item_uuid) in item_ids {
        enqueue_unit_tag_recalculation_for_inbox_item(db, item_id, item_uuid)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn run_unit_tag_queue_worker_nofail(dbx: DatabaseConnection) {
    loop {
        let _loop_guard = worker_watch::loop_guard("unit_tag_queue_worker");
        match run_unit_tag_queue_worker_once(&dbx).await {
            Ok(has_work) => {
                if !has_work {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
                    ))
                    .await;
                }
            }
            Err(err) => {
                error!("unit_tag_queue_worker failed: {err:#?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    UNIT_TAG_QUEUE_WORKER_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

async fn run_unit_tag_queue_worker_once(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    if !crate::system_settings::support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    let queue_items = sigint_inbox_item_unit_tag_queue::Entity::find()
        .order_by_asc(sigint_inbox_item_unit_tag_queue::Column::CreatedAt)
        .order_by_asc(sigint_inbox_item_unit_tag_queue::Column::Id)
        .limit(UNIT_TAG_QUEUE_WORKER_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    if queue_items.is_empty() {
        return Ok(false);
    }
    for queue_item in queue_items {
        let inbox_item_id = queue_item.sigint_inbox_item_id;
        recalculate_inbox_item_unit_tags(dbx, inbox_item_id)
            .await
            .c(h!())?;
        crate::stats::enqueue_group_stats_recalculation_for_message(
            dbx,
            inbox_item_id,
            format!(
                "recalculated unit links for inbox message {inbox_item_id}"
            ),
        )
        .await
        .c(h!())?;
        sigint_inbox_item_unit_tag_queue::Entity::delete_by_id(queue_item.id)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(true)
}

pub async fn recalculate_inbox_item_unit_tags<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if inbox_item_is_non_rer(db, sigint_inbox_item_id)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    delete_network_links_for_item(db, sigint_inbox_item_id)
        .await
        .c(h!())?;
    recalculate_regular_networks_for_item(db, sigint_inbox_item_id)
        .await
        .c(h!())?;
    Ok(())
}

async fn recalculate_regular_networks_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let Some(sigint_inbox_item) =
        sigint_inbox_item::Entity::find_by_id(sigint_inbox_item_id)
            .one(db)
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![sigint_inbox_item],
        db,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn delete_network_links_for_item<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let old_freq_ids =
        crate::sigint::network::recalculation::load_freq_ids_for_message_links(
            db,
            &[sigint_inbox_item_id],
        )
        .await
        .c(h!())?;
    crate::rer_importer::inbox::invalidate_message_network_frequency_last_seen(
        db,
        sigint_inbox_item_id,
    )
    .await
    .c(h!())?;
    sigint_inbox_item_network::Entity::delete_many()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .exec(db)
        .await
        .c(h!())?;
    crate::sigint::network::recalculation::enqueue_last_seen_for_freq_ids(
        db,
        old_freq_ids,
    )
    .await
    .c(h!())?;
    crate::inbox::unit_resolution::sync_network_unit_links(
        db,
        &[sigint_inbox_item_id],
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn inbox_item_is_non_rer<C>(
    db: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let count = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq(sigint_inbox_item_id),
        )
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .count(db)
        .await
        .c(h!())?;
    Ok(count > 0)
}

pub fn normalize_unit_mask(
    unit_mask: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for unit_mask in unit_mask {
        let unit_mask = unit_mask.trim().to_string();
        if unit_mask.is_empty() {
            return Err(AppError::BL {
                msg: "unit_mask must not contain empty values".to_string(),
            });
        }
        let key = unit_mask.to_lowercase();
        if seen.insert(key) {
            out.push(unit_mask);
        }
    }
    Ok(out)
}

pub fn sigint_network_unit_mask(
    sigint_network: &sigint_network::Model,
) -> Vec<String> {
    serde_json::from_value(sigint_network.unit_mask.clone()).unwrap_or_default()
}

pub async fn non_rer_item_ids_from_items<C>(
    db: &C,
    sigint_inbox_item_ids: Vec<i64>,
) -> anyhow::Result<HashSet<i64>>
where
    C: ConnectionTrait,
{
    if sigint_inbox_item_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let ids = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(sigint_inbox_item_ids),
        )
        .filter(
            signal_group::Column::InterseptionKind.eq(InterseptionKind::Other),
        )
        .select_only()
        .column(signal_message_group::Column::SignalMessageId)
        .distinct()
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn issue_3940_non_rer_assignment_preserves_history_without_new_links()
    {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                interseption_kind: Set(InterseptionKind::Other),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                unit_mask: Set(serde_json::json!(["test"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let historical = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let fresh = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        for item in [&historical, &fresh] {
            mk_signal_message_group(
                &env.dbx,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(item.id),
                    group_master_key: Set(Some(group.master_key.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let old_link = mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(historical.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        recalculate_inbox_item_unit_tags(&env.dbx, historical.id)
            .await
            .unwrap();
        recalculate_inbox_item_unit_tags(&env.dbx, fresh.id)
            .await
            .unwrap();
        crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(vec![historical, fresh.clone()], &env.dbx).await.unwrap();
        assert!(sigint_inbox_item_network::Entity::find_by_id(old_link.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert!(sigint_inbox_item_network::Entity::find()
            .filter(
                sigint_inbox_item_network::Column::SigintInboxItemId
                    .eq(fresh.id)
            )
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
    }
}
