use super::types::{
    AiGovUaModelsRsp, AiGovUaSettingsRsp, SaveAiGovUaSettingsReq,
};
use crate::config::{
    AI_GOV_UA_SCOPE_MAX_CHARS, AI_GOV_UA_SECRET_AAD, AI_GOV_UA_SETTINGS_ID,
};
use crate::entities::ai_gov_ua_settings;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web};
use base64::Engine;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, EntityTrait,
    IntoActiveModel, QuerySelect, TransactionTrait,
};
use strong_box::{StaticStrongBox, StrongBox};
use uuid::Uuid;

pub(super) async fn load(
    dbx: &DatabaseConnection,
) -> anyhow::Result<ai_gov_ua_settings::Model> {
    ai_gov_ua_settings::Entity::find_by_id(AI_GOV_UA_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("Government AI settings are missing"))
        .c(h!())
}

#[post("/api/admin/ai-engines/gov/settings")]
pub async fn get_settings(
    env: web::Data<Env>,
    user: Identity,
) -> Result<web::Json<AiGovUaSettingsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(settings_response(load(&env.dbx).await.c(h!())?)))
}

#[post("/api/admin/ai-engines/gov/save")]
pub async fn save_settings(
    env: web::Data<Env>,
    user: Identity,
    req: web::Json<SaveAiGovUaSettingsReq>,
) -> Result<web::Json<AiGovUaSettingsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = save(
        &env.dbx,
        env.config.totp_strongbox_key.as_deref(),
        req.into_inner(),
    )
    .await
    .c(h!())?;
    Ok(web::Json(settings_response(settings)))
}

#[post("/api/admin/ai-engines/gov/models")]
pub async fn list_models(
    env: web::Data<Env>,
    user: Identity,
) -> Result<web::Json<AiGovUaModelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(web::Json(AiGovUaModelsRsp {
        models: env.ai_engine_client.government_models().await.c(h!())?,
    }))
}

pub(super) async fn save(
    dbx: &DatabaseConnection,
    key: Option<&str>,
    req: SaveAiGovUaSettingsReq,
) -> anyhow::Result<ai_gov_ua_settings::Model> {
    validate(&req).c(h!())?;
    let transaction = dbx.begin().await.c(h!())?;
    let settings =
        ai_gov_ua_settings::Entity::find_by_id(AI_GOV_UA_SETTINGS_ID)
            .lock_exclusive()
            .one(&transaction)
            .await
            .c(h!())?
            .c(h!())?;
    let secret = match req
        .client_secret
        .as_deref()
        .filter(|secret| !secret.is_empty())
    {
        Some(secret) => Some(encrypt_secret(key, secret).c(h!())?),
        None if req.clear_client_secret => None,
        None => settings.client_secret_encrypted.clone(),
    };
    anyhow::ensure!(
        !req.enabled || secret.is_some(),
        "Вкажіть секрет застосунку Azure"
    );
    let mut settings = settings.into_active_model();
    settings.enabled = Set(Some(req.enabled));
    settings.tenant_id = Set(Some(req.tenant_id.trim().to_string()));
    settings.client_id = Set(Some(req.client_id.trim().to_string()));
    settings.scope = Set(Some(req.scope.trim().to_string()));
    settings.client_secret_encrypted = Set(secret);
    settings.updated_at = Set(Utc::now().naive_utc());
    let settings = settings.update(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(settings)
}

fn validate(req: &SaveAiGovUaSettingsReq) -> anyhow::Result<()> {
    for (name, value) in
        [("Tenant ID", &req.tenant_id), ("Client ID", &req.client_id)]
    {
        anyhow::ensure!(
            (!req.enabled && value.trim().is_empty())
                || Uuid::parse_str(value.trim()).is_ok(),
            "Некоректний {name}"
        );
    }
    let scope = req.scope.trim();
    anyhow::ensure!(
        (!req.enabled && scope.is_empty())
            || (scope.len() <= AI_GOV_UA_SCOPE_MAX_CHARS
                && scope.ends_with("/.default")
                && !scope.chars().any(char::is_whitespace)),
        "Вкажіть scope API з суфіксом /.default"
    );
    anyhow::ensure!(
        !req.clear_client_secret
            || req.client_secret.as_deref().is_none_or(str::is_empty),
        "Не можна одночасно замінити й видалити секрет"
    );
    anyhow::ensure!(
        req.client_secret
            .as_ref()
            .is_none_or(|secret| secret.len()
                <= crate::config::AI_ENGINE_TOKEN_MAX_CHARS),
        "Секрет застосунку надто довгий"
    );
    Ok(())
}

pub(super) fn settings_response(
    settings: ai_gov_ua_settings::Model,
) -> AiGovUaSettingsRsp {
    AiGovUaSettingsRsp {
        enabled: settings.enabled.unwrap_or(false),
        tenant_id: settings.tenant_id.unwrap_or_default(),
        client_id: settings.client_id.unwrap_or_default(),
        scope: settings.scope.unwrap_or_default(),
        has_client_secret: settings.client_secret_encrypted.is_some(),
        updated_at: settings.updated_at.and_utc().timestamp_millis(),
    }
}

fn strongbox(key: Option<&str>) -> anyhow::Result<StaticStrongBox> {
    let key = key.ok_or_else(|| anyhow::anyhow!("Збереження секрету ШІ недоступне: ключ шифрування сервера відсутній")).c(h!())?;
    let key = crate::storage::key_from_b64(key).c(h!())?;
    Ok(StaticStrongBox::new(key.clone(), vec![key]))
}

fn encrypt_secret(key: Option<&str>, secret: &str) -> anyhow::Result<String> {
    let encrypted = strongbox(key)
        .c(h!())?
        .encrypt(secret.as_bytes(), AI_GOV_UA_SECRET_AAD)
        .map_err(|_| anyhow::anyhow!("Не вдалося зашифрувати секрет ШІ"))
        .c(h!())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

pub(super) fn decrypt_secret(
    key: Option<&str>,
    encrypted: &str,
) -> anyhow::Result<String> {
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(encrypted)
        .c(h!())?;
    let secret = strongbox(key)
        .c(h!())?
        .decrypt(&encrypted, AI_GOV_UA_SECRET_AAD)
        .map_err(|_| anyhow::anyhow!("Не вдалося розшифрувати секрет ШІ"))
        .c(h!())?;
    String::from_utf8(secret).c(h!())
}
