mod bl;
pub(in crate::devices) mod query;
mod rules;
#[cfg(test)]
mod tests;
pub mod types;
pub(crate) mod worker;

use self::types::{
    AdminAnalyticsTag, AnalyticsTagIdReq, CreateAnalyticsTagReq,
    DeviceAnalyticsFilesReq, DeviceAnalyticsFilesRsp, DeviceAnalyticsReq,
    DeviceAnalyticsSummaryRsp, DeviceAnalyticsTagsRsp,
    ListAnalyticsTagTestFilesRsp, ListAnalyticsTagsRsp, ReanalysisRsp,
    ReanalyzeDeviceReq, RuleTestFile, TestAnalyticsTagRuleRsp,
    UpdateAnalyticsTagReq,
};
use crate::devices::access;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use serde::Deserialize;

pub(in crate::devices) use bl::{
    hydrate_active_tags, load_active_tag_memberships, matches_tag_filter,
    normalize_tag_filter,
};
pub(in crate::devices) use types::AnalyticsTag;

#[post("/api/admin/device-analytics/tags/list")]
pub(crate) async fn list_tags(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<ListAnalyticsTagsRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(ListAnalyticsTagsRsp {
        tags: bl::list_admin_tags(&env.dbx).await.c(h!())?,
    }))
}

#[post("/api/admin/device-analytics/tags/create")]
pub(crate) async fn create_tag(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<CreateAnalyticsTagReq>,
) -> Result<Json<AdminAnalyticsTag>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(bl::create_tag(&env.dbx, body.name).await.c(h!())?))
}

#[post("/api/admin/device-analytics/tags/update")]
pub(crate) async fn update_tag(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<UpdateAnalyticsTagReq>,
) -> Result<Json<AdminAnalyticsTag>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(
        bl::update_tag(&env.dbx, tag_id, body.name).await.c(h!())?,
    ))
}

#[post("/api/admin/device-analytics/tags/archive")]
pub(crate) async fn archive_tag(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<AnalyticsTagIdReq>,
) -> Result<Json<AdminAnalyticsTag>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(bl::archive_tag(&env.dbx, tag_id).await.c(h!())?))
}

#[post("/api/admin/device-analytics/tags/restore")]
pub(crate) async fn restore_tag(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<AnalyticsTagIdReq>,
) -> Result<Json<AdminAnalyticsTag>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(bl::restore_tag(&env.dbx, tag_id).await.c(h!())?))
}

#[post("/api/admin/device-analytics/tags/rule/save")]
pub(crate) async fn save_tag_rule(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<AdminAnalyticsTag>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let body = parse_save_rule_request(body)?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(
        bl::save_rule(&env.dbx, tag_id, nullable_json(body.rule_expression))
            .await
            .c(h!())?,
    ))
}

#[post("/api/admin/device-analytics/tags/rule/test-files/list")]
pub(crate) async fn list_tag_test_files(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<AnalyticsTagIdReq>,
) -> Result<Json<ListAnalyticsTagTestFilesRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(ListAnalyticsTagTestFilesRsp {
        files: bl::list_tag_test_files(&env.dbx, tag_id).await.c(h!())?,
    }))
}

#[post("/api/admin/device-analytics/tags/rule/test")]
pub(crate) async fn test_tag_rule(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<TestAnalyticsTagRuleRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let body = parse_test_rule_request(body)?;
    let tag_id = bl::parse_canonical_uuid(&body.id, "id")?;
    Ok(Json(
        bl::test_rule(
            &env.dbx,
            tag_id,
            nullable_json(body.rule_expression),
            body.files,
        )
        .await
        .c(h!())?,
    ))
}

#[post("/api/admin/device-analytics/reanalyze/all")]
pub(crate) async fn reanalyze_all(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<ReanalysisRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(ReanalysisRsp {
        scheduled_file_count: bl::schedule_all_reanalysis(
            env.file_registry_db()?,
        )
        .await
        .c(h!())?,
    }))
}

#[post("/api/admin/device-analytics/reanalyze/device")]
pub(crate) async fn reanalyze_device(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<ReanalyzeDeviceReq>,
) -> Result<Json<ReanalysisRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device_id = bl::parse_canonical_uuid(&body.device_id, "device_id")?;
    Ok(Json(ReanalysisRsp {
        scheduled_file_count: bl::schedule_device_reanalysis(
            &env.dbx,
            env.file_registry_db()?,
            &login,
            device_id,
        )
        .await
        .c(h!())?,
    }))
}

#[post("/api/device/analytics/tags")]
pub(crate) async fn device_tags(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceAnalyticsReq>,
) -> Result<Json<DeviceAnalyticsTagsRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device_id = bl::parse_canonical_uuid(&body.device_id, "device_id")?;
    Ok(Json(DeviceAnalyticsTagsRsp {
        tags: bl::list_public_tags(&env.dbx, &login, device_id)
            .await
            .c(h!())?,
    }))
}

#[post("/api/device/analytics/summary")]
pub(crate) async fn device_summary(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceAnalyticsReq>,
) -> Result<Json<DeviceAnalyticsSummaryRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device_id = bl::parse_canonical_uuid(&body.device_id, "device_id")?;
    Ok(Json(DeviceAnalyticsSummaryRsp {
        items: bl::device_summary(&env.dbx, &login, device_id)
            .await
            .c(h!())?,
    }))
}

#[post("/api/device/analytics/files")]
pub(crate) async fn device_files(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceAnalyticsFilesReq>,
) -> Result<Json<DeviceAnalyticsFilesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device_id = bl::parse_canonical_uuid(&body.device_id, "device_id")?;
    let tag_id = bl::parse_canonical_uuid(&body.tag_id, "tag_id")?;
    Ok(Json(
        bl::device_files(
            &env.dbx,
            env.file_registry_db()?,
            &login,
            device_id,
            tag_id,
            body.limit,
            body.cursor,
        )
        .await
        .c(h!())?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSaveRuleRequest {
    id: String,
    rule_expression: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTestRuleRequest {
    id: String,
    rule_expression: serde_json::Value,
    files: Vec<RuleTestFile>,
}

fn parse_save_rule_request(
    body: serde_json::Value,
) -> Result<RawSaveRuleRequest, AppError> {
    serde_json::from_value(body).map_err(|_| invalid_request_error())
}

fn parse_test_rule_request(
    body: serde_json::Value,
) -> Result<RawTestRuleRequest, AppError> {
    serde_json::from_value(body).map_err(|_| invalid_request_error())
}

fn nullable_json(value: serde_json::Value) -> Option<serde_json::Value> {
    if value.is_null() {
        None
    } else {
        Some(value)
    }
}

fn invalid_request_error() -> AppError {
    AppError::BadRequestJson {
        body: serde_json::json!({
            "path": "request",
            "code": "invalid_request",
            "message": "Запит має некоректний формат"
        }),
    }
}
