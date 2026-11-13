//! Historical message replay for training instances: an admin picks a past
//! window, and its messages are pushed through the regular ingest pipeline
//! with the original pacing, shifted to look recent. At the window end it
//! loops or pauses at the window start. Stopping hard-deletes every
//! replayed message.

pub mod body;
pub mod clock;
pub mod emit;
pub mod purge;
pub mod session;
pub mod source;
pub mod types;
pub mod worker;

use crate::config::MESSAGE_REPLAY_MAX_RANGE_DAYS;
use crate::error::AppError;
use crate::h;
use crate::message_replay::clock::{resolve_plan, ReplayPlan};
use crate::message_replay::session::{now_utc, to_ms};
use crate::message_replay::types::{
    MessageReplayActivityPoint, MessageReplayActivityReq,
    MessageReplayActivityRsp, MessageReplayExtentRsp, MessageReplayPlanReq,
    MessageReplayPreviewRsp, MessageReplaySpeedReq, MessageReplayStatusRsp,
};
use crate::types::{Env, ShortContext};
use crate::users::{ensure_admin, login_id_from_identity};
use crate::utils::dt_from_millis;
use actix_identity::Identity;
use actix_web::{post, web::Data, web::Json};
use chrono::NaiveDateTime;
use sea_orm::{DatabaseTransaction, SqlErr, TransactionTrait};

#[post("/api/admin/message-replay/activity")]
pub async fn activity(
    user: Identity,
    env: Data<Env>,
    req: Json<MessageReplayActivityReq>,
) -> Result<Json<MessageReplayActivityRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let (from, to) =
        parse_window(req.from_ms, req.to_ms, req.bucket.max_range_days())
            .c(h!())?;
    let points = source::activity(&env.dbx, from, to, &req.bucket)
        .await
        .c(h!())?
        .into_iter()
        .map(|(bucket, count)| MessageReplayActivityPoint {
            ts_ms: to_ms(bucket),
            count,
        })
        .collect();
    Ok(Json(MessageReplayActivityRsp {
        bucket_sec: req.bucket.seconds(),
        points,
    }))
}

#[post("/api/admin/message-replay/extent")]
pub async fn extent(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<MessageReplayExtentRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let (first, last) = source::extent(&env.dbx).await.c(h!())?;
    Ok(Json(MessageReplayExtentRsp {
        first_ms: first.map(to_ms),
        last_ms: last.map(to_ms),
    }))
}

#[post("/api/admin/message-replay/preview")]
pub async fn preview(
    user: Identity,
    env: Data<Env>,
    req: Json<MessageReplayPlanReq>,
) -> Result<Json<MessageReplayPreviewRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let now = now_utc();
    let plan = plan_from_req(&req, now).c(h!())?;
    let counts = source::count_window(
        &env.dbx,
        plan.window_from,
        plan.window_to,
        plan.first_replayed_ts(),
    )
    .await
    .c(h!())?;
    let clock = plan.clock(now);
    let first = counts.first_replayed_ts;
    Ok(Json(MessageReplayPreviewRsp {
        window_count: counts.window_count,
        skipped_count: counts.skipped_count,
        replay_count: counts.window_count - counts.skipped_count,
        offset_ms: clock.offset(now).num_milliseconds(),
        start_position_ms: to_ms(plan.start_position),
        first_message_ms: first.map(to_ms),
        first_message_eta_ms: first.map(|ts| clock.eta_ms(ts, now)),
        first_message_shown_ms: first.map(|ts| to_ms(clock.shown_at(ts))),
        cycle_end_eta_ms: clock.eta_ms(plan.window_to, now),
    }))
}

#[post("/api/admin/message-replay/start")]
pub async fn start(
    user: Identity,
    env: Data<Env>,
    req: Json<MessageReplayPlanReq>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = login_id_from_identity(&user).c(h!())?;
    let now = now_utc();
    let plan = plan_from_req(&req, now).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    if session::lock_for_update(&txn).await.c(h!())?.is_some() {
        return Err(session_exists_error());
    }
    let counts = source::count_window(
        &txn,
        plan.window_from,
        plan.window_to,
        plan.first_replayed_ts(),
    )
    .await
    .c(h!())?;
    let cycle_source_count = counts.window_count - counts.skipped_count;
    insert_session(&txn, login_id, &plan, &req, cycle_source_count, now)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/message-replay/pause")]
pub async fn pause(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let replay_session = lock_session(&txn).await.c(h!())?;
    session::pause(&txn, replay_session, now_utc())
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/message-replay/resume")]
pub async fn resume(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let replay_session = lock_session(&txn).await.c(h!())?;
    session::resume(&txn, replay_session, now_utc())
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

/// Changes the speed of a running or paused replay from its current
/// position on.
#[post("/api/admin/message-replay/speed")]
pub async fn speed(
    user: Identity,
    env: Data<Env>,
    req: Json<MessageReplaySpeedReq>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let replay_session = lock_session(&txn).await.c(h!())?;
    session::set_speed(&txn, replay_session, &req.speed, now_utc())
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/message-replay/stop")]
pub async fn stop(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let replay_session = lock_session(&txn).await.c(h!())?;
    session::stop(&txn, replay_session, now_utc())
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/message-replay/status")]
pub async fn status(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<MessageReplayStatusRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(session::status(&env.dbx).await.c(h!())?))
}

fn plan_from_req(
    req: &MessageReplayPlanReq,
    now: NaiveDateTime,
) -> anyhow::Result<ReplayPlan> {
    let (from, to) =
        parse_window(req.from_ms, req.to_ms, MESSAGE_REPLAY_MAX_RANGE_DAYS)
            .c(h!())?;
    resolve_plan(
        from,
        to,
        &req.shift_mode,
        req.manual_shift_ms,
        &req.speed,
        now,
    )
}

/// Shared by the activity range and the replay window.
fn parse_window(
    from_ms: i64,
    to_ms: i64,
    max_days: i64,
) -> anyhow::Result<(NaiveDateTime, NaiveDateTime)> {
    let from = dt_from_millis(from_ms).c(h!())?;
    let to = dt_from_millis(to_ms).c(h!())?;
    if from >= to {
        return Err(AppError::BL {
            msg: "Початок вікна має бути раніше за його кінець".to_string(),
        })
        .c(h!());
    }
    if to - from > chrono::Duration::days(max_days) {
        return Err(AppError::BL {
            msg: format!("Період не може перевищувати {max_days} днів"),
        })
        .c(h!());
    }
    Ok((from, to))
}

async fn lock_session(
    txn: &DatabaseTransaction,
) -> anyhow::Result<crate::entities::message_replay_session::Model> {
    session::lock_for_update(txn)
        .await
        .c(h!())?
        .ok_or(AppError::BL {
            msg: "Відтворення не запущене".to_string(),
        })
        .c(h!())
}

/// The singleton index also rejects a session started concurrently.
async fn insert_session(
    txn: &DatabaseTransaction,
    login_id: uuid::Uuid,
    plan: &ReplayPlan,
    req: &MessageReplayPlanReq,
    cycle_source_count: i64,
    now: NaiveDateTime,
) -> anyhow::Result<()> {
    match session::insert_running(
        txn,
        login_id,
        plan,
        &req.on_end,
        cycle_source_count,
        now,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(e)
            if matches!(
                e.sql_err(),
                Some(SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            Err(session_exists_error()).c(h!())
        }
        Err(e) => Err(e).c(h!())?,
    }
}

fn session_exists_error() -> AppError {
    AppError::BL {
        msg: "Відтворення вже запущене. Зупиніть його перед новим запуском"
            .to_string(),
    }
}
