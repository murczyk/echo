use crate::config::{
    NETWORK_LAST_ACTIVITY_RECENT_LINK_WINDOW_MINUTES,
    NETWORK_LAST_ACTIVITY_REFRESH_BATCH_SIZE,
    NETWORK_LAST_ACTIVITY_REFRESH_INTERVAL_SECS,
    NETWORK_LAST_ACTIVITY_REFRESH_STATEMENT_TIMEOUT_MS,
};
use crate::h;
use crate::types::{error, info, ShortContext};
use crate::utils::worker_watch;
use anyhow::Context;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use std::time::{Duration, Instant};

struct BatchResult {
    last_id: Option<i64>,
    scanned: i64,
    updated: u64,
}

pub(crate) async fn run_worker(db: DatabaseConnection) {
    let mut interval = tokio::time::interval(Duration::from_secs(
        NETWORK_LAST_ACTIVITY_REFRESH_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let _loop_guard =
            worker_watch::loop_guard("network_last_activity_worker");
        match refresh(&db).await {
            Ok(updated) => info!(
                "network last activity refreshed: {updated} networks updated"
            ),
            Err(error) => {
                error!("network last activity refresh failed: {error:?}")
            }
        }
    }
}

pub(super) async fn refresh(db: &DatabaseConnection) -> anyhow::Result<u64> {
    let Some(max_id) = load_max_network_id(db).await.c(h!())? else {
        return Ok(0);
    };
    let started = Instant::now();
    let mut after_id = 0;
    let mut scanned = 0;
    let mut updated = 0;
    loop {
        let batch = refresh_batch(db, after_id, max_id)
            .await
            .with_context(|| format!("network_cursor={after_id}"))
            .c(h!())?;
        let Some(last_id) = batch.last_id else {
            break;
        };
        after_id = last_id;
        scanned += batch.scanned;
        updated += batch.updated;
        if scanned % (NETWORK_LAST_ACTIVITY_REFRESH_BATCH_SIZE * 20) == 0 {
            let rate =
                scanned as f64 / started.elapsed().as_secs_f64().max(0.001);
            let estimated_remaining_ids = max_id.saturating_sub(after_id);
            info!(
                "network last activity progress: cursor={after_id} scanned={scanned} updated={updated} rate={rate:.1}/s estimated_remaining_ids={estimated_remaining_ids}"
            );
        }
    }
    Ok(updated)
}

async fn load_max_network_id(
    db: &DatabaseConnection,
) -> anyhow::Result<Option<i64>> {
    let row = db
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "select max(id) as max_id from sigint_network",
        ))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("network maximum ID returned no result"))
        .c(h!())?;
    row.try_get("", "max_id").c(h!())
}

async fn refresh_batch(
    db: &DatabaseConnection,
    after_id: i64,
    max_id: i64,
) -> anyhow::Result<BatchResult> {
    let txn = db.begin().await.c(h!())?;
    txn.execute_unprepared(&format!(
        "set local statement_timeout = '{}ms'",
        NETWORK_LAST_ACTIVITY_REFRESH_STATEMENT_TIMEOUT_MS
    ))
    .await
    .c(h!())?;
    let result = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with selected as materialized (
                select id
                from sigint_network
                where id > $1 and id <= $4
                order by id
                limit $2
            ), recent_links as (
                select network_link.sigint_network_id as network_id,
                       inbox_item.freq,
                       coalesce(inbox_item.datetime, signal_message.timestamp, signal_message.created_at) as activity_at
                from selected
                join sigint_inbox_item_network network_link
                  on network_link.sigint_network_id = selected.id
                 and network_link.created_at >= (now() at time zone 'utc') - make_interval(mins => $3)
                -- Keep lookups in the large inbox and message tables on their primary keys.
                join lateral (
                    select id, freq, datetime
                    from sigint_inbox_item
                    where id = network_link.sigint_inbox_item_id
                    limit 1
                ) inbox_item on true
                join lateral (
                    select timestamp, created_at, deleted
                    from signal_message
                    where id = inbox_item.id
                    limit 1
                ) signal_message on true
                where signal_message.deleted = false
            ), recent_activity as (
                select recent_links.network_id,
                       max(recent_links.activity_at) as last_active_at
                from recent_links
                join sigint_network network
                  on network.id = recent_links.network_id
                 and network.deleted = false
                join sigint_network_freq network_freq
                  on network_freq.network_id = network.id
                 and network_freq.freq = recent_links.freq
                 and network_freq.deleted = false
                where recent_links.activity_at >= network_freq.active_from
                  and (network_freq.active_to is null or recent_links.activity_at <= network_freq.active_to)
                  and (network.active_from is null or recent_links.activity_at >= network.active_from)
                  and (network.active_to is null or recent_links.activity_at <= network.active_to)
                group by recent_links.network_id
            ), cached_activity as (
                select freq.network_id,
                       max(freq.last_seen_dt) as last_active_at
                from selected
                join sigint_network_freq freq on freq.network_id = selected.id
                join sigint_network network on network.id = freq.network_id
                where freq.deleted = false
                  and network.deleted = false
                  and freq.last_seen_dt >= freq.active_from
                  and (freq.active_to is null or freq.last_seen_dt <= freq.active_to)
                  and (network.active_from is null or freq.last_seen_dt >= network.active_from)
                  and (network.active_to is null or freq.last_seen_dt <= network.active_to)
                group by freq.network_id
            ), activity as (
                select network.id,
                       greatest(cached_activity.last_active_at, recent_activity.last_active_at) as last_active_at
                from selected
                join sigint_network network on network.id = selected.id
                left join cached_activity on cached_activity.network_id = network.id
                left join recent_activity on recent_activity.network_id = network.id
            ), updated as (
                update sigint_network network
                set last_active_at = activity.last_active_at
                from activity
                where network.id = activity.id
                  and network.id = any(array(select id from selected))
                  and network.last_active_at is distinct from activity.last_active_at
                returning network.id
            )
            select (select max(id) from selected) as last_id,
                   (select count(*) from selected) as scanned,
                   (select count(*) from updated) as updated
            "#,
            [
                after_id.into(),
                NETWORK_LAST_ACTIVITY_REFRESH_BATCH_SIZE.into(),
                NETWORK_LAST_ACTIVITY_RECENT_LINK_WINDOW_MINUTES.into(),
                max_id.into(),
            ],
        ))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("network activity batch returned no result"))
        .c(h!())?;
    let result = BatchResult {
        last_id: result.try_get("", "last_id").c(h!())?,
        scanned: result.try_get("", "scanned").c(h!())?,
        updated: result.try_get::<i64>("", "updated").c(h!())? as u64,
    };
    txn.commit().await.c(h!())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        sigint_inbox_item, sigint_inbox_item_network, sigint_network,
        sigint_network_freq, signal_message,
    };
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_sigint_inbox_item_network,
        mk_sigint_network, mk_sigint_network_freq, mk_signal_message,
    };
    use chrono::{NaiveDate, Timelike, Utc};
    use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn refresh_uses_valid_frequency_activity_and_clears_removed_activity()
    {
        let env = cleanup().await.unwrap();
        let timestamp = NaiveDate::from_ymd_opt(2026, 9, 12)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.5000".to_string()),
                active_from: Set(timestamp - chrono::Duration::days(1)),
                last_seen_dt: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.last_active_at, Some(timestamp));
        assert_eq!(refresh(&env.dbx).await.unwrap(), 0);

        let mut freq = freq.into_active_model();
        freq.deleted = Set(true);
        let freq = freq.update(&env.dbx).await.unwrap();

        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.last_active_at, None);

        let mut freq = sigint_network_freq::Entity::find_by_id(freq.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        freq.deleted = Set(false);
        freq.update(&env.dbx).await.unwrap();
        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let mut network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        network.deleted = Set(true);
        let network = network.update(&env.dbx).await.unwrap();
        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.last_active_at, None);
    }

    #[tokio::test]
    #[serial]
    async fn refresh_includes_newly_linked_activity_before_frequency_recalculation(
    ) {
        let env = cleanup().await.unwrap();
        let timestamp = Utc::now().naive_utc().with_nanosecond(0).unwrap()
            - chrono::Duration::minutes(10);
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.5000".to_string()),
                active_from: Set(timestamp - chrono::Duration::days(1)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("146.5000".to_string())),
                datetime: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_link = mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(network.last_active_at, Some(timestamp));
        assert_eq!(network_freq.last_seen_dt, None);

        sigint_inbox_item_network::Entity::delete_by_id(network_link.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.last_active_at, None);
    }

    #[tokio::test]
    #[serial]
    async fn refresh_reaches_networks_after_the_first_batch() {
        let env = cleanup().await.unwrap();
        let timestamp = NaiveDate::from_ymd_opt(2026, 9, 12)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let mut last_network = None;
        for _ in 0..=NETWORK_LAST_ACTIVITY_REFRESH_BATCH_SIZE {
            last_network = Some(
                mk_sigint_network(&env.dbx, Default::default())
                    .await
                    .unwrap(),
            );
        }
        let last_network = last_network.unwrap();
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(last_network.id),
                freq: Set("146.5000".to_string()),
                active_from: Set(timestamp - chrono::Duration::days(1)),
                last_seen_dt: Set(Some(timestamp)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(refresh(&env.dbx).await.unwrap(), 1);
        let last_network = sigint_network::Entity::find_by_id(last_network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(last_network.last_active_at, Some(timestamp));
    }
}
