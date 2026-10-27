use super::{
    inference,
    input::{load as input, Snapshot as Input},
    message, settings,
    store::*,
};
use crate::{
    config::*,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, FromQueryResult, TransactionTrait,
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct Job {
    message_id: i64,
    lease: Option<Uuid>,
    attempts: i32,
}
#[derive(FromQueryResult)]
struct Allowed {
    allowed: bool,
}

pub(crate) async fn eligible<C: ConnectionTrait>(
    db: &C,
    message: i64,
) -> anyhow::Result<bool> {
    Ok(rows::<Allowed,_>(db, "select exists(select 1 from signal_message message join signal_message_group membership on membership.signal_message_id=message.id join signal_group g on g.master_key=membership.group_master_key where message.id=$1 and not message.deleted and not g.deleted and not g.is_archived and g.ai_transcript_analysis_enabled=true and message.created_at>=g.ai_transcript_analysis_enabled_at) as allowed", vec![message.into()]).await.c(h!())?.pop().c(h!())?.allowed)
}

pub(crate) async fn enqueue<C: ConnectionTrait>(
    db: &C,
    message: i64,
) -> anyhow::Result<()> {
    if eligible(db, message).await.c(h!())? {
        execute(db, "insert into ai_transcript_analysis_job(message_id) values($1) on conflict(message_id) do nothing", vec![message.into()]).await.c(h!())?;
    }
    Ok(())
}

pub(crate) async fn suppress<C: ConnectionTrait>(
    db: &C,
    message: i64,
) -> anyhow::Result<()> {
    execute(db, "insert into ai_transcript_analysis_job(message_id,manual_suppressed,state) values($1,true,'skipped') on conflict(message_id) do update set manual_suppressed=true,lease=null,lease_until=null,state=case when ai_transcript_analysis_job.state='completed' then 'completed' else 'skipped' end", vec![message.into()]).await.c(h!())?;
    execute(db, "update sigint_important set deleted=true where id=(select important_id from ai_transcript_analysis_job where message_id=$1) and not deleted", vec![message.into()]).await.c(h!())?;
    Ok(())
}

pub async fn run(env: Arc<Env>, cancel: CancellationToken) {
    while !cancel.is_cancelled() {
        let _loop_guard = crate::utils::worker_watch::loop_guard(
            "ai_transcript_analysis_worker",
        );
        let processed = tokio::select! {
            _ = cancel.cancelled() => break,
            result = step(&env) => match result {
                Ok(processed) => processed,
                Err(error) => { log::error!("transcript analysis worker: {error:#}"); false }
            }
        };
        if !processed {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(AI_TRANSCRIPT_ANALYSIS_IDLE_MS)) => ()
            }
        }
    }
}

async fn claim(db: &DatabaseConnection) -> anyhow::Result<Option<Job>> {
    Ok(rows(db, "with candidate as (select message_id from ai_transcript_analysis_job where not manual_suppressed and state in ('waiting','retry','running') and next_attempt_at<=now() at time zone 'utc' and (state<>'running' or lease_until<now() at time zone 'utc') order by next_attempt_at,message_id limit 1 for update skip locked) update ai_transcript_analysis_job job set state='running',lease=$1,lease_until=(now() at time zone 'utc')+make_interval(secs=>$2) from candidate where candidate.message_id=job.message_id returning job.message_id,job.lease,job.attempts", vec![Uuid::new_v4().into(),(AI_TRANSCRIPT_ANALYSIS_LEASE_SECS as f64).into()]).await.c(h!())?.pop())
}

async fn release(
    db: &DatabaseConnection,
    job: &Job,
    state: &str,
    delay: i64,
) -> anyhow::Result<()> {
    execute(db, "update ai_transcript_analysis_job set state=$3,lease=null,lease_until=null,next_attempt_at=(now() at time zone 'utc')+make_interval(secs=>$4) where message_id=$1 and lease=$2", vec![job.message_id.into(),job.lease.into(),state.into(),(delay as f64).into()]).await.c(h!())?;
    Ok(())
}

pub(crate) async fn step(env: &Env) -> anyhow::Result<bool> {
    let settings = settings::load(&env.dbx).await.c(h!())?;
    if !settings.worker_enabled {
        return Ok(false);
    }
    let Some(id) = settings.worker_ai_engine_id else {
        return Ok(false);
    };
    let engine = match settings::engine(&env.dbx, id, false).await {
        Ok(engine) => engine,
        Err(error) => {
            log::warn!("transcript analysis paused: {error:#}");
            return Ok(false);
        }
    };
    let Some(job) = claim(&env.dbx).await.c(h!())? else {
        return Ok(false);
    };
    if !eligible(&env.dbx, job.message_id).await.c(h!())? {
        release(&env.dbx, &job, "skipped", 0).await.c(h!())?;
        return Ok(true);
    }
    let files = env
        .file_registry_db
        .as_ref()
        .map(|files| files.connection());
    let snapshot = input(&env.dbx, files, job.message_id, false)
        .await
        .c(h!())?;
    if !snapshot.ready {
        release(&env.dbx, &job, "waiting", AI_TRANSCRIPT_ANALYSIS_WAIT_SECS)
            .await
            .c(h!())?;
        return Ok(true);
    }
    if snapshot.transcript.is_empty() {
        release(&env.dbx, &job, "skipped", 0).await.c(h!())?;
        return Ok(true);
    }
    if job.attempts >= AI_TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS {
        fail(&env.dbx, &job, "Вичерпано спроби після відновлення оренди")
            .await
            .c(h!())?;
        return Ok(true);
    }
    let Some(job) = rows::<Job,_>(&env.dbx, "update ai_transcript_analysis_job set attempts=attempts+1 where message_id=$1 and lease=$2 and lease_until>now() at time zone 'utc' and not manual_suppressed returning message_id,lease,attempts", vec![job.message_id.into(),job.lease.into()]).await.c(h!())?.pop() else { return Ok(true); };
    let response = inference::analyze(
        &env.ai_engine_client,
        &engine,
        settings::effective_prompt(&settings),
        &snapshot.transcript,
    )
    .await;
    let changed = complete(
        &env.dbx, files, &job, &settings, &engine, &snapshot, response,
    )
    .await
    .c(h!())?;
    if changed {
        crate::inbox::fanout_inbox_changed(
            &mut env.redis.clone(),
            job.message_id,
        )
        .await
        .c(h!())?;
    }
    Ok(true)
}

async fn complete(
    db: &DatabaseConnection,
    files: Option<&DatabaseConnection>,
    job: &Job,
    expected: &settings::Settings,
    engine: &crate::entities::ai_engine::Model,
    snapshot: &Input,
    response: anyhow::Result<(inference::Decision, String)>,
) -> anyhow::Result<bool> {
    let transaction = db.begin().await.c(h!())?;
    transaction
        .query_all_raw(sql(
            "select id from signal_message where id=$1 for update",
            vec![job.message_id.into()],
        ))
        .await
        .c(h!())?;
    let current = rows::<Job,_>(&transaction, "select message_id,lease,attempts from ai_transcript_analysis_job where message_id=$1 and lease=$2 and not manual_suppressed and state='running' and lease_until>now() at time zone 'utc' for update", vec![job.message_id.into(),job.lease.into()]).await.c(h!())?.pop();
    if current.is_none() {
        return Ok(false);
    }

    transaction.query_all_raw(sql("select g.master_key from signal_group g join signal_message_group membership on membership.group_master_key=g.master_key where membership.signal_message_id=$1 order by g.master_key for share of g",vec![job.message_id.into()])).await.c(h!())?;
    if !eligible(&transaction, job.message_id).await.c(h!())? {
        release_in_transaction(&transaction, job, "skipped")
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    let current_engine = settings::engine(&transaction, engine.id, true).await;
    transaction.query_all_raw(sql("select id from ai_transcript_analysis_settings where id=1 for share",vec![])).await.c(h!())?;
    let settings = settings::load(&transaction).await.c(h!())?;
    if settings.revision != expected.revision
        || current_engine
            .as_ref()
            .map(|current| current.updated_at)
            .ok()
            != Some(engine.updated_at)
        || input(&transaction, files, job.message_id, true)
            .await
            .c(h!())?
            != *snapshot
    {
        release_in_transaction(&transaction, job, "waiting")
            .await
            .c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(false);
    }
    let changed = match response {
        Ok((decision, response)) => {
            apply(
                &transaction,
                job,
                expected,
                engine.id,
                snapshot,
                &decision,
                response,
            )
            .await
            .c(h!())?;
            decision.important
        }
        Err(error) => {
            fail(&transaction, job, &format!("{error:#}"))
                .await
                .c(h!())?;
            false
        }
    };
    transaction.commit().await.c(h!())?;
    Ok(changed)
}

async fn release_in_transaction<C: ConnectionTrait>(
    db: &C,
    job: &Job,
    state: &str,
) -> anyhow::Result<()> {
    execute(db, "update ai_transcript_analysis_job set state=$3,lease=null,lease_until=null,next_attempt_at=(now() at time zone 'utc')+make_interval(secs=>$4) where message_id=$1 and lease=$2",vec![job.message_id.into(),job.lease.into(),state.into(),(AI_TRANSCRIPT_ANALYSIS_WAIT_SECS as f64).into()]).await.c(h!())?;
    Ok(())
}

async fn apply<C: ConnectionTrait>(
    db: &C,
    job: &Job,
    settings: &settings::Settings,
    engine: Uuid,
    input: &Input,
    decision: &inference::Decision,
    response: String,
) -> anyhow::Result<()> {
    let important_id = if decision.important {
        #[derive(FromQueryResult)]
        struct Important {
            id: i64,
        }
        Some(rows::<Important,_>(db, "insert into sigint_important(signal_message_id,signal_message_uuid) select id,id_uuid from signal_message where id=$1 returning id", vec![job.message_id.into()]).await.c(h!())?.pop().c(h!())?.id)
    } else {
        None
    };
    if decision.important {
        message::append_analysis(db, job.message_id, decision)
            .await
            .c(h!())?;
    }
    execute(db, "update ai_transcript_analysis_job set state='completed',important=$3,important_id=$4,transcript=$5,prompt=$6,ai_engine_id=$7,response_text=$8,completed_at=now() at time zone 'utc',lease=null,lease_until=null,last_error=null where message_id=$1 and lease=$2", vec![job.message_id.into(),job.lease.into(),decision.important.into(),important_id.into(),input.transcript.clone().into(),settings::effective_prompt(settings).into(),engine.into(),response.into()]).await.c(h!())?;
    Ok(())
}

async fn fail<C: ConnectionTrait>(
    db: &C,
    job: &Job,
    error: &str,
) -> anyhow::Result<()> {
    let attempts = job.attempts;
    let state = if attempts >= AI_TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS {
        "failed"
    } else {
        "retry"
    };
    let delay = (AI_TRANSCRIPT_ANALYSIS_RETRY_BASE_SECS
        * 2_i64.pow(job.attempts.saturating_sub(1).min(6) as u32))
    .min(AI_TRANSCRIPT_ANALYSIS_RETRY_MAX_SECS);
    let error: String = error
        .chars()
        .take(AI_TRANSCRIPT_ANALYSIS_ERROR_MAX_CHARS)
        .collect();
    execute(db, "update ai_transcript_analysis_job set state=$3,attempts=$4,last_error=$5,lease=null,lease_until=null,next_attempt_at=(now() at time zone 'utc')+make_interval(secs=>$6) where message_id=$1 and lease=$2", vec![job.message_id.into(),job.lease.into(),state.into(),attempts.into(),error.into(),(delay as f64).into()]).await.c(h!())?;
    log::warn!(
        "transcript analysis message_id={} state={state} attempts={attempts}",
        job.message_id
    );
    Ok(())
}

#[cfg(test)]
mod tests;
