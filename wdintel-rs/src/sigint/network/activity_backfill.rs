use crate::config::NETWORK_LAST_ACTIVITY_BACKFILL_STATEMENT_TIMEOUT_MS;
use crate::error::AppError;
use crate::types::{info, Mode, ShortContext};
use crate::{h, OneoffBackfillNetworkLastActivityPs};
use anyhow::{ensure, Context};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use std::time::Instant;

pub(crate) async fn run_oneoff(
    mode: Mode,
    ps: &OneoffBackfillNetworkLastActivityPs,
) -> Result<(), AppError> {
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    run(&db, ps.batch_size, ps.after_id).await.c(h!())?;
    Ok(())
}

async fn run(
    db: &DatabaseConnection,
    batch_size: i64,
    after_id: i64,
) -> anyhow::Result<()> {
    ensure!(batch_size > 0, "batch_size must be positive");
    ensure!(after_id >= 0, "after_id must be nonnegative");
    let started = Instant::now();
    let total = count_missing_frequencies(db, after_id).await.c(h!())?;
    let mut after_id = after_id;
    let mut scanned = 0;

    loop {
        let ids = load_missing_frequency_ids(db, after_id, batch_size)
            .await
            .c(h!())?;
        if ids.is_empty() {
            break;
        }
        for id in ids {
            recalculate_frequency(db, id)
                .await
                .with_context(|| format!("network_freq_id={id}"))
                .c(h!())?;
            after_id = id;
            scanned += 1;
        }
        let rate = scanned as f64 / started.elapsed().as_secs_f64().max(0.001);
        let remaining = (total - scanned).max(0);
        let eta_seconds = (remaining as f64 / rate).ceil() as u64;
        info!(
            "network activity backfill: frequency_cursor={after_id} scanned={scanned} rate={rate:.1}/s estimated_remaining={remaining} eta_seconds={eta_seconds}"
        );
    }

    let updated = super::activity_cache::refresh(db).await.c(h!())?;
    println!(
        "network activity backfill complete: frequency_cursor={after_id} scanned={scanned} networks_updated={updated} elapsed={:.1}s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn count_missing_frequencies(
    db: &DatabaseConnection,
    after_id: i64,
) -> anyhow::Result<i64> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*) as missing from sigint_network_freq where id > $1 and deleted = false and last_seen_dt is null",
            [after_id.into()],
        ))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("frequency count returned no result"))
        .c(h!())?;
    row.try_get("", "missing").c(h!())
}

async fn load_missing_frequency_ids(
    db: &DatabaseConnection,
    after_id: i64,
    batch_size: i64,
) -> anyhow::Result<Vec<i64>> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select id
            from sigint_network_freq
            where id > $1 and deleted = false and last_seen_dt is null
            order by id
            limit $2
            "#,
            [after_id.into(), batch_size.into()],
        ))
        .await
        .c(h!())?;
    rows.into_iter()
        .map(|row| row.try_get("", "id").c(h!()))
        .collect()
}

async fn recalculate_frequency(
    db: &DatabaseConnection,
    network_freq_id: i64,
) -> anyhow::Result<()> {
    let txn = db.begin().await.c(h!())?;
    txn.execute_unprepared(&format!(
        "set local statement_timeout = '{NETWORK_LAST_ACTIVITY_BACKFILL_STATEMENT_TIMEOUT_MS}ms'"
    ))
    .await
    .c(h!())?;
    if super::recalculation::lock_network_freq_recalculation_target(
        &txn,
        network_freq_id,
    )
    .await
    .c(h!())?
    {
        super::recalculation::recalculate_last_seen(&txn, network_freq_id)
            .await
            .c(h!())?;
    }
    txn.commit().await.c(h!())?;
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
    use chrono::{Duration, NaiveDate, Utc};
    use sea_orm::{EntityTrait, Set};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn backfill_reconciles_valid_interception_time_and_survives_refresh()
    {
        let env = cleanup().await.unwrap();
        let timestamp = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.5000".to_string()),
                active_from: Set(timestamp - Duration::days(1)),
                active_to: Set(Some(timestamp + Duration::days(1))),
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
                created_at: Set(Utc::now().naive_utc()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let invalid_message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp + Duration::days(2))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let invalid_inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(invalid_message.id),
                freq: Set(Some("146.5000".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            &env.dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(invalid_inbox_item.id),
                sigint_network_id: Set(network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        run(&env.dbx, 1, 0).await.unwrap();
        run(&env.dbx, 1, network_freq.id).await.unwrap();

        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network_freq.last_seen_dt, Some(timestamp));
        assert_eq!(network.last_active_at, Some(timestamp));
    }
}
