use crate::config::{
    NETWORK_LAST_ACTIVITY_RECENT_LINK_WINDOW_MINUTES,
    NETWORK_LAST_ACTIVITY_REFRESH_INTERVAL_SECS,
    NETWORK_LAST_ACTIVITY_REFRESH_STATEMENT_TIMEOUT_MS,
};
use crate::h;
use crate::types::{error, info, ShortContext};
use crate::utils::worker_watch;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use std::time::Duration;

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

async fn refresh(db: &DatabaseConnection) -> anyhow::Result<u64> {
    let txn = db.begin().await.c(h!())?;
    txn.execute_unprepared(&format!(
        "set local statement_timeout = '{}ms'",
        NETWORK_LAST_ACTIVITY_REFRESH_STATEMENT_TIMEOUT_MS
    ))
    .await
    .c(h!())?;
    refresh_recent_frequency_activity(&txn).await.c(h!())?;
    let result = txn
        .execute_unprepared(
            r#"
            with activity as (
                select network.id,
                       max(freq.last_seen_dt) as last_active_at
                from sigint_network network
                left join sigint_network_freq freq
                  on freq.network_id = network.id
                 and freq.deleted = false
                 and freq.last_seen_dt >= freq.active_from
                 and (freq.active_to is null or freq.last_seen_dt <= freq.active_to)
                 and (network.active_from is null or freq.last_seen_dt >= network.active_from)
                 and (network.active_to is null or freq.last_seen_dt <= network.active_to)
                group by network.id
            )
            update sigint_network network
            set last_active_at = activity.last_active_at
            from activity
            where network.id = activity.id
              and network.last_active_at is distinct from activity.last_active_at
            "#,
        )
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(result.rows_affected())
}

async fn refresh_recent_frequency_activity(
    txn: &sea_orm::DatabaseTransaction,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            with recent_links as (
                select network_link.sigint_network_id as network_id,
                       inbox_item.freq,
                       coalesce(inbox_item.datetime, signal_message.timestamp, signal_message.created_at) as activity_at
                from sigint_inbox_item_network network_link
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
                where network_link.created_at >= (now() at time zone 'utc') - make_interval(mins => $1)
                  and signal_message.deleted = false
            ), recent_activity as (
                select network_freq.id,
                       max(recent_links.activity_at) as last_seen_dt
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
                group by network_freq.id
            )
            update sigint_network_freq network_freq
            set last_seen_dt = recent_activity.last_seen_dt
            from recent_activity
            where network_freq.id = recent_activity.id
              and (network_freq.last_seen_dt is null or network_freq.last_seen_dt < recent_activity.last_seen_dt)
        "#,
        [NETWORK_LAST_ACTIVITY_RECENT_LINK_WINDOW_MINUTES.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
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
        freq.update(&env.dbx).await.unwrap();

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
        assert_eq!(network_freq.last_seen_dt, Some(timestamp));
    }
}
