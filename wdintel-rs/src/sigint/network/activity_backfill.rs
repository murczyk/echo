use crate::config::NETWORK_LAST_ACTIVITY_BACKFILL_STATEMENT_TIMEOUT_MS;
use crate::error::AppError;
use crate::types::{info, Mode, ShortContext};
use crate::{h, OneoffBackfillNetworkLastActivityPs};
use anyhow::ensure;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use std::time::Instant;

struct BatchResult {
    last_id: Option<i64>,
    scanned: i64,
    updated: i64,
}

pub(crate) async fn run_oneoff(
    mode: Mode,
    ps: &OneoffBackfillNetworkLastActivityPs,
) -> Result<(), AppError> {
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    run(&db, ps.batch_size).await.c(h!())?;
    Ok(())
}

async fn run(db: &DatabaseConnection, batch_size: i64) -> anyhow::Result<()> {
    ensure!(batch_size > 0, "batch_size must be positive");
    let started = Instant::now();
    let total = count_missing(db).await.c(h!())?;
    let mut after_id = 0;
    let mut scanned = 0;
    let mut updated = 0;

    loop {
        let batch = backfill_batch(db, after_id, batch_size).await.c(h!())?;
        let Some(last_id) = batch.last_id else {
            break;
        };
        after_id = last_id;
        scanned += batch.scanned;
        updated += batch.updated;
        let rate = scanned as f64 / started.elapsed().as_secs_f64().max(0.001);
        let remaining = (total - scanned).max(0);
        let eta_seconds = (remaining as f64 / rate).ceil() as u64;
        info!(
            "network activity backfill: cursor={after_id} scanned={scanned} updated={updated} rate={rate:.1}/s estimated_remaining={remaining} eta_seconds={eta_seconds}"
        );
    }

    println!(
        "network activity backfill complete: scanned={scanned} updated={updated} elapsed={:.1}s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn count_missing(db: &DatabaseConnection) -> anyhow::Result<i64> {
    let row = db
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "select count(*) as missing from sigint_network where last_active_at is null",
        ))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("network count returned no result"))
        .c(h!())?;
    row.try_get("", "missing").c(h!())
}

async fn backfill_batch(
    db: &DatabaseConnection,
    after_id: i64,
    batch_size: i64,
) -> anyhow::Result<BatchResult> {
    let txn = db.begin().await.c(h!())?;
    txn.execute_unprepared(&format!(
        "set local statement_timeout = '{NETWORK_LAST_ACTIVITY_BACKFILL_STATEMENT_TIMEOUT_MS}ms'"
    ))
    .await
    .c(h!())?;
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with selected as materialized (
                select id
                from sigint_network
                where id > $1 and last_active_at is null
                order by id
                limit $2
            ), activity as materialized (
                select selected.id,
                       max(network_link.created_at) as last_active_at
                from selected
                left join sigint_inbox_item_network network_link
                  on network_link.sigint_network_id = selected.id
                 and network_link.sigint_network_id = any(array(select id from selected))
                group by selected.id
            ), updated as (
                update sigint_network network
                set last_active_at = activity.last_active_at
                from activity
                where network.id = activity.id
                  and network.id = any(array(select id from selected))
                  and network.last_active_at is null
                  and activity.last_active_at is not null
                returning network.id
            )
            select (select max(id) from selected) as last_id,
                   (select count(*) from selected) as scanned,
                   (select count(*) from updated) as updated
            "#,
            [after_id.into(), batch_size.into()],
        ))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("backfill batch returned no result"))
        .c(h!())?;
    let result = BatchResult {
        last_id: row.try_get("", "last_id").c(h!())?,
        scanned: row.try_get("", "scanned").c(h!())?,
        updated: row.try_get("", "updated").c(h!())?,
    };
    txn.commit().await.c(h!())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{sigint_inbox_item_network, sigint_network};
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_sigint_inbox_item_network,
        mk_sigint_network,
    };
    use chrono::{Duration, Timelike, Utc};
    use sea_orm::{EntityTrait, Set};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn fills_only_missing_network_activity_from_latest_link() {
        let env = cleanup().await.unwrap();
        let older = Utc::now().naive_utc().with_nanosecond(0).unwrap()
            - Duration::days(2);
        let newer = older + Duration::days(1);
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let empty = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let filled = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                last_active_at: Set(Some(older)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        for created_at in [newer, older] {
            let inbox_item = mk_sigint_inbox_item(&env.dbx, Default::default())
                .await
                .unwrap();
            mk_sigint_inbox_item_network(
                &env.dbx,
                sigint_inbox_item_network::ActiveModel {
                    sigint_inbox_item_id: Set(inbox_item.id),
                    sigint_network_id: Set(network.id),
                    created_at: Set(created_at),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        run(&env.dbx, 1).await.unwrap();
        run(&env.dbx, 1).await.unwrap();

        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let empty = sigint_network::Entity::find_by_id(empty.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let filled = sigint_network::Entity::find_by_id(filled.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network.last_active_at, Some(newer));
        assert_eq!(empty.last_active_at, None);
        assert_eq!(filled.last_active_at, Some(older));
    }
}
