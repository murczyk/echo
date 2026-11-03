//! Background extraction and cleanup for conversation uploads.

use super::extraction::{self, Step};
use crate::config::{
    AI_AGENT_UPLOAD_CLEANUP_BATCH, AI_AGENT_UPLOAD_CLEANUP_INTERVAL_SECS,
    AI_AGENT_UPLOAD_DRAFT_TTL_HOURS, AI_AGENT_UPLOAD_EXTRACTION_MAX_MINUTES,
    AI_AGENT_UPLOAD_LEASE_SECS, AI_AGENT_UPLOAD_MAX_ATTEMPTS,
    AI_AGENT_UPLOAD_POLL_SECS, AI_AGENT_UPLOAD_RETRY_SECS,
    AI_AGENT_UPLOAD_WORKER_SLEEP_SECS,
};
use crate::entities::ai_agent_upload;
use crate::h;
use crate::types::{error, Env, ShortContext};
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use std::{sync::Arc, time::Duration, time::Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub async fn run_nofail(env: Arc<Env>, cancel: CancellationToken) {
    let mut next_cleanup = Instant::now();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        if Instant::now() >= next_cleanup {
            if let Err(err) = cleanup(&env).await {
                error!("AI upload cleanup failed: {err:#}");
            }
            if let Err(err) = crate::ai_agent::documents::cleanup(&env).await {
                error!("AI document cleanup failed: {err:#}");
            }
            next_cleanup = Instant::now()
                + Duration::from_secs(AI_AGENT_UPLOAD_CLEANUP_INTERVAL_SECS);
        }
        let worked = match process_next(&env).await {
            Ok(worked) => worked,
            Err(err) => {
                error!("AI upload worker failed: {err:#}");
                false
            }
        };
        if worked {
            continue;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(AI_AGENT_UPLOAD_WORKER_SLEEP_SECS)) => {}
        }
    }
}

async fn process_next(env: &Env) -> anyhow::Result<bool> {
    let Some(upload) = claim(env).await.c(h!())? else {
        return Ok(false);
    };
    let lease = upload.lease.c(h!())?;
    if extraction_expired(&upload) {
        fail(env, upload.id, lease, "Обробка файлу тривала надто довго")
            .await
            .c(h!())?;
        return Ok(true);
    }
    match extraction::step(env, &upload).await {
        Ok(Step::Published) => {}
        Ok(Step::Pending { extractor_job_id }) => {
            wait(env, upload.id, lease, extractor_job_id, false)
                .await
                .c(h!())?;
        }
        Ok(Step::Rejected(message)) => {
            fail(env, upload.id, lease, message).await.c(h!())?;
        }
        Ok(Step::Busy) => {
            wait(env, upload.id, lease, upload.extractor_job_id, true)
                .await
                .c(h!())?;
        }
        Err(err) => {
            error!("AI upload {} extraction failed: {err:#}", upload.id);
            if upload.attempts >= AI_AGENT_UPLOAD_MAX_ATTEMPTS {
                fail(env, upload.id, lease, "Не вдалося обробити файл")
                    .await
                    .c(h!())?;
            } else {
                retry(env, upload.id, lease).await.c(h!())?;
            }
        }
    }
    Ok(true)
}

fn extraction_expired(upload: &ai_agent_upload::Model) -> bool {
    chrono::Utc::now().naive_utc() - upload.created_at
        > chrono::Duration::minutes(
            AI_AGENT_UPLOAD_EXTRACTION_MAX_MINUTES.into(),
        )
}

async fn claim(env: &Env) -> anyhow::Result<Option<ai_agent_upload::Model>> {
    ai_agent_upload::Model::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
update ai_agent_upload set lease=$1,
 lease_until=(now() at time zone 'utc') + make_interval(secs => $2),
 updated_at=now() at time zone 'utc'
where id=(
 select id from ai_agent_upload
 where state in ('uploaded','extracting')
   and next_attempt_at <= now() at time zone 'utc'
   and (lease_until is null or lease_until < now() at time zone 'utc')
 order by next_attempt_at, created_at, id
 limit 1 for update skip locked)
returning *
        "#,
        [Uuid::now_v7().into(), AI_AGENT_UPLOAD_LEASE_SECS.into()],
    ))
    .one(&env.dbx)
    .await
    .c(h!())
}

/// Releases the lease and schedules the next poll. A busy extractor does not
/// count as an attempt; a pending job resets the failure counter.
async fn wait(
    env: &Env,
    id: Uuid,
    lease: Uuid,
    extractor_job_id: Option<String>,
    busy: bool,
) -> anyhow::Result<()> {
    let delay = if busy {
        AI_AGENT_UPLOAD_RETRY_SECS
    } else {
        AI_AGENT_UPLOAD_POLL_SECS
    };
    execute(
        env,
        r#"
update ai_agent_upload set state='extracting', extractor_job_id=$3,
 attempts=case when $5 then attempts else 0 end,
 lease=null, lease_until=null,
 next_attempt_at=(now() at time zone 'utc') + make_interval(secs => $4),
 updated_at=now() at time zone 'utc'
where id=$1 and lease=$2
        "#,
        vec![
            id.into(),
            lease.into(),
            extractor_job_id.into(),
            delay.into(),
            busy.into(),
        ],
    )
    .await
}

async fn retry(env: &Env, id: Uuid, lease: Uuid) -> anyhow::Result<()> {
    execute(
        env,
        r#"
update ai_agent_upload set attempts=attempts+1, lease=null, lease_until=null,
 next_attempt_at=(now() at time zone 'utc') + make_interval(secs => $3 * (attempts+1)),
 updated_at=now() at time zone 'utc'
where id=$1 and lease=$2
        "#,
        vec![id.into(), lease.into(), AI_AGENT_UPLOAD_RETRY_SECS.into()],
    )
    .await
}

async fn fail(
    env: &Env,
    id: Uuid,
    lease: Uuid,
    message: &str,
) -> anyhow::Result<()> {
    execute(
        env,
        r#"
update ai_agent_upload set state='failed', last_error=$3, lease=null,
 lease_until=null, updated_at=now() at time zone 'utc'
where id=$1 and lease=$2
        "#,
        vec![id.into(), lease.into(), message.into()],
    )
    .await
}

async fn execute(
    env: &Env,
    sql: &str,
    values: Vec<sea_orm::Value>,
) -> anyhow::Result<()> {
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .c(h!())?;
    Ok(())
}

/// Deletes uploads of deleted conversations and drafts that were never sent.
/// Eligibility is evaluated by the delete itself, so a draft bound by a
/// concurrent send survives.
pub(super) async fn cleanup(env: &Env) -> anyhow::Result<()> {
    let deleted = ai_agent_upload::Model::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
delete from ai_agent_upload upload
where upload.id in (
  select candidate.id from ai_agent_upload candidate
  left join ai_agent_conversation conversation on conversation.id=candidate.conversation_id
  where conversation.deleted_at is not null
     or (candidate.request_id is null
         and candidate.created_at < (now() at time zone 'utc') - make_interval(hours => $1))
  order by candidate.created_at
  limit $2
  for update of candidate skip locked)
and (upload.request_id is null
     or exists(select 1 from ai_agent_conversation conversation
               where conversation.id=upload.conversation_id and conversation.deleted_at is not null))
returning upload.*
            "#,
            [
                AI_AGENT_UPLOAD_DRAFT_TTL_HOURS.into(),
                AI_AGENT_UPLOAD_CLEANUP_BATCH.into(),
            ],
        ),
    )
    .all(&env.dbx)
    .await
    .c(h!())?;
    for upload in deleted {
        super::store::delete_objects(env, &upload).await;
    }
    Ok(())
}
