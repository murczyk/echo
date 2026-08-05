use super::{
    access, auth, chat_monitoring, dispatcher::DispatcherClient, events,
    lifecycle, review,
};
use crate::config::{
    AI_AGENT_DESTROY_STOPPED_DAYS, AI_AGENT_DISPATCHER_TIMEOUT_SEC,
    AI_AGENT_ERROR_MAX_CHARS, AI_AGENT_HISTORY_MAX_TURNS,
    AI_AGENT_IDLE_STOP_MINUTES, AI_AGENT_REQUEST_MAX_EVENT_BYTES,
    AI_AGENT_REQUEST_MAX_RUNNER_EVENTS, AI_AGENT_REQUEST_WORKER_COUNT,
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
    ai_agent_container, ai_agent_conversation, ai_agent_request,
};
use crate::error::AppError;
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseBackend,
    EntityTrait, FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde_json::{json, Value};
use sqlx::pool::PoolConnection;
use sqlx::Postgres;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tokio::task::JoinSet;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

enum RunOutcome {
    Completed(String),
    Cancelled,
}

struct WorkerLease {
    connection: PoolConnection<Postgres>,
}

pub async fn run_nofail(env: Arc<Env>, cancellation: CancellationToken) {
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

async fn claim_next_request(
    env: &Env,
) -> Result<Option<ai_agent_request::Model>, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let statement = Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
with candidate as (
    select request.id
    from ai_agent_request request
    where request.state = 'queued'
      and not exists (
          select 1
          from ai_agent_request running
          where running.human_login_id = request.human_login_id
            and running.state = 'running'
      )
      and not exists (
          select 1
          from ai_agent_request earlier
          where earlier.human_login_id = request.human_login_id
            and earlier.state = 'queued'
            and (earlier.queued_at, earlier.id) < (request.queued_at, request.id)
      )
    order by request.queued_at, request.id
    for update skip locked
    limit 1
)
update ai_agent_request request
set state = 'running',
    started_at = now() at time zone 'utc',
    updated_at = now() at time zone 'utc',
    error = null
where request.id in (select id from candidate)
returning request.*
        "#,
    );
    let request = ai_agent_request::Model::find_by_statement(statement)
        .one(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(request)
}

async fn process_claimed_request(
    env: &Env,
    request: ai_agent_request::Model,
    cancellation: &CancellationToken,
) {
    let request_id = request.id;
    let result = run_request(env, &request, cancellation).await;
    let revoke_result = auth::revoke_request(env, request_id).await;
    if let Err(err) = revoke_result {
        error!(
            "AI agent credential revocation failed for {request_id}: {err:#?}"
        );
    }
    match result {
        Ok(RunOutcome::Completed(response)) => {
            if let Err(err) = complete_request(env, request_id, response).await
            {
                error!(
                    "AI agent completion persistence failed for {request_id}: {err:#?}"
                );
                let _ = fail_request(env, request_id, &err).await;
            }
        }
        Ok(RunOutcome::Cancelled) => {}
        Err(err) => {
            if let Err(persist_err) = fail_request(env, request_id, &err).await
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
) -> Result<RunOutcome, AppError> {
    match tokio::time::timeout(
        StdDuration::from_secs(AI_AGENT_DISPATCHER_TIMEOUT_SEC),
        run_request_inner(env, request, cancellation),
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

async fn run_request_inner(
    env: &Env,
    request: &ai_agent_request::Model,
    cancellation: &CancellationToken,
) -> Result<RunOutcome, AppError> {
    let request_started_at = Utc::now();
    if cancellation.is_cancelled() {
        return Err(interrupted_error());
    }
    if !access::settings(&env.dbx).await?.feature_enabled {
        return Err(AppError::Forbidden(
            "AI agent harness was disabled before execution".to_string(),
        ));
    }
    let ai_engine =
        access::allowed_engine(&env.dbx, Some(request.ai_engine_id)).await?;
    if request_is_cancelled(env, request.id).await? {
        return Ok(RunOutcome::Cancelled);
    }
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
    if !events::append_request_start(
        &env.dbx,
        request.id,
        json!({ "requestId": request.id }),
    )
    .await?
    {
        return Ok(RunOutcome::Cancelled);
    }
    let provider_transport = access::agent_provider_transport(&ai_engine)
        .ok_or_else(|| {
            AppError::Forbidden(
                "AI engine is not supported by the agent harness".to_string(),
            )
        })?;
    let gateway_capability =
        if provider_transport == access::AgentProviderTransport::EchoGateway {
            Some(
                auth::issue_provider_capability(
                    env,
                    linked.login.id,
                    request.id,
                    correlation_id,
                    ai_engine.id,
                    ai_engine.model_name.clone(),
                )
                .await?,
            )
        } else {
            None
        };
    let history = load_history(env, request).await?;
    let runner_payload = runner_payload_for_provider(
        json!({
            "echoPublicHost": env.config.public_host,
            "modelName": ai_engine.model_name,
            "bootstrapToken": bootstrap_token,
            "correlationId": correlation_id,
            "correlationHeader": crate::config::AI_AGENT_CORRELATION_HEADER,
            "prompt": request.prompt,
            "skills": super::route_registry::skills_json(),
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
    let payload = bounded_runner_payload(runner_payload, history)?;
    let dispatcher = DispatcherClient::from_env(env).await?;
    let mut stream = dispatcher
        .start_stream(
            "run_request",
            linked.login.id,
            json!({ "payload": payload }),
        )
        .await?;
    let mut response = String::new();
    let mut response_chars = 0_usize;
    let mut runner_event_count = 0_usize;
    let mut runner_event_bytes = 0_usize;
    let mut terminal_seen = false;
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
                    runner_event_count = runner_event_count.saturating_add(1);
                    runner_event_bytes = runner_event_bytes.saturating_add(
                        serde_json::to_vec(&event).c(h!())?.len(),
                    );
                    if !stream_limits_allow(
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
                    if let Some((event_type, payload)) = events::normalize_runner_event(event) {
                        let delta = if event_type == "assistant_delta" {
                            events::assistant_delta(&payload).map(str::to_string)
                        } else {
                            None
                        };
                        if let Some(delta) = delta.as_deref() {
                            response_chars = response_chars
                                .saturating_add(delta.chars().count());
                        }
                        let response_bytes = response.len().saturating_add(
                            delta.as_deref().map_or(0, str::len),
                        );
                        if !stream_limits_allow(
                            runner_event_count,
                            runner_event_bytes,
                            response_bytes,
                            response_chars,
                        ) {
                            let _ = stream.terminate().await;
                            return Err(AppError::BL {
                                msg: "AI agent runner output exceeded the configured limit"
                                    .to_string(),
                            });
                        }
                        if !events::append_runner(
                            &env.dbx,
                            request.id,
                            &event_type,
                            payload,
                        )
                        .await?
                        {
                            let _ = stream.terminate().await;
                            return Ok(RunOutcome::Cancelled);
                        }
                        if let Some(delta) = delta {
                            response.push_str(&delta);
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
    Ok(RunOutcome::Completed(response))
}

fn bounded_runner_payload(
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
        history.drain(..2);
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
    runner_event_count: usize,
    runner_event_bytes: usize,
    response_bytes: usize,
    response_chars: usize,
) -> bool {
    runner_event_count <= AI_AGENT_REQUEST_MAX_RUNNER_EVENTS
        && runner_event_bytes <= AI_AGENT_REQUEST_MAX_EVENT_BYTES
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

async fn load_history(
    env: &Env,
    request: &ai_agent_request::Model,
) -> Result<Vec<Value>, AppError> {
    let requests = ai_agent_request::Entity::find()
        .filter(
            ai_agent_request::Column::ConversationId
                .eq(request.conversation_id),
        )
        .filter(ai_agent_request::Column::State.eq("completed"))
        .filter(ai_agent_request::Column::Id.ne(request.id))
        .order_by_desc(ai_agent_request::Column::QueuedAt)
        .order_by_desc(ai_agent_request::Column::Id)
        .limit(AI_AGENT_HISTORY_MAX_TURNS)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let requests = requests.into_iter().rev();
    Ok(requests
        .flat_map(|request| {
            [
                json!({ "role": "user", "content": request.prompt }),
                json!({ "role": "assistant", "content": request.response.unwrap_or_default() }),
            ]
        })
        .collect())
}

fn interrupted_error() -> AppError {
    AppError::BL {
        msg: "AI agent request was interrupted by worker shutdown".to_string(),
    }
}

async fn complete_request(
    env: &Env,
    request_id: Uuid,
    response: String,
) -> Result<bool, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
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
    events::append_in_transaction(
        &txn,
        request_id,
        "completion",
        json!({ "responseLength": response.chars().count() }),
    )
    .await?;
    review::enqueue_in_transaction(&txn, request_id).await?;
    txn.commit().await.c(h!())?;
    Ok(true)
}

async fn fail_request(
    env: &Env,
    request_id: Uuid,
    err: &AppError,
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
    request.state = Set("failed".to_string());
    request.error = Set(Some(message.clone()));
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
        if let Err(err) = fail_request(env, request.id, &err).await {
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
    use serial_test::serial;

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
        assert!(stream_limits_allow(
            AI_AGENT_REQUEST_MAX_RUNNER_EVENTS,
            AI_AGENT_REQUEST_MAX_EVENT_BYTES,
            AI_AGENT_RESPONSE_MAX_BYTES,
            AI_AGENT_RESPONSE_MAX_CHARS,
        ));
        assert!(!stream_limits_allow(
            AI_AGENT_REQUEST_MAX_RUNNER_EVENTS + 1,
            0,
            0,
            0,
        ));
        assert!(!stream_limits_allow(
            0,
            AI_AGENT_REQUEST_MAX_EVENT_BYTES + 1,
            0,
            0,
        ));
        assert!(!stream_limits_allow(
            0,
            0,
            AI_AGENT_RESPONSE_MAX_BYTES + 1,
            0,
        ));
        assert!(!stream_limits_allow(
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
