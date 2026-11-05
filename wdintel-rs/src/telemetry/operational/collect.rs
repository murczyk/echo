use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opentelemetry::KeyValue;
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    DatabaseTransaction, FromQueryResult, Statement, TransactionTrait,
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
        if pending.as_ref().is_some_and(|read| read.is_finished()) {
            *pending = None;
        }
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
        .begin_with_config(None, Some(AccessMode::ReadOnly))
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

async fn inventory(db: &DatabaseConnection) -> anyhow::Result<Vec<Account>> {
    let txn = read_transaction(db).await.c(h!())?;
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
    "#)).all(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(accounts)
}

async fn accounts_and_datasources(
    env: &Env,
    exporter: &Exporter,
    now: DateTime<Utc>,
) {
    match bounded(inventory(&env.dbx)).await {
        Ok(accounts) => {
            exporter.publish(
                "accounts",
                now.timestamp_millis(),
                Ok(account_snapshot(&accounts)),
            );
            initialize_errors(exporter, &accounts);
            publish(
                exporter,
                "datasources",
                now,
                datasource_snapshot(&env.dbx, &accounts, now),
            )
            .await;
        }
        Err(error) => {
            exporter.publish("accounts", now.timestamp_millis(), Err(error));
            exporter.publish(
                "datasources",
                now.timestamp_millis(),
                Err(anyhow::anyhow!("account inventory unavailable")),
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
    db: &DatabaseConnection,
    accounts: &[Account],
    now: DateTime<Utc>,
) -> anyhow::Result<Snapshot> {
    let txn = read_transaction(db).await.c(h!())?;
    let monitoring = echo_im::collect_monitoring_data_at(&txn, now)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
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
