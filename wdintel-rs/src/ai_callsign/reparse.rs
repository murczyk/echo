use super::feedback::sql;
use crate::config::*;
use crate::entities::signal_message;
use crate::h;
use crate::types::{Env, ShortContext};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, EntityTrait, FromQueryResult,
    TransactionTrait,
};
use uuid::Uuid;

#[derive(FromQueryResult)]
struct Run {
    id: Uuid,
    state: String,
    since_ts: NaiveDateTime,
    until_ts: NaiveDateTime,
    cursor_callsign: String,
    cursor_item_id: i64,
}

#[derive(FromQueryResult)]
struct Job {
    inbox_item_id: i64,
    attempts: i32,
}

pub(crate) async fn start(
    db: &DatabaseConnection,
    actor: Option<Uuid>,
    days: i64,
) -> anyhow::Result<Uuid> {
    anyhow::ensure!(days > 0, "Кількість днів повинна бути додатною");
    let now = Utc::now().naive_utc();
    let duration = chrono::Duration::try_days(days)
        .ok_or_else(|| anyhow::anyhow!("Завеликий період"))
        .c(h!())?;
    let since = now
        .checked_sub_signed(duration)
        .ok_or_else(|| anyhow::anyhow!("Завеликий період"))
        .c(h!())?;
    let transaction = db.begin().await.c(h!())?;
    transaction
        .execute_raw(sql(
            "select pg_advisory_xact_lock($1)",
            vec![(AI_CALLSIGN_WORKER_LOCK + 1).into()],
        ))
        .await
        .c(h!())?;
    if let Some(row) = transaction.query_one_raw(sql("select id from ai_callsign_reparse_run where state in ('enumerating', 'running')", vec![])).await.c(h!())? {
        return row.try_get("", "id").c(h!());
    }
    let id = Uuid::new_v4();
    transaction.execute_raw(sql("insert into ai_callsign_reparse_run (id, actor_id, automatic, state, since_ts, until_ts) values ($1, $2, $3, 'enumerating', $4, $5)", vec![id.into(), actor.into(), actor.is_none().into(), since.into(), now.into()])).await.c(h!())?;
    transaction.execute_raw(sql("insert into ai_callsign_reparse_target (run_id, callsign, removal_count) select $1, callsign, removal_count from ai_callsign_feedback_summary where $2 or removal_count > scheduled_count", vec![id.into(), actor.is_some().into()])).await.c(h!())?;
    transaction.execute_raw(sql("update ai_callsign_feedback_summary s set scheduled_count = greatest(s.scheduled_count, t.removal_count) from ai_callsign_reparse_target t where t.run_id = $1 and t.callsign = s.callsign", vec![id.into()])).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(id)
}

pub(crate) async fn tick(env: &Env) -> anyhow::Result<bool> {
    let Some(config) =
        super::worker::load_worker_config(&env.dbx).await.c(h!())?
    else {
        return Ok(false);
    };
    let active = Run::find_by_statement(sql("select id, state, since_ts, until_ts, cursor_callsign, cursor_item_id from ai_callsign_reparse_run where state in ('enumerating', 'running')", vec![])).one(&env.dbx).await.c(h!())?;
    let Some(run) = active else {
        if schedule(&env.dbx).await.c(h!())? {
            return Ok(true);
        }
        return cleanup(&env.dbx).await.c(h!());
    };
    if run.state == "enumerating" {
        return enumerate(&env.dbx, &run).await.c(h!());
    }
    let job = Job::find_by_statement(sql("select inbox_item_id, attempts from ai_callsign_reparse_job where run_id = $1 and state = 'pending' and next_attempt_at <= now() at time zone 'utc' order by next_attempt_at, inbox_item_id limit 1", vec![run.id.into()])).one(&env.dbx).await.c(h!())?;
    let Some(job) = job else {
        env.dbx.execute_raw(sql("update ai_callsign_reparse_run set state = case when failed > 0 then 'failed' else 'completed' end, completed_at = now() at time zone 'utc' where id = $1 and state = 'running' and not exists (select 1 from ai_callsign_reparse_job where run_id = $1 and state = 'pending')", vec![run.id.into()])).await.c(h!())?;
        return Ok(false);
    };
    let result = process(env, &run, &job, &config).await;
    finish(&env.dbx, &run, &job, result).await.c(h!())?;
    Ok(true)
}

async fn schedule(db: &DatabaseConnection) -> anyhow::Result<bool> {
    let row = db.query_one_raw(sql("select 1 as ready where exists (select 1 from ai_callsign_feedback_summary where removal_count > scheduled_count) and not exists (select 1 from ai_callsign_reparse_run where automatic and created_at > $1)", vec![(Utc::now().naive_utc() - chrono::Duration::seconds(AI_CALLSIGN_REPARSE_INTERVAL_SECS)).into()])).await.c(h!())?;
    if row.is_none() {
        return Ok(false);
    }
    start(db, None, AI_CALLSIGN_REPARSE_DAYS).await.c(h!())?;
    Ok(true)
}

async fn enumerate(db: &DatabaseConnection, run: &Run) -> anyhow::Result<bool> {
    let transaction = db.begin().await.c(h!())?;
    let active = transaction.query_one_raw(sql("select id from ai_callsign_reparse_run where id = $1 and state = 'enumerating' for update", vec![run.id.into()])).await.c(h!())?;
    if active.is_none() {
        return Ok(false);
    }
    let target = transaction.query_one_raw(sql("select callsign from ai_callsign_reparse_target where run_id = $1 and callsign >= $2 order by callsign limit 1", vec![run.id.into(), run.cursor_callsign.clone().into()])).await.c(h!())?;
    let Some(target) = target else {
        transaction.execute_raw(sql("update ai_callsign_reparse_run set state = 'running' where id = $1", vec![run.id.into()])).await.c(h!())?;
        transaction.commit().await.c(h!())?;
        return Ok(true);
    };
    let callsign: String = target.try_get("", "callsign").c(h!())?;
    let cursor = if callsign == run.cursor_callsign {
        run.cursor_item_id
    } else {
        0
    };
    let page = transaction.query_one_raw(sql(
        r#"
with candidates as materialized (
    select distinct sigint_inbox_item_id as id
    from sigint_inbox_item_callsign
    where callsign = $1 and not deleted and sigint_inbox_item_id > $2
    order by sigint_inbox_item_id limit $5
)
select (select max(id) from candidates) as last_id,
    coalesce(array_agg(i.id order by i.id) filter (where i.id is not null), '{}'::bigint[]) as ids
from candidates c left join sigint_inbox_item i on i.id = c.id
    and i.datetime >= $3 and i.datetime < $4
"#,
        vec![callsign.clone().into(), cursor.into(), run.since_ts.into(), run.until_ts.into(), AI_CALLSIGN_REPARSE_BATCH_SIZE.into()],
    )).await.c(h!())?.c(h!())?;
    let last: Option<i64> = page.try_get("", "last_id").c(h!())?;
    let ids: Vec<i64> = page.try_get("", "ids").c(h!())?;
    if let Some(last) = last {
        let inserted = transaction.execute_raw(sql("insert into ai_callsign_reparse_job (run_id, inbox_item_id) select $1, unnest($2::bigint[]) on conflict do nothing", vec![run.id.into(), ids.clone().into()])).await.c(h!())?.rows_affected();
        transaction.execute_raw(sql("update ai_callsign_reparse_run set cursor_callsign = $2, cursor_item_id = $3, total = total + $4 where id = $1", vec![run.id.into(), callsign.into(), last.into(), (inserted as i64).into()])).await.c(h!())?;
    } else {
        transaction.execute_raw(sql("update ai_callsign_reparse_run set cursor_callsign = coalesce((select min(callsign) from ai_callsign_reparse_target where run_id = $1 and callsign > $2), $2), cursor_item_id = 0, state = case when exists (select 1 from ai_callsign_reparse_target where run_id = $1 and callsign > $2) then 'enumerating' else 'running' end where id = $1", vec![run.id.into(), callsign.into()])).await.c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(true)
}

async fn process(
    env: &Env,
    run: &Run,
    job: &Job,
    config: &super::worker::WorkerConfig,
) -> anyhow::Result<&'static str> {
    let message = signal_message::Entity::find_by_id(job.inbox_item_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let Some(message) = message.filter(|m| !m.deleted) else {
        return Ok("skipped");
    };
    let is_aviation_group =
        crate::inbox::message_is_aviation_group(&env.dbx, &message)
            .await
            .c(h!())?;
    let Some(body) = message.body.filter(|body| !body.is_empty()) else {
        return Ok("skipped");
    };
    let callsigns = super::parse_with_feedback(
        &env.dbx,
        &env.rq,
        &config.ai_engine,
        &config.prompt,
        &body,
        is_aviation_group,
    )
    .await
    .c(h!())?;
    let active = env.dbx.query_one_raw(sql("select id from ai_callsign_reparse_run where id = $1 and state = 'running'", vec![run.id.into()])).await.c(h!())?;
    if active.is_none() {
        return Ok("skipped");
    }
    let changed = super::worker::complete_job(
        &env.dbx,
        &env.rq,
        job.inbox_item_id,
        &body,
        callsigns,
        Some(run.id),
    )
    .await
    .c(h!())?;
    if changed {
        crate::event_stream::fanout_mult(
            &mut env.redis.clone(),
            vec![crate::event_stream::types::EventMsg::new(
                crate::event_stream::types::EventType::ETInboxChanged(
                    job.inbox_item_id,
                ),
            )],
        )
        .await
        .c(h!())?;
    }
    Ok(if changed { "changed" } else { "unchanged" })
}

async fn finish(
    db: &DatabaseConnection,
    run: &Run,
    job: &Job,
    result: anyhow::Result<&str>,
) -> anyhow::Result<()> {
    let attempts = job.attempts + 1;
    let (state, error) = match result {
        Ok(state) => (state, None),
        Err(error) => (
            if attempts >= AI_CALLSIGN_WORKER_MAX_ATTEMPTS {
                "failed"
            } else {
                "pending"
            },
            Some(
                error
                    .to_string()
                    .chars()
                    .take(AI_CALLSIGN_WORKER_MAX_ERROR_CHARS)
                    .collect::<String>(),
            ),
        ),
    };
    let next = Utc::now().naive_utc()
        + chrono::Duration::seconds(super::worker::retry_delay_secs(attempts));
    let transaction = db.begin().await.c(h!())?;
    let active = transaction.query_one_raw(sql("select id from ai_callsign_reparse_run where id = $1 and state = 'running' for update", vec![run.id.into()])).await.c(h!())?;
    if active.is_none() {
        return Ok(());
    }
    let updated = transaction.execute_raw(sql("update ai_callsign_reparse_job set state = $3, attempts = $4, last_error = $5, next_attempt_at = $6 where run_id = $1 and inbox_item_id = $2 and state = 'pending'", vec![run.id.into(), job.inbox_item_id.into(), state.into(), attempts.into(), error.into(), next.into()])).await.c(h!())?.rows_affected();
    if state != "pending" && updated > 0 {
        let query = format!("update ai_callsign_reparse_run set {state} = {state} + 1 where id = $1");
        transaction
            .execute_raw(sql(&query, vec![run.id.into()]))
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn record_success<C: ConnectionTrait>(
    db: &C,
    run_id: Uuid,
    id: i64,
    state: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(state, "changed" | "unchanged"),
        "Invalid completion state"
    );
    let updated = db.execute_raw(sql("update ai_callsign_reparse_job set state = $3 where run_id = $1 and inbox_item_id = $2 and state = 'pending'", vec![run_id.into(), id.into(), state.into()])).await.c(h!())?.rows_affected();
    if updated > 0 {
        db.execute_raw(sql(&format!("update ai_callsign_reparse_run set {state} = {state} + 1 where id = $1"), vec![run_id.into()])).await.c(h!())?;
    }
    Ok(())
}

async fn cleanup(db: &DatabaseConnection) -> anyhow::Result<bool> {
    let transaction = db.begin().await.c(h!())?;
    let run = transaction.query_one_raw(sql("select id from ai_callsign_reparse_run where state in ('completed', 'failed') and not cleanup_complete order by created_at limit 1 for update", vec![])).await.c(h!())?;
    let Some(run) = run else {
        return Ok(false);
    };
    let id: Uuid = run.try_get("", "id").c(h!())?;
    let deleted = transaction.execute_raw(sql("delete from ai_callsign_reparse_job where (run_id, inbox_item_id) in (select run_id, inbox_item_id from ai_callsign_reparse_job where run_id = $1 and state in ('changed', 'unchanged', 'skipped') order by inbox_item_id limit $2)", vec![id.into(), AI_CALLSIGN_REPARSE_CLEANUP_BATCH_SIZE.into()])).await.c(h!())?.rows_affected();
    if deleted == 0 {
        transaction
            .execute_raw(sql(
                "delete from ai_callsign_reparse_target where run_id = $1",
                vec![id.into()],
            ))
            .await
            .c(h!())?;
        transaction.execute_raw(sql("update ai_callsign_reparse_run set cleanup_complete = true where id = $1", vec![id.into()])).await.c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(true)
}

#[cfg(test)]
pub(super) async fn enumerate_for_test(db: &DatabaseConnection, id: Uuid) {
    for _ in 0..20 {
        let run = Run::find_by_statement(sql("select id, state, since_ts, until_ts, cursor_callsign, cursor_item_id from ai_callsign_reparse_run where id = $1", vec![id.into()])).one(db).await.unwrap().unwrap();
        if run.state != "enumerating" {
            return;
        }
        enumerate(db, &run).await.unwrap();
    }
    panic!("enumeration did not finish");
}
