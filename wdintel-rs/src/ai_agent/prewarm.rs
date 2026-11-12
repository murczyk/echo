//! Starts a user's agent container while they compose a message, so the
//! request that follows finds it running (#4139). Prewarming only uses spare
//! capacity, never waits for another lifecycle operation, and never surfaces
//! errors to the user.

use super::access;
use super::dispatcher::DispatcherClient;
use super::lifecycle;
use super::types::AiAgentPrewarmReq;
use crate::config::{
    AI_AGENT_IDLE_STOP_MINUTES, AI_AGENT_MAX_RUNNING_CONTAINERS,
    AI_AGENT_PREWARM_REDIS_PREFIX, AI_AGENT_PREWARM_RESERVED_SLOTS,
    AI_AGENT_PREWARM_THROTTLE_SEC, AI_AGENT_PREWARM_UNUSED_MINUTES,
};
use crate::entities::{ai_agent_container, ai_agent_user_link, ai_engine};
use crate::error::AppError;
use crate::h;
use crate::types::{info, warn, Context, Env, ShortContext};
use actix_identity::Identity;
use actix_web::{post, web::Json};
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    DatabaseTransaction, EntityTrait, IntoActiveModel, PaginatorTrait,
    QueryFilter, TransactionTrait,
};
use serde_json::json;
use std::time::Instant;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrewarmOutcome {
    Started,
    KeptAlive,
    LifecycleBusy,
    ActiveRequest,
    NoCapacity,
    /// The dispatcher cannot keep the reserve atomically; prewarming could
    /// take slots that real requests need.
    NoAtomicReserve,
}

#[post("/api/ai-agent/prewarm")]
pub async fn prewarm(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentPrewarmReq>,
) -> Result<Json<()>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, true)
        .await
        .context(h!())?;
    let requested = req
        .ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()
        .context(h!())?;
    let ai_engine = access::allowed_engine(&env.dbx, requested)
        .await
        .context(h!())?;
    if !claim_prewarm(&env, human.id).await.context(h!())? {
        return Ok(Json(()));
    }
    let env = env.into_inner();
    actix_web::rt::spawn(async move {
        let started = Instant::now();
        match prewarm_for_user(&env, human.id, &ai_engine).await {
            Ok(outcome) => info!(
                "AI agent prewarm human_login_id={} outcome={outcome:?} duration_ms={}",
                human.id,
                started.elapsed().as_millis()
            ),
            Err(err) => warn!(
                "AI agent prewarm failed human_login_id={}: {err:#}",
                human.id
            ),
        }
    });
    Ok(Json(()))
}

/// At most one prewarm per user per throttle window, across all Echo workers.
async fn claim_prewarm(
    env: &Env,
    human_login_id: Uuid,
) -> Result<bool, AppError> {
    let mut redis = env.redis.clone();
    let claimed: Option<String> = redis::cmd("SET")
        .arg(format!("{AI_AGENT_PREWARM_REDIS_PREFIX}{human_login_id}"))
        .arg(1)
        .arg("NX")
        .arg("EX")
        .arg(AI_AGENT_PREWARM_THROTTLE_SEC)
        .query_async(&mut redis)
        .await
        .c(h!())?;
    Ok(claimed.is_some())
}

async fn prewarm_for_user(
    env: &Env,
    human_login_id: Uuid,
    ai_engine: &ai_engine::Model,
) -> Result<PrewarmOutcome, AppError> {
    crate::ai_agent::ensure_valid_human_target(&env.dbx, human_login_id)
        .await
        .context(h!())?;
    let lifecycle_lock = env.dbx.begin().await.c(h!())?;
    if !lifecycle::try_lock_user_lifecycle(&lifecycle_lock, human_login_id)
        .await
        .context(h!())?
    {
        lifecycle_lock.commit().await.c(h!())?;
        return Ok(PrewarmOutcome::LifecycleBusy);
    }
    let outcome =
        prewarm_locked(env, &lifecycle_lock, human_login_id, ai_engine).await;
    lifecycle_lock.commit().await.c(h!())?;
    outcome
}

async fn prewarm_locked(
    env: &Env,
    lifecycle_lock: &DatabaseTransaction,
    human_login_id: Uuid,
    ai_engine: &ai_engine::Model,
) -> Result<PrewarmOutcome, AppError> {
    if lifecycle::has_active_request(lifecycle_lock, human_login_id)
        .await
        .context(h!())?
    {
        return Ok(PrewarmOutcome::ActiveRequest);
    }
    let now = Utc::now().naive_utc();
    if let Some(container) = running_container(&env.dbx, human_login_id)
        .await
        .context(h!())?
    {
        let activity = kept_alive_activity(container.last_activity_at, now);
        set_last_activity(&env.dbx, container, activity)
            .await
            .context(h!())?;
        return Ok(PrewarmOutcome::KeptAlive);
    }
    match prewarm_capacity(env).await.context(h!())? {
        PrewarmCapacity::Available => {}
        PrewarmCapacity::Full => return Ok(PrewarmOutcome::NoCapacity),
        PrewarmCapacity::NoAtomicReserve => {
            return Ok(PrewarmOutcome::NoAtomicReserve)
        }
    }
    let linked = match lifecycle::start_for_user_locked(
        env,
        human_login_id,
        Some(ai_engine),
        AI_AGENT_PREWARM_RESERVED_SLOTS,
    )
    .await
    {
        Ok(linked) => linked,
        Err(err) if lifecycle::is_capacity_refusal(&err) => {
            return Ok(PrewarmOutcome::NoCapacity)
        }
        Err(err) => return Err(err).context(h!())?,
    };
    set_last_activity(&env.dbx, linked.container, unused_prewarm_activity(now))
        .await
        .context(h!())?;
    Ok(PrewarmOutcome::Started)
}

async fn running_container(
    dbx: &DatabaseConnection,
    human_login_id: Uuid,
) -> Result<Option<ai_agent_container::Model>, AppError> {
    let Some(link) = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human_login_id))
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    Ok(ai_agent_container::Entity::find_by_id(link.id)
        .filter(ai_agent_container::Column::State.eq("running"))
        .one(dbx)
        .await
        .c(h!())?)
}

async fn set_last_activity(
    dbx: &DatabaseConnection,
    container: ai_agent_container::Model,
    last_activity_at: NaiveDateTime,
) -> Result<(), AppError> {
    let mut container = container.into_active_model();
    container.last_activity_at = Set(Some(last_activity_at));
    container.updated_at = Set(Utc::now().naive_utc());
    container.update(dbx).await.c(h!())?;
    Ok(())
}

/// The idle stop runs `AI_AGENT_IDLE_STOP_MINUTES` after the last activity;
/// a prewarmed container that no request uses stops after
/// `AI_AGENT_PREWARM_UNUSED_MINUTES` instead.
fn unused_prewarm_activity(now: NaiveDateTime) -> NaiveDateTime {
    now - chrono::Duration::minutes(
        AI_AGENT_IDLE_STOP_MINUTES - AI_AGENT_PREWARM_UNUSED_MINUTES,
    )
}

/// Typing keeps a running container for at least the prewarm window, but
/// never shortens the longer window a finished request earned.
fn kept_alive_activity(
    last_activity_at: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> NaiveDateTime {
    let typing = unused_prewarm_activity(now);
    last_activity_at.map_or(typing, |last| last.max(typing))
}

enum PrewarmCapacity {
    Available,
    Full,
    NoAtomicReserve,
}

/// An advisory early exit; the dispatcher enforces the reserve atomically
/// when the start happens.
async fn prewarm_capacity(env: &Env) -> Result<PrewarmCapacity, AppError> {
    let echo_running = ai_agent_container::Entity::find()
        .filter(
            ai_agent_container::Column::State.is_in(["starting", "running"]),
        )
        .count(&env.dbx)
        .await
        .c(h!())?;
    if !leaves_reserved_slots(echo_running, AI_AGENT_MAX_RUNNING_CONTAINERS) {
        return Ok(PrewarmCapacity::Full);
    }
    let host = host_capacity(env).await.context(h!())?;
    Ok(if !host.atomic_reserve {
        PrewarmCapacity::NoAtomicReserve
    } else if leaves_reserved_slots(host.running, host.max_running) {
        PrewarmCapacity::Available
    } else {
        PrewarmCapacity::Full
    })
}

/// Starting one more container must still leave the reserved slots free for
/// real requests, which fail instead of waiting when capacity runs out.
fn leaves_reserved_slots(running: u64, max_running: u64) -> bool {
    running + 1 + AI_AGENT_PREWARM_RESERVED_SLOTS <= max_running
}

struct HostCapacity {
    running: u64,
    max_running: u64,
    atomic_reserve: bool,
}

/// Running containers across every Echo namespace on the shared agent host.
async fn host_capacity(env: &Env) -> Result<HostCapacity, AppError> {
    let settings = access::settings(&env.dbx).await.context(h!())?;
    let template_login_id =
        access::template_login_id(&settings).context(h!())?;
    let dispatcher = DispatcherClient::from_env(env).await.context(h!())?;
    let preflight = dispatcher
        .call(
            "preflight",
            None,
            json!({ "template_id": template_login_id }),
        )
        .await
        .context(h!())?;
    let count = |field: &str| {
        preflight.result.get(field).and_then(|value| value.as_u64())
    };
    let (Some(running), Some(max_running)) =
        (count("running"), count("max_running"))
    else {
        return Err(AppError::BL {
            msg: "AI agent dispatcher did not report its capacity".to_string(),
        });
    };
    let atomic_reserve = preflight
        .result
        .get("start_reserved_slots")
        .and_then(|value| value.as_bool())
        == Some(true);
    Ok(HostCapacity {
        running,
        max_running,
        atomic_reserve,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minute: u32) -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 11, 11)
            .unwrap()
            .and_hms_opt(12, minute, 0)
            .unwrap()
    }

    #[test]
    fn prewarm_leaves_two_slots_for_real_requests() {
        assert!(leaves_reserved_slots(0, 6));
        assert!(leaves_reserved_slots(3, 6));
        assert!(!leaves_reserved_slots(4, 6));
        assert!(!leaves_reserved_slots(6, 6));
    }

    #[test]
    fn unused_prewarm_stops_three_minutes_after_start() {
        let stops_at = unused_prewarm_activity(at(30))
            + chrono::Duration::minutes(AI_AGENT_IDLE_STOP_MINUTES);
        assert_eq!(stops_at, at(33));
    }

    #[test]
    fn typing_extends_but_never_shortens_the_idle_window() {
        assert_eq!(kept_alive_activity(None, at(30)), at(28));
        assert_eq!(kept_alive_activity(Some(at(10)), at(30)), at(28));
        assert_eq!(kept_alive_activity(Some(at(29)), at(30)), at(29));
    }
}
