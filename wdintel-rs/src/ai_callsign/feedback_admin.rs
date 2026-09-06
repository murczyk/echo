use super::feedback::sql;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_admin, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{ConnectionTrait, FromQueryResult, TransactionTrait};
use uuid::Uuid;

#[derive(
    Debug,
    Clone,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackListReq {
    pub search: String,
    pub after: String,
}

#[derive(
    Debug,
    Clone,
    FromQueryResult,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackItem {
    pub callsign: String,
    pub removal_count: i64,
    pub updated_at: i64,
}

#[derive(
    Debug,
    Clone,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDetailsReq {
    pub callsign: String,
    pub before_id: Option<i64>,
}

#[derive(
    Debug,
    Clone,
    FromQueryResult,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDetail {
    pub id: i64,
    pub inbox_item_id: Option<i64>,
    pub actor: Option<String>,
    pub body: String,
    pub created_at: i64,
}

#[derive(
    Debug,
    Clone,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
pub struct ReparseStartReq {
    pub days: i64,
}

#[derive(
    Debug,
    Clone,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
pub struct ReparseIdReq {
    pub id: String,
}

#[derive(
    Debug,
    Clone,
    FromQueryResult,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct ReparseStatus {
    pub id: String,
    pub state: String,
    pub automatic: bool,
    pub since_ts: i64,
    pub until_ts: i64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub total: i64,
    pub changed: i64,
    pub unchanged: i64,
    pub skipped: i64,
    pub failed: i64,
}

#[derive(
    Debug,
    Clone,
    FromQueryResult,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct ReparseFailure {
    pub inbox_item_id: i64,
    pub attempts: i32,
    pub last_error: Option<String>,
}

#[post("/api/admin/ai-callsigns/feedback/list")]
pub async fn list(
    env: Data<Env>,
    user: Identity,
    req: Json<FeedbackListReq>,
) -> Result<Json<Vec<FeedbackItem>>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let search = req.search.trim().to_lowercase();
    let search = search
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
        + "%";
    Ok(Json(FeedbackItem::find_by_statement(sql("select callsign, removal_count, (extract(epoch from updated_at) * 1000)::bigint as updated_at from ai_callsign_feedback_summary where callsign > $1 and callsign like $2 order by callsign limit $3", vec![req.after.clone().into(), search.into(), crate::config::AI_CALLSIGN_FEEDBACK_PAGE_SIZE.into()])).all(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-callsigns/feedback/details")]
pub async fn details(
    env: Data<Env>,
    user: Identity,
    req: Json<FeedbackDetailsReq>,
) -> Result<Json<Vec<FeedbackDetail>>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(FeedbackDetail::find_by_statement(sql("select f.id, f.inbox_item_id, l.login as actor, f.body, (extract(epoch from f.created_at) * 1000)::bigint as created_at from ai_callsign_feedback f left join login l on l.id = f.actor_id where f.callsign = $1 and f.id < $2 order by f.id desc limit $3", vec![req.callsign.trim().to_lowercase().into(), req.before_id.unwrap_or(i64::MAX).into(), crate::config::AI_CALLSIGN_FEEDBACK_PAGE_SIZE.into()])).all(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-callsigns/reparse/start")]
pub async fn start(
    env: Data<Env>,
    user: Identity,
    req: Json<ReparseStartReq>,
) -> Result<Json<ReparseIdReq>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    super::worker::load_worker_config(&env.dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "Спочатку увімкніть ШІ-воркер позивних".into(),
        })
        .c(h!())?;
    let id = super::reparse::start(
        &env.dbx,
        Some(login_id_from_identity(&user).c(h!())?),
        req.days,
    )
    .await
    .c(h!())?;
    Ok(Json(ReparseIdReq { id: id.to_string() }))
}

#[post("/api/admin/ai-callsigns/reparse/status")]
pub async fn status(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<Vec<ReparseStatus>>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(ReparseStatus::find_by_statement(sql("select id::text, state, automatic, (extract(epoch from since_ts) * 1000)::bigint as since_ts, (extract(epoch from until_ts) * 1000)::bigint as until_ts, (extract(epoch from created_at) * 1000)::bigint as created_at, (extract(epoch from completed_at) * 1000)::bigint as completed_at, total, changed, unchanged, skipped, failed from ai_callsign_reparse_run order by created_at desc limit $1", vec![crate::config::AI_CALLSIGN_FEEDBACK_PAGE_SIZE.into()])).all(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-callsigns/reparse/failures")]
pub async fn failures(
    env: Data<Env>,
    user: Identity,
    req: Json<ReparseIdReq>,
) -> Result<Json<Vec<ReparseFailure>>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = Uuid::parse_str(&req.id).c(h!())?;
    Ok(Json(ReparseFailure::find_by_statement(sql("select inbox_item_id, attempts, last_error from ai_callsign_reparse_job where run_id = $1 and state = 'failed' order by inbox_item_id limit $2", vec![id.into(), crate::config::AI_CALLSIGN_FEEDBACK_PAGE_SIZE.into()])).all(&env.dbx).await.c(h!())?))
}

#[post("/api/admin/ai-callsigns/reparse/cancel")]
pub async fn cancel(
    env: Data<Env>,
    user: Identity,
    req: Json<ReparseIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = Uuid::parse_str(&req.id).c(h!())?;
    env.dbx.execute_raw(sql("update ai_callsign_reparse_run set state = 'cancelled', completed_at = now() at time zone 'utc' where id = $1 and state in ('enumerating', 'running')", vec![id.into()])).await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/admin/ai-callsigns/reparse/retry")]
pub async fn retry(
    env: Data<Env>,
    user: Identity,
    req: Json<ReparseIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = Uuid::parse_str(&req.id).c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    transaction
        .execute_raw(sql(
            "select pg_advisory_xact_lock($1)",
            vec![(crate::config::AI_CALLSIGN_WORKER_LOCK + 1).into()],
        ))
        .await
        .c(h!())?;
    transaction.execute_raw(sql("update ai_callsign_reparse_run set state = case when state = 'cancelled' then 'enumerating' else 'running' end, failed = 0, cleanup_complete = false, completed_at = null where id = $1 and state in ('failed', 'cancelled')", vec![id.into()])).await.c(h!())?;
    transaction.execute_raw(sql("update ai_callsign_reparse_job set state = 'pending', attempts = 0, last_error = null, next_attempt_at = now() at time zone 'utc' where run_id = $1 and state = 'failed'", vec![id.into()])).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(()))
}
