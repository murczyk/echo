use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opentelemetry::KeyValue;
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    DatabaseTransaction, FromQueryResult, IsolationLevel, Statement,
    TransactionTrait,
};

use super::{Exporter, Snapshot};
use crate::config::*;
use crate::h;
use crate::types::{Env, ShortContext};

type FilesystemRead = tokio::task::JoinHandle<anyhow::Result<u64>>;

#[derive(Default)]
pub(super) struct FilesystemProbe {
    pending: tokio::sync::Mutex<Option<FilesystemRead>>,
}

impl FilesystemProbe {
    async fn read(&self) -> anyhow::Result<u64> {
        let mut pending = self.pending.lock().await;
        let read = pending.get_or_insert_with(|| {
            tokio::task::spawn_blocking(
                crate::server::monitoring::root_available_bytes,
            )
        });
        let result = read.await.c(h!());
        *pending = None;
        result.c(h!())?.c(h!())
    }
}

#[derive(Debug, FromQueryResult)]
struct Account {
    datasource_id: Option<i64>,
    account_id: Option<i32>,
    client_id: Option<i32>,
    messenger: String,
    linked: bool,
    active: bool,
}

impl Account {
    fn labels(&self) -> Vec<KeyValue> {
        let mut labels =
            vec![KeyValue::new("messenger", self.messenger.clone())];
        if let Some(id) = self.datasource_id {
            labels.push(KeyValue::new("datasource_id", id.to_string()));
        }
        if let Some(id) = self.account_id {
            labels.push(KeyValue::new("account_id", id.to_string()));
        }
        if let Some(id) = self.client_id {
            labels.push(KeyValue::new("client_id", id.to_string()));
        }
        labels
    }
}

pub(super) async fn collect(
    env: &Env,
    exporter: &Exporter,
    now: DateTime<Utc>,
) {
    tokio::join!(
        accounts_and_datasources(env, exporter, now),
        publish(
            exporter,
            "filesystem",
            now,
            filesystem(&exporter.filesystem)
        ),
        publish(exporter, "nlp", now, nlp(&env.rq)),
    );
}

async fn publish(
    exporter: &Exporter,
    source: &'static str,
    now: DateTime<Utc>,
    collect: impl Future<Output = anyhow::Result<Snapshot>>,
) {
    exporter.publish(source, now.timestamp_millis(), bounded(collect).await);
}

async fn bounded<T>(
    work: impl Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    tokio::time::timeout(
        Duration::from_secs(OPERATIONAL_METRICS_TIMEOUT_SECS),
        work,
    )
    .await
    .c(h!())?
    .c(h!())
}

pub(crate) async fn read_transaction(
    db: &DatabaseConnection,
) -> anyhow::Result<DatabaseTransaction> {
    let txn = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    txn.execute_unprepared(&format!(
        "SET LOCAL statement_timeout = '{}'",
        OPERATIONAL_METRICS_TIMEOUT_SECS * 1_000,
    ))
    .await
    .c(h!())?;
    Ok(txn)
}

async fn inventory(txn: &DatabaseTransaction) -> anyhow::Result<Vec<Account>> {
    let accounts = Account::find_by_statement(Statement::from_string(DatabaseBackend::Postgres, r#"
        select d.id as datasource_id, a.id as account_id, c.id as client_id,
               coalesce(a.source::text, d.kind) as messenger,
               coalesce(a.is_linked, false) as linked, d.status = 'active' as active
        from datasource d
        left join echo_client_lock l on l.id = d.echo_client_lock_id
        left join echo_account a on a.id = l.account_id
        left join echo_client c on c.id = l.client_id
        where not d.deleted and (d.kind in ('signal', 'whatsapp') or l.id is not null)
          and (c.id is null or not c.deleted)
          and (l.id is null or not l.remove_requested)
        union all
        select null::bigint, a.id, c.id, a.source::text, a.is_linked, false
        from echo_account a
        left join echo_client_lock l on l.account_id = a.id
        left join echo_client c on c.id = l.client_id
        where (c.id is null or not c.deleted)
          and (l.id is null or not l.remove_requested)
          and not exists (
              select 1 from datasource d
              where d.echo_client_lock_id = l.id and not d.deleted
          )
    "#)).all(txn).await.c(h!())?;
    Ok(accounts)
}

async fn accounts_and_datasources(
    env: &Env,
    exporter: &Exporter,
    now: DateTime<Utc>,
) {
    let inventory = bounded(async {
        let txn = read_transaction(&env.dbx).await.c(h!())?;
        let accounts = inventory(&txn).await.c(h!())?;
        Ok((txn, accounts))
    })
    .await;
    match inventory {
        Ok((txn, accounts)) => {
            let datasources = bounded(async {
                let snapshot =
                    datasource_snapshot(&txn, &accounts, now).await.c(h!())?;
                txn.commit().await.c(h!())?;
                Ok(snapshot)
            })
            .await;
            initialize_errors(exporter, &accounts);
            exporter.publish_all(
                now.timestamp_millis(),
                [
                    ("accounts", Ok(account_snapshot(&accounts))),
                    ("datasources", datasources),
                ],
            );
        }
        Err(error) => {
            exporter.publish_all(
                now.timestamp_millis(),
                [
                    ("accounts", Err(error)),
                    (
                        "datasources",
                        Err(anyhow::anyhow!("account inventory unavailable")),
                    ),
                ],
            );
        }
    }
}

fn account_snapshot(accounts: &[Account]) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for account in accounts {
        let labels = account.labels();
        if account.datasource_id.is_some() {
            snapshot.integer(
                OPERATIONAL_METRICS_DATASOURCE_ACTIVE,
                u64::from(account.active),
                &labels,
            );
        }
        if account.account_id.is_some() {
            snapshot.integer(
                OPERATIONAL_METRICS_ACCOUNT_LINKED,
                u64::from(account.linked),
                &labels,
            );
            snapshot.integer(
                OPERATIONAL_METRICS_ACCOUNT_ACTIVE,
                u64::from(account.active),
                &labels,
            );
        }
    }
    snapshot
}

async fn datasource_snapshot(
    txn: &DatabaseTransaction,
    accounts: &[Account],
    now: DateTime<Utc>,
) -> anyhow::Result<Snapshot> {
    let monitoring = echo_im::collect_monitoring_data_at(txn, now)
        .await
        .c(h!())?;
    let mut snapshot = Snapshot::default();
    for datasource in monitoring {
        for account in accounts.iter().filter(|account| {
            account.datasource_id.is_some()
                && account.account_id == Some(datasource.account_id)
                && account.client_id == Some(datasource.client_id)
        }) {
            let age = now
                .timestamp_millis()
                .saturating_sub(datasource.activity_at_ms())
                .max(0) as f64
                / 1_000.0;
            snapshot.float(
                OPERATIONAL_METRICS_ACTIVITY_AGE,
                age,
                &account.labels(),
            );
        }
    }
    Ok(snapshot)
}

fn initialize_errors(exporter: &Exporter, accounts: &[Account]) {
    for account in accounts
        .iter()
        .filter(|account| account.messenger == "signal")
    {
        for (operation, identified) in
            [("receive", true), ("send", true), ("request", false)]
        {
            if identified && account.account_id.is_none() {
                continue;
            }
            let mut labels = if identified {
                account.labels()
            } else {
                let mut labels = vec![KeyValue::new("messenger", "signal")];
                if let Some(id) = account.client_id {
                    labels.push(KeyValue::new("client_id", id.to_string()));
                }
                labels
            };
            labels.extend([
                KeyValue::new("path", "echo_im"),
                KeyValue::new("process", super::process()),
                KeyValue::new("operation", operation),
            ]);
            for kind in ["timeout", "other"] {
                let mut labels = labels.clone();
                labels.push(KeyValue::new("error_kind", kind));
                exporter.errors.add(0, &labels);
            }
        }
    }
}

async fn filesystem(probe: &FilesystemProbe) -> anyhow::Result<Snapshot> {
    let bytes = probe.read().await.c(h!())?;
    let mut snapshot = Snapshot::default();
    snapshot.integer(
        OPERATIONAL_METRICS_ROOT_BYTES,
        bytes,
        &[KeyValue::new("mountpoint", "/")],
    );
    Ok(snapshot)
}

async fn nlp(rq: &reqwest::Client) -> anyhow::Result<Snapshot> {
    let ready = crate::nlp::check_ready(rq).await.is_ok();
    let mut snapshot = Snapshot::default();
    snapshot.integer(OPERATIONAL_METRICS_NLP_READY, u64::from(ready), &[]);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    // https://github.com/echoua/echo/issues/4034
    #[tokio::test]
    async fn operational_filesystem_retains_a_probe_completed_after_timeout(
    ) -> anyhow::Result<()> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let read = tokio::task::spawn_blocking(move || {
            receiver.blocking_recv().c(h!())
        });
        let probe = FilesystemProbe {
            pending: tokio::sync::Mutex::new(Some(read)),
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(10), probe.read())
                .await
                .is_err()
        );
        sender.send(42).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !probe.pending.lock().await.as_ref().unwrap().is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .c(h!())?;
        assert_eq!(probe.read().await.c(h!())?, 42);
        assert!(probe.pending.lock().await.is_none());
        Ok(())
    }

    // https://github.com/echoua/echo/issues/4034
    #[tokio::test]
    #[serial_test::serial]
    async fn operational_inventory_and_freshness_share_a_database_snapshot(
    ) -> anyhow::Result<()> {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.c(h!())?;
        let now = Utc::now();
        let (account_id, datasource_id) =
            super::super::tests::seed_account(&env.dbx, now)
                .await
                .c(h!())?;
        let txn = read_transaction(&env.dbx).await.c(h!())?;
        let accounts = inventory(&txn).await.c(h!())?;
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"update echo_client set deleted = true where id in (
                    select client_id from echo_client_lock where account_id = $1
                )"#,
                [account_id.into()],
            ))
            .await
            .c(h!())?;
        let snapshot =
            datasource_snapshot(&txn, &accounts, now).await.c(h!())?;
        txn.commit().await.c(h!())?;
        let (metrics, recorder) =
            crate::telemetry::Metrics::recording(&env.config);
        metrics.operational.publish_all(
            now.timestamp_millis(),
            [
                ("accounts", Ok(account_snapshot(&accounts))),
                ("datasources", Ok(snapshot)),
            ],
        );
        let datasource_id = datasource_id.to_string();
        let labels = [("datasource_id", datasource_id.as_str())];
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_value(OPERATIONAL_METRICS_ACCOUNT_ACTIVE, &labels),
            Some(1)
        );
        assert_eq!(
            recorder.gauge_f64_value(OPERATIONAL_METRICS_ACTIVITY_AGE, &labels),
            Some(0.0)
        );
        collect(&env, &metrics.operational, now).await;
        metrics.force_flush_for_test();
        for name in [
            OPERATIONAL_METRICS_ACCOUNT_LINKED,
            OPERATIONAL_METRICS_ACCOUNT_ACTIVE,
            OPERATIONAL_METRICS_DATASOURCE_ACTIVE,
            OPERATIONAL_METRICS_ACTIVITY_AGE,
        ] {
            assert!(recorder.find_with_attributes(name, &labels).is_none());
        }
        Ok(())
    }
}
