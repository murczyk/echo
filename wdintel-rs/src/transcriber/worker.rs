use crate::transcription::worker::{worker_policy, EchoTranscriptionAdapter};
use crate::{
    config::*,
    h,
    types::{Env, ShortContext},
};
use anyhow::{Context, Result};
use echo_gpu_client::{WorkerIterationResult, WorkerRunResult};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub async fn run_nofail(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) {
    while !cancel_token.is_cancelled() {
        if let Err(error) =
            run(env.clone(), worker_id, cancel_token.clone()).await
        {
            log::error!(
                "audio transcription worker cycle failed worker_id={worker_id}: {error:#}"
            );
            wait_or_cancel(
                &cancel_token,
                ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
            )
            .await;
        }
    }
}

async fn run(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) -> Result<()> {
    crate::transcription::service::ensure_sources_registered(&env.dbx)
        .await
        .context(h!())?;
    let client = tokio::select! {
        _ = cancel_token.cancelled() => return Ok(()),
        client = crate::transcription::executor::client(&env.config) => client.context(h!())?,
    };
    let adapter = EchoTranscriptionAdapter::new(env.clone(), worker_id)
        .await
        .context(h!())?;
    let policy = worker_policy();
    let mut last_status_log = None;
    log::info!("audio transcription worker started worker_id={worker_id}");

    loop {
        if cancel_token.is_cancelled() {
            break;
        }
        log_queue_status(env.as_ref(), worker_id, &mut last_status_log)
            .await
            .context(h!())?;
        if !crate::system_settings::audio_transcription_enabled(&env.dbx)
            .await
            .c(h!())?
        {
            wait_or_cancel(
                &cancel_token,
                ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
            )
            .await;
            continue;
        }

        let result = tokio::select! {
            _ = client.lost() => anyhow::bail!("transcription executor session lost"),
            result = echo_gpu_client::run_transcriber_worker_once(
                &client, worker_id, &policy, &adapter,
            ) => result.context(h!())?,
        };
        let result = match result {
            WorkerRunResult::Idle(reason) => {
                WorkerIterationResult::Idle(reason)
            }
            result => WorkerIterationResult::Processed {
                results: vec![result],
                queue_drained: !echo_gpu_client::has_due_work(
                    client.database(),
                )
                .await
                .context(h!())?,
            },
        };
        notify_completed(&env, &result).await.context(h!())?;
        wait_or_cancel(&cancel_token, worker_iteration_sleep_ms(&result)).await;
    }

    log::info!("audio transcription worker drained worker_id={worker_id}");
    Ok(())
}

async fn log_queue_status(
    env: &Env,
    worker_id: Uuid,
    last_log: &mut Option<tokio::time::Instant>,
) -> Result<()> {
    let now = tokio::time::Instant::now();
    if last_log.as_ref().is_some_and(|last_log| {
        now.duration_since(*last_log).as_secs()
            < ECHO_AUDIO_TRANSCRIPTION_STATUS_LOG_INTERVAL_SECS
    }) {
        return Ok(());
    }
    let status = echo_gpu_client::queue_status(&env.dbx)
        .await
        .context(h!())?;
    let oldest_due_age_seconds = status.oldest_due_at.map(|oldest_due_at| {
        (chrono::Utc::now().naive_utc() - oldest_due_at)
            .num_seconds()
            .max(0)
    });
    log::info!(
        "audio transcription status worker_id={worker_id} queued={} processing={} retrying={} completed={} terminal={} oldest_due_age_seconds={:?}",
        status.queued,
        status.processing,
        status.retrying,
        status.completed,
        status.terminal,
        oldest_due_age_seconds,
    );
    *last_log = Some(now);
    Ok(())
}

fn worker_iteration_sleep_ms(result: &WorkerIterationResult) -> u64 {
    match result {
        WorkerIterationResult::Idle(_)
        | WorkerIterationResult::Processed {
            queue_drained: true,
            ..
        } => ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
        WorkerIterationResult::Processed {
            queue_drained: false,
            ..
        } => ECHO_AUDIO_TRANSCRIPTION_ACTIVE_SLEEP_MS,
    }
}

async fn wait_or_cancel(cancel_token: &CancellationToken, sleep_ms: u64) {
    tokio::select! {
        _ = cancel_token.cancelled() => {}
        _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
    }
}

async fn notify_completed(
    env: &Env,
    result: &WorkerIterationResult,
) -> Result<()> {
    let WorkerIterationResult::Processed { results, .. } = result else {
        return Ok(());
    };
    let sources: Vec<Uuid> = results
        .iter()
        .filter_map(|result| match result {
            WorkerRunResult::Completed { source_id } => Some(*source_id),
            _ => None,
        })
        .collect();
    if sources.is_empty() {
        return Ok(());
    }
    let sql = format!("select distinct media.signal_message_id as id from transcription_source source join signal_message_media media on {}=source.source_key join signal_message message on message.id=media.signal_message_id and not message.deleted where source.id=any($1)", super::media_queue::SOURCE_KEY_SQL);
    let messages = env
        .dbx
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [sources.into()],
        ))
        .await
        .context(h!())?;
    for message in messages {
        crate::inbox::fanout_inbox_changed(
            &mut env.redis.clone(),
            message.try_get("", "id").context(h!())?,
        )
        .await
        .context(h!())?;
    }
    Ok(())
}
