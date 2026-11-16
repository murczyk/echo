use super::{
    access, activity_titles::ActivityTitles, auth, chat_monitoring,
    dispatcher::DispatcherClient, events, lifecycle, review,
};
use crate::ai_engine::client::{government_model, model_id};
use crate::config::{
    AI_AGENT_DESTROY_STOPPED_DAYS, AI_AGENT_DISPATCHER_TIMEOUT_SEC,
    AI_AGENT_ERROR_MAX_CHARS, AI_AGENT_HISTORY_MAX_TURNS,
    AI_AGENT_IDLE_STOP_MINUTES, AI_AGENT_MAX_RUNNING_CONTAINERS,
    AI_AGENT_REASON_MODEL_REFUSAL, AI_AGENT_REASON_PROVIDER_ERROR,
    AI_AGENT_REQUEST_CLAIM_ADVISORY_LOCK_KEY, AI_AGENT_REQUEST_WORKER_COUNT,
    AI_AGENT_RESPONSE_MAX_BYTES, AI_AGENT_RESPONSE_MAX_CHARS,
    AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES, AI_AGENT_USER_FAILURE_MESSAGE,
    AI_AGENT_WORKER_ERROR_SLEEP_SEC, AI_AGENT_WORKER_IDLE_SLEEP_MS,
    AI_AGENT_WORKER_LEASE_ADVISORY_LOCK_KEY,
    AI_AGENT_WORKER_LEASE_HEARTBEAT_SEC,
    AI_AGENT_WORKER_LEASE_HEARTBEAT_TIMEOUT_SEC,
    AI_AGENT_WORKER_LEASE_RETRY_MS, AI_AGENT_WORKER_LEASE_TAKEOVER_GRACE_SEC,
    AI_AGENT_WORKER_SHUTDOWN_GRACE_SEC,
};
use crate::entities::{
    ai_agent_container, ai_agent_conversation, ai_agent_engine_runtime_profile,
    ai_agent_request,
};
use crate::error::AppError;
use crate::h;
use crate::types::{error, info, warn, Context, Env, ShortContext};
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition,
    ConnectionTrait, DatabaseBackend, EntityTrait, FromQueryResult,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Statement,
    TransactionTrait,
};
use serde_json::{json, Value};
use sqlx::pool::PoolConnection;
use sqlx::Postgres;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};
use tokio::task::JoinSet;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

enum RunOutcome {
    Completed(String, Option<super::types::AiAgentCompletionMetadata>),
    Cancelled,
}

struct CheckpointProvider {
    ai_engine_id: Uuid,
    model_name: String,
    context_window: i32,
    max_tokens: i32,
}

struct WorkerLease {
    connection: PoolConnection<Postgres>,
}

pub async fn run_nofail(env: Arc<Env>, cancellation: CancellationToken) {
    if env.config.ai_agent_work_memory_enabled.is_none() {
        crate::types::warn!(
            "AI work memory is disabled: ai_agent_work_memory_enabled is unset"
        );
    }
    while !cancellation.is_cancelled() {
        let lease = match wait_for_worker_lease(
            &env.dbx,
            &cancellation,
            AI_AGENT_WORKER_LEASE_ADVISORY_LOCK_KEY,
        )
        .await
        {
            Ok(Some(lease)) => lease,
            Ok(None) => break,
            Err(err) => {
                error!("AI agent worker lease acquisition failed: {err:#?}");
                wait_or_cancel(
                    &cancellation,
                    StdDuration::from_secs(AI_AGENT_WORKER_ERROR_SLEEP_SEC),
                )
                .await;
                continue;
            }
        };
        info!("AI agent worker lease acquired");
        let lease_lost =
            run_as_lease_owner(env.clone(), cancellation.clone(), lease).await;
        if cancellation.is_cancelled() {
            break;
        }
        if lease_lost {
            error!("AI agent worker lease was lost; waiting to reacquire it");
            wait_or_cancel(
                &cancellation,
                StdDuration::from_secs(AI_AGENT_WORKER_ERROR_SLEEP_SEC),
            )
            .await;
        }
    }
}

async fn run_as_lease_owner(
    env: Arc<Env>,
    cancellation: CancellationToken,
    mut lease: WorkerLease,
) -> bool {
    if !prepare_lease_owner(&env, &cancellation, &mut lease).await {
        close_worker_lease(lease).await;
        return !cancellation.is_cancelled();
    }
    let worker_cancellation = cancellation.child_token();
    let mut workers = JoinSet::new();
    for worker_index in 0..AI_AGENT_REQUEST_WORKER_COUNT {
        let env = env.clone();
        let cancellation = worker_cancellation.clone();
        workers.spawn(async move {
            request_loop(env, cancellation, worker_index).await;
        });
    }
    {
        let env = env.clone();
        let cancellation = worker_cancellation.clone();
        workers.spawn(async move { review_loop(env, cancellation).await });
    }
    {
        let env = env.clone();
        let cancellation = worker_cancellation.clone();
        workers.spawn(async move { alert_loop(env, cancellation).await });
    }
    {
        let env = env.clone();
        let cancellation = worker_cancellation.clone();
        workers.spawn(
            async move { chat_monitoring_loop(env, cancellation).await },
        );
    }
    {
        let env = env.clone();
        let cancellation = worker_cancellation.clone();
        workers.spawn(async move { maintenance_loop(env, cancellation).await });
    }
    let lease_lost = supervise_worker_lease(&cancellation, &mut lease).await;
    worker_cancellation.cancel();
    let graceful = tokio::time::timeout(
        StdDuration::from_secs(AI_AGENT_WORKER_SHUTDOWN_GRACE_SEC),
        async { while workers.join_next().await.is_some() {} },
    )
    .await;
    if graceful.is_err() {
        workers.abort_all();
        while workers.join_next().await.is_some() {}
    }
    if !lease_lost {
        match lease.heartbeat().await {
            Ok(()) => {
                if let Err(err) = recover_interrupted_requests(&env).await {
                    error!("AI agent shutdown recovery failed: {err:#?}");
                }
            }
            Err(err) => {
                error!(
                    "AI agent worker lease was lost during shutdown: {err:#?}"
                );
            }
        }
    }
    close_worker_lease(lease).await;
    lease_lost
}

async fn prepare_lease_owner(
    env: &Env,
    cancellation: &CancellationToken,
    lease: &mut WorkerLease,
) -> bool {
    if let Err(err) = lease.heartbeat().await {
        error!("AI agent worker lease validation failed: {err:#?}");
        return false;
    }
    match has_running_requests(env).await {
        Ok(true) => {
            info!(
                "AI agent worker lease takeover is waiting for the prior owner to quiesce"
            );
            match wait_for_takeover_grace(cancellation, lease).await {
                Ok(true) => {}
                Ok(false) => return false,
                Err(err) => {
                    error!(
                        "AI agent worker lease was lost during takeover: {err:#?}"
                    );
                    return false;
                }
            }
        }
        Ok(false) => {}
        Err(err) => {
            error!("AI agent running-request check failed: {err:#?}");
            return false;
        }
    }
    if let Err(err) = recover_interrupted_requests(env).await {
        error!("AI agent request recovery failed: {err:#?}");
        return false;
    }
    if let Err(err) = lease.heartbeat().await {
        error!("AI agent worker lease was lost during recovery: {err:#?}");
        return false;
    }
    true
}

async fn has_running_requests(env: &Env) -> Result<bool, AppError> {
    Ok(ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::State.eq("running"))
        .one(&env.dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn wait_for_worker_lease(
    dbx: &sea_orm::DatabaseConnection,
    cancellation: &CancellationToken,
    lock_key: i64,
) -> Result<Option<WorkerLease>, AppError> {
    if cancellation.is_cancelled() {
        return Ok(None);
    }
    let acquire = dbx.get_postgres_connection_pool().acquire();
    let mut connection = tokio::select! {
        _ = cancellation.cancelled() => return Ok(None),
        connection = acquire => connection.c(h!())?,
    };
    connection.close_on_drop();
    loop {
        if try_acquire_worker_lease(&mut connection, lock_key).await? {
            return Ok(Some(WorkerLease { connection }));
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(None),
            _ = tokio::time::sleep(StdDuration::from_millis(
                AI_AGENT_WORKER_LEASE_RETRY_MS,
            )) => {}
        }
    }
}

async fn try_acquire_worker_lease(
    connection: &mut PoolConnection<Postgres>,
    lock_key: i64,
) -> Result<bool, AppError> {
    let acquire =
        sqlx::query_scalar::<_, bool>("select pg_try_advisory_lock($1)")
            .bind(lock_key)
            .fetch_one(&mut **connection);
    Ok(tokio::time::timeout(worker_lease_query_timeout(), acquire)
        .await
        .map_err(|_| AppError::BL {
            msg: "AI agent worker lease acquisition timed out".to_string(),
        })?
        .c(h!())?)
}

impl WorkerLease {
    async fn heartbeat(&mut self) -> Result<(), AppError> {
        let heartbeat = sqlx::query("select 1").execute(&mut *self.connection);
        tokio::time::timeout(worker_lease_query_timeout(), heartbeat)
            .await
            .map_err(|_| AppError::BL {
                msg: "AI agent worker lease heartbeat timed out".to_string(),
            })?
            .c(h!())?;
        Ok(())
    }
}

async fn wait_for_takeover_grace(
    cancellation: &CancellationToken,
    lease: &mut WorkerLease,
) -> Result<bool, AppError> {
    let delay = tokio::time::sleep(StdDuration::from_secs(
        AI_AGENT_WORKER_LEASE_TAKEOVER_GRACE_SEC,
    ));
    tokio::pin!(delay);
    let mut heartbeat = tokio::time::interval(StdDuration::from_secs(
        AI_AGENT_WORKER_LEASE_HEARTBEAT_SEC,
    ));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(false),
            _ = &mut delay => return Ok(true),
            _ = heartbeat.tick() => lease.heartbeat().await?,
        }
    }
}

async fn supervise_worker_lease(
    cancellation: &CancellationToken,
    lease: &mut WorkerLease,
) -> bool {
    let mut heartbeat = tokio::time::interval(StdDuration::from_secs(
        AI_AGENT_WORKER_LEASE_HEARTBEAT_SEC,
    ));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return false,
            _ = heartbeat.tick() => {
                if let Err(err) = lease.heartbeat().await {
                    error!("AI agent worker lease heartbeat failed: {err:#?}");
                    return true;
                }
            }
        }
    }
}

async fn close_worker_lease(lease: WorkerLease) {
    if let Err(err) = lease.connection.close().await {
        error!("AI agent worker lease connection close failed: {err:#?}");
    }
}

fn worker_lease_query_timeout() -> StdDuration {
    StdDuration::from_secs(AI_AGENT_WORKER_LEASE_HEARTBEAT_TIMEOUT_SEC)
}

async fn wait_or_cancel(
    cancellation: &CancellationToken,
    duration: StdDuration,
) {
    tokio::select! {
        _ = cancellation.cancelled() => {}
        _ = tokio::time::sleep(duration) => {}
    }
}

async fn request_loop(
    env: Arc<Env>,
    cancellation: CancellationToken,
    worker_index: usize,
) {
    while !cancellation.is_cancelled() {
        match claim_next_request(&env).await {
            Ok(Some(request)) => {
                info!(
                    "AI agent worker {worker_index} claimed request {}",
                    request.id
                );
                process_claimed_request(&env, request, &cancellation).await;
            }
            Ok(None) => {
                tokio::time::sleep(StdDuration::from_millis(
                    AI_AGENT_WORKER_IDLE_SLEEP_MS,
                ))
                .await;
            }
            Err(err) => {
                error!("AI agent worker {worker_index} claim failed: {err:#?}");
                tokio::time::sleep(StdDuration::from_secs(
                    AI_AGENT_WORKER_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

/// Claims the next request to run. A conversation runs its requests one at a
/// time, in order; a user's conversations run in parallel while they need the
/// same container proxies (#4232). Claims are serialized so each sees the
/// requests the previous one started.
async fn claim_next_request(
    env: &Env,
) -> Result<Option<ai_agent_request::Model>, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    txn.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [AI_AGENT_REQUEST_CLAIM_ADVISORY_LOCK_KEY.into()],
    ))
    .await
    .c(h!())?;
    let candidates = claim_candidates(&txn).await.context(h!())?;
    let request_id = if candidates.is_empty() {
        None
    } else {
        let running =
            running_requests_of(&txn, &candidates).await.context(h!())?;
        let needs = engine_proxy_needs(&txn, &candidates, &running)
            .await
            .context(h!())?;
        let containers_in_use = containers_in_use(&txn).await.context(h!())?;
        pick_claim(&candidates, &running, &needs, containers_in_use)
    };
    let request = match request_id {
        Some(request_id) => start_claimed_request(&txn, request_id)
            .await
            .context(h!())?,
        None => None,
    };
    txn.commit().await.c(h!())?;
    Ok(request)
}

#[derive(Clone, Debug, FromQueryResult)]
struct ClaimCandidate {
    id: Uuid,
    human_login_id: Uuid,
    ai_engine_id: Uuid,
    queued_at: chrono::NaiveDateTime,
}

/// Each user's oldest queued request that heads its conversation's queue.
/// Only the oldest is offered, so a request needing other proxies than the
/// user's running ones is not overtaken by newer requests that fit.
async fn claim_candidates(
    txn: &sea_orm::DatabaseTransaction,
) -> Result<Vec<ClaimCandidate>, AppError> {
    let statement = Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
select distinct on (request.human_login_id)
    request.id,
    request.human_login_id,
    request.ai_engine_id,
    request.queued_at
from ai_agent_request request
where request.state = 'queued'
  and not exists (
      select 1
      from ai_agent_request running
      where running.conversation_id = request.conversation_id
        and running.state = 'running'
  )
  and not exists (
      select 1
      from ai_agent_request earlier
      where earlier.conversation_id = request.conversation_id
        and earlier.state = 'queued'
        and (earlier.queued_at, earlier.id) < (request.queued_at, request.id)
  )
order by request.human_login_id, request.queued_at, request.id
        "#,
    );
    Ok(ClaimCandidate::find_by_statement(statement)
        .all(txn)
        .await
        .c(h!())?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RunningRequest {
    human_login_id: Uuid,
    ai_engine_id: Uuid,
}

async fn running_requests_of(
    txn: &sea_orm::DatabaseTransaction,
    candidates: &[ClaimCandidate],
) -> Result<Vec<RunningRequest>, AppError> {
    let human_login_ids = candidates
        .iter()
        .map(|candidate| candidate.human_login_id)
        .collect::<Vec<_>>();
    let running: Vec<(Uuid, Uuid)> = ai_agent_request::Entity::find()
        .select_only()
        .column(ai_agent_request::Column::HumanLoginId)
        .column(ai_agent_request::Column::AiEngineId)
        .filter(ai_agent_request::Column::State.eq("running"))
        .filter(ai_agent_request::Column::HumanLoginId.is_in(human_login_ids))
        .into_tuple()
        .all(txn)
        .await
        .c(h!())?;
    Ok(running
        .into_iter()
        .map(|(human_login_id, ai_engine_id)| RunningRequest {
            human_login_id,
            ai_engine_id,
        })
        .collect())
}

/// Containers serving running requests: one per user running any.
async fn containers_in_use(
    txn: &sea_orm::DatabaseTransaction,
) -> Result<u64, AppError> {
    let row = txn
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "select count(distinct human_login_id) as count
             from ai_agent_request
             where state = 'running'",
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let count: i64 = row.try_get("", "count").c(h!())?;
    Ok(count.max(0) as u64)
}

async fn engine_proxy_needs(
    txn: &sea_orm::DatabaseTransaction,
    candidates: &[ClaimCandidate],
    running: &[RunningRequest],
) -> Result<HashMap<Uuid, access::AgentProxyNeed>, AppError> {
    let ai_engine_ids = candidates
        .iter()
        .map(|candidate| candidate.ai_engine_id)
        .chain(running.iter().map(|running| running.ai_engine_id))
        .collect::<BTreeSet<_>>();
    Ok(crate::entities::ai_engine::Entity::find()
        .filter(crate::entities::ai_engine::Column::Id.is_in(ai_engine_ids))
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|ai_engine| {
            access::agent_proxy_need(&ai_engine)
                .map(|need| (ai_engine.id, need))
        })
        .collect())
}

/// A candidate may run beside its user's running requests only if they all
/// need the same container proxies; an engine the harness cannot serve runs
/// alone and fails at its start. A user with nothing running needs a
/// container of their own, so they wait while every container slot serves
/// running requests, instead of failing at the running-container limit; the
/// extra worker slots go to more conversations of users already running.
/// Users running the fewest requests go first.
fn pick_claim(
    candidates: &[ClaimCandidate],
    running: &[RunningRequest],
    needs: &HashMap<Uuid, access::AgentProxyNeed>,
    containers_in_use: u64,
) -> Option<Uuid> {
    let container_available =
        containers_in_use < AI_AGENT_MAX_RUNNING_CONTAINERS;
    candidates
        .iter()
        .filter_map(|candidate| {
            let users_running = running
                .iter()
                .filter(|running| {
                    running.human_login_id == candidate.human_login_id
                })
                .collect::<Vec<_>>();
            let claimable = if users_running.is_empty() {
                container_available
            } else {
                needs.get(&candidate.ai_engine_id).is_some_and(|need| {
                    users_running.iter().all(|running| {
                        needs.get(&running.ai_engine_id) == Some(need)
                    })
                })
            };
            claimable.then_some((users_running.len(), candidate))
        })
        .min_by_key(|(running_count, candidate)| {
            (*running_count, candidate.queued_at, candidate.id)
        })
        .map(|(_, candidate)| candidate.id)
}

async fn start_claimed_request(
    txn: &sea_orm::DatabaseTransaction,
    request_id: Uuid,
) -> Result<Option<ai_agent_request::Model>, AppError> {
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
update ai_agent_request
set state = 'running',
    started_at = now() at time zone 'utc',
    updated_at = now() at time zone 'utc',
    error = null
where id = $1
  and state = 'queued'
returning *
        "#,
        [request_id.into()],
    );
    Ok(ai_agent_request::Model::find_by_statement(statement)
        .one(txn)
        .await
        .c(h!())?)
}

async fn process_claimed_request(
    env: &Env,
    request: ai_agent_request::Model,
    cancellation: &CancellationToken,
) {
    let request_id = request.id;
    let mut model_failure = None;
    let result =
        run_request(env, &request, cancellation, &mut model_failure).await;
    let revoke_result = auth::revoke_request(env, request_id).await;
    if let Err(err) = revoke_result {
        error!(
            "AI agent credential revocation failed for {request_id}: {err:#?}"
        );
    }
    match result {
        Ok(RunOutcome::Completed(response, metadata)) => {
            if let Err(err) = complete_request(
                env,
                request_id,
                response,
                metadata,
                model_failure,
            )
            .await
            {
                error!(
                    "AI agent completion persistence failed for {request_id}: {err:#?}"
                );
                let _ = fail_request(env, request_id, &err, None).await;
            }
        }
        Ok(RunOutcome::Cancelled) => {}
        Err(err) => {
            error!("AI agent request failed for {request_id}: {err:#?}");
            if let Err(persist_err) =
                fail_request(env, request_id, &err, model_failure).await
            {
                error!(
                    "AI agent failure persistence failed for {request_id}: {persist_err:#?}"
                );
            }
        }
    }
}

async fn run_request(
    env: &Env,
    request: &ai_agent_request::Model,
    cancellation: &CancellationToken,
    model_failure: &mut Option<&'static str>,
) -> Result<RunOutcome, AppError> {
    let ai_engine =
        access::allowed_engine(&env.dbx, Some(request.ai_engine_id))
            .await
            .c(h!())?;
    let policy = super::reasoning::request_policy(request).c(h!())?;
    let timeout = policy
        .as_ref()
        .and_then(|policy| super::reasoning::deadline_millis(request, policy))
        .map(|deadline| {
            StdDuration::from_millis(std::cmp::max(
                deadline.saturating_sub(Utc::now().timestamp_millis()),
                1,
            ) as u64)
                + StdDuration::from_secs(
                    crate::config::AI_AGENT_DEADLINE_CLEANUP_SEC,
                )
        })
        .unwrap_or_else(|| request_execution_timeout(&ai_engine));
    match tokio::time::timeout(
        timeout,
        run_request_inner(env, request, cancellation, ai_engine, model_failure),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            if let Err(err) = lifecycle::stop_after_request_interruption(
                env,
                request.human_login_id,
                request.id,
            )
            .await
            {
                error!(
                    "AI agent fail-safe stop failed after request timeout {}: {err:#?}",
                    request.id
                );
            }
            Err(AppError::BL {
                msg: "AI agent request exceeded its total execution deadline"
                    .to_string(),
            })
        }
    }
}

/// Phase timings up to the runner's first event, logged once per request so
/// container warm-up can be compared across releases.
struct EnvironmentTimings {
    queue_ms: i64,
    began: Instant,
    container_start: Option<Instant>,
    container_ms: Option<u128>,
    runner_spawned: Option<Instant>,
    reported: bool,
}

impl EnvironmentTimings {
    fn new(request: &ai_agent_request::Model) -> Self {
        let queue_ms = request
            .started_at
            .map(|started| (started - request.queued_at).num_milliseconds())
            .unwrap_or_default();
        Self {
            queue_ms,
            began: Instant::now(),
            container_start: None,
            container_ms: None,
            runner_spawned: None,
            reported: false,
        }
    }

    fn container_start_began(&mut self) {
        self.container_start = Some(Instant::now());
    }

    fn container_start_finished(&mut self) {
        self.container_ms = self
            .container_start
            .map(|started| started.elapsed().as_millis());
    }

    fn runner_spawned(&mut self) {
        self.runner_spawned = Some(Instant::now());
    }

    fn report_first_runner_event(&mut self, request_id: Uuid) {
        if self.reported {
            return;
        }
        self.reported = true;
        let before_container_ms = self
            .container_start
            .map(|started| started.duration_since(self.began).as_millis())
            .unwrap_or_default();
        let runner_ms = self
            .runner_spawned
            .map(|spawned| spawned.elapsed().as_millis())
            .unwrap_or_default();
        info!(
            "AI agent environment ready request_id={request_id} queue_ms={} before_container_ms={before_container_ms} container_ms={} runner_first_event_ms={runner_ms} total_ms={}",
            self.queue_ms,
            self.container_ms.unwrap_or_default(),
            self.began.elapsed().as_millis()
        );
    }
}

fn request_execution_timeout(
    ai_engine: &crate::entities::ai_engine::Model,
) -> StdDuration {
    let seconds = if government_model(ai_engine)
        == Some(crate::config::AI_AGENT_GLM_5_3)
    {
        crate::config::AI_AGENT_GLM_5_3_EXECUTION_TIMEOUT_SEC
    } else {
        AI_AGENT_DISPATCHER_TIMEOUT_SEC
    };
    StdDuration::from_secs(seconds)
}

async fn append_request_preparation(
    env: &Env,
    request_id: Uuid,
    activity_titles: &mut ActivityTitles,
) -> anyhow::Result<bool> {
    if !events::append_request_start(
        &env.dbx,
        request_id,
        json!({ "requestId": request_id }),
    )
    .await
    .context(h!())?
    {
        return Ok(false);
    }
    append_presented_event(
        env,
        request_id,
        "progress",
        json!({ "summary": "Готую середовище" }),
        activity_titles,
    )
    .await
    .context(h!())
}

async fn append_presented_event(
    env: &Env,
    request_id: Uuid,
    event_type: &str,
    mut payload: Value,
    activity_titles: &mut ActivityTitles,
) -> anyhow::Result<bool> {
    let activity = activity_titles.prepare(event_type, &mut payload);
    let appended =
        events::append_runner(&env.dbx, request_id, event_type, payload)
            .await
            .context(h!())?;
    if appended {
        activity_titles.submitted(activity);
    }
    Ok(appended)
}

fn log_tool_diagnostic(
    request: &ai_agent_request::Model,
    correlation_id: Uuid,
    diagnostic: &Value,
) {
    let ids = format!(
        "request_id={} conversation_id={} correlation_id={correlation_id}",
        request.id, request.conversation_id
    );
    match events::tool_diagnostic_level(diagnostic) {
        log::Level::Error => {
            error!("AI agent tool failed {ids} diagnostic={diagnostic}")
        }
        log::Level::Warn => {
            warn!("AI agent tool failed {ids} diagnostic={diagnostic}")
        }
        _ => info!("AI agent tool {ids} diagnostic={diagnostic}"),
    }
}

async fn run_request_inner(
    env: &Env,
    request: &ai_agent_request::Model,
    cancellation: &CancellationToken,
    ai_engine: crate::entities::ai_engine::Model,
    model_failure: &mut Option<&'static str>,
) -> Result<RunOutcome, AppError> {
    let request_started_at = request
        .started_at
        .map(|started| started.and_utc())
        .unwrap_or_else(Utc::now);
    let execution_policy = super::reasoning::request_policy(request).c(h!())?;
    if cancellation.is_cancelled() {
        return Err(interrupted_error());
    }
    let mut timings = EnvironmentTimings::new(request);
    let mut activity_titles = ActivityTitles::new(
        env.ai_engine_client.clone(),
        env.dbx.clone(),
        request.id,
        &request.prompt,
        cancellation,
    );
    if !append_request_preparation(env, request.id, &mut activity_titles)
        .await
        .context(h!())?
    {
        return Ok(RunOutcome::Cancelled);
    }
    if !access::settings(&env.dbx).await?.feature_enabled {
        return Err(AppError::Forbidden(
            "AI agent harness was disabled before execution".to_string(),
        ));
    }
    let runtime_profile =
        ai_agent_engine_runtime_profile::Entity::find_by_id(ai_engine.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or_else(|| AppError::BL {
                msg: "AI agent provider runtime profile is not configured"
                    .to_string(),
            })?;
    if request_is_cancelled(env, request.id).await? {
        return Ok(RunOutcome::Cancelled);
    }
    if !wait_for_uploads(
        env,
        request,
        execution_policy.as_ref(),
        cancellation,
        &mut activity_titles,
    )
    .await
    .c(h!())?
    {
        return Ok(RunOutcome::Cancelled);
    }
    timings.container_start_began();
    let Some(linked) = lifecycle::start_for_request(
        env,
        request.id,
        request.human_login_id,
        &ai_engine,
    )
    .await?
    else {
        return Ok(RunOutcome::Cancelled);
    };
    timings.container_start_finished();
    if cancellation.is_cancelled() {
        return Err(interrupted_error());
    }
    if request_is_cancelled(env, request.id).await? {
        return Ok(RunOutcome::Cancelled);
    }
    let (bootstrap_token, correlation_id) =
        auth::issue_bootstrap(env, linked.login.id, Some(request.id), false)
            .await?;
    match assign_agent(env, request.id, linked.login.id, correlation_id).await {
        Ok(true) => {}
        Ok(false) => {
            auth::revoke_correlation(
                env,
                Some(linked.login.id),
                correlation_id,
            )
            .await?;
            return Ok(RunOutcome::Cancelled);
        }
        Err(err) => {
            auth::revoke_correlation(
                env,
                Some(linked.login.id),
                correlation_id,
            )
            .await?;
            return Err(err);
        }
    }
    if request_is_cancelled(env, request.id).await? {
        return Ok(RunOutcome::Cancelled);
    }
    let provider_transport = access::agent_provider_transport(&ai_engine)
        .ok_or_else(|| {
            AppError::Forbidden(
                "AI engine is not supported by the agent harness".to_string(),
            )
        })?;
    let mut checkpoint = checkpoint_provider(env, &ai_engine, &runtime_profile)
        .await
        .c(h!())?;
    if execution_policy.is_some()
        && provider_transport == access::AgentProviderTransport::EchoGateway
    {
        checkpoint = Some(CheckpointProvider {
            ai_engine_id: ai_engine.id,
            model_name: model_id(&ai_engine).to_string(),
            context_window: runtime_profile.context_window_tokens,
            max_tokens: checkpoint_output_tokens(&ai_engine, &runtime_profile),
        });
    }
    let checkpoint_max_tokens = checkpoint.as_ref().map_or_else(
        || checkpoint_output_tokens(&ai_engine, &runtime_profile),
        |checkpoint| checkpoint.max_tokens,
    );
    let rewrite_provider =
        refusal_rewrite_provider(env, &ai_engine, provider_transport)
            .await
            .c(h!())?;
    let gateway_capability =
        if provider_transport == access::AgentProviderTransport::EchoGateway {
            Some(
                auth::issue_provider_capability(
                    env,
                    linked.login.id,
                    request.id,
                    correlation_id,
                    ai_engine.id,
                    model_id(&ai_engine).to_string(),
                    checkpoint
                        .as_ref()
                        .filter(|checkpoint| {
                            execution_policy.is_some()
                                || checkpoint.model_name != model_id(&ai_engine)
                        })
                        .map(|checkpoint| auth::CheckpointProviderGrant {
                            ai_engine_id: checkpoint.ai_engine_id,
                            model_name: checkpoint.model_name.clone(),
                            max_output_tokens: checkpoint.max_tokens,
                        }),
                    rewrite_provider.clone(),
                )
                .await
                .c(h!())?,
            )
        } else {
            None
        };
    let history = load_history(env, request).await?;
    let map_edit =
        super::maps::workspace::load_request_target(&env.dbx, request.id)
            .await
            .c(h!())?;
    let mut runner_payload = runner_payload_for_provider(
        json!({
            "echoPublicHost": env.config.public_host,
            // The runner sees model names without a proxy prefix.
            "modelName": model_id(&ai_engine),
            "contextWindow": runtime_profile.context_window_tokens,
            "providerRequestMaxBytes": (provider_transport == access::AgentProviderTransport::EchoGateway).then_some(crate::config::AI_AGENT_PROVIDER_REQUEST_MAX_BYTES),
            "maxTokens": runtime_profile.max_output_tokens,
            "checkpointMaxTokens": checkpoint_max_tokens,
            "compactionReserveTokens": runtime_profile.compaction_reserve_tokens,
            "compactionKeepRecentTokens": runtime_profile.compaction_keep_recent_tokens,
            "bootstrapToken": bootstrap_token,
            "correlationId": correlation_id,
            "correlationHeader": crate::config::AI_AGENT_CORRELATION_HEADER,
            "prompt": request.prompt,
            "skills": super::route_registry::skills_for_devices(crate::devices::documents::access::available(env, request.human_login_id).await),
            "timeContext": {
                "timeZone": "Europe/Kyiv",
                "requestStartedAtUtc": request_started_at.to_rfc3339(),
            },
            "expectedIdentity": {
                "id": linked.login.id,
                "name": linked.login.login,
                "roles": linked.login.roles,
            },
        }),
        provider_transport,
        ai_engine.token,
        gateway_capability,
    );
    if let Some(policy) = &execution_policy {
        runner_payload["executionPolicy"] =
            serde_json::to_value(policy).c(h!())?;
        runner_payload["deadlineAt"] =
            json!(super::reasoning::deadline_millis(request, policy));
    }
    if let Some(checkpoint) = checkpoint {
        runner_payload["checkpointModelName"] = json!(checkpoint.model_name);
        runner_payload["checkpointContextWindow"] =
            json!(checkpoint.context_window);
    }
    if let Some(rewrite) = rewrite_provider {
        runner_payload["rewriteModelName"] = json!(rewrite.model_name);
        runner_payload["rewriteMaxTokens"] = json!(rewrite.max_output_tokens);
    }
    if let Some(map_edit) = map_edit {
        runner_payload["mapEdit"] = serde_json::to_value(map_edit).c(h!())?;
    }
    add_document_context(&env.dbx, request, &mut runner_payload)
        .await
        .c(h!())?;
    add_upload_context(
        env,
        request,
        runtime_profile.vision_input_enabled == Some(true),
        &mut runner_payload,
    )
    .await
    .c(h!())?;
    if env.config.ai_agent_work_memory_enabled == Some(true) {
        runner_payload["workMemory"] =
            match super::work_memory::initial_context(env, request).await {
                Ok(context) => context,
                Err(error) => {
                    crate::types::warn!(
                        "AI work recap unavailable for {}: {error:#?}",
                        request.id
                    );
                    json!({"version":1})
                }
            };
    } else if let Some(skills) = runner_payload["skills"].as_array_mut() {
        skills.retain(|skill| {
            !skill["skill"]
                .as_str()
                .unwrap_or_default()
                .starts_with("work_")
        });
    }
    let payload = bounded_runner_payload(runner_payload, history)?;
    let dispatcher = DispatcherClient::from_env(env).await?;
    timings.runner_spawned();
    let mut stream = dispatcher
        .start_stream(
            "run_request",
            linked.login.id,
            json!({ "payload": payload }),
        )
        .await?;
    let mut response = String::new();
    let mut response_chars = 0_usize;
    let stream_limits = super::reasoning::limits(execution_policy.as_ref());
    let mut runner_event_count = 0_usize;
    let mut runner_event_bytes = 0_usize;
    let mut terminal_seen = false;
    let mut completion_metadata = None;
    loop {
        tokio::select! {
            envelope = stream.next() => {
                let Some(envelope) = envelope? else {
                    break;
                };
                if request_is_cancelled(env, request.id).await? {
                    let _ = stream.terminate().await;
                    return Ok(RunOutcome::Cancelled);
                }
                if let Some(event) = envelope.event {
                    timings.report_first_runner_event(request.id);
                    runner_event_count = runner_event_count.saturating_add(1);
                    runner_event_bytes = runner_event_bytes.saturating_add(
                        serde_json::to_vec(&event).c(h!())?.len(),
                    );
                    if !stream_limits_allow(
                        &stream_limits,
                        runner_event_count,
                        runner_event_bytes,
                        response.len(),
                        response_chars,
                    ) {
                        let _ = stream.terminate().await;
                        return Err(AppError::BL {
                            msg: "AI agent runner output exceeded the configured limit"
                                .to_string(),
                        });
                    }
                    if let Some(diagnostic) = events::completion_diagnostic(&event) {
                        info!("AI agent completion request_id={} diagnostic={diagnostic}", request.id);
                        *model_failure = next_model_failure(*model_failure, &diagnostic);
                        continue;
                    }
                    if let Some(diagnostic) = events::tool_diagnostic(&event) {
                        log_tool_diagnostic(request, correlation_id, &diagnostic);
                        continue;
                    }
                    if let Some((event_type, payload)) = events::normalize_runner_event(event) {
                        if event_type == "completion_metadata" {
                            let metadata: super::types::AiAgentCompletionMetadata =
                                serde_json::from_value(payload.clone()).c(h!())?;
                            let publish = keeps_runner_metadata(execution_policy.is_some(), &metadata);
                            // Kept even when hidden: completion may still turn it into a provider failure.
                            completion_metadata = Some(metadata);
                            if !publish { continue; }
                        }
                        let update = events::assistant_text_update(&event_type, &payload);
                        let (response_bytes, next_chars) = match &update {
                            Some(events::AssistantTextUpdate::Replace(text)) => {
                                (text.len(), text.chars().count())
                            }
                            Some(events::AssistantTextUpdate::Append(delta)) => (
                                response.len().saturating_add(delta.len()),
                                response_chars.saturating_add(delta.chars().count()),
                            ),
                            None => (response.len(), response_chars),
                        };
                        if !stream_limits_allow(
                            &stream_limits,
                            runner_event_count,
                            runner_event_bytes,
                            response_bytes,
                            next_chars,
                        ) {
                            let _ = stream.terminate().await;
                            return Err(AppError::BL {
                                msg: "AI agent runner output exceeded the configured limit"
                                    .to_string(),
                            });
                        }
                        if !append_presented_event(
                            env,
                            request.id,
                            &event_type,
                            payload,
                            &mut activity_titles,
                        )
                        .await.context(h!())?
                        {
                            let _ = stream.terminate().await;
                            return Ok(RunOutcome::Cancelled);
                        }
                        match update {
                            Some(events::AssistantTextUpdate::Replace(text)) => {
                                response.clear();
                                response.push_str(&text);
                                response_chars = next_chars;
                            }
                            Some(events::AssistantTextUpdate::Append(delta)) => {
                                response.push_str(&delta);
                                response_chars = next_chars;
                            }
                            None => {}
                        }
                    }
                }
                if envelope.done {
                    terminal_seen = true;
                    if !envelope.ok {
                        let detail = envelope
                            .error
                            .as_deref()
                            .map(str::trim)
                            .filter(|detail| !detail.is_empty())
                            .unwrap_or("agent runner failed");
                        return Err(AppError::BL {
                            msg: format!(
                                "AI agent runner failed: {}",
                                access::truncate(detail, AI_AGENT_ERROR_MAX_CHARS)
                            ),
                        });
                    }
                    break;
                }
            }
            _ = tokio::time::sleep(StdDuration::from_millis(250)) => {
                if request_is_cancelled(env, request.id).await? {
                    stream.terminate().await?;
                    return Ok(RunOutcome::Cancelled);
                }
            }
            _ = cancellation.cancelled() => {
                let _ = stream.terminate().await;
                return Err(interrupted_error());
            }
        }
    }
    if !terminal_seen {
        return Err(AppError::BL {
            msg: "AI agent dispatcher ended without a terminal event"
                .to_string(),
        });
    }
    stream.finish().await?;
    if request_is_cancelled(env, request.id).await? {
        return Ok(RunOutcome::Cancelled);
    }
    Ok(RunOutcome::Completed(response, completion_metadata))
}

/// Holds the run until documents sent with this message are extracted, so
/// the agent sees their text. Proceeds with whatever is ready on timeout.
/// A reasoning preset's runtime is shared with the wait, so only part of it
/// may be spent here.
async fn wait_for_uploads(
    env: &Env,
    request: &ai_agent_request::Model,
    execution_policy: Option<&super::reasoning::ExecutionPolicy>,
    cancellation: &CancellationToken,
    activity_titles: &mut ActivityTitles,
) -> Result<bool, AppError> {
    if super::uploads::context::pending_count(env, request.id)
        .await
        .c(h!())?
        == 0
    {
        return Ok(true);
    }
    append_presented_event(
        env,
        request.id,
        "progress",
        json!({ "summary": "Обробляю вкладені файли" }),
        activity_titles,
    )
    .await
    .c(h!())?;
    let wait_secs = execution_policy.map_or(
        crate::config::AI_AGENT_UPLOAD_EXTRACTION_WAIT_SECS,
        |policy| {
            (policy.max_runtime_seconds
                / crate::config::AI_AGENT_UPLOAD_EXTRACTION_WAIT_RUNTIME_DIVISOR)
                .min(crate::config::AI_AGENT_UPLOAD_EXTRACTION_WAIT_SECS)
        },
    );
    let deadline =
        std::time::Instant::now() + StdDuration::from_secs(wait_secs);
    while std::time::Instant::now() < deadline {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(interrupted_error()),
            _ = tokio::time::sleep(StdDuration::from_millis(crate::config::AI_AGENT_UPLOAD_EXTRACTION_WAIT_POLL_MS)) => {}
        }
        if request_is_cancelled(env, request.id).await.c(h!())? {
            return Ok(false);
        }
        if super::uploads::context::pending_count(env, request.id)
            .await
            .c(h!())?
            == 0
        {
            break;
        }
    }
    Ok(true)
}

async fn add_upload_context(
    env: &Env,
    request: &ai_agent_request::Model,
    vision: bool,
    runner_payload: &mut Value,
) -> Result<(), AppError> {
    let context = super::uploads::context::runner_uploads(env, request, vision)
        .await
        .c(h!())?;
    if let Some(skills) = runner_payload["skills"].as_array_mut() {
        skills.retain(|skill| {
            let name = skill["skill"].as_str().unwrap_or_default();
            (vision || name != "upload_image")
                && (!context.uploads.is_empty() || !name.starts_with("upload_"))
        });
    }
    if !context.uploads.is_empty() {
        runner_payload["uploads"] = json!(context.uploads);
    }
    if vision {
        runner_payload["visionInput"] = json!(true);
    }
    if !context.turn_images.is_empty() {
        runner_payload["turnImages"] = json!(context.turn_images);
    }
    Ok(())
}

pub(super) fn bounded_runner_payload(
    mut payload: Value,
    mut history: Vec<Value>,
) -> Result<Value, AppError> {
    loop {
        payload["history"] = Value::Array(history.clone());
        if serde_json::to_vec(&payload).c(h!())?.len()
            <= AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
        {
            return Ok(payload);
        }
        if history.len() < 2 {
            return Err(AppError::BL {
                msg: "AI agent request is too large for the runner".to_string(),
            });
        }
        if history.len() == 2 {
            for index in [1, 0] {
                let content =
                    history[index]["content"].as_str().unwrap_or_default();
                let content_bytes = serde_json::to_vec(content).c(h!())?.len();
                let excess = serde_json::to_vec(&payload).c(h!())?.len()
                    - AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES;
                let budget = content_bytes.saturating_sub(excess);
                if budget >= crate::config::AI_AGENT_HISTORY_MIN_TEXT_BYTES {
                    history[index]["content"] = json!(
                        events::truncate_serialized_text(content, budget)
                            .c(h!())?
                    );
                    break;
                }
                history[index] = json!({"role":history[index]["role"],"content":"[Earlier text omitted to fit context.]"});
                payload["history"] = json!(history);
                if serde_json::to_vec(&payload).c(h!())?.len()
                    <= AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
                {
                    return Ok(payload);
                }
            }
            payload["history"] = json!(history);
            if serde_json::to_vec(&payload).c(h!())?.len()
                <= AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
            {
                return Ok(payload);
            }
        }
        history.drain(..2);
    }
}

async fn checkpoint_provider(
    env: &Env,
    ai_engine: &crate::entities::ai_engine::Model,
    runtime_profile: &ai_agent_engine_runtime_profile::Model,
) -> anyhow::Result<Option<CheckpointProvider>> {
    if government_model(ai_engine) != Some(crate::config::AI_AGENT_GLM_5_3) {
        return Ok(None);
    }
    if env.config.ai_agent_glm_checkpoint_provider
        == Some(crate::config::AiAgentGlmCheckpointProvider::Glm)
    {
        return Ok(Some(CheckpointProvider {
            ai_engine_id: ai_engine.id,
            model_name: model_id(ai_engine).to_string(),
            context_window: runtime_profile.context_window_tokens,
            max_tokens: checkpoint_output_tokens(ai_engine, runtime_profile),
        }));
    }
    // A Luna the request cannot reach (a direct one while the Azure gateway
    // is disabled, a proxied one without its key) would fail the checkpoint.
    let gateway_enabled = crate::ai_engine::gov::gateway_enabled(&env.dbx)
        .await
        .c(h!())?;
    let ai_engine = access::allowed_engines(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter(|ai_engine| {
            government_model(ai_engine)
                .is_some_and(crate::ai_engine::client::is_gpt_luna)
                && crate::ai_engine::client::government_route_available(
                    ai_engine,
                    gateway_enabled,
                )
        })
        .min_by_key(|ai_engine| ai_engine.id);
    let Some(ai_engine) = ai_engine else {
        return Ok(None);
    };
    let checkpoint_profile =
        ai_agent_engine_runtime_profile::Entity::find_by_id(ai_engine.id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Checkpoint provider runtime profile is not configured"
                )
            })
            .c(h!())?;
    let max_tokens = std::cmp::min(
        checkpoint_profile.max_output_tokens,
        runtime_profile.compaction_reserve_tokens,
    );
    anyhow::ensure!(
        max_tokens >= 256
            && max_tokens < checkpoint_profile.context_window_tokens - 1_024,
        "Checkpoint provider runtime profile is invalid"
    );
    Ok(Some(CheckpointProvider {
        ai_engine_id: ai_engine.id,
        model_name: model_id(&ai_engine).to_string(),
        context_window: checkpoint_profile.context_window_tokens,
        max_tokens,
    }))
}

/// The refusal rewrite layer for OpenAI-family engines: when the model
/// declines an operational request, the runner rewrites the ask into
/// evidence-inventory form via this second engine and retries once.
/// Returns the grant, or `None` when the layer is off or unusable; an
/// unavailable engine degrades the request to running without the layer.
async fn refusal_rewrite_provider(
    env: &Env,
    ai_engine: &crate::entities::ai_engine::Model,
    provider_transport: access::AgentProviderTransport,
) -> anyhow::Result<Option<auth::RewriteProviderGrant>> {
    if provider_transport != access::AgentProviderTransport::EchoGateway
        || !super::reasoning::openai_model(model_id(ai_engine))
    {
        return Ok(None);
    }
    let settings = access::settings(&env.dbx).await.c(h!())?;
    if !settings.refusal_rewrite_enabled.unwrap_or(false) {
        return Ok(None);
    }
    let allowed = access::ordered_allowed_engines(&env.dbx)
        .await
        .context(h!())?;
    let rewrite_engine = match settings.refusal_rewrite_ai_engine_id {
        Some(configured_id) => allowed
            .into_iter()
            .find(|engine| engine.id == configured_id),
        None => allowed.into_iter().find(|engine| {
            model_id(engine)
                == crate::config::AI_AGENT_REFUSAL_REWRITE_DEFAULT_MODEL
        }),
    };
    let Some(rewrite_engine) =
        rewrite_engine.filter(access::refusal_rewrite_compatible)
    else {
        warn!(
            "Refusal rewrite is enabled but no compatible gateway rewrite \
             engine is allowed; running the request without the layer"
        );
        return Ok(None);
    };
    Ok(Some(auth::RewriteProviderGrant {
        ai_engine_id: rewrite_engine.id,
        model_name: model_id(&rewrite_engine).to_string(),
        max_output_tokens: crate::config::AI_AGENT_REFUSAL_REWRITE_MAX_TOKENS,
    }))
}

fn checkpoint_output_tokens(
    ai_engine: &crate::entities::ai_engine::Model,
    runtime_profile: &ai_agent_engine_runtime_profile::Model,
) -> i32 {
    if government_model(ai_engine) == Some(crate::config::AI_AGENT_GLM_5_3) {
        std::cmp::max(
            runtime_profile.max_output_tokens,
            std::cmp::min(
                crate::config::AI_AGENT_GLM_5_3_CHECKPOINT_OUTPUT_TOKENS,
                runtime_profile.compaction_reserve_tokens,
            ),
        )
    } else {
        runtime_profile.max_output_tokens
    }
}

fn runner_payload_for_provider(
    mut payload: Value,
    provider_transport: access::AgentProviderTransport,
    direct_api_key: Option<String>,
    gateway_capability: Option<String>,
) -> Value {
    payload["providerTransport"] =
        Value::String(provider_transport.as_str().to_string());
    let provider_api_key = match provider_transport {
        access::AgentProviderTransport::DirectHttp => direct_api_key,
        access::AgentProviderTransport::EchoGateway => gateway_capability,
    };
    if let Some(provider_api_key) = provider_api_key {
        payload["providerApiKey"] = Value::String(provider_api_key);
    }
    payload
}

fn stream_limits_allow(
    limits: &super::reasoning::RequestLimits,
    runner_event_count: usize,
    runner_event_bytes: usize,
    response_bytes: usize,
    response_chars: usize,
) -> bool {
    runner_event_count <= limits.runner_events
        && runner_event_bytes <= limits.event_bytes
        && response_bytes <= AI_AGENT_RESPONSE_MAX_BYTES
        && response_chars <= AI_AGENT_RESPONSE_MAX_CHARS
}

async fn assign_agent(
    env: &Env,
    request_id: Uuid,
    agent_login_id: Uuid,
    correlation_id: Uuid,
) -> Result<bool, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if request.state != "running" || request.cancellation_requested {
        txn.commit().await.c(h!())?;
        return Ok(false);
    }
    let mut request = request.into_active_model();
    request.agent_login_id = Set(Some(agent_login_id));
    request.correlation_id = Set(Some(correlation_id));
    request.updated_at = Set(Utc::now().naive_utc());
    request.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

/// The conversation's documents and the one the user had open, so the
/// agent can refine them in this turn.
async fn add_document_context(
    dbx: &sea_orm::DatabaseConnection,
    request: &ai_agent_request::Model,
    runner_payload: &mut Value,
) -> Result<(), AppError> {
    runner_payload["documents"] = serde_json::to_value(
        super::documents::runner_documents(dbx, request.conversation_id)
            .await
            .c(h!())?,
    )
    .c(h!())?;
    if let Some(target) = super::documents::load_request_target(dbx, request.id)
        .await
        .c(h!())?
    {
        runner_payload["documentTarget"] =
            serde_json::to_value(target).c(h!())?;
    }
    Ok(())
}

/// A trailing note naming the documents an earlier turn saved, which keeps
/// their ids in the agent's context after the tool results are gone.
fn saved_documents_note(
    documents: &[super::documents::types::AiAgentDocumentArtifact],
) -> String {
    if documents.is_empty() {
        return String::new();
    }
    let saved = documents
        .iter()
        .take(crate::config::AI_AGENT_DOCUMENT_HISTORY_MAX_ITEMS)
        .map(|document| {
            format!(
                "[{}](echo-document:{}) v{}",
                document.title, document.document_id, document.revision
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("\n\n[Saved documents: {saved}]")
}

pub(super) async fn load_history(
    env: &Env,
    request: &ai_agent_request::Model,
) -> Result<Vec<Value>, AppError> {
    let requests = ai_agent_request::Entity::find()
        .filter(
            ai_agent_request::Column::ConversationId
                .eq(request.conversation_id),
        )
        .filter(ai_agent_request::Column::State.is_in([
            "completed",
            "failed",
            "cancelled",
        ]))
        .filter(
            Condition::any()
                .add(ai_agent_request::Column::QueuedAt.lt(request.queued_at))
                .add(
                    Condition::all()
                        .add(
                            ai_agent_request::Column::QueuedAt
                                .eq(request.queued_at),
                        )
                        .add(ai_agent_request::Column::Id.lt(request.id)),
                ),
        )
        .order_by_desc(ai_agent_request::Column::QueuedAt)
        .order_by_desc(ai_agent_request::Column::Id)
        .limit(AI_AGENT_HISTORY_MAX_TURNS)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let request_ids = requests
        .iter()
        .map(|request| request.id)
        .collect::<Vec<_>>();
    let mut citations = super::citations::load(&env.dbx, &request_ids)
        .await
        .c(h!())?;
    let mut maps = super::maps::load_summaries(&env.dbx, &request_ids)
        .await
        .c(h!())?;
    let mut documents =
        super::documents::load_artifacts(&env.dbx, &request_ids)
            .await
            .c(h!())?;
    let mut file_citations =
        super::file_citations::load(&env.dbx, &request_ids)
            .await
            .c(h!())?;
    let mut attachments =
        super::uploads::context::by_request(&env.dbx, &request_ids)
            .await
            .c(h!())?;
    let message_ids = citations
        .values()
        .flatten()
        .map(|source| source.message_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let readable_messages = super::citations::readable_message_ids(
        &env.dbx,
        request.human_login_id,
        &message_ids,
    )
    .await
    .c(h!())?;
    let mut accessible = std::collections::HashSet::new();
    for prior in &requests {
        if citations
            .get(&prior.id)
            .into_iter()
            .flatten()
            .all(|source| readable_messages.contains(&source.message_id))
            && super::file_citations::readable(
                env,
                request.human_login_id,
                file_citations
                    .get(&prior.id)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            )
            .await
            .c(h!())?
        {
            accessible.insert(prior.id);
        }
    }
    let mut history = Vec::new();
    for prior in requests.into_iter().rev() {
        let attached = super::uploads::context::history_prefix(
            &attachments.remove(&prior.id).unwrap_or_default(),
        );
        history.push(
            json!({ "role": "user", "content": format!("{attached}{}", prior.prompt) }),
        );
        let readable = accessible.contains(&prior.id);
        let request_maps = if readable {
            maps.remove(&prior.id).unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut response = if readable {
            match prior.response.filter(|response| !response.is_empty()) {
                Some(response) => response,
                None if prior.state != "completed" => {
                    events::interrupted_text(&env.dbx, prior.id)
                        .await
                        .c(h!())?
                }
                None => String::new(),
            }
        } else {
            "Previous output is unavailable under current access permissions."
                .to_string()
        };
        if response.is_empty() {
            response = request_maps
                .iter()
                .map(|summary| {
                    format!(
                        "{}: [мапа](echo-map:{})",
                        summary.title, summary.id
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        if prior.state != "completed" {
            if response.is_empty() {
                response = "No partial output was saved.".to_string();
            }
            response = format!(
                "[Previous request {}; any text below is an incomplete, unverified draft.]\n{}",
                prior.state, response,
            );
        }
        if readable {
            let note = saved_documents_note(
                &documents.remove(&prior.id).unwrap_or_default(),
            );
            response = format!("{response}{note}").trim_start().to_string();
        }
        if response.is_empty() {
            response = "[Previous request completed without a text answer.]"
                .to_string();
        }
        let citations = super::citations::referenced(
            citations.remove(&prior.id).unwrap_or_default(),
            &response,
        );
        history.push(json!({
            "role": "assistant", "content": response, "citations": citations,
            "fileCitations": if readable { file_citations.remove(&prior.id).unwrap_or_default() } else { Vec::new() },
            "maps": request_maps,
        }));
    }
    Ok(history)
}

fn interrupted_error() -> AppError {
    AppError::BL {
        msg: "AI agent request was interrupted by worker shutdown".to_string(),
    }
}

/// The model failure still standing after a provider diagnostic, so a run
/// that ends on it can offer another model. A later provider reply or an
/// authorization failure clears an earlier one; progress outcomes keep it.
fn next_model_failure(
    current: Option<&'static str>,
    diagnostic: &Value,
) -> Option<&'static str> {
    let outcome = diagnostic.get("outcome").and_then(Value::as_str);
    if outcome == Some("authorization")
        || diagnostic.get("failureKind").and_then(Value::as_str)
            == Some("authorization")
    {
        return None;
    }
    match outcome {
        // The provider answered, even if the answer itself was unusable.
        Some(
            "complete" | "output_limit" | "empty" | "citation_rejected"
            | "no_evidence" | "research_text" | "partial",
        ) => None,
        // A refused answer the rewrite layer could not recover (#4224).
        Some("content_filter" | "refusal") => {
            Some(AI_AGENT_REASON_MODEL_REFUSAL)
        }
        Some("provider_error" | "transient_error") => {
            Some(AI_AGENT_REASON_PROVIDER_ERROR)
        }
        _ => current,
    }
}

/// Runs without an execution policy (reasoning presets off) show no coverage
/// notices, but a provider failure still lets the chat offer another model.
fn keeps_runner_metadata(
    has_execution_policy: bool,
    metadata: &super::types::AiAgentCompletionMetadata,
) -> bool {
    has_execution_policy || metadata.reason == AI_AGENT_REASON_PROVIDER_ERROR
}

/// Research that only fell back to a saved draft because the provider kept
/// failing, or kept declining the request (#4224), reports that model
/// failure, not unfinished research, so the chat offers another model
/// instead of a Deep continuation on the same one.
fn provider_limited_metadata(
    metadata: Option<super::types::AiAgentCompletionMetadata>,
    model_failure: Option<&str>,
) -> Option<super::types::AiAgentCompletionMetadata> {
    match (metadata, model_failure) {
        (Some(mut metadata), Some(failure))
            if metadata.reason == "incomplete_research"
                && matches!(
                    failure,
                    AI_AGENT_REASON_PROVIDER_ERROR
                        | AI_AGENT_REASON_MODEL_REFUSAL
                ) =>
        {
            metadata.reason = failure.to_string();
            Some(metadata)
        }
        (metadata, _) => metadata,
    }
}

/// The runner's own metadata wins; otherwise a policy refusal in the answer
/// is recorded so the chat can offer another model.
fn completed_metadata(
    response: &str,
    metadata: Option<super::types::AiAgentCompletionMetadata>,
) -> (Option<super::types::AiAgentCompletionMetadata>, bool) {
    if metadata.is_some() || !super::refusal::is_policy_refusal(response) {
        return (metadata, false);
    }
    (
        Some(model_failure_metadata(AI_AGENT_REASON_MODEL_REFUSAL)),
        true,
    )
}

fn model_failure_metadata(
    reason: &str,
) -> super::types::AiAgentCompletionMetadata {
    super::types::AiAgentCompletionMetadata {
        coverage_limited: false,
        reason: reason.to_string(),
    }
}

pub(super) async fn complete_request(
    env: &Env,
    request_id: Uuid,
    response: String,
    runner_metadata: Option<super::types::AiAgentCompletionMetadata>,
    model_failure: Option<&str>,
) -> Result<bool, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let has_policy = request.execution_policy.is_some();
    let visible = |metadata: Option<
        super::types::AiAgentCompletionMetadata,
    >| {
        metadata.filter(|metadata| keeps_runner_metadata(has_policy, metadata))
    };
    let limited = visible(provider_limited_metadata(
        runner_metadata.clone(),
        model_failure,
    ));
    let (metadata, detected_refusal) = completed_metadata(&response, limited);
    // The browser already holds what the runner published; send what Echo changed.
    let publish_metadata =
        detected_refusal || metadata != visible(runner_metadata);
    if request.state == "cancelled" || request.cancellation_requested {
        txn.commit().await.c(h!())?;
        return Ok(false);
    }
    if request.state != "running" {
        return Err(AppError::BL {
            msg: "AI agent request is no longer running".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    let conversation_id = request.conversation_id;
    let human_login_id = request.human_login_id;
    let mut request = request.into_active_model();
    request.state = Set("completed".to_string());
    request.response = Set(Some(response.clone()));
    request.completion_metadata = Set(metadata
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .c(h!())?);
    request.completed_at = Set(Some(now));
    request.updated_at = Set(now);
    request.update(&txn).await.c(h!())?;
    touch_conversation_in_transaction(&txn, conversation_id, now).await?;
    lifecycle::touch_container_activity_in_transaction(
        &txn,
        human_login_id,
        now,
    )
    .await?;
    super::citations::persist_referenced(&txn, request_id, &response)
        .await
        .c(h!())?;
    if publish_metadata {
        events::append_in_transaction(
            &txn,
            request_id,
            "completion_metadata",
            serde_json::to_value(&metadata).c(h!())?,
        )
        .await
        .context(h!())?;
    }
    events::append_in_transaction(
        &txn,
        request_id,
        "completion",
        json!({ "responseLength": response.chars().count(), "completionMetadata": metadata }),
    )
    .await?;
    review::enqueue_in_transaction(&txn, request_id).await?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

pub(super) async fn fail_request(
    env: &Env,
    request_id: Uuid,
    err: &AppError,
    model_failure: Option<&str>,
) -> Result<(), AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if matches!(request.state.as_str(), "completed" | "failed" | "cancelled") {
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    let now = Utc::now().naive_utc();
    let conversation_id = request.conversation_id;
    let human_login_id = request.human_login_id;
    let message =
        access::truncate(format!("{err:#}"), AI_AGENT_ERROR_MAX_CHARS);
    let mut request = request.into_active_model();
    let metadata = model_failure.map(model_failure_metadata);
    request.state = Set("failed".to_string());
    request.error = Set(Some(message.clone()));
    request.completion_metadata = Set(metadata
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .c(h!())?);
    request.completed_at = Set(Some(now));
    request.updated_at = Set(now);
    request.update(&txn).await.c(h!())?;
    touch_conversation_in_transaction(&txn, conversation_id, now).await?;
    lifecycle::touch_container_activity_in_transaction(
        &txn,
        human_login_id,
        now,
    )
    .await?;
    if let Some(metadata) = &metadata {
        events::append_in_transaction(
            &txn,
            request_id,
            "completion_metadata",
            serde_json::to_value(metadata).c(h!())?,
        )
        .await
        .context(h!())?;
    }
    events::append_in_transaction(
        &txn,
        request_id,
        "error",
        json!({ "message": AI_AGENT_USER_FAILURE_MESSAGE }),
    )
    .await?;
    review::enqueue_in_transaction(&txn, request_id).await?;
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn request_is_cancelled(
    env: &Env,
    request_id: Uuid,
) -> Result<bool, AppError> {
    Ok(ai_agent_request::Entity::find_by_id(request_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .is_none_or(|request| {
            request.state == "cancelled" || request.cancellation_requested
        }))
}

async fn touch_conversation_in_transaction(
    txn: &sea_orm::DatabaseTransaction,
    conversation_id: Uuid,
    now: chrono::NaiveDateTime,
) -> Result<(), AppError> {
    let conversation =
        ai_agent_conversation::Entity::find_by_id(conversation_id)
            .one(txn)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let mut conversation = conversation.into_active_model();
    conversation.updated_at = Set(now);
    conversation.update(txn).await.c(h!())?;
    Ok(())
}

async fn recover_interrupted_requests(env: &Env) -> Result<(), AppError> {
    let requests = ai_agent_request::Entity::find()
        .filter(ai_agent_request::Column::State.eq("running"))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut failure_count = 0_usize;
    let mut affected_human_login_ids = BTreeSet::new();
    for request in requests {
        affected_human_login_ids.insert(request.human_login_id);
        if let Err(err) = auth::revoke_request(env, request.id).await {
            failure_count += 1;
            error!(
                "Could not revoke interrupted AI agent request {}: {err:#?}",
                request.id
            );
        }
        let err = AppError::BL {
            msg: "AI agent request was interrupted by worker restart"
                .to_string(),
        };
        if let Err(err) = fail_request(env, request.id, &err, None).await {
            failure_count += 1;
            error!(
                "Could not persist interrupted AI agent request {}: {err:#?}",
                request.id
            );
        }
    }
    for human_login_id in affected_human_login_ids {
        if let Err(err) =
            lifecycle::stop_after_worker_recovery(env, human_login_id).await
        {
            failure_count += 1;
            error!(
                "Could not fail-safe stop recovered AI agent user {human_login_id}: {err:#?}"
            );
        }
    }
    if let Err(err) = reconcile_abandoned_containers(env).await {
        failure_count += 1;
        error!(
            "Could not reconcile abandoned AI agent containers during recovery: {err:#?}"
        );
    }
    if failure_count > 0 {
        return Err(AppError::BL {
            msg: format!(
                "AI agent recovery completed with {failure_count} failures"
            ),
        });
    }
    Ok(())
}

async fn review_loop(env: Arc<Env>, cancellation: CancellationToken) {
    while !cancellation.is_cancelled() {
        match review::process_one(&env).await {
            Ok(true) => {}
            Ok(false) => {
                tokio::time::sleep(StdDuration::from_millis(
                    AI_AGENT_WORKER_IDLE_SLEEP_MS,
                ))
                .await;
            }
            Err(err) => {
                error!("AI agent review worker failed: {err:#?}");
                tokio::time::sleep(StdDuration::from_secs(
                    AI_AGENT_WORKER_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

async fn alert_loop(env: Arc<Env>, cancellation: CancellationToken) {
    while !cancellation.is_cancelled() {
        match review::process_alert_one(&env).await {
            Ok(true) => {}
            Ok(false) => {
                tokio::time::sleep(StdDuration::from_millis(
                    AI_AGENT_WORKER_IDLE_SLEEP_MS,
                ))
                .await;
            }
            Err(err) => {
                error!("AI agent alert worker failed: {err:#?}");
                tokio::time::sleep(StdDuration::from_secs(
                    AI_AGENT_WORKER_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

async fn chat_monitoring_loop(env: Arc<Env>, cancellation: CancellationToken) {
    while !cancellation.is_cancelled() {
        match chat_monitoring::process_one(&env).await {
            Ok(true) => {}
            Ok(false) => {
                tokio::time::sleep(StdDuration::from_millis(
                    AI_AGENT_WORKER_IDLE_SLEEP_MS,
                ))
                .await;
            }
            Err(err) => {
                error!("AI agent chat monitoring worker failed: {err:#?}");
                tokio::time::sleep(StdDuration::from_secs(
                    AI_AGENT_WORKER_ERROR_SLEEP_SEC,
                ))
                .await;
            }
        }
    }
}

async fn maintenance_loop(env: Arc<Env>, cancellation: CancellationToken) {
    while !cancellation.is_cancelled() {
        if let Err(err) = maintenance_once(&env).await {
            error!("AI agent lifecycle maintenance failed: {err:#?}");
        }
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = tokio::time::sleep(StdDuration::from_secs(30)) => {}
        }
    }
}

async fn maintenance_once(env: &Env) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    let mut reconciliation_failure_count = 0_usize;
    if let Err(err) = reconcile_abandoned_containers(env).await {
        reconciliation_failure_count += 1;
        error!("AI agent abandoned-container maintenance failed: {err:#?}");
    }
    let running = ai_agent_container::Entity::find()
        .filter(ai_agent_container::Column::State.eq("running"))
        .filter(
            ai_agent_container::Column::LastActivityAt
                .lte(now - Duration::minutes(AI_AGENT_IDLE_STOP_MINUTES)),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;
    for container in running {
        let container =
            match lifecycle::refresh_container_stats(env, &container).await {
                Ok(container) => container,
                Err(err) => {
                    error!(
                    "AI agent container stats refresh failed for {}: {err:#?}",
                    container.instance_name
                );
                    container
                }
            };
        let link = crate::entities::ai_agent_user_link::Entity::find_by_id(
            container.ai_agent_user_link_id,
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
        lifecycle::stop_for_user_if_idle(env, link.human_login_id).await?;
    }
    let stopped = ai_agent_container::Entity::find()
        .filter(ai_agent_container::Column::State.eq("stopped"))
        .filter(
            ai_agent_container::Column::StoppedAt
                .lte(now - Duration::days(AI_AGENT_DESTROY_STOPPED_DAYS)),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;
    for container in stopped {
        lifecycle::destroy_container(env, &container).await?;
    }
    if reconciliation_failure_count > 0 {
        return Err(AppError::BL {
            msg: format!(
                "AI agent maintenance had {reconciliation_failure_count} abandoned-container reconciliation failures"
            ),
        });
    }
    Ok(())
}

async fn reconcile_abandoned_containers(env: &Env) -> Result<(), AppError> {
    let risky = ai_agent_container::Entity::find()
        .filter(
            ai_agent_container::Column::State
                .is_in(["creating", "starting", "stopping", "error"]),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut failure_count = 0_usize;
    for container in risky {
        let link = crate::entities::ai_agent_user_link::Entity::find_by_id(
            container.ai_agent_user_link_id,
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
        if let Err(err) =
            lifecycle::reconcile_abandoned_container(env, link.human_login_id)
                .await
        {
            failure_count += 1;
            error!(
                "AI agent abandoned-container reconciliation failed for {}: {err:#?}",
                container.instance_name
            );
        }
    }
    if failure_count > 0 {
        return Err(AppError::BL {
            msg: format!(
                "AI agent abandoned-container reconciliation had {failure_count} failures"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AI_AGENT_REQUEST_MAX_EVENT_BYTES, AI_AGENT_REQUEST_MAX_RUNNER_EVENTS,
    };
    use crate::entities::{ai_agent_allowed_engine, ai_engine};
    use serial_test::serial;

    fn claim_candidate(
        human_login_id: Uuid,
        ai_engine_id: Uuid,
        queued_minute: u32,
    ) -> ClaimCandidate {
        ClaimCandidate {
            id: Uuid::now_v7(),
            human_login_id,
            ai_engine_id,
            queued_at: chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
                .unwrap()
                .and_hms_opt(12, queued_minute, 0)
                .unwrap(),
        }
    }

    #[test]
    fn issue_4232_claims_beside_running_requests_with_the_same_proxies() {
        let (alice, bob) = (Uuid::now_v7(), Uuid::now_v7());
        let (gpt, flash, gemma, unsupported) = (
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
        );
        let needs = HashMap::from([
            (gpt, access::AgentProxyNeed::EchoGateway),
            (flash, access::AgentProxyNeed::EchoGateway),
            (
                gemma,
                access::AgentProxyNeed::DirectHttp {
                    vllm_upstream: "127.0.0.1:18000".to_string(),
                },
            ),
        ]);
        let running = |human_login_id, ai_engine_id| RunningRequest {
            human_login_id,
            ai_engine_id,
        };

        let flash_beside_gpt = claim_candidate(alice, flash, 1);
        assert_eq!(
            pick_claim(
                std::slice::from_ref(&flash_beside_gpt),
                &[running(alice, gpt)],
                &needs,
                1
            ),
            Some(flash_beside_gpt.id),
            "every gateway engine shares the container"
        );
        assert_eq!(
            pick_claim(
                &[claim_candidate(alice, gemma, 1)],
                &[running(alice, gpt)],
                &needs,
                1
            ),
            None,
            "a vLLM request waits for the gateway runs to finish"
        );
        let unsupported_alone = claim_candidate(alice, unsupported, 1);
        assert_eq!(
            pick_claim(
                std::slice::from_ref(&unsupported_alone),
                &[],
                &needs,
                0
            ),
            Some(unsupported_alone.id),
            "an unsupported engine still runs alone and fails at its start"
        );
        assert_eq!(
            pick_claim(
                &[claim_candidate(alice, unsupported, 1)],
                &[running(alice, gpt)],
                &needs,
                1
            ),
            None
        );

        let alice_older = claim_candidate(alice, gpt, 1);
        let bob_newer = claim_candidate(bob, gpt, 2);
        assert_eq!(
            pick_claim(
                &[alice_older.clone(), bob_newer.clone()],
                &[running(alice, gpt)],
                &needs,
                1
            ),
            Some(bob_newer.id),
            "users running fewer requests go first"
        );
        assert_eq!(
            pick_claim(
                &[alice_older.clone(), bob_newer.clone()],
                &[],
                &needs,
                0
            ),
            Some(alice_older.id),
            "then the older request"
        );
        assert_eq!(
            pick_claim(
                &[alice_older.clone(), bob_newer.clone()],
                &[running(alice, gpt)],
                &needs,
                AI_AGENT_MAX_RUNNING_CONTAINERS
            ),
            Some(alice_older.id),
            "with every container busy, only users already running get slots"
        );
        assert_eq!(
            pick_claim(
                std::slice::from_ref(&bob_newer),
                &[],
                &needs,
                AI_AGENT_MAX_RUNNING_CONTAINERS
            ),
            None,
            "a new user waits for a container instead of failing at the limit"
        );
    }

    async fn fail_stray_requests(dbx: &sea_orm::DatabaseConnection) {
        dbx.execute_unprepared(
            "update ai_agent_request
             set state = 'failed',
                 completed_at = now() at time zone 'utc',
                 updated_at = now() at time zone 'utc'
             where state in ('queued', 'running')",
        )
        .await
        .unwrap();
    }

    async fn claim_test_engine(
        dbx: &sea_orm::DatabaseConnection,
        url: &str,
    ) -> ai_engine::Model {
        ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("claim-{}", Uuid::now_v7())),
            model_name: Set("test".to_string()),
            url: Set(url.to_string()),
            enabled: Set(true),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn claim_test_conversation(
        dbx: &sea_orm::DatabaseConnection,
        human_login_id: Uuid,
        ai_engine_id: Uuid,
    ) -> ai_agent_conversation::Model {
        let now = Utc::now().naive_utc();
        ai_agent_conversation::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human_login_id),
            ai_engine_id: Set(ai_engine_id),
            title: Set("Parallel conversations".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn queue_test_request(
        dbx: &sea_orm::DatabaseConnection,
        conversation: &ai_agent_conversation::Model,
        queued_second: i64,
    ) -> Uuid {
        let queued_at = Utc::now().naive_utc() - Duration::minutes(10)
            + Duration::seconds(queued_second);
        ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            conversation_id: Set(conversation.id),
            human_login_id: Set(conversation.human_login_id),
            ai_engine_id: Set(conversation.ai_engine_id),
            prompt: Set("parallel".to_string()),
            state: Set("queued".to_string()),
            cancellation_requested: Set(false),
            queued_at: Set(queued_at),
            updated_at: Set(queued_at),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
        .id
    }

    async fn finish_test_request(
        dbx: &sea_orm::DatabaseConnection,
        request_id: Uuid,
    ) {
        let request = ai_agent_request::Entity::find_by_id(request_id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap();
        let mut request = request.into_active_model();
        request.state = Set("completed".to_string());
        request.completed_at = Set(Some(Utc::now().naive_utc()));
        request.update(dbx).await.unwrap();
    }

    async fn delete_claim_fixtures(
        dbx: &sea_orm::DatabaseConnection,
        conversations: &[ai_agent_conversation::Model],
        engines: &[ai_engine::Model],
    ) {
        for conversation in conversations {
            ai_agent_request::Entity::delete_many()
                .filter(
                    ai_agent_request::Column::ConversationId
                        .eq(conversation.id),
                )
                .exec(dbx)
                .await
                .unwrap();
            ai_agent_conversation::Entity::delete_by_id(conversation.id)
                .exec(dbx)
                .await
                .unwrap();
        }
        for engine in engines {
            ai_engine::Entity::delete_by_id(engine.id)
                .exec(dbx)
                .await
                .unwrap();
        }
    }

    async fn claimed_id(env: &Env) -> Option<Uuid> {
        claim_next_request(env)
            .await
            .unwrap()
            .map(|request| request.id)
    }

    #[actix_web::test]
    #[serial]
    async fn issue_4232_runs_conversations_in_parallel_and_each_in_order() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        fail_stray_requests(&env.dbx).await;
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let gateway =
            claim_test_engine(&env.dbx, crate::config::AI_GOV_UA_API_BASE)
                .await;
        let vllm =
            claim_test_engine(&env.dbx, "http://127.0.0.1:18000/v1").await;
        let first =
            claim_test_conversation(&env.dbx, human.id, gateway.id).await;
        let second =
            claim_test_conversation(&env.dbx, human.id, gateway.id).await;
        let local = claim_test_conversation(&env.dbx, human.id, vllm.id).await;
        let first_1 = queue_test_request(&env.dbx, &first, 1).await;
        let first_2 = queue_test_request(&env.dbx, &first, 2).await;
        let second_1 = queue_test_request(&env.dbx, &second, 3).await;
        let local_1 = queue_test_request(&env.dbx, &local, 4).await;

        assert_eq!(claimed_id(&env).await, Some(first_1));
        assert_eq!(
            claimed_id(&env).await,
            Some(second_1),
            "another conversation runs beside the first"
        );
        assert_eq!(
            claimed_id(&env).await,
            None,
            "the vLLM conversation waits for the gateway runs"
        );
        finish_test_request(&env.dbx, first_1).await;
        assert_eq!(
            claimed_id(&env).await,
            Some(first_2),
            "a conversation's next request starts after its previous one"
        );
        finish_test_request(&env.dbx, first_2).await;
        finish_test_request(&env.dbx, second_1).await;
        assert_eq!(claimed_id(&env).await, Some(local_1));

        let now = Utc::now().naive_utc();
        let second_running = ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            conversation_id: Set(local.id),
            human_login_id: Set(human.id),
            ai_engine_id: Set(vllm.id),
            prompt: Set("parallel".to_string()),
            state: Set("running".to_string()),
            cancellation_requested: Set(false),
            queued_at: Set(now),
            started_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await;
        assert!(
            second_running.is_err(),
            "the index keeps one running request per conversation"
        );
        delete_claim_fixtures(
            &env.dbx,
            &[first, second, local],
            &[gateway, vllm],
        )
        .await;
    }

    #[actix_web::test]
    #[serial]
    async fn issue_4232_concurrent_claims_keep_one_container_proxy_per_user() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        fail_stray_requests(&env.dbx).await;
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let gateway =
            claim_test_engine(&env.dbx, crate::config::AI_GOV_UA_API_BASE)
                .await;
        let vllm =
            claim_test_engine(&env.dbx, "http://127.0.0.1:18000/v1").await;
        let mut conversations = Vec::new();
        for queued_second in 0..4 {
            let conversation =
                claim_test_conversation(&env.dbx, human.id, gateway.id).await;
            queue_test_request(&env.dbx, &conversation, queued_second).await;
            conversations.push(conversation);
        }
        let local = claim_test_conversation(&env.dbx, human.id, vllm.id).await;
        queue_test_request(&env.dbx, &local, 10).await;
        conversations.push(local);

        let claims =
            futures::future::join_all((0..6).map(|_| claim_next_request(&env)))
                .await;
        let claimed = claims
            .into_iter()
            .filter_map(|claim| claim.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(claimed.len(), 4);
        assert!(claimed
            .iter()
            .all(|request| request.ai_engine_id == gateway.id));
        delete_claim_fixtures(&env.dbx, &conversations, &[gateway, vllm]).await;
    }

    #[actix_web::test]
    #[serial]
    async fn issue_3724_selected_glm_checkpoints_with_luna_still_allowed() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let mut env = env.as_ref().clone();
        let gateway = set_government_gateway(&env.dbx, true).await;
        let allowed_engines = ai_agent_allowed_engine::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        ai_agent_allowed_engine::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let mut engines = Vec::new();
        for (name, output_tokens) in [
            (crate::config::AI_AGENT_GLM_5_3, 16_384),
            (crate::config::AI_AGENT_OPENAI_GPT_6_LUNA, 8_192),
        ] {
            let engine = ai_engine::ActiveModel {
                id: Set(Uuid::now_v7()),
                name: Set(format!("checkpoint-{name}-{}", Uuid::now_v7())),
                model_name: Set(name.to_string()),
                url: Set(crate::config::AI_GOV_UA_API_BASE.to_string()),
                enabled: Set(true),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            ai_agent_allowed_engine::ActiveModel {
                ai_engine_id: Set(engine.id),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            let profile = ai_agent_engine_runtime_profile::ActiveModel {
                ai_engine_id: Set(engine.id),
                context_window_tokens: Set(65_536),
                max_output_tokens: Set(output_tokens),
                compaction_reserve_tokens: Set(16_384),
                compaction_keep_recent_tokens: Set(8_192),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            engines.push((engine, profile));
        }
        let (glm, profile) = &engines[0];
        env.config.ai_agent_glm_checkpoint_provider = None;
        let checkpoint = checkpoint_provider(&env, glm, profile)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.ai_engine_id, engines[1].0.id);
        assert_eq!(checkpoint.max_tokens, 8_192);
        env.config.ai_agent_glm_checkpoint_provider =
            Some(crate::config::AiAgentGlmCheckpointProvider::Glm);
        let checkpoint = checkpoint_provider(&env, glm, profile)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.ai_engine_id, glm.id);
        assert_eq!(checkpoint.model_name, glm.model_name);
        assert_eq!(checkpoint.context_window, 65_536);
        assert_eq!(checkpoint.max_tokens, 16_384);
        assert!(checkpoint_provider(&env, &engines[1].0, &engines[1].1)
            .await
            .unwrap()
            .is_none());
        for (engine, _) in engines {
            ai_engine::Entity::delete_by_id(engine.id)
                .exec(&env.dbx)
                .await
                .unwrap();
        }
        for engine in allowed_engines {
            engine.into_active_model().insert(&env.dbx).await.unwrap();
        }
        gateway
            .into_active_model()
            .reset_all()
            .update(&env.dbx)
            .await
            .unwrap();
    }

    async fn set_government_gateway(
        dbx: &sea_orm::DatabaseConnection,
        enabled: bool,
    ) -> crate::entities::ai_gov_ua_settings::Model {
        let gateway = crate::entities::ai_gov_ua_settings::Entity::find_by_id(
            crate::config::AI_GOV_UA_SETTINGS_ID,
        )
        .one(dbx)
        .await
        .unwrap()
        .unwrap();
        let mut active = gateway.clone().into_active_model();
        active.enabled = Set(Some(enabled));
        active.update(dbx).await.unwrap();
        gateway
    }

    async fn allowed_checkpoint_engine(
        dbx: &sea_orm::DatabaseConnection,
        url: &str,
        model_name: &str,
        token: Option<&str>,
        output_tokens: i32,
    ) -> (ai_engine::Model, ai_agent_engine_runtime_profile::Model) {
        let engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("checkpoint-{model_name}-{}", Uuid::now_v7())),
            model_name: Set(model_name.to_string()),
            url: Set(url.to_string()),
            token: Set(token.map(str::to_string)),
            enabled: Set(true),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(engine.id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        let profile = ai_agent_engine_runtime_profile::ActiveModel {
            ai_engine_id: Set(engine.id),
            context_window_tokens: Set(65_536),
            max_output_tokens: Set(output_tokens),
            compaction_reserve_tokens: Set(16_384),
            compaction_keep_recent_tokens: Set(8_192),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        (engine, profile)
    }

    // A proxied GLM must not checkpoint on a direct Luna the disabled Azure
    // gateway cannot reach, or on a proxied Luna without its key.
    #[actix_web::test]
    #[serial]
    async fn proxied_glm_checkpoints_only_on_a_reachable_luna() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let mut env = env.as_ref().clone();
        env.config.ai_agent_glm_checkpoint_provider = None;
        let gateway = set_government_gateway(&env.dbx, false).await;
        let allowed_engines = ai_agent_allowed_engine::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        ai_agent_allowed_engine::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let proxy = "http://proxy.internal:8080/v1";
        let government = crate::config::AI_GOV_UA_API_BASE;
        // Created first, so it has the lowest id among the Luna engines.
        let (direct_luna, _) = allowed_checkpoint_engine(
            &env.dbx,
            government,
            crate::config::AI_AGENT_OPENAI_GPT_6_LUNA,
            None,
            8_192,
        )
        .await;
        let (proxied_luna, _) = allowed_checkpoint_engine(
            &env.dbx,
            proxy,
            "inference.ai.mod.gov.ua/gpt-6-luna",
            Some("sk-bf-test"),
            8_192,
        )
        .await;
        let (glm, glm_profile) = allowed_checkpoint_engine(
            &env.dbx,
            proxy,
            "inference.ai.mod.gov.ua/glm-5.3",
            Some("sk-bf-test"),
            16_384,
        )
        .await;

        let checkpoint = checkpoint_provider(&env, &glm, &glm_profile)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.ai_engine_id, proxied_luna.id);
        assert_eq!(
            checkpoint.model_name,
            crate::config::AI_AGENT_OPENAI_GPT_6_LUNA
        );

        let mut keyless = proxied_luna.clone().into_active_model();
        keyless.token = Set(None);
        keyless.update(&env.dbx).await.unwrap();
        assert!(checkpoint_provider(&env, &glm, &glm_profile)
            .await
            .unwrap()
            .is_none());

        set_government_gateway(&env.dbx, true).await;
        let checkpoint = checkpoint_provider(&env, &glm, &glm_profile)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.ai_engine_id, direct_luna.id);

        for engine in [direct_luna, proxied_luna, glm] {
            ai_engine::Entity::delete_by_id(engine.id)
                .exec(&env.dbx)
                .await
                .unwrap();
        }
        for engine in allowed_engines {
            engine.into_active_model().insert(&env.dbx).await.unwrap();
        }
        gateway
            .into_active_model()
            .reset_all()
            .update(&env.dbx)
            .await
            .unwrap();
    }

    #[test]
    fn issue_3724_scoped_long_execution_to_government_glm() {
        let regular = StdDuration::from_secs(AI_AGENT_DISPATCHER_TIMEOUT_SEC);
        let long = StdDuration::from_secs(
            crate::config::AI_AGENT_GLM_5_3_EXECUTION_TIMEOUT_SEC,
        );
        let timeout = |url: &str, model_name: &str| {
            request_execution_timeout(&crate::ai_engine::client::test_engine(
                url, model_name, None,
            ))
        };
        let government = crate::config::AI_GOV_UA_API_BASE;
        let glm = crate::config::AI_AGENT_GLM_5_3;
        assert_eq!(timeout(government, glm), long);
        assert_eq!(timeout("https://example.invalid/v1", glm), regular);
        assert_eq!(
            timeout(government, crate::config::AI_AGENT_OPENAI_GPT_6_LUNA),
            regular
        );
        assert_eq!(
            timeout(
                "http://proxy.internal:8080/v1",
                "inference.ai.mod.gov.ua/glm-5.3"
            ),
            long,
            "a proxied government GLM keeps the long execution"
        );
    }

    #[test]
    fn issue_4112_provider_diagnostics_choose_the_chat_reason() {
        let after = |diagnostics: &[serde_json::Value]| {
            diagnostics.iter().fold(None, |current, diagnostic| {
                super::next_model_failure(current, diagnostic)
            })
        };
        let failed = json!({"outcome": "transient_error", "httpStatus": 503});
        assert_eq!(
            after(std::slice::from_ref(&failed)),
            Some("provider_error")
        );
        assert_eq!(
            after(&[json!({"outcome": "provider_error", "stage": "research"})]),
            Some("provider_error")
        );
        assert_eq!(
            after(&[json!({"outcome": "content_filter"})]),
            Some("model_refusal")
        );
        assert_eq!(
            after(&[
                json!({"outcome": "complete", "stage": "synthesis"}),
                json!({"outcome": "refusal", "stage": "synthesis"}),
                json!({"outcome": "inability", "stage": "answer"})
            ]),
            Some("model_refusal"),
            "#4224: an unrecovered refusal"
        );
        assert_eq!(
            after(&[
                json!({"outcome": "refusal", "stage": "synthesis"}),
                json!({"outcome": "complete", "stage": "synthesis"})
            ]),
            None,
            "#4224: the rewritten retry answered"
        );
        assert_eq!(
            after(&[failed.clone(), json!({"outcome": "continued"})]),
            Some("provider_error"),
            "progress keeps the failure"
        );
        assert_eq!(
            after(&[failed.clone(), json!({"outcome": "complete"})]),
            None,
            "a later reply succeeded"
        );
        assert_eq!(
            after(&[
                failed.clone(),
                json!({"outcome": "transient_error", "failureKind": "authorization"})
            ]),
            None,
            "authorization ended the run"
        );
        assert_eq!(
            after(&[failed.clone(), json!({"outcome": "authorization"})]),
            None
        );
        assert_eq!(
            after(&[failed.clone(), json!({"outcome": "citation_rejected"})]),
            None,
            "the provider answered"
        );
        assert_eq!(
            after(&[failed.clone(), json!({"outcome": "research_text"})]),
            None,
            "#4115: research's own reply was delivered"
        );
        assert_eq!(
            after(&[failed, json!({"outcome": "partial"})]),
            None,
            "the finished part of a cut-off synthesis was delivered"
        );
    }

    #[test]
    fn issue_4112_legacy_runs_keep_only_provider_failures() {
        let metadata =
            |reason: &str| crate::ai_agent::types::AiAgentCompletionMetadata {
                coverage_limited: true,
                reason: reason.to_string(),
            };
        assert!(super::keeps_runner_metadata(
            false,
            &metadata("provider_error")
        ));
        assert!(!super::keeps_runner_metadata(
            false,
            &metadata("time_limit")
        ));
        assert!(super::keeps_runner_metadata(true, &metadata("time_limit")));
    }

    #[test]
    fn issue_4112_provider_failure_replaces_incomplete_research() {
        let metadata = |reason: &str| {
            Some(crate::ai_agent::types::AiAgentCompletionMetadata {
                coverage_limited: true,
                reason: reason.to_string(),
            })
        };
        assert_eq!(
            super::provider_limited_metadata(
                metadata("incomplete_research"),
                Some("provider_error")
            ),
            metadata("provider_error")
        );
        assert_eq!(
            super::provider_limited_metadata(
                metadata("incomplete_research"),
                None
            ),
            metadata("incomplete_research")
        );
        assert_eq!(
            super::provider_limited_metadata(
                metadata("time_limit"),
                Some("provider_error")
            ),
            metadata("time_limit")
        );
        assert_eq!(
            super::provider_limited_metadata(None, Some("provider_error")),
            None
        );
        // #4224: a refusal the rewrite layer could not recover offers another
        // model too.
        assert_eq!(
            super::provider_limited_metadata(
                metadata("incomplete_research"),
                Some("model_refusal")
            ),
            metadata("model_refusal")
        );
    }

    #[test]
    fn cleanup_periods_match_product_contract() {
        assert_eq!(AI_AGENT_IDLE_STOP_MINUTES, 5);
        assert_eq!(AI_AGENT_DESTROY_STOPPED_DAYS, 7);
    }

    #[test]
    fn runner_payload_drops_oldest_complete_turns_to_fit() {
        let history = vec![
            json!({"role": "user", "content": "o".repeat(180_000)}),
            json!({"role": "assistant", "content": "o".repeat(180_000)}),
            json!({"role": "user", "content": "n".repeat(180_000)}),
            json!({"role": "assistant", "content": "n".repeat(180_000)}),
        ];
        let payload = bounded_runner_payload(
            json!({"prompt": "question", "skills": []}),
            history,
        )
        .unwrap();
        let history = payload["history"].as_array().unwrap();
        assert_eq!(history.len(), 2);
        assert!(history[0]["content"].as_str().unwrap().starts_with('n'));
        assert!(
            serde_json::to_vec(&payload).unwrap().len()
                <= AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
        );
    }

    #[test]
    fn issue_3770_large_multibyte_draft_keeps_the_latest_question() {
        let payload = bounded_runner_payload(
            json!({"prompt":"Continue the research","context":"x".repeat(300_000)}),
            vec![json!({"role":"user","content":"Original subjects"}),
                 json!({"role":"assistant","content":"🧭\n".repeat(100_000)})],
        ).unwrap();
        assert_eq!(payload["history"][0]["content"], "Original subjects");
        assert!(payload["history"][1]["content"]
            .as_str()
            .unwrap()
            .contains("truncated to fit context"));
        assert!(
            serde_json::to_vec(&payload).unwrap().len()
                <= AI_AGENT_RUNNER_PAYLOAD_MAX_BYTES
        );
    }

    #[test]
    fn runner_payload_carries_only_transport_scoped_provider_credentials() {
        let payload = runner_payload_for_provider(
            json!({"prompt": "question"}),
            access::AgentProviderTransport::DirectHttp,
            Some("budget-limited-token".to_string()),
            None,
        );
        assert_eq!(payload["providerApiKey"], "budget-limited-token");
        assert_eq!(payload["providerTransport"], "direct_http");

        let payload = runner_payload_for_provider(
            json!({"prompt": "question"}),
            access::AgentProviderTransport::EchoGateway,
            Some("real-openai-token".to_string()),
            Some("scoped-capability".to_string()),
        );
        assert_eq!(payload["providerApiKey"], "scoped-capability");
        assert_eq!(payload["providerTransport"], "echo_gateway");
        assert!(!payload.to_string().contains("real-openai-token"));

        let payload = runner_payload_for_provider(
            json!({"prompt": "question"}),
            access::AgentProviderTransport::DirectHttp,
            None,
            None,
        );
        assert!(payload.get("providerApiKey").is_none());
    }

    #[test]
    fn runner_stream_limits_are_inclusive_and_bounded() {
        let limits = crate::ai_agent::reasoning::limits(None);
        assert!(stream_limits_allow(
            &limits,
            AI_AGENT_REQUEST_MAX_RUNNER_EVENTS,
            AI_AGENT_REQUEST_MAX_EVENT_BYTES,
            AI_AGENT_RESPONSE_MAX_BYTES,
            AI_AGENT_RESPONSE_MAX_CHARS,
        ));
        assert!(!stream_limits_allow(
            &limits,
            AI_AGENT_REQUEST_MAX_RUNNER_EVENTS + 1,
            0,
            0,
            0,
        ));
        assert!(!stream_limits_allow(
            &limits,
            0,
            AI_AGENT_REQUEST_MAX_EVENT_BYTES + 1,
            0,
            0,
        ));
        assert!(!stream_limits_allow(
            &limits,
            0,
            0,
            AI_AGENT_RESPONSE_MAX_BYTES + 1,
            0,
        ));
        assert!(!stream_limits_allow(
            &limits,
            0,
            0,
            0,
            AI_AGENT_RESPONSE_MAX_CHARS + 1,
        ));
        assert_eq!(AI_AGENT_HISTORY_MAX_TURNS * 2, 200);
    }

    #[tokio::test]
    #[serial]
    async fn worker_lease_allows_only_one_database_session() {
        crate::tests::test::init().await;
        let first_db = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let second_db = crate::new_pg_pool_from_mode(crate::types::Mode::Test)
            .await
            .unwrap();
        let lock_key = {
            let id = Uuid::now_v7();
            let mut bytes = [0_u8; 8];
            bytes.copy_from_slice(&id.as_bytes()[..8]);
            i64::from_be_bytes(bytes) ^ AI_AGENT_WORKER_LEASE_ADVISORY_LOCK_KEY
        };
        let cancellation = CancellationToken::new();
        let first = tokio::time::timeout(
            StdDuration::from_secs(5),
            wait_for_worker_lease(&first_db, &cancellation, lock_key),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();

        let blocked = tokio::time::timeout(
            StdDuration::from_millis(100),
            wait_for_worker_lease(&second_db, &cancellation, lock_key),
        )
        .await;
        assert!(blocked.is_err());

        close_worker_lease(first).await;
        let second = tokio::time::timeout(
            StdDuration::from_secs(5),
            wait_for_worker_lease(&second_db, &cancellation, lock_key),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        close_worker_lease(second).await;
    }
}
