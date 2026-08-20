use crate::config::{DEVICE_MATTERMOST_TIMEOUT_SEC, DEVICE_SETTINGS_ID};
use crate::entities::device_settings;
use crate::error::AppError;
use crate::h;
use crate::mattermost;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::Utc;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, EntityTrait,
    IntoActiveModel, QuerySelect, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Default,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceSettingsReq {
    pub mattermost_webhook_url: Option<String>,
    pub clear_mattermost_webhook: bool,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceSettingsItem {
    pub has_mattermost_webhook: bool,
}

#[post("/api/admin/device/settings")]
pub async fn update(
    env: actix_web::web::Data<Env>,
    user: Identity,
    Json(req): Json<DeviceSettingsReq>,
) -> Result<Json<DeviceSettingsItem>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user)
        .await
        .context(h!())?;

    let replacement = req
        .mattermost_webhook_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if req.clear_mattermost_webhook && replacement.is_some() {
        return Err(AppError::BL {
            msg: "Mattermost webhook cannot be replaced and cleared in the same request"
                .to_string(),
        });
    }
    if let Some(webhook) = replacement {
        mattermost::resolve_webhook(
            webhook,
            Duration::from_secs(DEVICE_MATTERMOST_TIMEOUT_SEC),
        )
        .await
        .context(h!())?;
    }
    if !req.clear_mattermost_webhook && replacement.is_none() {
        return Ok(Json(settings_item(&env.dbx).await.context(h!())?));
    }

    let txn = env.dbx.begin().await.c(h!())?;
    let settings = device_settings::Entity::find_by_id(DEVICE_SETTINGS_ID)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let mut settings = settings.into_active_model();
    settings.mattermost_webhook_url = Set(replacement.map(str::to_string));
    settings.updated_at = Set(Utc::now().naive_utc());
    let settings = settings.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;

    Ok(Json(DeviceSettingsItem {
        has_mattermost_webhook: settings.mattermost_webhook_url.is_some(),
    }))
}

pub(crate) async fn mattermost_webhook_url(
    dbx: &DatabaseConnection,
) -> Result<Option<String>, AppError> {
    Ok(load_settings(dbx)
        .await
        .context(h!())?
        .mattermost_webhook_url)
}

async fn settings_item(
    dbx: &DatabaseConnection,
) -> Result<DeviceSettingsItem, AppError> {
    Ok(DeviceSettingsItem {
        has_mattermost_webhook: mattermost_webhook_url(dbx)
            .await
            .context(h!())?
            .is_some(),
    })
}

async fn load_settings(
    dbx: &DatabaseConnection,
) -> Result<device_settings::Model, AppError> {
    device_settings::Entity::find_by_id(DEVICE_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}
