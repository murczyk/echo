//! Automatic AI engine health (#4157).
//!
//! Every call through the shared [`AiEngineClient`], from every process, is
//! counted per minute in Redis for its engine when it starts, and its outcome
//! when it ends; a stream's outcome is how the stream ended, not its headers.
//! Once a minute one instance reads the counters and:
//!
//! - marks a healthy engine unhealthy when more than
//!   `AI_ENGINE_HEALTH_FAILURE_PERCENT` of at least `AI_ENGINE_HEALTH_MIN_CALLS`
//!   calls in the last `AI_ENGINE_HEALTH_WINDOW_MINUTES` failed at the provider;
//! - marks an automatically unhealthy engine healthy again when its traffic
//!   recovers, or, when no call has reached it for
//!   `AI_ENGINE_HEALTH_PROBE_IDLE_MINUTES`, after a minimal probe succeeds. Users
//!   who still call the engine are the signal, so it is never probed then.
//!
//! Only outcomes after the engine's latest health change count, so a mark never
//! acts on evidence an administrator has already seen; every writer stamps the
//! time. The worker's unhealthy marks have no login and a message starting with
//! [`AUTOMATIC_PREFIX`]. A mark an administrator set (with a login) or a
//! profile import set with its own message is never reverted automatically;
//! an imported copy of the worker's own mark stays automatic.
//!
//! The flag only steers the chat to a healthy engine; nothing blocks calls, so
//! background jobs keep using the engine and their outcomes count too.

use super::{AiEngineClient, AiEngineMessage, OpenAiChatCompletionReq};
use crate::config::{
    AI_ENGINE_HEALTH_FAILURE_PERCENT, AI_ENGINE_HEALTH_INTERVAL_SECS,
    AI_ENGINE_HEALTH_MIN_CALLS, AI_ENGINE_HEALTH_PROBE_IDLE_MINUTES,
    AI_ENGINE_HEALTH_PROBE_INTERVAL_SECS, AI_ENGINE_HEALTH_PROBE_MAX_TOKENS,
    AI_ENGINE_HEALTH_PROBE_TIMEOUT_SECS, AI_ENGINE_HEALTH_RECOVERY_MIN_CALLS,
    AI_ENGINE_HEALTH_RECOVERY_WINDOW_MINUTES, AI_ENGINE_HEALTH_REDIS_PREFIX,
    AI_ENGINE_HEALTH_WINDOW_MINUTES, AI_ENGINE_OPENAI_REASONING_MODEL_PREFIXES,
};
use crate::entities::ai_engine;
use crate::h;
use crate::types::{Env, ShortContext};
use chrono::{NaiveDateTime, Utc};
use redis::aio::ConnectionManager;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::future::Future;
use std::ops::RangeInclusive;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const LOG_TARGET: &str = "ai_engine_health";
const FIELD_TOTAL: &str = "total";
const FIELD_OK: &str = "ok";
const FIELD_FAILED: &str = "failed";
/// Counters outlive the longest window they feed.
const BUCKET_TTL_SECS: i64 = (AI_ENGINE_HEALTH_WINDOW_MINUTES + 5) * 60;
/// Longer than any provider call or stream runs. A call still listed after
/// this was left behind by a process that died.
const IN_FLIGHT_MAX_MS: i64 = 2 * 60 * 60 * 1000;

/// A call's entry in the engine's in-flight list.
pub(crate) struct InFlight {
    call: Uuid,
    /// The task adding it, which removal waits for.
    listed: Option<tokio::task::JoinHandle<()>>,
}

/// Where a client's call outcomes are counted.
#[derive(Clone)]
pub(crate) struct HealthSink {
    redis: ConnectionManager,
}

impl HealthSink {
    pub(super) fn new(redis: ConnectionManager) -> Self {
        Self { redis }
    }

    /// Counts a call as it starts, so recent use shows even before it ends.
    pub(super) fn record_start(&self, engine_id: Uuid) {
        self.spawn_increment(engine_id, FIELD_TOTAL);
    }

    /// A call or stream is now running on the engine; [`Self::end`] it once it
    /// stops. The worker never probes an engine with one running, however
    /// long, and drops entries older than `IN_FLIGHT_MAX_MS`.
    pub(super) fn begin(&self, engine_id: Uuid) -> InFlight {
        let call = Uuid::now_v7();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return InFlight { call, listed: None };
        };
        let mut redis = self.redis.clone();
        let started_ms = Utc::now().timestamp_millis();
        let listed = runtime.spawn(async move {
            let key = in_flight_key(engine_id);
            let mut pipe = redis::pipe();
            pipe.atomic();
            pipe.zadd(&key, call.to_string(), started_ms).ignore();
            pipe.expire(&key, IN_FLIGHT_MAX_MS / 1000).ignore();
            if let Err(error) = pipe.query_async::<()>(&mut redis).await {
                log::warn!(target: LOG_TARGET, "engine_id={engine_id} in-flight start failed: {error:?}");
            }
        });
        InFlight {
            call,
            listed: Some(listed),
        }
    }

    /// Removes the call once its listing landed, so a quick call cannot be
    /// removed before it is added and then linger.
    pub(super) fn end(&self, engine_id: Uuid, in_flight: InFlight) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let mut redis = self.redis.clone();
        runtime.spawn(async move {
            if let Some(listed) = in_flight.listed {
                let _ = listed.await;
            }
            let removed: redis::RedisResult<()> = redis::cmd("ZREM")
                .arg(in_flight_key(engine_id))
                .arg(in_flight.call.to_string())
                .query_async(&mut redis)
                .await;
            if let Err(error) = removed {
                log::warn!(target: LOG_TARGET, "engine_id={engine_id} in-flight end failed: {error:?}");
            }
        });
    }

    /// Counts how a call ended. Outcomes that say nothing about the provider
    /// add nothing beyond the start.
    pub(super) fn record(&self, engine_id: Uuid, outcome: &'static str) {
        if let Some(field) = outcome_field(outcome) {
            self.spawn_increment(engine_id, field);
        }
    }

    /// Updates the counters without delaying the call they belong to.
    fn spawn_increment(&self, engine_id: Uuid, field: &'static str) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let mut redis = self.redis.clone();
        let minute = current_minute();
        runtime.spawn(async move {
            if let Err(error) =
                increment(&mut redis, engine_id, minute, field).await
            {
                log::warn!(target: LOG_TARGET, "engine_id={engine_id} field={field} counter update failed: {error:?}");
            }
        });
    }
}

/// How an outcome bears on an engine's health.
#[derive(Debug, PartialEq)]
enum OutcomeClass {
    Ok,
    /// The provider failed: rate limit, server error, timeout, connection or
    /// a stream that broke off.
    Failed,
    /// Says nothing about the provider: our own bad request, a cancelled call,
    /// a local cooldown or a local error. It still shows that someone called.
    Neutral,
}

fn classify(outcome: &str) -> OutcomeClass {
    match outcome {
        "ok" => OutcomeClass::Ok,
        "rate_limited" | "server_error" | "timeout" | "connect_error"
        | "transport_error" | "stream_failed" => OutcomeClass::Failed,
        _ => OutcomeClass::Neutral,
    }
}

fn outcome_field(outcome: &str) -> Option<&'static str> {
    match classify(outcome) {
        OutcomeClass::Ok => Some(FIELD_OK),
        OutcomeClass::Failed => Some(FIELD_FAILED),
        OutcomeClass::Neutral => None,
    }
}

fn bucket_key(engine_id: Uuid, minute: i64) -> String {
    format!("{AI_ENGINE_HEALTH_REDIS_PREFIX}{engine_id}:{minute}")
}

fn in_flight_key(engine_id: Uuid) -> String {
    format!("{AI_ENGINE_HEALTH_REDIS_PREFIX}{engine_id}:in-flight")
}

/// Calls and streams running on the engine now, leaving out those a dead
/// process left behind.
async fn in_flight(
    redis: &mut ConnectionManager,
    engine_id: Uuid,
) -> anyhow::Result<u64> {
    let key = in_flight_key(engine_id);
    let oldest = Utc::now().timestamp_millis() - IN_FLIGHT_MAX_MS;
    let mut pipe = redis::pipe();
    pipe.cmd("ZREMRANGEBYSCORE")
        .arg(&key)
        .arg("-inf")
        .arg(oldest)
        .ignore();
    pipe.cmd("ZCARD").arg(&key);
    let (count,): (u64,) = pipe.query_async(redis).await.c(h!())?;
    Ok(count)
}

/// Whether nobody called the engine lately and nothing is running on it.
async fn unused(
    redis: &mut ConnectionManager,
    engine_id: Uuid,
    now_minute: i64,
) -> anyhow::Result<bool> {
    let recent = read_counts(
        redis,
        engine_id,
        now_minute - AI_ENGINE_HEALTH_PROBE_IDLE_MINUTES + 1..=now_minute,
    )
    .await
    .c(h!())?;
    Ok(recent.total == 0 && in_flight(redis, engine_id).await.c(h!())? == 0)
}

fn current_minute() -> i64 {
    Utc::now().timestamp().div_euclid(60)
}

async fn increment(
    redis: &mut ConnectionManager,
    engine_id: Uuid,
    minute: i64,
    field: &str,
) -> anyhow::Result<()> {
    let key = bucket_key(engine_id, minute);
    let mut pipe = redis::pipe();
    pipe.atomic();
    pipe.hincr(&key, field, 1).ignore();
    pipe.expire(&key, BUCKET_TTL_SECS).ignore();
    pipe.query_async::<()>(redis).await.c(h!())?;
    Ok(())
}

/// A whole call: its start and how it ended.
#[cfg(test)]
pub(crate) async fn record_outcome(
    redis: &mut ConnectionManager,
    engine_id: Uuid,
    minute: i64,
    outcome: &str,
) -> anyhow::Result<()> {
    increment(redis, engine_id, minute, FIELD_TOTAL)
        .await
        .c(h!())?;
    if let Some(field) = outcome_field(outcome) {
        increment(redis, engine_id, minute, field).await.c(h!())?;
    }
    Ok(())
}

/// Calls counted over some minutes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Counts {
    pub(crate) total: u64,
    pub(crate) ok: u64,
    pub(crate) failed: u64,
}

impl Counts {
    /// Calls whose outcome says whether the provider works.
    fn decisive(&self) -> u64 {
        self.ok + self.failed
    }
}

async fn read_counts(
    redis: &mut ConnectionManager,
    engine_id: Uuid,
    minutes: RangeInclusive<i64>,
) -> anyhow::Result<Counts> {
    if minutes.is_empty() {
        return Ok(Counts::default());
    }
    let mut pipe = redis::pipe();
    for minute in minutes {
        pipe.cmd("HMGET")
            .arg(bucket_key(engine_id, minute))
            .arg(FIELD_TOTAL)
            .arg(FIELD_OK)
            .arg(FIELD_FAILED);
    }
    let rows: Vec<Vec<Option<u64>>> = pipe.query_async(redis).await.c(h!())?;
    Ok(rows.into_iter().fold(Counts::default(), |sum, row| {
        let field =
            |index: usize| row.get(index).copied().flatten().unwrap_or(0);
        Counts {
            total: sum.total + field(0),
            ok: sum.ok + field(1),
            failed: sum.failed + field(2),
        }
    }))
}

/// What the worker knows about an engine in one round.
#[derive(Debug)]
pub(crate) struct Observation {
    pub(crate) unhealthy: bool,
    /// The current health was set by this worker.
    pub(crate) automatic: bool,
    /// Calls in the failure window since the last health change.
    pub(crate) window: Counts,
    /// Calls in the recovery window since the last health change.
    pub(crate) recent: Counts,
    /// No call at all reached the engine in the probe idle window.
    pub(crate) idle: bool,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Decision {
    Keep,
    MarkUnhealthy { failed: u64, calls: u64 },
    MarkHealthy,
    Probe,
}

pub(crate) fn decide(observation: &Observation) -> Decision {
    if !observation.unhealthy {
        let calls = observation.window.decisive();
        let failed = observation.window.failed;
        return if calls >= AI_ENGINE_HEALTH_MIN_CALLS
            && failed * 100 > calls * AI_ENGINE_HEALTH_FAILURE_PERCENT
        {
            Decision::MarkUnhealthy { failed, calls }
        } else {
            Decision::Keep
        };
    }
    if !observation.automatic {
        return Decision::Keep;
    }
    let recent = observation.recent;
    if recent.decisive() >= AI_ENGINE_HEALTH_RECOVERY_MIN_CALLS
        && recent.failed * 2 <= recent.decisive()
    {
        return Decision::MarkHealthy;
    }
    if observation.idle {
        Decision::Probe
    } else {
        Decision::Keep
    }
}

/// How the worker's unhealthy messages start.
pub(crate) const AUTOMATIC_PREFIX: &str = "Автоматично:";

/// The worker set this unhealthy mark: no login, and its message.
fn automatic(engine: &ai_engine::Model) -> bool {
    engine.health_updated_by_login_id.is_none()
        && engine
            .health_message
            .as_deref()
            .is_some_and(|message| message.starts_with(AUTOMATIC_PREFIX))
}

fn unhealthy_message(failed: u64, calls: u64, minutes: i64) -> String {
    format!("{AUTOMATIC_PREFIX} {failed} з {calls} викликів моделі за останні {minutes} хв завершилися помилкою постачальника. Позначку буде знято, щойно модель знову відповідатиме.")
}

/// Changes the engine's health unless someone changed it since it was read.
async fn mark(
    db: &sea_orm::DatabaseConnection,
    engine: &ai_engine::Model,
    unhealthy: bool,
    message: Option<String>,
    now: NaiveDateTime,
) -> anyhow::Result<bool> {
    let mut update = ai_engine::Entity::update_many()
        .col_expr(ai_engine::Column::Unhealthy, Expr::value(Some(unhealthy)))
        .col_expr(ai_engine::Column::HealthMessage, Expr::value(message))
        .col_expr(ai_engine::Column::HealthUpdatedAt, Expr::value(Some(now)))
        .col_expr(
            ai_engine::Column::HealthUpdatedByLoginId,
            Expr::value(Option::<Uuid>::None),
        )
        .filter(ai_engine::Column::Id.eq(engine.id));
    update = match engine.health_updated_at {
        Some(at) => update.filter(ai_engine::Column::HealthUpdatedAt.eq(at)),
        None => update.filter(ai_engine::Column::HealthUpdatedAt.is_null()),
    };
    update = match engine.unhealthy {
        Some(value) => update.filter(ai_engine::Column::Unhealthy.eq(value)),
        None => update.filter(ai_engine::Column::Unhealthy.is_null()),
    };
    Ok(update.exec(db).await.c(h!())?.rows_affected == 1)
}

/// `SET key 1 NX EX ttl`: true for the one caller that set it.
async fn claim(
    redis: &mut ConnectionManager,
    key: String,
    ttl_secs: u64,
) -> anyhow::Result<bool> {
    let claimed: Option<String> = redis::cmd("SET")
        .arg(key)
        .arg(1)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async(redis)
        .await
        .c(h!())?;
    Ok(claimed.is_some())
}

/// One check of every enabled engine. `probe` reports whether an idle,
/// automatically unhealthy engine answered.
pub(crate) async fn run_round<F, Fut>(env: &Env, probe: F) -> anyhow::Result<()>
where
    F: Fn(ai_engine::Model) -> Fut,
    Fut: Future<Output = bool>,
{
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Enabled.eq(true))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut redis = env.redis.clone();
    for engine in engines {
        // Probes of earlier engines can take a while, so each reads the clock.
        let now = Utc::now().naive_utc();
        let now_minute = now.and_utc().timestamp().div_euclid(60);
        // The minute of the last change is partly before it, so it is left out.
        let since_change = engine
            .health_updated_at
            .map(|at| at.and_utc().timestamp().div_euclid(60) + 1)
            .unwrap_or(i64::MIN);
        let window_start = std::cmp::max(
            now_minute - AI_ENGINE_HEALTH_WINDOW_MINUTES + 1,
            since_change,
        );
        let recent_start = std::cmp::max(
            now_minute - AI_ENGINE_HEALTH_RECOVERY_WINDOW_MINUTES + 1,
            since_change,
        );
        let observation = Observation {
            unhealthy: engine.unhealthy.unwrap_or(false),
            automatic: automatic(&engine),
            window: read_counts(
                &mut redis,
                engine.id,
                window_start..=now_minute,
            )
            .await
            .c(h!())?,
            recent: read_counts(
                &mut redis,
                engine.id,
                recent_start..=now_minute,
            )
            .await
            .c(h!())?,
            idle: unused(&mut redis, engine.id, now_minute).await.c(h!())?,
        };
        let decision = decide(&observation);
        let changed = match decision {
            Decision::Keep => continue,
            Decision::MarkUnhealthy { failed, calls } => {
                let minutes = now_minute - window_start + 1;
                mark(
                    &env.dbx,
                    &engine,
                    true,
                    Some(unhealthy_message(failed, calls, minutes)),
                    now,
                )
                .await
                .c(h!())?
            }
            Decision::MarkHealthy => {
                mark(&env.dbx, &engine, false, None, now).await.c(h!())?
            }
            Decision::Probe => {
                let key = format!(
                    "{AI_ENGINE_HEALTH_REDIS_PREFIX}{}:probe",
                    engine.id
                );
                if !claim(&mut redis, key, AI_ENGINE_HEALTH_PROBE_INTERVAL_SECS)
                    .await
                    .c(h!())?
                {
                    continue;
                }
                // Someone may have started a call since the engine was read.
                let minute = Utc::now().timestamp().div_euclid(60);
                if !unused(&mut redis, engine.id, minute).await.c(h!())? {
                    continue;
                }
                let answered = probe(engine.clone()).await;
                log::info!(target: LOG_TARGET, "engine_id={} name={:?} probe answered={answered}", engine.id, engine.name);
                if !answered {
                    continue;
                }
                mark(&env.dbx, &engine, false, None, Utc::now().naive_utc())
                    .await
                    .c(h!())?
            }
        };
        log::warn!(target: LOG_TARGET, "engine_id={} name={:?} decision={decision:?} applied={changed} window={:?} recent={:?}", engine.id, engine.name, observation.window, observation.recent);
    }
    Ok(())
}

/// A minimal chat completion: any 2xx answer is a sign of health.
pub(crate) async fn probe_engine(
    client: &AiEngineClient,
    engine: &ai_engine::Model,
) -> bool {
    let reasoning = AI_ENGINE_OPENAI_REASONING_MODEL_PREFIXES
        .iter()
        .any(|prefix| engine.model_name.starts_with(prefix));
    let body = match serde_json::to_value(OpenAiChatCompletionReq {
        model_name: engine.model_name.clone(),
        messages: vec![AiEngineMessage {
            role: "user".to_string(),
            content: "ping".to_string(),
        }],
        temperature: None,
        max_tokens: (!reasoning).then_some(AI_ENGINE_HEALTH_PROBE_MAX_TOKENS),
        max_completion_tokens: reasoning
            .then_some(AI_ENGINE_HEALTH_PROBE_MAX_TOKENS),
        reasoning_effort: None,
        response_format: None,
    }) {
        Ok(body) => body,
        Err(_) => return false,
    };
    match client
        .send(
            engine,
            body,
            Duration::from_secs(AI_ENGINE_HEALTH_PROBE_TIMEOUT_SECS),
        )
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

/// Runs a round every `AI_ENGINE_HEALTH_INTERVAL_SECS` in whichever process
/// claims it first.
pub async fn health_worker(env: Arc<Env>) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("ai_engine_health_worker");
        if let Err(error) = claimed_round(&env).await {
            log::warn!(target: LOG_TARGET, "health round failed: {error:?}");
        }
        tokio::time::sleep(Duration::from_secs(AI_ENGINE_HEALTH_INTERVAL_SECS))
            .await;
    }
}

async fn claimed_round(env: &Env) -> anyhow::Result<()> {
    let mut redis = env.redis.clone();
    let key = format!("{AI_ENGINE_HEALTH_REDIS_PREFIX}round");
    if !claim(&mut redis, key, AI_ENGINE_HEALTH_INTERVAL_SECS - 5)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    let client = env.ai_engine_client.without_health();
    let client = &client;
    run_round(
        env,
        |engine| async move { probe_engine(client, &engine).await },
    )
    .await
}

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
