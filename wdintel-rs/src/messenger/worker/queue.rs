use crate::messenger::worker::pool::ProcessorPool;
use crate::messenger::worker::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use tokio::time::{sleep, Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Worker which ultimately consumes [signal_message_queue](crate::entities::signal_message_queue) rows
///
/// - TODO: document producers, consumers etc.
/// - at the end main processing business logic is done by [process_signal_message_queue_item](crate::message_queue::process_signal_message_queue_item)
pub async fn process_queue_nofail(
    env: Arc<Env>,
    cancel_token: CancellationToken,
) {
    tokio::join!(
        process_queue_loop_nofail(env.clone(), cancel_token.clone()),
        queue_metrics_nofail(env, cancel_token),
    );
}

async fn process_queue_loop_nofail(
    env: Arc<Env>,
    cancel_token: CancellationToken,
) {
    loop {
        if cancel_token.is_cancelled() {
            return;
        }
        if let Err(e) = process_queue_inner(env.clone(), &cancel_token).await {
            error!("process_queue_inner encountered an error: {:?}", e);
            if !sleep_unless_cancelled(
                &cancel_token,
                Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS),
            )
            .await
            {
                return;
            }
        }
        if !sleep_unless_cancelled(
            &cancel_token,
            Duration::from_millis(MESSENGER_WORKER_IDLE_SLEEP_MS),
        )
        .await
        {
            return;
        }
    }
}

pub async fn process_queue_inner(
    env: Arc<Env>,
    cancel_token: &CancellationToken,
) -> anyhow::Result<()> {
    let dbx = env.dbx.clone();

    info!("started process_queue_inner");

    if !wait_for_nlp_ready(&env, cancel_token).await {
        return Ok(());
    }

    let mut worker_pool =
        crate::messenger::worker::pool::mk_message_processor_pool(env.clone())
            .await
            .c(h!())?;

    loop {
        if cancel_token.is_cancelled() {
            info!("cancel token received, stopping process_queue_inner...");
            return Ok(());
        }
        let outcome = process_queue_inner_iteration(&mut worker_pool, &dbx)
            .await
            .c(h!())?;
        if outcome.failed_count > 0
            && crate::nlp::check_ready(&env.rq).await.is_err()
            && !wait_for_nlp_ready(&env, cancel_token).await
        {
            return Ok(());
        }
        let sleep_duration = if outcome.had_items {
            MESSENGER_WORKER_IDLE_SLEEP_MS
        } else {
            MESSENGER_WORKER_LONG_SLEEP_MS
        };
        if !sleep_unless_cancelled(
            cancel_token,
            Duration::from_millis(sleep_duration),
        )
        .await
        {
            return Ok(());
        }
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
struct QueueIterationOutcome {
    had_items: bool,
    failed_count: usize,
}

/// - Pull [signal_message_queue](crate::entities::signal_message_queue) rows in batches
async fn process_queue_inner_iteration(
    worker_pool: &mut ProcessorPool,
    dbx: &DatabaseConnection,
) -> anyhow::Result<QueueIterationOutcome> {
    let datasources = list_echo_accounts(None, dbx).await.c(h!())?;
    let active_status = AccountStatus::Active.into_value().value.into_owned();
    let datasource_ids = datasources
        .iter()
        .filter(|a| a.is_linked && a.status == active_status)
        .map(|a| a.id)
        .collect_vec();
    let next_items = signal_message_queue::Entity::find()
        .filter(
            signal_message_queue::Column::DatasourceId.eq_any(datasource_ids),
        )
        .filter(
            signal_message_queue::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(signal_message_queue::Column::NextAttemptAt)
        .order_by_asc(signal_message_queue::Column::CreatedAt)
        .limit(MESSENGER_WORKER_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    if next_items.is_empty() {
        return Ok(QueueIterationOutcome::default());
    }
    let signal_message_queue_ids =
        next_items.iter().map(|a| a.id).collect_vec();
    let attachments = if signal_message_queue_ids.is_empty() {
        vec![]
    } else {
        signal_message_queue_attachment::Entity::find()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .eq_any(signal_message_queue_ids),
            )
            .all(dbx)
            .await
            .c(h!())?
    };
    let outcome = crate::messenger::worker::pool::process_queue(
        worker_pool,
        next_items.clone(),
        attachments.clone(),
        datasources,
    )
    .await
    .c(h!())?;
    Ok(QueueIterationOutcome {
        had_items: true,
        failed_count: outcome.failed_count,
    })
}

async fn wait_for_nlp_ready(
    env: &Env,
    cancel_token: &CancellationToken,
) -> bool {
    let started_at = Instant::now();
    let startup_deadline =
        Duration::from_secs(MESSENGER_NLP_READY_STARTUP_DEADLINE_SEC);
    let mut deadline_reported = false;
    info!("waiting for NLP readiness before messenger queue processing");
    if let Some(metrics) = &env.metrics {
        metrics.record_messenger_nlp_ready(false);
    }

    loop {
        if cancel_token.is_cancelled() {
            return false;
        }
        match crate::nlp::check_ready(&env.rq).await {
            Ok(()) => {
                if let Some(metrics) = &env.metrics {
                    metrics.record_messenger_nlp_ready(true);
                }
                info!(
                    "NLP is ready; messenger queue processing resumed after {:.1}s",
                    started_at.elapsed().as_secs_f64()
                );
                return true;
            }
            Err(error)
                if started_at.elapsed() >= startup_deadline
                    && !deadline_reported =>
            {
                error!(
                    "NLP did not become ready within {} seconds; messenger queue processing remains paused while ingestion continues: {error:#}",
                    MESSENGER_NLP_READY_STARTUP_DEADLINE_SEC,
                );
                deadline_reported = true;
            }
            Err(_) => {}
        }

        let retry_delay = if deadline_reported {
            Duration::from_secs(MESSENGER_NLP_READY_DEGRADED_RETRY_SEC)
        } else {
            Duration::from_millis(MESSENGER_NLP_READY_STARTUP_RETRY_MS)
        };
        if !sleep_unless_cancelled(cancel_token, retry_delay).await {
            return false;
        }
    }
}

async fn sleep_unless_cancelled(
    cancel_token: &CancellationToken,
    duration: Duration,
) -> bool {
    tokio::select! {
        _ = cancel_token.cancelled() => false,
        _ = sleep(duration) => true,
    }
}

async fn queue_metrics_nofail(env: Arc<Env>, cancel_token: CancellationToken) {
    let Some(metrics) = env.metrics.clone() else {
        cancel_token.cancelled().await;
        return;
    };
    loop {
        match load_queue_metrics(&env.dbx).await {
            Ok(snapshot) => metrics.record_messenger_queue_state(
                snapshot.depth,
                snapshot.due_depth,
                snapshot.oldest_age_seconds,
            ),
            Err(error) => {
                error!("failed to load messenger queue metrics: {error:#}")
            }
        }
        if !sleep_unless_cancelled(
            &cancel_token,
            Duration::from_secs(MESSENGER_QUEUE_METRICS_INTERVAL_SEC),
        )
        .await
        {
            return;
        }
    }
}

#[derive(Debug, PartialEq)]
struct QueueMetricsSnapshot {
    depth: u64,
    due_depth: u64,
    oldest_age_seconds: f64,
}

async fn load_queue_metrics(
    dbx: &DatabaseConnection,
) -> anyhow::Result<QueueMetricsSnapshot> {
    let row = dbx
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
select
    count(*)::bigint as depth,
    count(*) filter (
        where next_attempt_at <= now() at time zone 'utc'
    )::bigint as due_depth,
    coalesce(
        extract(epoch from ((now() at time zone 'utc') - min(created_at))),
        0
    )::double precision as oldest_age_seconds
from signal_message_queue
            "#,
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let depth: i64 = row.try_get("", "depth").c(h!())?;
    let due_depth: i64 = row.try_get("", "due_depth").c(h!())?;
    Ok(QueueMetricsSnapshot {
        depth: u64::try_from(depth).c(h!())?,
        due_depth: u64::try_from(due_depth).c(h!())?,
        oldest_age_seconds: row.try_get("", "oldest_age_seconds").c(h!())?,
    })
}
