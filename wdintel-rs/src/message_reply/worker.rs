use crate::config::{
    MESSAGE_REPLY_EVENT_BATCH, MESSAGE_REPLY_EVENT_INTERVAL_MS,
};
use crate::types::*;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, FromQueryResult, Statement,
    TransactionTrait,
};
use tokio_util::sync::CancellationToken;

pub async fn run(env: Arc<Env>, cancel: CancellationToken) {
    loop {
        if let Err(error) = flush(&env).await {
            error!("reply event delivery failed: {error:?}");
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_millis(MESSAGE_REPLY_EVENT_INTERVAL_MS)) => {}
        }
    }
}

async fn flush(env: &Env) -> anyhow::Result<()> {
    let txn = env.dbx.begin().await.c(h!())?;
    let rows = super::query::IdRow::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "select signal_message_id as id from message_reply_change order by signal_message_id limit $1 for update skip locked",
        vec![(MESSAGE_REPLY_EVENT_BATCH as i64).into()])).all(&txn).await.c(h!())?;
    let ids: Vec<_> = rows.into_iter().map(|row| row.id).collect();
    if !ids.is_empty() {
        // The source transactions committed before their outbox rows became visible.
        crate::inbox::fanout_inbox_changes(&mut env.redis.clone(), ids.clone())
            .await
            .c(h!())?;
        txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "delete from message_reply_change where signal_message_id = any($1)", vec![ids.into()])).await.c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}
